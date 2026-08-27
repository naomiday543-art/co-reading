import { create } from 'zustand';

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
