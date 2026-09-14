import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store';
import {
  OFFSET_ATTR,
  MIN_SELECTION_CHARS,
  buildParagraphs,
  resolveSelectionQuote,
  paragraphIndexOfOffset,
} from '../lib/fulltext-offsets';

// 閱讀方式：PDF 原檔（版面對、但選不到偏移）／文字版（可選取提問）。
// 工單 14：選段提問要拿得到「這段在全文第幾個字」，而瀏覽器內建的 PDF 檢視器是一個
// 我們碰不到的 document——所以「問這段」只在文字版裡出現，PDF 那邊維持原樣。
const MODE_KEY = 'co-reading:fulltext-mode';

function loadMode() {
  try {
    return localStorage.getItem(MODE_KEY) === 'text' ? 'text' : 'pdf';
  } catch {
    return 'pdf';
  }
}

function saveMode(mode) {
  try { localStorage.setItem(MODE_KEY, mode); } catch {}
}

/** 文字版：段落帶 data-cr-offset 錨點（偏移映射唯一的依據，見 lib/fulltext-offsets.js）。 */
function TextBody({ paper, paragraphs }) {
  const setPendingQuote = useStore(s => s.setPendingQuote);
  const quoteJump = useStore(s => s.quoteJump);
  const clearQuoteJump = useStore(s => s.clearQuoteJump);

  const [selection, setSelection] = useState(null);   // { quote, rect }
  const [flashIdx, setFlashIdx] = useState(-1);
  const paraRefs = useRef([]);
  const rootRef = useRef(null);

  const captureSelection = useCallback(() => {
    const sel = typeof window !== 'undefined' && window.getSelection ? window.getSelection() : null;
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
      setSelection(null);
      return;
    }
    const quote = resolveSelectionQuote({
      anchorNode: sel.anchorNode,
      anchorOffset: sel.anchorOffset,
      focusNode: sel.focusNode,
      focusOffset: sel.focusOffset,
    }, paper.full_text);
    if (!quote) {
      setSelection(null);
      return;
    }
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    setSelection({
      quote,
      rect: { top: rect.top, bottom: rect.bottom, left: rect.left, width: rect.width },
    });
  }, [paper.full_text]);

  // 選取被清掉（點別處、按鍵）時把浮鈕收起來
  useEffect(() => {
    const onChange = () => {
      const sel = window.getSelection?.();
      if (!sel || sel.isCollapsed) setSelection(null);
    };
    document.addEventListener('selectionchange', onChange);
    return () => document.removeEventListener('selectionchange', onChange);
  }, []);

  // 氣泡上的引用塊 → 跳回原文那一段（做不到精確就滾到最近的段落，工單 14 §3.3）
  useEffect(() => {
    if (!quoteJump) return;
    const idx = paragraphIndexOfOffset(paragraphs, quoteJump.start);
    if (idx < 0) { clearQuoteJump(); return; }
    const el = paraRefs.current[idx];
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setFlashIdx(idx);
    clearQuoteJump();
    const timer = setTimeout(() => setFlashIdx(-1), 1800);
    return () => clearTimeout(timer);
  }, [quoteJump, paragraphs, clearQuoteJump]);

  const handleAsk = () => {
    if (!selection) return;
    setPendingQuote(selection.quote);
    setSelection(null);
    try { window.getSelection()?.removeAllRanges(); } catch {}
  };

  const narrow = typeof window !== 'undefined' && window.innerWidth < 640;

  return (
    <div className="cr-fulltext-body" ref={rootRef}>
      <div
        className="text-left space-y-3"
        onMouseUp={captureSelection}
        onTouchEnd={captureSelection}
      >
        {paragraphs.map((para, i) => (
          <p
            key={para.start}
            ref={el => { paraRefs.current[i] = el; }}
            {...{ [OFFSET_ATTR]: String(para.start) }}
            className={`cr-serif text-[13.5px] text-text leading-relaxed whitespace-pre-wrap${
              flashIdx === i ? ' cr-quote-flash' : ''
            }`}
          >
            {para.text}
          </p>
        ))}
      </div>

      {/* 「問這段」：桌機浮在選取旁邊，窄螢幕貼底部工具列（§3.3） */}
      {selection && (
        <button
          className="cr-ask-selection"
          style={narrow ? undefined : {
            top: Math.max(8, selection.rect.top - 38),
            left: Math.max(8, selection.rect.left + selection.rect.width / 2 - 44),
          }}
          data-narrow={narrow ? '1' : undefined}
          onMouseDown={e => e.preventDefault()}   // 別讓按下去就把選取清掉
          onClick={handleAsk}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
          問這段
        </button>
      )}
    </div>
  );
}

export default function FullTextView({ paper }) {
  const hasPdf = !!paper.pdf_filename;
  const hasText = !!paper.full_text;
  const [mode, setMode] = useState(() => (hasPdf ? loadMode() : 'text'));
  const pendingJump = useStore(s => s.quoteJump);

  const paragraphs = useMemo(() => buildParagraphs(paper.full_text), [paper.full_text]);

  // 她在討論裡點引用塊要跳回原文——PDF 模式跳不了，自動切到文字版再跳
  useEffect(() => {
    if (pendingJump && hasText && mode !== 'text') setMode('text');
  }, [pendingJump, hasText, mode]);

  const switchMode = (next) => {
    setMode(next);
    saveMode(next);
  };

  const modeSwitch = hasPdf && hasText ? (
    <div className="flex items-center justify-center gap-1 mb-2 shrink-0">
      <div className="inline-flex rounded-full border border-border p-0.5 bg-surface">
        {[['pdf', 'PDF 原檔'], ['text', '文字版（可選取提問）']].map(([key, label]) => (
          <button
            key={key}
            className={`text-[11.5px] px-2.5 py-1 rounded-full transition-colors ${mode === key
              ? 'bg-accent text-accent-fg'
              : 'text-muted hover:text-accent'
            }`}
            onClick={() => switchMode(key)}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  ) : null;

  if (hasPdf && mode === 'pdf') {
    return (
      <div className="flex flex-col h-full">
        {modeSwitch}
        <iframe
          src={`/api/papers/${paper.id}/pdf`}
          className="flex-1 w-full border border-border rounded-lg bg-surface"
          title="論文原文"
          style={{ minHeight: '600px' }}
        />
        <p className="text-xs text-faint mt-2 text-center">
          {hasText
            ? '想選一段直接問 AI？切到「文字版」，選取後會浮出「問這段」'
            : '選中文字後，複製貼到右側聊天框即可問 AI'}
        </p>
      </div>
    );
  }

  if (!hasText) {
    return (
      <div className="text-center py-12 text-faint text-sm">
        <p>無法顯示原文</p>
        {paper.analyze_error?.includes('掃描版') && (
          <p className="text-xs mt-1">此 PDF 可能是掃描版，未能提取文本</p>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {modeSwitch}
      <p className="text-xs text-faint text-center mb-3">
        {hasPdf
          ? `提取的文字版（選取 ${MIN_SELECTION_CHARS} 字以上會浮出「問這段」）`
          : `原始 PDF 檔案不可用，僅能顯示提取的文字（選取 ${MIN_SELECTION_CHARS} 字以上可直接提問）`}
      </p>
      <TextBody paper={paper} paragraphs={paragraphs} />
    </div>
  );
}
