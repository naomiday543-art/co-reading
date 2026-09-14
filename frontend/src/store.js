import { create } from 'zustand';

// ── 閱讀模式 / 聊天字級的本機偏好（工單 06）────────────────────────────
// 慣例跟 App.jsx 的 theme 一樣：手寫 localStorage，全部包 try/catch
// （隱私模式下 localStorage 會拋）。
const READING_MODE_KEY = 'co-reading:reading-mode';
const CHAT_FONT_KEY = 'co-reading:chat-font';

/** 「使用進階設定」的本機記憶（工單 17 §2.2）。後端的 `advanced_enabled` 才是跨機器的事實源。 */
export const ADVANCED_ENABLED_KEY = 'co-reading-settings.advanced.enabled';

export const CHAT_FONT_SIZES = ['sm', 'md', 'lg'];
export const CHAT_FONT_PX = { sm: '14px', md: '16px', lg: '18px' };
export const CHAT_FONT_LABELS = { sm: '小', md: '中', lg: '大' };

export function nextChatFontSize(size) {
  const idx = CHAT_FONT_SIZES.indexOf(size);
  return CHAT_FONT_SIZES[(idx + 1) % CHAT_FONT_SIZES.length];
}

/** 等待提示要等這麼久才開始報秒數／字數——免得一送出就閃一個「已想 0 秒 · 0 字」。 */
export const THINKING_LABEL_DELAY_MS = 2_000;

/**
 * 等待中那一行字（工單 12 §3.3）。
 *
 * 首字前實測 10–17 秒（報告 11 §5），舊版是三個沒有文字的點，看起來跟當掉一樣。
 * 秒數由前端自己數（`startedAt`），字數來自後端的 `thinking` 事件——
 * **只有字數，沒有思考內容**（§4 紅線）。字數是 0（例如非推理模型）時不硬報一個 0。
 *
 * @param {number|null} startedAt 這一輪開始的時間戳
 * @param {number} chars 累計 reasoning 字數
 * @param {number} [now]
 */
export function thinkingLabel(startedAt, chars, now = Date.now()) {
  if (!startedAt) return '正在思考…';
  const elapsedMs = now - startedAt;
  if (elapsedMs < THINKING_LABEL_DELAY_MS) return '正在思考…';
  const seconds = Math.floor(elapsedMs / 1000);
  const charPart = chars > 0 ? ` · ${chars} 字` : '';
  return `正在思考…（已想 ${seconds} 秒${charPart}）`;
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

/** 開機時先信本機記憶；`Settings` 掛載後會用後端的 `advanced_enabled` 覆蓋掉。 */
function loadAdvancedEnabled() {
  try {
    return localStorage.getItem(ADVANCED_ENABLED_KEY) === '1';
  } catch {
    return false;
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

  // ── 選一段問它（工單 14 §3.3）──────────────────────────────────────
  // `pendingQuote`：她在閱讀模式按了「問這段」、還沒送出的那段引用（`{text,start,end}`）。
  // `quoteJump`：她點了氣泡上的引用塊，要跳回原文那個位置。
  // **兩個都不持久化**——這是一次動作，不是偏好；重整就該乾淨。
  pendingQuote: null,
  setPendingQuote: (quote) => set({ pendingQuote: quote || null }),
  clearPendingQuote: () => set({ pendingQuote: null }),
  quoteJump: null,
  requestQuoteJump: (quote) => set({
    quoteJump: quote ? { start: quote.start, end: quote.end, ts: Date.now() } : null,
  }),
  clearQuoteJump: () => set({ quoteJump: null }),

  // ── 跳到某一則訊息（工單 18 §2 A2）────────────────────────────────
  // 跟 `quoteJump` 同一套（工單 14）：store 放一顆一次性訊號 →ChatPanel 的 effect
  // `scrollIntoView` ＋ 閃一下 → 清掉。差別只在目標是「訊息 id」不是「原文偏移」。
  // 從洞察頁按「去對話」時**先發訊號再換頁**，ChatPanel 掛載後訊息載好才消化得到，
  // 所以它要等 `messages` 非空才判定找不找得到（見 ChatPanel 的 effect）。
  messageJump: null,
  requestMessageJump: (messageId) => set({
    messageJump: messageId ? { id: messageId, ts: Date.now() } : null,
  }),
  clearMessageJump: () => set({ messageJump: null }),

  searchQuery: '',
  setSearchQuery: (q) => set({ searchQuery: q }),
  sortBy: 'updated',
  setSortBy: (s) => set({ sortBy: s }),

  // Settings
  provider: 'anthropic',
  setProvider: (p) => set({ provider: p }),
  // `advancedOpen` 只是摺疊區的版面狀態（不持久化）；
  // 「要不要用進階值」是 `advancedEnabled`，持久化到 localStorage ＋ 後端 settings。
  advancedOpen: false,
  toggleAdvanced: () => set(s => ({ advancedOpen: !s.advancedOpen })),
  advancedEnabled: loadAdvancedEnabled(),
  setAdvancedEnabled: (v) => {
    const next = !!v;
    try { localStorage.setItem(ADVANCED_ENABLED_KEY, next ? '1' : '0'); } catch {}
    set({ advancedEnabled: next });
  },

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

// ── 進階設定的開關（工單 17 §2.2）──────────────────────────────────
// 舊版拿**摺疊狀態**（`advancedOpen`）當「要不要寫進階值」的判斷：摺疊區關著按儲存，
// 通讀線的 base_url／model／format／vision 全部被 preset 預設蓋回去。
// 9/14 13:40 她把視覺模式改成 off、再按上面那顆儲存，就這樣被寫回 preset 的 'on'。
// 開關與摺疊從此分家：`advancedEnabled` 是持久化的意圖，`advancedOpen` 只是版面。

function truthy(raw) {
  return !['0', 'false', 'off', 'no'].includes(`${raw}`.trim().toLowerCase());
}

/**
 * 這台機器到底算不算「開著進階設定」。
 *
 * 後端有 `advanced_enabled` 就聽後端的（跨瀏覽器／跨機器的唯一事實源）。
 * 沒有這個鍵＝還沒升級過的舊資料：**通讀線與討論線只要有一項真的不一樣，就推定為開**——
 * 否則她既有的分開設定會在第一次儲存時被 preset 靜靜蓋掉（就是這次要修的那個病）。
 * 只有兩邊都填了而且不同才算「不一樣」：analyze_* 留空是「沒有分開設定」，不是差異。
 *
 * @param {object} cfg `GET /api/settings` 的回應
 * @returns {boolean}
 */
export function inferAdvancedEnabled(cfg = {}) {
  const raw = cfg.advanced_enabled;
  if (raw !== undefined && raw !== null && `${raw}`.trim() !== '') return truthy(raw);

  const differs = (a, b) => !!a && !!b && a !== b;
  return differs(cfg.analyze_base_url, cfg.ai_base_url)
    || differs(cfg.analyze_model, cfg.ai_model)
    || differs(cfg.analyze_format, cfg.ai_format)
    || differs(cfg.analyze_api_key, cfg.ai_api_key);
}

/**
 * 組 `PUT /api/settings` 的 body。純函式，好單測（工單 17 §4.6）。
 *
 * 關鍵是它**只看 `advancedEnabled`，不看摺疊狀態**：她在進階區改完、把區塊收起來
 * 再按儲存，寫出去的還是她改的值。關閉進階才回 preset 預設——而且那是她自己按的開關，
 * UI 上有寫「關閉後通讀線會回到 preset 預設」。
 *
 * @param {{provider: string, apiKey: string, advancedEnabled: boolean, advanced: object}} input
 */
export function buildSettingsPayload({ provider, apiKey, advancedEnabled, advanced } = {}) {
  const defaults = getProviderDefaults(provider);
  const a = advanced || {};
  const on = !!advancedEnabled;

  const baseUrl = on ? a.chatBaseUrl : defaults.base_url;
  const format = on ? a.chatFormat : defaults.format;
  const model = on ? a.chatModel : defaults.model;

  return {
    ai_api_key: apiKey || '',
    ai_base_url: baseUrl || '',
    ai_model: model || '',
    ai_format: format || 'openai',
    analyze_api_key: on && a.analyzeApiKey ? a.analyzeApiKey : (apiKey || ''),
    analyze_base_url: on && a.analyzeBaseUrl ? a.analyzeBaseUrl : (baseUrl || ''),
    analyze_model: on && a.analyzeModel ? a.analyzeModel : (defaults.analyze_model || model || ''),
    analyze_format: on ? (a.analyzeFormat || format) : format,
    analyze_vision_model: on && a.analyzeVisionModel ? a.analyzeVisionModel : (defaults.vision_model || ''),
    // 開著進階時就是寫她選的那個值——不再有 `defaults.vision_mode` 的回填（§2.2）。
    analyze_vision_mode: on ? (a.analyzeVisionMode || 'auto') : (defaults.vision_mode || 'auto'),
    advanced_enabled: on ? 'true' : 'false',
  };
}

/** 密鑰欄位一律不進主控台／日誌（§3 紅線）。名字裡有 key／token／secret／password 的都算。 */
export function publicSettingsSummary(cfg = {}) {
  const out = {};
  for (const [key, value] of Object.entries(cfg)) {
    if (/key|token|secret|password/i.test(key)) continue;
    out[key] = value;
  }
  return out;
}
