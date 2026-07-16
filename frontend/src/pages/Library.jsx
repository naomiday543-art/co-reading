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
    <div className="max-w-5xl mx-auto">
      {/* Toolbar */}
      <div className="flex items-end justify-between mb-5 gap-3 flex-wrap">
        <div>
          <h2 className="cr-serif text-2xl font-semibold text-text-strong">
            {selectedTag || selectedTreeNode ? '篩選結果' : '全部論文'}
          </h2>
          <div className="mt-1 text-[13.5px] text-muted">
            {papers.length > 0 ? `${papers.length} 篇` : '尚無論文'}
            {loading && <span className="ml-2 text-faint">載入中…</span>}
          </div>
        </div>

        <div className="flex items-center gap-2.5">
          {/* Sort */}
          <select
            className="text-[13px] border border-border rounded-[10px] bg-surface px-3 py-1.5 text-text cursor-pointer"
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
              className="text-[13px] border border-border rounded-[10px] bg-surface pl-8 pr-3 py-1.5 w-56 text-text placeholder:text-faint focus:outline-none focus:border-accent"
              placeholder="搜尋標題、作者、標籤…"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
            />
            <svg className="w-3.5 h-3.5 text-faint absolute left-2.5 top-1/2 -translate-y-1/2" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24">
              <circle cx="11" cy="11" r="7" /><path strokeLinecap="round" d="m20 20-4-4" />
            </svg>
          </div>
        </div>
      </div>

      {/* Paper list */}
      {papers.length === 0 ? (
        <div className="text-center py-16 text-faint">
          <p className="cr-serif text-lg mb-2 text-muted">尚無論文</p>
          <p className="text-sm">拖拽 PDF 到底部上傳區開始</p>
        </div>
      ) : (
        <div className="space-y-3">
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
