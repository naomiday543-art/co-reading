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
