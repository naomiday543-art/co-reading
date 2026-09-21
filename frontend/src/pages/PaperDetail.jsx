import React, { useEffect, useState, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { papersApi, tagsApi, treeApi, insightsApi, attachmentsApi } from '../api';
import { useStore } from '../store';
import SummaryView from '../components/SummaryView';
import FullTextView from '../components/FullTextView';
import ChatPanel from '../components/ChatPanel';
import TagBadge from '../components/TagBadge';
import InsightCard from '../components/InsightCard';
import InsightForm from '../components/InsightForm';
import InsightPopover from '../components/InsightPopover';
import { describeTextQuality, renderPageReasons } from '../textQuality';

// 閱讀模式的聊天抽屜寬度（工單 06 §3.1）
const DRAWER_WIDTH_KEY = 'co-reading:chat-drawer-width';
const DRAWER_MIN = 320;
const DRAWER_MAX = 720;
const DRAWER_DEFAULT = 420;

// 分欄模式左右兩欄的分隔線位置（工單 25 附錄 A）。原本每次進論文都回到 50%——
// 她的 PDF 檢視器工具列比半個視窗寬，左欄太窄時檢視器底下會多一條橫向捲軸，
// 每次都要重拖一遍分隔線。拖一次就記住。範圍與拖曳時的夾限一致（30–70%）。
const SPLIT_KEY = 'co-reading:detail-split';
const SPLIT_MIN = 30;
const SPLIT_MAX = 70;
// 預設 58 而不是 50（工單 25 附錄 B）：Chrome 新版 PDF 檢視器的工具列有一個不小的最小寬度，
// 左欄只有半個視窗時放不下 ⇒ 檢視器整頁多出一條橫向捲軸（她兩張截圖量出來都是「還差一成寬」）。
// 多給左欄 8% 就夠；她自己拖過的位置（localStorage）永遠優先。
const SPLIT_DEFAULT = 58;

function loadSplit() {
  try {
    const raw = localStorage.getItem(SPLIT_KEY);
    if (raw === null) return SPLIT_DEFAULT;
    const n = Number(raw);
    return n >= SPLIT_MIN && n <= SPLIT_MAX ? n : SPLIT_DEFAULT;
  } catch {
    return SPLIT_DEFAULT;
  }
}

function loadDrawerWidth() {
  try {
    const n = Number(localStorage.getItem(DRAWER_WIDTH_KEY));
    return n >= DRAWER_MIN && n <= DRAWER_MAX ? n : DRAWER_DEFAULT;
  } catch {
    return DRAWER_DEFAULT;
  }
}

export default function PaperDetail({ paperId, onBack, onNavigate, headerMainSlot = null, headerEndSlot = null }) {
  const [paper, setPaper] = useState(null);
  const [loading, setLoading] = useState(true);
  const [split, setSplit] = useState(loadSplit);
  const splitRef = useRef(split);
  const splitBoxRef = useRef(null);   // 分欄容器：拖曳時百分比要以它為基準（見下方 onMove）
  // 'summary' | 'fulltext'——閱讀模式下刷新回來也該是 PDF，不是摘要
  const [leftTab, setLeftTab] = useState(() => (useStore.getState().readingMode ? 'fulltext' : 'summary'));
  const [statusMenu, setStatusMenu] = useState(false);
  // 工單 24 §D4：補充文件清單。撈在這一層，「原文」tab 的標籤才知道有幾份。
  const [attachments, setAttachments] = useState([]);
  // 工單 24b：分頁列右側的插槽（DOM node）。用 state 存、不用 useRef——節點就位要觸發重渲染，
  // FullTextView 才拿得到它去 createPortal。
  const [controlsSlot, setControlsSlot] = useState(null);
  const [tagInput, setTagInput] = useState('');
  const [tagSuggestions, setTagSuggestions] = useState([]);
  const [showTagSuggest, setShowTagSuggest] = useState(false);
  const [treeMenu, setTreeMenu] = useState(false);
  const [relatedInsights, setRelatedInsights] = useState([]);
  const [showInsightForm, setShowInsightForm] = useState(false);
  // 工單 18 §2 A1：「存為洞察」帶進來的預填（來源論文＋那一則回覆的 id）
  const [insightSeed, setInsightSeed] = useState({ source_paper_id: paperId });
  // 工單 18 §2 A2：論文頁的相關洞察卡片點下去也浮這張卡（渲染 InsightCard 的地方行為一致）
  const [popoverId, setPopoverId] = useState(null);
  const { tags, tree, papers, setTags, readingMode, setReadingMode } = useStore();
  // 工單 14 §3.3：選段與跳回原文是跨面板的動作（FullTextView ↔ ChatPanel），
  // 中間只借 store 這兩顆訊號，兩個元件都不用知道對方存在。
  const pendingQuote = useStore(s => s.pendingQuote);
  const quoteJump = useStore(s => s.quoteJump);
  const messageJump = useStore(s => s.messageJump);
  const requestMessageJump = useStore(s => s.requestMessageJump);

  // 閱讀模式的聊天抽屜：開合不持久化（每次進論文預設收起），寬度持久化
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerWidth, setDrawerWidth] = useState(loadDrawerWidth);
  const [drawerDragging, setDrawerDragging] = useState(false);
  const [chatUnread, setChatUnread] = useState(false);
  const drawerWidthRef = useRef(drawerWidth);
  const lastMsgCount = useRef(null);

  // 工單 18 §2 A2：閱讀模式下討論是收起來的抽屜——有待跳的訊息就先把它打開，
  // 不然「去對話」按下去畫面毫無反應。
  useEffect(() => {
    if (messageJump && readingMode) setDrawerOpen(true);
  }, [messageJump, readingMode]);

  const loadPaper = useCallback(async () => {
    try {
      const data = await papersApi.get(paperId);
      setPaper(data);
    } catch (err) {
      console.error(err);
    }
    setLoading(false);
  }, [paperId]);

  useEffect(() => { loadPaper(); }, [loadPaper]);

  // 補充文件／SI 清單（工單 24 §D4）。
  // 為什麼撈在這一層而不是 FullTextView 裡：「原文」tab 沒打開時那個元件根本不會
  // mount，而 tab 標籤上的「· SI N」在摘要頁就要看得見。
  const loadAttachments = useCallback(async () => {
    try {
      const data = await attachmentsApi.list(paperId);
      setAttachments(data.attachments || []);
    } catch (err) {
      console.error(err);
      setAttachments([]);
    }
  }, [paperId]);

  // 換論文先清空：不然上一篇的 SI chips 會閃一下，手快點下去就是一個 404。
  useEffect(() => { setAttachments([]); loadAttachments(); }, [loadAttachments]);

  // Poll while analyzing
  useEffect(() => {
    if (!paper || paper.analyze_status !== 'analyzing') return;
    const timer = setInterval(loadPaper, 3000);
    return () => clearInterval(timer);
  }, [paper?.analyze_status, loadPaper]);

  // Load related insights
  useEffect(() => {
    if (!paper) return;
    insightsApi.related(paper.id)
      .then(setRelatedInsights)
      .catch(() => {});
  }, [paper?.id]);

  // 狀態下拉搬進頂列之後是一片絕對定位的小板子——點外面／Escape 要收得掉，
  // 而且 listener 必須在關掉時就拆（不然它會一直賴在 document 上）。
  const statusBoxRef = useRef(null);
  useEffect(() => {
    if (!statusMenu) return;
    const onDown = (e) => {
      if (!statusBoxRef.current?.contains(e.target)) setStatusMenu(false);
    };
    const onKey = (e) => { if (e.key === 'Escape') setStatusMenu(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [statusMenu]);

  const handleStatusChange = async (status) => {
    await papersApi.update(paperId, { status });
    setStatusMenu(false);
    loadPaper();
  };

  const handleDelete = async () => {
    if (confirm('確定要刪除這篇論文嗎？此操作無法復原。')) {
      await papersApi.delete(paperId);
      onBack();
    }
  };

  const handleAddTag = async (tagId) => {
    await papersApi.addTag(paperId, tagId);
    setTagInput('');
    setShowTagSuggest(false);
    loadPaper();
  };

  const handleRemoveTag = async (tagId) => {
    await papersApi.removeTag(paperId, tagId);
    loadPaper();
  };

  const handleCreateAndAddTag = async () => {
    const name = tagInput.trim();
    if (!name) return;
    const created = await tagsApi.create(name);
    setTags([...tags, created]);
    await papersApi.addTag(paperId, created.id);
    setTagInput('');
    setShowTagSuggest(false);
    loadPaper();
  };

  const handleTagInputChange = (val) => {
    setTagInput(val);
    if (val.trim()) {
      const suggestions = tags.filter(t =>
        t.name.toLowerCase().includes(val.toLowerCase()) &&
        !(paper?.tags || []).some(pt => pt.id === t.id)
      );
      setTagSuggestions(suggestions);
      setShowTagSuggest(true);
    } else {
      setShowTagSuggest(false);
    }
  };

  const handleMoveToTree = async (nodeId) => {
    await papersApi.update(paperId, { tree_node_id: nodeId || null });
    setTreeMenu(false);
    loadPaper();
  };

  const handleRetryAnalyze = async () => {
    await papersApi.analyze(paperId);
    loadPaper();
  };

  // Split dragging — uses an overlay to prevent iframe from stealing mouseup
  const [isDragging, setIsDragging] = useState(false);
  // 雙擊分隔線＝還原。不能用 onDoubleClick：第一下 mousedown 就會蓋上一層全螢幕遮罩
  // （防 iframe 偷走 mouseup），第二下 click 落在遮罩上，瀏覽器不會對握把發 dblclick。
  // 所以在 mousedown 自己量兩下的間隔。
  const lastHandleDownRef = useRef(0);
  const handleMouseDown = () => {
    const now = Date.now();
    if (now - lastHandleDownRef.current < 350) {
      lastHandleDownRef.current = 0;
      resetSplit();
      return;
    }
    lastHandleDownRef.current = now;
    setIsDragging(true);
  };
  // 回到預設寬度，並忘掉記住的位置
  const resetSplit = () => {
    splitRef.current = SPLIT_DEFAULT;
    setSplit(SPLIT_DEFAULT);
    try { localStorage.removeItem(SPLIT_KEY); } catch {}
  };
  useEffect(() => {
    if (!isDragging) return;
    const onMove = (e) => {
      // 左欄的 `width: N%` 是相對於分欄容器，不是整個視窗——原本用 clientX / innerWidth 算，
      // 側欄開著（容器左邊多 250px）時分隔線完全不跟手。改成以容器自己的位置與寬度為基準。
      const box = splitBoxRef.current?.getBoundingClientRect();
      const pct = box && box.width > 0
        ? ((e.clientX - box.left) / box.width) * 100
        : (e.clientX / window.innerWidth) * 100;
      const next = Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, pct));
      splitRef.current = next;
      setSplit(next);
    };
    const onUp = () => {
      setIsDragging(false);
      // 放手才存（不要每個 mousemove 都寫 localStorage）；存一位小數就夠
      try { localStorage.setItem(SPLIT_KEY, String(Math.round(splitRef.current * 10) / 10)); } catch {}
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [isDragging]);

  // ── 閱讀模式（工單 06 §3.1）───────────────────────────────────────
  const toggleReadingMode = () => {
    const next = !readingMode;
    setReadingMode(next);
    if (next) {
      // 閱讀模式就是看 PDF；離開時不切回（拍板）
      if (leftTab === 'summary') setLeftTab('fulltext');
    } else {
      setDrawerOpen(false);
    }
  };

  const toggleDrawer = () => {
    setDrawerOpen(open => {
      if (!open) setChatUnread(false);
      return !open;
    });
  };

  // 換論文時重置抽屜（PaperDetail 不是按 paperId keyed，不會重掛）
  useEffect(() => {
    setDrawerOpen(false);
    setChatUnread(false);
    lastMsgCount.current = null;
  }, [paperId]);

  // 按了「問這段」：閱讀模式下把討論抽屜拉開（分欄模式本來就看得到，不用動）
  useEffect(() => {
    if (pendingQuote && readingMode) {
      setDrawerOpen(true);
      setChatUnread(false);
    }
  }, [pendingQuote, readingMode]);

  // 點氣泡上的引用塊要跳回原文 → 先確保左欄在「原文」而不是摘要（滾動由 FullTextView 做）
  useEffect(() => {
    if (quoteJump) setLeftTab('fulltext');
  }, [quoteJump]);

  // 抽屜 fixed 定位要貼在 header 下緣——量一次，別寫死魔術數字
  useEffect(() => {
    if (!readingMode) return;
    const update = () => {
      const h = document.querySelector('header')?.getBoundingClientRect().height;
      if (h) document.documentElement.style.setProperty('--cr-drawer-top', `${Math.round(h)}px`);
    };
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [readingMode]);

  // Esc 關抽屜
  useEffect(() => {
    if (!readingMode || !drawerOpen) return;
    const onKey = (e) => { if (e.key === 'Escape') setDrawerOpen(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [readingMode, drawerOpen]);

  // 抽屜左緣拖寬（320–720），放手才寫 localStorage
  const handleDrawerDragStart = (e) => { e.preventDefault(); setDrawerDragging(true); };
  useEffect(() => {
    if (!drawerDragging) return;
    const onMove = (e) => {
      const w = Math.round(Math.min(DRAWER_MAX, Math.max(DRAWER_MIN, window.innerWidth - e.clientX)));
      drawerWidthRef.current = w;
      setDrawerWidth(w);
    };
    const onUp = () => {
      setDrawerDragging(false);
      try { localStorage.setItem(DRAWER_WIDTH_KEY, String(drawerWidthRef.current)); } catch {}
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [drawerDragging]);

  // 抽屜收著的時候來了新回覆 → 浮鈕帶小點
  const handleMessagesUpdated = useCallback((count) => {
    const prev = lastMsgCount.current;
    lastMsgCount.current = count;
    if (prev == null) return; // 首次載入不算未讀
    if (count > prev && !drawerOpen) setChatUnread(true);
  }, [drawerOpen]);

  const statusLabels = { unread: '待讀', reading: '閱讀中', done: '已讀' };

  if (loading) {
    return <div className="flex items-center justify-center h-64 text-faint">載入中...</div>;
  }
  if (!paper) {
    return <div className="flex items-center justify-center h-64 text-faint">論文不存在</div>;
  }

  const fullTitle = paper.title || paper.pdf_filename || '未命名';

  // 工單 26 §D1：這一段照常在 PaperDetail 裡宣告，只是畫到 App 頂列的插槽去
  // （createPortal 不改 React 樹，事件與 state 都還在這裡）。
  const topbarMain = (
    <>
      <button onClick={onBack} className="flex items-center gap-1 text-muted hover:text-text-strong text-[12.5px] shrink-0 px-1.5 py-1 rounded-md hover:bg-surface-hover transition-colors">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="m15 18-6-6 6-6" /></svg>
        返回列表
      </button>
      {/* 閱讀模式開關——抽屜開著時也不會被蓋住 */}
      <button
        className={`text-[11.5px] border rounded-full pl-2 pr-2.5 py-[3px] flex items-center gap-1 shrink-0 transition-colors ${readingMode
          ? 'border-accent bg-accent-soft text-accent font-medium'
          : 'border-border text-muted hover:bg-surface-hover hover:text-text-strong'
        }`}
        onClick={toggleReadingMode}
        title={readingMode ? '離開閱讀模式' : '閱讀模式：論文撐滿，討論收到右下角'}
      >
        {readingMode ? (
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M8 3v3a2 2 0 0 1-2 2H3M21 8h-3a2 2 0 0 1-2-2V3M3 16h3a2 2 0 0 1 2 2v3M16 21v-3a2 2 0 0 1 2-2h3" /></svg>
        ) : (
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3" /></svg>
        )}
        {readingMode ? '離開閱讀' : '閱讀模式'}
      </button>

      <div className="flex-1 min-w-0 flex items-center gap-2">
        <h2 className="cr-serif text-[15.5px] text-text-strong truncate min-w-0" title={fullTitle}>{fullTitle}</h2>

        {/* Status dropdown */}
        <div className="relative shrink-0" ref={statusBoxRef}>
          <button
            className="text-[11.5px] border border-border bg-surface-alt rounded-full pl-2.5 pr-2 py-[3px] text-muted hover:bg-surface-hover hover:text-text-strong flex items-center gap-1 transition-colors"
            onClick={() => setStatusMenu(!statusMenu)}
          >
            {statusLabels[paper.status]} ▾
          </button>
          {statusMenu && (
            <div className="absolute left-0 top-[calc(100%+5px)] bg-surface border border-border rounded-lg shadow-lg z-[60] py-1 text-sm min-w-[104px]">
              {Object.entries(statusLabels).map(([k, v]) => (
                <button key={k} className="block w-full text-left px-3 py-1.5 hover:bg-surface-hover"
                  onClick={() => handleStatusChange(k)}>{v}</button>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );

  // 工單 26 §三：最右那顆**不是**「關閉這篇」，是刪除論文（有 confirm）——換成垃圾桶，
  // 字也講清楚，免得她以為只是把頁面關掉。
  const deleteButton = (
    <button
      onClick={handleDelete}
      className="w-7 h-7 shrink-0 flex items-center justify-center rounded-md text-faint hover:text-danger hover:bg-surface-hover transition-colors"
      title="刪除這篇論文"
    >
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
        <path d="M2.8 4.2h10.4M6.3 4.2V2.9h3.4v1.3M4.1 4.2l.6 8.2a1 1 0 0 0 1 .93h4.6a1 1 0 0 0 1-.93l.6-8.2M6.6 6.5v4.4M9.4 6.5v4.4" />
      </svg>
    </button>
  );

  return (
    <div className="flex flex-col h-full">
      {/* Top bar —— 兩個插槽都在時整列住進 App 的 52px 頂列；
          拿不到插槽（別處單獨用這個元件）就退回原本這一條，功能一顆不少。 */}
      {headerMainSlot ? createPortal(topbarMain, headerMainSlot) : null}
      {headerEndSlot ? createPortal(deleteButton, headerEndSlot) : null}
      {(!headerMainSlot || !headerEndSlot) && (
        <div className="cr-detail-topbar flex items-center justify-between mb-4 shrink-0 gap-2.5">
          {!headerMainSlot && <div className="flex items-center gap-2.5 min-w-0 flex-1">{topbarMain}</div>}
          {!headerEndSlot && deleteButton}
        </div>
      )}

      {/* Split content */}
      <div ref={splitBoxRef} className="cr-detail-split flex flex-1 overflow-hidden gap-0 min-h-0">
        {/* Left: Summary / Fulltext tabs */}
        <div className="cr-detail-pane flex flex-col overflow-hidden" style={{ width: readingMode ? '100%' : `${split}%` }}>
          {/* Tab bar */}
          <div className="flex flex-wrap-reverse items-end border-b border-border-soft mb-3 shrink-0">
            <button
              className={`text-[13px] px-3 py-2 border-b-2 -mb-px transition-colors whitespace-nowrap shrink-0 ${leftTab === 'summary' ? 'border-accent text-accent font-medium' : 'border-transparent text-muted hover:text-text-strong'}`}
              onClick={() => setLeftTab('summary')}
            >
              AI 摘要
            </button>
            <button
              className={`text-[13px] px-3 py-2 border-b-2 -mb-px transition-colors whitespace-nowrap shrink-0 ${leftTab === 'fulltext' ? 'border-accent text-accent font-medium' : 'border-transparent text-muted hover:text-text-strong'}`}
              onClick={() => setLeftTab('fulltext')}
            >
              原文{attachments.length > 0 && (
                <span className="text-[11px] text-faint ml-1">· SI {attachments.length}</span>
              )}
            </button>
            {/* 工單 24b：原文分頁的「正文｜SI…｜＋」與「PDF 原檔｜文字版」收在這一行右側
                （FullTextView 用 portal 畫進來）——她嫌那兩排佔地方，要把高度還給 PDF。
                摘要分頁時這格是空的。pr-4 對齊下面內容區的右內距。
                左欄被拖得很窄、一行放不下時：分頁列用 wrap-reverse，這格**整塊**換到上面一行，
                兩顆分頁仍留在底行貼著底線（不會被擠成三行）。 */}
            <div
              ref={setControlsSlot}
              className="ml-auto flex items-center flex-wrap justify-end gap-1.5 min-w-0 max-w-full pl-2 pr-4 py-1"
            />
          </div>

          <div className="overflow-y-auto pr-4 flex-1">
          {leftTab === 'summary' ? (
            <>
            {/* 工單 12 §3.5：AI 只讀得到前 N 字，超過的部分她有權知道 */}
            {paper.full_text_truncated && (
              <div className="mb-3 text-xs text-muted">
                全文 {paper.full_text_chars.toLocaleString('en-US')} 字，AI 只讀前{' '}
                {(paper.full_text_limit || 250000).toLocaleString('en-US')} 字
              </div>
            )}
            {/* 工單 13 §3.3：哪幾頁抽字抽壞了。沒壞頁時整塊不出現。 */}
            <TextQualityNotice textMeta={paper.text_meta} />
            <SummaryView paper={paper} />

          {/* Retry analyze */}
          {paper.analyze_status === 'error' && (
            <button
              onClick={handleRetryAnalyze}
              className="mt-3 text-sm text-primary hover:underline"
            >
              [重試 AI 通讀]
            </button>
          )}
          {paper.analyze_status === 'pending' && paper.full_text && (
            <button
              onClick={handleRetryAnalyze}
              className="mt-3 text-sm text-primary hover:underline"
            >
              [開始 AI 通讀]
            </button>
          )}

          {/* Notes */}
          <div className="mt-6">
            <h3 className="cr-serif text-sm font-semibold text-text-strong mb-2 flex items-center gap-2">我的筆記</h3>
            <textarea
              className="w-full border border-border bg-surface rounded-lg p-3 text-sm resize-y min-h-[80px] focus:outline-none focus:border-accent"
              placeholder="記錄你的想法..."
              value={paper.notes || ''}
              onChange={async (e) => {
                setPaper({ ...paper, notes: e.target.value });
              }}
              onBlur={async () => {
                await papersApi.update(paperId, { notes: paper.notes });
              }}
            />
          </div>

          {/* Tags */}
          <div className="mt-4">
            <h3 className="cr-serif text-sm font-semibold text-text-strong mb-2 flex items-center gap-2">標籤</h3>
            <div className="flex flex-wrap gap-1 mb-2">
              {(paper.tags || []).map(tag => (
                <TagBadge key={tag.id} tag={tag} onRemove={() => handleRemoveTag(tag.id)} />
              ))}
            </div>
            <div className="relative">
              <input
                className="text-sm border border-border bg-surface rounded-lg px-2 py-1 w-40 focus:outline-none focus:border-accent"
                placeholder="+ 新增 tag"
                value={tagInput}
                onChange={e => handleTagInputChange(e.target.value)}
                onFocus={() => tagInput.trim() && setShowTagSuggest(true)}
                onKeyDown={e => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    if (tagSuggestions.length > 0) {
                      handleAddTag(tagSuggestions[0].id);
                    } else if (tagInput.trim()) {
                      handleCreateAndAddTag();
                    }
                  }
                }}
              />
              {showTagSuggest && (tagSuggestions.length > 0 || tagInput.trim()) && (
                <div className="absolute left-0 top-8 bg-surface border border-border rounded-lg shadow-lg z-20 py-1 text-sm w-40">
                  {tagSuggestions.map(t => (
                    <button key={t.id} className="block w-full text-left px-3 py-1.5 hover:bg-surface-hover"
                      onClick={() => handleAddTag(t.id)}>
                      <span className="w-2 h-2 rounded-full inline-block mr-1" style={{ backgroundColor: t.color }} />
                      {t.name}
                    </button>
                  ))}
                  {tagInput.trim() && !tags.some(t => t.name === tagInput.trim()) && (
                    <button className="block w-full text-left px-3 py-1.5 hover:bg-surface-hover text-accent"
                      onClick={handleCreateAndAddTag}>
                      + 新建「{tagInput.trim()}」
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Tree assignment */}
          <div className="mt-4">
            <h3 className="cr-serif text-sm font-semibold text-text-strong mb-2 flex items-center gap-2">方向</h3>
            <div className="relative">
              <button
                className="text-sm border border-border bg-surface rounded-lg px-2.5 py-1 text-muted hover:bg-surface-hover"
                onClick={() => setTreeMenu(!treeMenu)}
              >
                {paper.tree_node ? paper.tree_node.name : '未掛方向'} ▾
              </button>
              {treeMenu && (
                <div className="absolute left-0 top-8 bg-surface border border-border rounded-lg shadow-lg z-20 py-1 text-sm max-h-48 overflow-y-auto">
                  <button className="block w-full text-left px-3 py-1.5 hover:bg-surface-hover"
                    onClick={() => handleMoveToTree(null)}>未掛方向</button>
                  {flattenTree(tree).map(n => (
                    <button key={n.id} className="block w-full text-left px-3 py-1.5 hover:bg-surface-hover"
                      style={{ paddingLeft: `${12 + n.depth * 16}px` }}
                      onClick={() => handleMoveToTree(n.id)}>
                      {n.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Meta info */}
          <div className="mt-4 pt-3 border-t border-border-soft text-xs text-muted">
            {paper.authors && <span>{paper.authors}</span>}
            {paper.year && <span className="cr-mono"> · {paper.year}</span>}
            {paper.doi && <span className="cr-mono"> · DOI: {paper.doi}</span>}
          </div>

          {/* Related Insights */}
          <div className="mt-4 pt-3 border-t border-border-soft">
            <div className="flex items-center justify-between mb-2">
              <h3 className="cr-serif text-sm font-semibold text-text-strong">相關洞察</h3>
              <button
                className="text-xs text-accent hover:underline"
                onClick={() => setShowInsightForm(true)}
              >
                + 從此論文新建
              </button>
            </div>
            {relatedInsights.length > 0 ? (
              <div className="space-y-2">
                {relatedInsights.slice(0, 3).map(ins => (
                  <InsightCard
                    key={ins.id}
                    insight={ins}
                    compact
                    onClick={(insight) => setPopoverId(insight.id)}
                  />
                ))}
              </div>
            ) : (
              <p className="text-xs text-faint">尚無相關洞察，讀完後跟 AI 討論，洞察會自然沉澱。</p>
            )}
          </div>
            </>
          ) : (
            <FullTextView
              paper={paper}
              attachments={attachments}
              onAttachmentsChange={setAttachments}
              controlsSlot={controlsSlot}
            />
          )}
          </div>
        </div>

        {/* Split handle — 閱讀模式下不渲染 */}
        {!readingMode && (
          <div
            className="cr-split-handle group relative w-1.5 bg-border-soft hover:bg-accent-soft cursor-col-resize shrink-0 rounded-full my-4 transition-colors"
            title="拖曳調整左右寬度（會記住位置）· 雙擊還原"
            onMouseDown={handleMouseDown}
          >
            {/* 中間一小段深一點的握把：原本整條跟背景幾乎同色，她根本不知道這裡能拖 */}
            <span className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-1 h-10 rounded-full bg-faint opacity-40 group-hover:opacity-100 group-hover:bg-accent transition" />
          </div>
        )}

        {/* Right: Chat —— 閱讀模式下同一個 div 變成浮動抽屜。
            只換 className/style，ChatPanel 永遠停在同一個位置，不會被 unmount：
            串流中的回覆不能因為開關抽屜而中斷（工單 06 §3.1/§5）。
            收起也是 CSS（translateX + visibility），不是條件渲染。 */}
        <div
          className={readingMode
            ? `cr-chat-drawer${drawerOpen ? ' cr-chat-drawer--open' : ''}`
            : 'cr-detail-pane overflow-y-auto pl-4 flex flex-col min-h-0'}
          style={readingMode ? { width: `${drawerWidth}px` } : { width: `${100 - split}%` }}
        >
          {readingMode && (
            <>
              <div
                className="cr-chat-drawer-grip"
                onMouseDown={handleDrawerDragStart}
                title="拖動調整寬度"
              />
              <button
                className="cr-chat-drawer-close"
                onClick={() => setDrawerOpen(false)}
                title="收起討論（Esc）"
              >
                ✕
              </button>
            </>
          )}
          <ChatPanel
            paperId={paperId}
            paper={paper}
            onMessagesUpdated={handleMessagesUpdated}
            onSaveInsight={(msg) => {
              setInsightSeed({ source_paper_id: paperId, source_message_id: msg?.id || '' });
              setShowInsightForm(true);
            }}
          />
        </div>
      </div>

      {/* 閱讀模式：右下角浮動按鈕。抽屜開著時往左讓開，所以永遠點得到 */}
      {readingMode && (
        <button
          className={`cr-chat-fab${drawerOpen ? ' cr-chat-fab--open' : ''}`}
          style={{ right: drawerOpen ? drawerWidth + 20 : 20 }}
          onClick={toggleDrawer}
          title={drawerOpen ? '收起討論（Esc）' : '打開討論'}
        >
          <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
          {chatUnread && !drawerOpen && <span className="cr-chat-fab-dot" />}
        </button>
      )}

      {/* Drag overlay — captures mouse events so iframe doesn't steal mouseup */}
      {(isDragging || drawerDragging) && (
        <div className="fixed inset-0 z-40 cursor-col-resize" style={{ userSelect: 'none' }} />
      )}

      {/* Insight form modal */}
      {showInsightForm && (
        <InsightForm
          insight={insightSeed}
          papers={papers.length > 0 ? papers : [paper]}
          onSave={async (data) => {
            await insightsApi.create(data);
            setShowInsightForm(false);
            insightsApi.related(paperId).then(setRelatedInsights).catch(() => {});
          }}
          onCancel={() => setShowInsightForm(false)}
        />
      )}

      {/* 洞察浮現卡（工單 18 §2 A2）。這裡的「去對話」多半就是本頁，直接發跳訊號。 */}
      {popoverId && (
        <InsightPopover
          insightId={popoverId}
          onClose={() => setPopoverId(null)}
          onGoChat={(targetPaperId, messageId) => {
            requestMessageJump(messageId);
            setPopoverId(null);
            // 相關洞察可能出自別篇——那就得先換頁（訊號已經發了，ChatPanel 掛好就消化）
            if (targetPaperId && targetPaperId !== paperId) onNavigate?.('detail', targetPaperId);
          }}
          onGoPaper={(targetPaperId) => {
            setPopoverId(null);
            if (targetPaperId && targetPaperId !== paperId) onNavigate?.('detail', targetPaperId);
          }}
        />
      )}
    </div>
  );
}

/**
 * 抽字品質提示（工單 13 §3.3）：一行人話，點開看每頁的數字。
 * 沒有壞頁、或這篇還沒算過 text_meta 時整塊不渲染——沒問題的時候不要製造焦慮。
 */
function TextQualityNotice({ textMeta }) {
  const quality = describeTextQuality(textMeta);
  if (!quality) return null;

  return (
    <details className="mb-3 text-xs text-muted">
      <summary className="cursor-pointer select-none hover:text-text-strong">
        {quality.line}（AI 讀不到這些頁）
      </summary>
      <div className="mt-2 pl-3 border-l border-border-soft space-y-1">
        {quality.badPages.map(page => (
          <div key={page.n} className="cr-mono text-[11px] text-faint">
            第 {page.n} 頁 · {renderPageReasons(page.reasons)} · {page.chars} 字 / {page.lines} 行
          </div>
        ))}
        <div className="text-[11px] text-faint pt-1">共 {quality.pageCount} 頁</div>
      </div>
    </details>
  );
}

function flattenTree(nodes, depth = 0) {
  const result = [];
  for (const n of nodes) {
    result.push({ id: n.id, name: n.name, depth });
    if (n.children) {
      result.push(...flattenTree(n.children, depth + 1));
    }
  }
  return result;
}
