import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
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

// PDF 框的最小高度（工單 25）。原本寫死 600px：視窗矮、或瀏覽器縮放調大時，iframe 比
// 可用高度還高，底部連同 PDF 檢視器自己的**水平捲軸**一起被擠到外層捲動區下面——
// 她把 PDF 放大到 163% 之後就「沒有左右滑塊、只能用觸控板」。現在只保一個不至於塌掉的
// 下限，其餘交給 flex-1 貼合可用高度，檢視器的兩條捲軸就都留在看得到的地方。
const PDF_FRAME_MIN_HEIGHT = 240;

// 工單 26 §D4：文字版不再是「一坨貼在框裡的字」——給它一張自己會捲的卡，
// 內文 620px 行寬、serif 14.5px／1.75。PDF 那邊維持原樣（框裡的東西我們碰不到）。
const TEXT_CARD = 'flex-1 min-h-0 overflow-auto border border-border rounded-lg bg-surface';
const TEXT_CARD_STYLE = { padding: '22px 26px' };

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
    /* 工單 26 §D4：捲動交給外面那張卡了（--flow 把這裡的 flex/overflow 關掉）。
       data-cr-offset／選段／跳回的機制一個字沒動，只換樣式 class。 */
    <div className="cr-fulltext-body cr-fulltext-body--flow" ref={rootRef}>
      <div
        className="text-left space-y-3.5"
        onMouseUp={captureSelection}
        onTouchEnd={captureSelection}
      >
        {paragraphs.map((para, i) => (
          <p
            key={para.start}
            ref={el => { paraRefs.current[i] = el; }}
            {...{ [OFFSET_ATTR]: String(para.start) }}
            className={`cr-serif text-[14.5px] leading-[1.75] text-text whitespace-pre-wrap${
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
    return <p className="py-12 text-faint text-sm">這份補充文件沒有抽到文字</p>;
  }

  return (
    <div className="cr-fulltext-body cr-fulltext-body--flow">
      <div className="text-left space-y-3.5">
        {paragraphs.map((para, i) => (
          <p key={i} className="cr-serif text-[14.5px] leading-[1.75] text-text whitespace-pre-wrap">
            {para}
          </p>
        ))}
      </div>
    </div>
  );
}

/**
 * AI 到底讀到這份多少（工單 24 §七的紅線：畫面不能說有、AI 其實沒讀）。
 * `full` ＝「勾了、而且真的整份讀進去了」——只有這種情況眼睛才是全不透明的。
 */
function aiTruth(item) {
  if (!item || !item.ai_visible) return { note: null, full: false };
  if (!item.has_text) return { note: '掃描版，AI 讀不到文字', full: false };
  if (item.dropped) return { note: '超出預算，AI 沒讀到', full: false };
  if (item.truncated) return { note: `AI 只讀前 ${(item.ai_chars_sent || 0).toLocaleString('en-US')} 字`, full: false };
  return { note: null, full: true };
}

function eyeTitle(item) {
  if (!item.ai_visible) return 'AI 讀不到這份（點擊開啟）';
  const { note } = aiTruth(item);
  return note ? `${note}（點擊關閉）` : 'AI 讀得到這份（點擊關閉）';
}

const EyeOn = (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
    <path d="M1.6 8s2.4-4 6.4-4 6.4 4 6.4 4-2.4 4-6.4 4-6.4-4-6.4-4z" />
    <circle cx="8" cy="8" r="1.7" />
  </svg>
);
const EyeOff = (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
    <path d="M1.6 8s2.4-4 6.4-4 6.4 4 6.4 4-2.4 4-6.4 4-6.4-4-6.4-4z" />
    <path d="M2.5 2.5l11 11" />
  </svg>
);

export default function FullTextView({ paper, attachments = [], onAttachmentsChange, controlsSlot = null }) {
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
  // 工單 26 §D4：SI 的小工具列收進膠囊本身 ＋ 一顆 ⋯ 選單（檔名／AI 讀得到／改名／刪除）
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState('');
  const [confirming, setConfirming] = useState(false);
  const groupRef = useRef(null);

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

  // 換一份 SI／關掉選單就把編輯狀態收乾淨，免得把 A 的名字寫到 B 上
  useEffect(() => {
    setMenuOpen(false);
    setRenaming(false);
    setConfirming(false);
  }, [selectedId]);
  useEffect(() => {
    if (!menuOpen) { setRenaming(false); setConfirming(false); }
  }, [menuOpen]);

  // 點外面／Escape 關選單。**Escape 是這裡的保命索**：選單蓋在 PDF iframe 上時，
  // 指標落在 iframe 裡的那一下 mousedown document 收不到（事件被 iframe 吃掉），
  // 只靠點外面關不掉。listener 一律在關掉／unmount 時拆。
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e) => {
      // 用整個膠囊組當界線：只檢查選單本身的話，再點一次 ⋯ 會「先關後開」而關不掉。
      if (!groupRef.current?.contains(e.target)) setMenuOpen(false);
    };
    const onKey = (e) => { if (e.key === 'Escape') setMenuOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  const commitRename = () => {
    if (!selected) return;
    const next = draft.trim();
    setRenaming(false);
    if (next && next !== selected.label) patchSelected({ label: next });
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
        className={attachments.length === 0
          ? 'text-[11.5px] px-2 py-1 rounded-full text-faint hover:text-accent transition-colors disabled:opacity-60 whitespace-nowrap'
          : 'w-[22px] h-[22px] shrink-0 flex items-center justify-center rounded-full border border-border text-muted hover:bg-surface-hover hover:text-text-strong transition-colors disabled:opacity-60'}
        disabled={uploading}
        title="加一份補充文件（SI，PDF）"
        onClick={() => fileInputRef.current?.click()}
      >
        {/* 已經有 SI 時縮成一顆圓形「＋」：這一排住在工作列裡，寸土寸金 */}
        {uploading
          ? (attachments.length === 0 ? '上傳中…' : <svg className="cr-spin" width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M8 1.6a6.4 6.4 0 1 0 6.4 6.4" /></svg>)
          : attachments.length === 0
            ? '＋ 補充文件'
            : <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M8 3v10M3 8h10" /></svg>}
      </button>
    </>
  );

  const pill = (active) => `text-[11.5px] px-2.5 py-1 rounded-full transition-colors whitespace-nowrap ${active
    ? 'bg-accent text-accent-fg'
    : 'text-muted hover:text-accent'
  }`;

  const menuRow = 'block w-full text-left text-[12px] px-[9px] py-1.5 rounded-md hover:bg-surface-hover transition-colors disabled:opacity-60';
  const selectedTruth = aiTruth(selected);

  // 文件切換：正文｜SI 1｜SI 2…。**選中的 SI 膠囊就地展開**（工單 26 §D4）：
  //   SI 1 ｜ 16,680 字 ｜ 👁 ｜ ⋯
  // 整整省下原本那一行小工具列的 24px，而且只在選到 SI 時才變長。
  // 外層改用 div（role=button）：按鈕裡不能再塞按鈕，眼睛與 ⋯ 都是可點的。
  const docSwitch = attachments.length === 0 ? addButton : (
    <>
      <div ref={groupRef} className="relative inline-flex items-center rounded-full border border-border p-0.5 bg-surface">
        <button className={pill(selectedId === null)} onClick={() => setSelectedId(null)}>正文</button>
        {attachments.map((a, i) => {
          const active = selectedId === a.id;
          const truth = aiTruth(a);
          return (
            <div
              key={a.id}
              role="button"
              tabIndex={0}
              className={`${pill(active)} flex items-center gap-[5px] cursor-pointer`}
              title={`${a.label}（${a.original_name}）`}
              onClick={() => setSelectedId(a.id)}
              onKeyDown={e => {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelectedId(a.id); }
              }}
            >
              <span>SI {i + 1}</span>
              {active && (
                <span
                  className="flex items-center gap-[5px] pl-[5px]"
                  // 選中時底是 accent、字是 accent-fg，分隔線跟著 currentColor 走半透明，
                  // 亮／深兩套都成立（寫死白色在深色模式會刺眼）
                  style={{ borderLeft: '1px solid color-mix(in srgb, currentColor 35%, transparent)' }}
                >
                  <span className="cr-mono text-[10px] opacity-85">{a.chars.toLocaleString('en-US')} 字</span>
                  <span
                    role="button"
                    tabIndex={0}
                    title={eyeTitle(a)}
                    className="flex items-center"
                    // 勾了但沒真的讀到（截斷／擠掉／掃描版）也是半透明——畫面不能說有、AI 其實沒讀
                    style={{ opacity: truth.full ? 1 : 0.55 }}
                    onClick={e => { e.stopPropagation(); if (!busy) patchSelected({ ai_visible: !a.ai_visible }); }}
                    onKeyDown={e => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault(); e.stopPropagation();
                        if (!busy) patchSelected({ ai_visible: !a.ai_visible });
                      }
                    }}
                  >
                    {a.ai_visible ? EyeOn : EyeOff}
                  </span>
                  <span
                    role="button"
                    tabIndex={0}
                    title="更多：改名、刪除"
                    className="flex items-center leading-none text-[12px] tracking-[1px]"
                    onClick={e => { e.stopPropagation(); setMenuOpen(o => !o); }}
                    onKeyDown={e => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault(); e.stopPropagation(); setMenuOpen(o => !o);
                      }
                    }}
                  >
                    ⋯
                  </span>
                </span>
              )}
            </div>
          );
        })}

        {menuOpen && selected && (
          <div className="absolute right-0 top-[calc(100%+6px)] z-[60] min-w-[186px] bg-surface border border-border rounded-[10px] shadow-md p-1">
            <div className="cr-mono text-[10.5px] text-faint px-[9px] pt-[5px] pb-1 break-all" title={selected.original_name}>
              {selected.original_name}
            </div>
            <button
              className={`${menuRow} flex items-center justify-between gap-2`}
              disabled={busy}
              onClick={() => patchSelected({ ai_visible: !selected.ai_visible })}
            >
              <span>AI 讀得到</span>
              <span className={`text-[11px] ${selected.ai_visible ? 'text-accent' : 'text-faint'}`}>
                {selected.ai_visible ? '開啟' : '關閉'}
              </span>
            </button>
            {selectedTruth.note && (
              <div className="px-[9px] pb-1.5 text-[10.5px] text-faint leading-snug">{selectedTruth.note}</div>
            )}

            {renaming ? (
              <div className="px-[5px] py-1">
                <input
                  autoFocus
                  className="w-full text-[12px] border border-border bg-surface rounded px-1.5 py-1 focus:outline-none focus:border-accent"
                  value={draft}
                  maxLength={120}
                  onChange={e => setDraft(e.target.value)}
                  onBlur={commitRename}
                  onKeyDown={e => {
                    if (e.key === 'Enter') { e.preventDefault(); commitRename(); }
                    // 這一下 Escape 是「取消改名」，不是關選單——別讓它冒到 document 那顆
                    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setRenaming(false); }
                  }}
                />
              </div>
            ) : (
              <button
                className={menuRow}
                disabled={busy}
                onClick={() => { setDraft(selected.label); setRenaming(true); }}
              >
                改名
              </button>
            )}

            {confirming ? (
              /* 頂列還有一顆刪「整篇論文」的垃圾桶——這裡要講清楚刪的只是這份 SI */
              <div className="px-[9px] py-1.5">
                <div className="text-[10.5px] text-faint mb-1">確定刪除這份補充文件？不動論文。</div>
                <div className="flex items-center gap-3">
                  <button
                    className="text-[11.5px] text-danger hover:underline disabled:opacity-60"
                    disabled={busy}
                    onClick={() => { setConfirming(false); setMenuOpen(false); deleteSelected(); }}
                  >
                    刪除
                  </button>
                  <button className="text-[11.5px] text-muted hover:text-accent" onClick={() => setConfirming(false)}>
                    取消
                  </button>
                </div>
              </div>
            ) : (
              <button
                className={`${menuRow} text-danger`}
                disabled={busy}
                title="只刪這份補充文件，不動論文"
                onClick={() => setConfirming(true)}
              >
                刪除這份
              </button>
            )}
          </div>
        )}
      </div>
      {addButton}
    </>
  );

  // PDF／文字版：正文與 SI 共用同一顆（同一個 localStorage 偏好）。
  // 掃描版 SI 沒有字可以顯示 → 只有 PDF、不給切。
  const showModeSwitch = selected ? selected.has_text : (hasPdf && hasText);
  const activeMode = selected ? (selected.has_text ? mode : 'pdf') : mode;
  const modeSwitch = showModeSwitch ? (
    <div className="inline-flex rounded-full border border-border p-0.5 bg-surface">
      {[
        ['pdf', 'PDF 原檔', '看原始 PDF 的版面'],
        // PDF 框下面原本各有一行提示小字，工單 25 附錄 B 收掉了（那 26px 還給 PDF）——說明都搬到這裡
        ['text', '文字版', selected ? '抽取出來的文字（SI 文字版暫不支援選段提問）' : '想選一段直接問 AI？切到這裡，選取後會浮出「問這段」'],
      ].map(([key, label, tip]) => (
        <button key={key} className={pill(activeMode === key)} title={tip} onClick={() => switchMode(key)}>
          {label}
        </button>
      ))}
    </div>
  ) : null;

  // 工單 24b：這兩排控制項收進 PaperDetail 分頁列右側的插槽——她嫌它們佔地方，
  // 要把高度還給 PDF。沒拿到插槽（別處單獨用這個元件）就退回內容區頂端，功能不少。
  const controlsInner = <>{docSwitch}{modeSwitch}</>;
  const controls = controlsSlot
    ? createPortal(controlsInner, controlsSlot)
    : <div className="flex items-center justify-center flex-wrap gap-1.5 mb-2 shrink-0">{controlsInner}</div>;

  const errorLine = error ? (
    <p className="text-xs text-danger text-center mb-2 shrink-0">{error}</p>
  ) : null;

  // ── 選到某一份 SI ────────────────────────────────────────────────
  if (selected) {
    return (
      <div className="flex flex-col h-full">
        {controls}
        {errorLine}
        {activeMode === 'pdf' ? (
          <>
            <iframe
              key={selected.id}   /* 換一份就換一個 iframe，免得殘留上一份 */
              src={attachmentsApi.fileUrl(paper.id, selected.id)}
              className="flex-1 min-h-0 w-full border border-border rounded-lg bg-surface"
              title={selected.label}
              style={{ minHeight: PDF_FRAME_MIN_HEIGHT }}
            />
          </>
        ) : (
          /* 工單 26 §D4：文字版給真排版——外框卡自己捲、內文 620px 行寬 */
          <div className={TEXT_CARD} style={TEXT_CARD_STYLE}>
            <div className="max-w-[620px]">
              <p className="text-xs text-faint mb-4">
                補充文件的文字版（SI 文字版暫不支援選段提問）
              </p>
              {siTextLoading
                ? <p className="py-12 text-faint text-sm">讀取中…</p>
                : <AttachmentTextBody text={siText} />}
            </div>
          </div>
        )}
      </div>
    );
  }

  // ── 正文（內容區的行為與工單 24 之前完全一致）──────────────────────
  if (hasPdf && mode === 'pdf') {
    return (
      <div className="flex flex-col h-full">
        {controls}
        {errorLine}
        <iframe
          src={`/api/papers/${paper.id}/pdf`}
          className="flex-1 min-h-0 w-full border border-border rounded-lg bg-surface"
          title="論文原文"
          style={{ minHeight: PDF_FRAME_MIN_HEIGHT }}
        />
      </div>
    );
  }

  if (!hasText) {
    return (
      <div className="flex flex-col h-full">
        {controls}
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
      {controls}
      {errorLine}
      {/* 工單 26 §D4：原本頂上那行說明小字搬進卡內第一行，卡自己捲動 */}
      <div className={TEXT_CARD} style={TEXT_CARD_STYLE}>
        <div className="max-w-[620px]">
          <p className="text-xs text-faint mb-4">
            {hasPdf
              ? `提取的文字版（選取 ${MIN_SELECTION_CHARS} 字以上會浮出「問這段」）`
              : `原始 PDF 檔案不可用，僅能顯示提取的文字（選取 ${MIN_SELECTION_CHARS} 字以上可直接提問）`}
          </p>
          <TextBody paper={paper} paragraphs={paragraphs} />
        </div>
      </div>
    </div>
  );
}
