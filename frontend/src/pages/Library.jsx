import React, { useEffect, useState } from 'react';
import { useStore } from '../store';
import { papersApi } from '../api';
import PaperCard from '../components/PaperCard';
import ActivityPanel from '../components/ActivityPanel';

// 首次引導（工單 07 §3.4）：關掉就不再出現。慣例跟 store.js 的偏好一樣，
// 手寫 localStorage 並全部包 try/catch（隱私模式下會拋）。
const DIRECTIONS_HINT_KEY = 'co-reading:directions-hint-dismissed';

function loadHintDismissed() {
  try {
    return localStorage.getItem(DIRECTIONS_HINT_KEY) === '1';
  } catch {
    return false;
  }
}

export default function Library({ onNavigate, onRefresh }) {
  const {
    papers, selectedTreeNode, selectedTag,
    searchQuery, sortBy, tree,
    setSearchQuery, setSortBy, setPapers,
  } = useStore();

  const [loading, setLoading] = useState(false);
  const [hintDismissed, setHintDismissed] = useState(loadHintDismissed);

  // 提示卡只在「沒有方向」或「所有方向都沒寫描述」時出現——寫了就功成身退。
  const directions = tree || [];
  const directionsNeedAttention = directions.length === 0
    || directions.every(d => !(d.description || '').trim());

  const dismissHint = () => {
    try { localStorage.setItem(DIRECTIONS_HINT_KEY, '1'); } catch {}
    setHintDismissed(true);
  };

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

      {/* 研究方向引導卡（工單 07 §3.4）— 活動面板之上，可完全跳過 */}
      {!hintDismissed && directionsNeedAttention && !selectedTag && !selectedTreeNode && !searchQuery && (
        <div className="card p-4 mb-5 flex items-center gap-3 flex-wrap">
          <p className="flex-1 text-[13.5px] text-text min-w-[220px]">
            告訴 AI 你在做哪幾個方向，它才能替你連到自己的題目 →
          </p>
          <button
            className="px-3.5 py-1.5 bg-accent text-accent-fg rounded-[10px] text-[13px] font-medium hover:bg-accent-hover shadow-sm shrink-0"
            onClick={() => onNavigate('settings')}
          >
            去設定研究方向
          </button>
          <button
            className="text-faint hover:text-muted px-1.5 shrink-0"
            onClick={dismissHint}
            title="關閉，不再顯示"
          >
            ✕
          </button>
        </div>
      )}

      {/* Activity panel — 只在未篩選狀態顯示（篩選時是工作模式，不是歡迎頁） */}
      {!selectedTag && !selectedTreeNode && !searchQuery && <ActivityPanel />}

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
