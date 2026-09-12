import { create } from 'zustand';

// ── 閱讀模式 / 聊天字級的本機偏好（工單 06）────────────────────────────
// 慣例跟 App.jsx 的 theme 一樣：手寫 localStorage，全部包 try/catch
// （隱私模式下 localStorage 會拋）。
const READING_MODE_KEY = 'co-reading:reading-mode';
const CHAT_FONT_KEY = 'co-reading:chat-font';

export const CHAT_FONT_SIZES = ['sm', 'md', 'lg'];
export const CHAT_FONT_PX = { sm: '14px', md: '16px', lg: '18px' };
export const CHAT_FONT_LABELS = { sm: '小', md: '中', lg: '大' };

export function nextChatFontSize(size) {
  const idx = CHAT_FONT_SIZES.indexOf(size);
  return CHAT_FONT_SIZES[(idx + 1) % CHAT_FONT_SIZES.length];
}

// ── 多篇對比（工單 09 §3.3）────────────────────────────────────────
// 上下限與後端 src/compare.js 的 MIN_PAPERS / MAX_PAPERS 是同一組數字；
// 後端才是閘門（400），前端只是先擋住不讓她白跑一趟。
export const COMPARE_MIN = 2;
export const COMPARE_MAX = 4;

/** 同一組論文的穩定 key：排序後 join，所以勾選順序不同但同一組＝同一個 key。 */
export function compareKey(ids) {
  return [...ids].sort().join(',');
}

// ── 對比結果存成「共振」洞察（工單 09 §3.2）────────────────────────
// 六維度裡的「共振」本來就是「兩篇互相呼應或打架」的位置，一直沒有入口——對比
// 結果正好是它的料。走既有的 POST /api/insights，不繞過它的驗證（§5 紅線）。
const COMPARE_TITLE_MAX = 30;

const ANALYSIS_PREFIX = [
  ['same', '相同'],
  ['differ', '相異'],
  ['conflict', '打架'],
];

function shortTitle(title) {
  const s = (title || '').trim() || '未命名論文';
  return s.length > COMPARE_TITLE_MAX ? `${s.slice(0, COMPARE_TITLE_MAX)}…` : s;
}

/**
 * 把 /api/compare 的結果組成 POST /api/insights 的 body。純函式，好單測。
 * @param {{papers: object[], table: object, analysis: object}} result
 * @returns {{dimension: string, title: string, content: string, source_paper_id: string, source_context: string, tags: string[]}}
 */
export function buildCompareInsight(result) {
  const papers = result?.papers || [];
  const analysis = result?.analysis || {};
  const table = result?.table || {};

  const title = `對比：${papers.map(p => `《${shortTitle(p.title)}》`).join(' × ')}`;

  const lines = [];
  for (const [key, prefix] of ANALYSIS_PREFIX) {
    for (const item of analysis[key] || []) lines.push(`${prefix}：${item}`);
  }
  if (analysis.for_her) lines.push(analysis.for_her);

  // source_context：對比表壓成純文字——每維度一段、每篇一行。
  const contextParts = [];
  for (const [dimension, cells] of Object.entries(table)) {
    const block = [`【${dimension}】`];
    for (const paper of papers) {
      block.push(`${shortTitle(paper.title)}：${cells?.[paper.id] || '摘要未提及'}`);
    }
    contextParts.push(block.join('\n'));
  }

  const context = contextParts.join('\n\n');

  return {
    dimension: '共振',
    title,
    // 三段分析全空（模型什麼都沒比出來）時退回對比表本身：POST /api/insights 的
    // 「內容不能為空」是硬驗證，空 content 會讓存洞察直接 400。
    content: lines.length > 0 ? lines.join('\n') : context,
    source_paper_id: papers[0]?.id || null,
    source_context: context,
    tags: ['compare', ...papers.map(p => `paper:${p.id}`)],
  };
}

function loadReadingMode() {
  try {
    return localStorage.getItem(READING_MODE_KEY) === '1';
  } catch {
    return false;
  }
}

function loadChatFontSize() {
  try {
    const saved = localStorage.getItem(CHAT_FONT_KEY);
    return CHAT_FONT_SIZES.includes(saved) ? saved : 'sm';
  } catch {
    return 'sm';
  }
}

export const useStore = create((set, get) => ({
  // Papers
  papers: [],
  currentPaper: null,
  setPapers: (papers) => set({ papers }),
  setCurrentPaper: (paper) => set({ currentPaper: paper }),

  // Tree
  tree: [],
  setTree: (tree) => set({ tree }),
  selectedTreeNode: null,
  setSelectedTreeNode: (id) => set({ selectedTreeNode: id }),

  // Tags
  tags: [],
  setTags: (tags) => set({ tags }),
  selectedTag: null,
  setSelectedTag: (id) => set({ selectedTag: id }),

  // UI
  sidebarOpen: true,
  toggleSidebar: () => set(s => ({ sidebarOpen: !s.sidebarOpen })),

  // 閱讀模式：全域一個，不按論文；刷新保持（工單 06 §3.1）
  readingMode: loadReadingMode(),
  setReadingMode: (v) => {
    const next = !!v;
    try { localStorage.setItem(READING_MODE_KEY, next ? '1' : '0'); } catch {}
    set({ readingMode: next });
  },

  // 聊天字級：'sm' | 'md' | 'lg' = 14 / 16 / 18px（工單 06 §3.2）
  chatFontSize: loadChatFontSize(),
  setChatFontSize: (size) => {
    const next = CHAT_FONT_SIZES.includes(size) ? size : 'sm';
    try { localStorage.setItem(CHAT_FONT_KEY, next); } catch {}
    set({ chatFontSize: next });
  },

  searchQuery: '',
  setSearchQuery: (q) => set({ searchQuery: q }),
  sortBy: 'updated',
  setSortBy: (s) => set({ sortBy: s }),

  // Settings
  provider: 'anthropic',
  setProvider: (p) => set({ provider: p }),
  advancedOpen: false,
  toggleAdvanced: () => set(s => ({ advancedOpen: !s.advancedOpen })),

  // Insights
  insights: [],
  setInsights: (insights) => set({ insights }),
  selectedInsightDimension: null,
  setSelectedInsightDimension: (d) => set({ selectedInsightDimension: d }),

  // 多篇對比的勾選（工單 09 §3.3）。
  // **不持久化**：重整就清掉——選一組論文是一次動作，不是一個偏好。
  compareSelection: [],
  toggleCompare: (id) => set(s => {
    if (s.compareSelection.includes(id)) {
      return { compareSelection: s.compareSelection.filter(x => x !== id) };
    }
    // 滿了就不加（上限由 prompt 的 40k 字天花板決定，見 src/compare.js）。
    if (s.compareSelection.length >= COMPARE_MAX) return {};
    return { compareSelection: [...s.compareSelection, id] };
  }),
  clearCompare: () => set({ compareSelection: [] }),

  // 對比結果：以「ids 排序後 join」當 key，返回 Library 再進來同一組不重打（§3.3）。
  compareResult: null,
  setCompareResult: (result) => set({ compareResult: result }),

  // Upload
  uploading: false,
  uploadProgress: [],
  setUploading: (v) => set({ uploading: v }),
  setUploadProgress: (p) => set({ uploadProgress: p }),
}));

const providerDefaults = {
  anthropic: { base_url: 'https://api.anthropic.com/v1', format: 'anthropic', model: 'claude-sonnet-4-6', analyze_model: 'claude-sonnet-4-6', vision_model: 'claude-sonnet-4-6', vision_mode: 'auto' },
  openai: { base_url: 'https://api.openai.com/v1', format: 'openai', model: 'gpt-4o', analyze_model: 'gpt-4o', vision_model: 'gpt-4o', vision_mode: 'auto' },
  deepseek: { base_url: 'https://api.deepseek.com/v1', format: 'openai', model: 'deepseek-chat', analyze_model: 'deepseek-chat', vision_model: '', vision_mode: 'off' },
  opencode_go: { base_url: 'https://opencode.ai/zen/go/v1', format: 'openai', model: 'deepseek-v4-pro', analyze_model: 'deepseek-v4-pro', vision_model: 'deepseek-v4-flash-vision-exp', vision_mode: 'on' },
  custom: { base_url: '', format: 'openai', model: '', analyze_model: '', vision_model: '', vision_mode: 'auto' },
};

export function getProviderDefaults(provider) {
  return providerDefaults[provider] || providerDefaults.custom;
}
