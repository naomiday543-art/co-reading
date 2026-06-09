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
  anthropic: { base_url: 'https://api.anthropic.com/v1', format: 'anthropic', model: 'claude-sonnet-4-6' },
  openai: { base_url: 'https://api.openai.com/v1', format: 'openai', model: 'gpt-4o' },
  deepseek: { base_url: 'https://api.deepseek.com/v1', format: 'openai', model: 'deepseek-chat' },
  custom: { base_url: '', format: 'openai', model: '' },
};

export function getProviderDefaults(provider) {
  return providerDefaults[provider] || providerDefaults.custom;
}
