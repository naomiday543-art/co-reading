import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store';
import { attachmentsApi } from '../api';
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
//
// 工單 24：同一個閱讀框裡多一排「文件切換」——正文｜SI 1｜SI 2…｜＋ 補充文件。
// 選到 SI 時沿用同一顆 PDF／文字版切換，但**文字版沒有「問這段」**（那是第三層，
// quote 的偏移語義綁死在 papers.full_text 上，SI 的字不在那條座標軸上）。
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
  const [flash, setFlash] = useState(null);           // { idx, ts } — 跳回時閃一下的那一段
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
    setFlash({ idx, ts: quoteJump.ts });
    clearQuoteJump();
  }, [quoteJump, paragraphs, clearQuoteJump]);

  // 熄燈另外一顆 effect：跟上面那顆綁在一起的話，`clearQuoteJump()` 會讓它立刻
  // 重跑並在 cleanup 裡把 timer 清掉 ⇒ 高亮永遠不滅（自驗時踩到）。
  useEffect(() => {
    if (!flash) return;
    const timer = setTimeout(() => setFlash(null), 1800);
    return () => clearTimeout(timer);
  }, [flash]);

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
              flash?.idx === i ? ' cr-quote-flash' : ''
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

/** SI 的文字版：純段落，**沒有「問這段」**（第三層才做）。 */
function AttachmentTextBody({ text }) {
  const paragraphs = useMemo(
    () => `${text || ''}`.split(/\n{2,}/).map(s => s.trim()).filter(Boolean),
    [text]
  );

  if (paragraphs.length === 0) {
    return <p className="text-center py-12 text-faint text-sm">這份補充文件沒有抽到文字</p>;
  }

  return (
    <div className="cr-fulltext-body">
      <div className="text-left space-y-3">
        {paragraphs.map((para, i) => (
          <p key={i} className="cr-serif text-[13.5px] text-text leading-relaxed whitespace-pre-wrap">
            {para}
          </p>
        ))}
      </div>
    </div>
  );
}

/** 選到 SI 時 chips 底下那一行小工具列：字數／AI 讀得到／改名／刪除。 */
function AttachmentToolbar({ item, onPatch, onDelete, busy }) {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(item.label);
  const [confirming, setConfirming] = useState(false);

  // 換一份 SI 就把編輯狀態收掉，免得把 A 的名字寫到 B 上
  useEffect(() => {
    setRenaming(false);
    setConfirming(false);
    setDraft(item.label);
  }, [item.id, item.label]);

  const commit = () => {
    const next = draft.trim();
    setRenaming(false);
    if (next && next !== item.label) onPatch({ label: next });
    else setDraft(item.label);
  };

  // AI 到底讀到多少——工單 §七：畫面不能說有、AI 其實沒讀
  let aiNote = null;
  if (!item.ai_visible) aiNote = null;
  else if (!item.has_text) aiNote = '掃描版，AI 讀不到文字';
  else if (item.dropped) aiNote = '超出預算，AI 沒讀到';
  else if (item.truncated) aiNote = `AI 只讀前 ${item.ai_chars_sent.toLocaleString('en-US')} 字`;

  return (
    <div className="flex items-center flex-wrap gap-x-3 gap-y-1 justify-center mb-2 text-[11.5px] text-muted shrink-0">
      <span className="text-faint">{item.chars.toLocaleString('en-US')} 字</span>

      <label className="flex items-center gap-1 cursor-pointer">
        <input
          type="checkbox"
          className="accent-current"
          checked={!!item.ai_visible}
          disabled={busy}
          onChange={e => onPatch({ ai_visible: e.target.checked })}
        />
        AI 讀得到
      </label>

      {aiNote && <span className="text-faint">（{aiNote}）</span>}

      {renaming ? (
        <input
          autoFocus
          className="text-[11.5px] border border-border bg-surface rounded px-1.5 py-0.5 w-40 focus:outline-none focus:border-accent"
          value={draft}
          maxLength={120}
          onChange={e => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={e => {
            if (e.key === 'Enter') { e.preventDefault(); commit(); }
            if (e.key === 'Escape') { e.preventDefault(); setDraft(item.label); setRenaming(false); }
          }}
        />
      ) : (
        <button className="hover:text-accent" disabled={busy} onClick={() => setRenaming(true)}>改名</button>
      )}

      {confirming ? (
        <span className="flex items-center gap-1.5">
          <span className="text-faint">確定刪除？</span>
          <button className="text-danger hover:underline" disabled={busy} onClick={() => { setConfirming(false); onDelete(); }}>刪除</button>
          <button className="hover:text-accent" onClick={() => setConfirming(false)}>取消</button>
        </span>
      ) : (
        <button className="hover:text-danger" disabled={busy} onClick={() => setConfirming(true)}>刪除</button>
      )}
    </div>
  );
}

export default function FullTextView({ paper, attachments = [], onAttachmentsChange }) {
  const hasPdf = !!paper.pdf_filename;
  const hasText = !!paper.full_text;
  const [mode, setMode] = useState(() => (hasPdf ? loadMode() : 'text'));
  // 當前選的是哪份文件：null ＝ 正文。**不存 localStorage**（換論文回到正文）。
  const [selectedId, setSelectedId] = useState(null);
  const [siText, setSiText] = useState('');
  const [siTextLoading, setSiTextLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const fileInputRef = useRef(null);
  const pendingJump = useStore(s => s.quoteJump);

  const paragraphs = useMemo(() => buildParagraphs(paper.full_text), [paper.full_text]);
  const selected = selectedId ? attachments.find(a => a.id === selectedId) || null : null;

  // 換論文（或被選中的那份被刪掉）→ 回到正文
  useEffect(() => { setSelectedId(null); setError(''); }, [paper.id]);
  useEffect(() => {
    if (selectedId && !attachments.some(a => a.id === selectedId)) setSelectedId(null);
  }, [attachments, selectedId]);

  // 她在討論裡點引用塊要跳回原文——引用的偏移只對正文有意義，所以**先切回正文**，
  // 再切文字版（PDF 模式跳不了）。兩件事放同一顆 effect：拆成兩顆會互相追著跑。
  useEffect(() => {
    if (!pendingJump) return;
    if (selectedId !== null) setSelectedId(null);
    if (hasText && mode !== 'text') setMode('text');
  }, [pendingJump, hasText, mode, selectedId]);

  // 選到 SI 且要看文字版 → 抓它的字（列表不背全文）
  useEffect(() => {
    if (!selected || !selected.has_text) { setSiText(''); return; }
    let alive = true;
    setSiTextLoading(true);
    attachmentsApi.text(paper.id, selected.id)
      .then(r => { if (alive) setSiText(r.text || ''); })
      .catch(err => { if (alive) { setSiText(''); setError(err.message); } })
      .finally(() => { if (alive) setSiTextLoading(false); });
    return () => { alive = false; };
  }, [paper.id, selected?.id, selected?.has_text]);

  const switchMode = (next) => {
    setMode(next);
    saveMode(next);
  };

  const handleUpload = async (files) => {
    if (!files || files.length === 0) return;
    setUploading(true);
    setError('');
    try {
      const body = await attachmentsApi.upload(paper.id, files);
      onAttachmentsChange?.(body.attachments);
      // 某幾份抽字失敗：後端照樣收下其他份，這裡把失敗的原樣說出來
      if (body.failed?.length > 0) {
        setError(body.failed.map(f => `${f.name}：${f.error}`).join('；'));
      }
    } catch (err) {
      setError(err.message);          // 後端的中文原樣顯示
    }
    setUploading(false);
  };

  const patchSelected = async (data) => {
    if (!selected) return;
    setBusy(true);
    setError('');
    try {
      const body = await attachmentsApi.patch(paper.id, selected.id, data);
      onAttachmentsChange?.(body.attachments);
    } catch (err) {
      setError(err.message);
    }
    setBusy(false);
  };

  const deleteSelected = async () => {
    if (!selected) return;
    setBusy(true);
    setError('');
    try {
      const body = await attachmentsApi.remove(paper.id, selected.id);
      setSelectedId(null);
      onAttachmentsChange?.(body.attachments);
    } catch (err) {
      setError(err.message);
    }
    setBusy(false);
  };

  const addButton = (
    <>
      <input
        ref={fileInputRef}
        type="file"
        accept=".pdf,application/pdf"
        multiple
        className="hidden"
        onChange={e => {
          const files = Array.from(e.target.files || []);
          e.target.value = '';        // 選同一個檔兩次也要觸發
          handleUpload(files);
        }}
      />
      <button
        className="text-[11.5px] px-2.5 py-1 rounded-full text-faint hover:text-accent transition-colors disabled:opacity-60"
        disabled={uploading}
        onClick={() => fileInputRef.current?.click()}
      >
        {uploading ? '上傳中…' : '＋ 補充文件'}
      </button>
    </>
  );

  // 一份 SI 都沒有時只露一顆淡色小鈕，不打擾原本的版面（工單 §D4）。
  const docSwitch = attachments.length === 0 ? (
    <div className="flex items-center justify-center mb-1 shrink-0">{addButton}</div>
  ) : (
    <div className="flex items-center justify-center flex-wrap gap-1 mb-2 shrink-0">
      <div className="inline-flex flex-wrap items-center rounded-full border border-border p-0.5 bg-surface">
        <button
          className={`text-[11.5px] px-2.5 py-1 rounded-full transition-colors ${selectedId === null
            ? 'bg-accent text-accent-fg'
            : 'text-muted hover:text-accent'
          }`}
          onClick={() => setSelectedId(null)}
        >
          正文
        </button>
        {attachments.map((a, i) => (
          <button
            key={a.id}
            className={`text-[11.5px] px-2.5 py-1 rounded-full transition-colors max-w-[11rem] truncate ${selectedId === a.id
              ? 'bg-accent text-accent-fg'
              : 'text-muted hover:text-accent'
            }`}
            title={a.original_name}
            onClick={() => setSelectedId(a.id)}
          >
            SI {i + 1} · {a.label}
          </button>
        ))}
      </div>
      {addButton}
    </div>
  );

  const errorLine = error ? (
    <p className="text-xs text-danger text-center mb-2 shrink-0">{error}</p>
  ) : null;

  // ── 選到某一份 SI ────────────────────────────────────────────────
  if (selected) {
    // 掃描版只有 PDF 模式（沒有字可以顯示）
    const siMode = selected.has_text ? mode : 'pdf';

    const siModeSwitch = selected.has_text ? (
      <div className="flex items-center justify-center gap-1 mb-2 shrink-0">
        <div className="inline-flex rounded-full border border-border p-0.5 bg-surface">
          {[['pdf', 'PDF 原檔'], ['text', '文字版']].map(([key, label]) => (
            <button
              key={key}
              className={`text-[11.5px] px-2.5 py-1 rounded-full transition-colors ${siMode === key
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

    return (
      <div className="flex flex-col h-full">
        {docSwitch}
        <AttachmentToolbar item={selected} onPatch={patchSelected} onDelete={deleteSelected} busy={busy} />
        {errorLine}
        {siModeSwitch}
        {siMode === 'pdf' ? (
          <>
            <iframe
              key={selected.id}   /* 換一份就換一個 iframe，免得殘留上一份 */
              src={attachmentsApi.fileUrl(paper.id, selected.id)}
              className="flex-1 w-full border border-border rounded-lg bg-surface"
              title={selected.label}
              style={{ minHeight: '600px' }}
            />
            <p className="text-xs text-faint mt-2 text-center">
              {selected.has_text
                ? '補充文件的原檔；切到「文字版」看抽取出來的文字'
                : '這份補充文件抽不到文字（可能是掃描版），只能看原檔'}
            </p>
          </>
        ) : (
          <>
            <p className="text-xs text-faint text-center mb-3">
              補充文件的文字版（SI 文字版暫不支援選段提問）
            </p>
            {siTextLoading
              ? <p className="text-center py-12 text-faint text-sm">讀取中…</p>
              : <AttachmentTextBody text={siText} />}
          </>
        )}
      </div>
    );
  }

  // ── 正文（以下行為與工單 24 之前完全一致）────────────────────────
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
        {docSwitch}
        {errorLine}
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
      <div className="flex flex-col h-full">
        {docSwitch}
        {errorLine}
        <div className="text-center py-12 text-faint text-sm">
          <p>無法顯示原文</p>
          {paper.analyze_error?.includes('掃描版') && (
            <p className="text-xs mt-1">此 PDF 可能是掃描版，未能提取文本</p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {docSwitch}
      {errorLine}
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
