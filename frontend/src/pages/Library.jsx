import React, { useEffect, useState } from 'react';
import { useStore } from '../store';
import { papersApi } from '../api';
import PaperCard from '../components/PaperCard';

export default function Library({ onNavigate, onRefresh }) {
  const {
    papers, selectedTreeNode, selectedTag,
    searchQuery, sortBy,
    setSearchQuery, setSortBy, setPapers,
  } = useStore();

  const [loading, setLoading] = useState(false);

  useEffect(() => {
    loadPapers();
  }, [selectedTreeNode, selectedTag, sortBy]);

  useEffect(() => {
    const timer = setTimeout(loadPapers, 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  const loadPapers = async () => {
    setLoading(true);
    try {
      const params = {};
      if (selectedTreeNode) params.tree_node_id = selectedTreeNode;
      if (selectedTag) params.tag = selectedTag;
      if (searchQuery) params.q = searchQuery;
      if (sortBy) params.sort = sortBy;

      const data = await papersApi.list(params);
      setPapers(data);
    } catch (err) {
      console.error('Failed to load papers:', err);
    }
    setLoading(false);
  };

  // Poll for papers that are being analyzed
  useEffect(() => {
    const analyzing = papers.some(p => p.analyze_status === 'analyzing');
    if (!analyzing) return;

    const timer = setInterval(loadPapers, 3000);
    return () => clearInterval(timer);
  }, [papers]);

  return (
    <div>
      {/* Toolbar */}
      <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <h2 className="text-base font-medium text-gray-800">
            {papers.length > 0 ? `${papers.length} 篇論文` : '尚無論文'}
          </h2>
          {loading && (
            <span className="text-xs text-gray-400">載入中...</span>
          )}
        </div>

        <div className="flex items-center gap-2">
          {/* Sort */}
          <select
            className="text-sm border border-gray-300 rounded-lg px-2 py-1 text-gray-600"
            value={sortBy}
            onChange={e => setSortBy(e.target.value)}
          >
            <option value="updated">最近更新</option>
            <option value="created">最近加入</option>
            <option value="title">標題排序</option>
          </select>

          {/* Search */}
          <div className="relative">
            <input
              className="text-sm border border-gray-300 rounded-lg pl-8 pr-3 py-1 w-48 focus:outline-none focus:ring-1 focus:ring-primary"
              placeholder="搜索..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
            />
            <svg className="w-4 h-4 text-gray-400 absolute left-2 top-1/2 -translate-y-1/2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
          </div>
        </div>
      </div>

      {/* Paper list */}
      {papers.length === 0 ? (
        <div className="text-center py-16 text-gray-400">
          <p className="text-lg mb-2">📄</p>
          <p className="text-sm">尚無文獻，拖拽 PDF 上傳開始</p>
        </div>
      ) : (
        <div className="space-y-2">
          {papers.map(paper => (
            <PaperCard
              key={paper.id}
              paper={paper}
              onClick={(id) => onNavigate('detail', id)}
              onRefresh={loadPapers}
            />
          ))}
        </div>
      )}
    </div>
  );
}
