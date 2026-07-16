import React, { useEffect, useState, useCallback } from 'react';
import { papersApi, tagsApi, treeApi, insightsApi } from '../api';
import { useStore } from '../store';
import SummaryView from '../components/SummaryView';
import FullTextView from '../components/FullTextView';
import ChatPanel from '../components/ChatPanel';
import TagBadge from '../components/TagBadge';
import InsightCard from '../components/InsightCard';
import InsightForm from '../components/InsightForm';

export default function PaperDetail({ paperId, onBack }) {
  const [paper, setPaper] = useState(null);
  const [loading, setLoading] = useState(true);
  const [split, setSplit] = useState(50);
  const [leftTab, setLeftTab] = useState('summary'); // 'summary' | 'fulltext'
  const [statusMenu, setStatusMenu] = useState(false);
  const [tagInput, setTagInput] = useState('');
  const [tagSuggestions, setTagSuggestions] = useState([]);
  const [showTagSuggest, setShowTagSuggest] = useState(false);
  const [treeMenu, setTreeMenu] = useState(false);
  const [relatedInsights, setRelatedInsights] = useState([]);
  const [showInsightForm, setShowInsightForm] = useState(false);
  const { tags, tree, papers, setTags } = useStore();

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
  const handleMouseDown = () => { setIsDragging(true); };
  useEffect(() => {
    if (!isDragging) return;
    const onMove = (e) => {
      const pct = (e.clientX / window.innerWidth) * 100;
      setSplit(Math.min(70, Math.max(30, pct)));
    };
    const onUp = () => { setIsDragging(false); };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [isDragging]);

  const statusLabels = { unread: '待讀', reading: '閱讀中', done: '已讀' };

  if (loading) {
    return <div className="flex items-center justify-center h-64 text-faint">載入中...</div>;
  }
  if (!paper) {
    return <div className="flex items-center justify-center h-64 text-faint">論文不存在</div>;
  }

  return (
    <div className="flex flex-col h-full">
      {/* Top bar */}
      <div className="flex items-center justify-between mb-4 shrink-0 gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <button onClick={onBack} className="flex items-center gap-1.5 text-muted hover:text-text-strong text-[13px] shrink-0 transition-colors">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="m15 18-6-6 6-6" /></svg>
            返回列表
          </button>
          <div className="w-px h-5 bg-border shrink-0" />
          <h2 className="cr-serif font-semibold text-[15.5px] text-text-strong truncate">{paper.title || paper.pdf_filename || '未命名'}</h2>

          {/* Status dropdown */}
          <div className="relative shrink-0">
            <button
              className="text-[11.5px] border border-border-soft bg-surface-alt rounded-full pl-2.5 pr-2 py-1 text-muted hover:bg-surface-hover flex items-center gap-1"
              onClick={() => setStatusMenu(!statusMenu)}
            >
              {statusLabels[paper.status]} ▾
            </button>
            {statusMenu && (
              <div className="absolute left-0 top-8 bg-surface border border-border rounded-lg shadow-lg z-20 py-1 text-sm">
                {Object.entries(statusLabels).map(([k, v]) => (
                  <button key={k} className="block w-full text-left px-3 py-1.5 hover:bg-surface-hover"
                    onClick={() => handleStatusChange(k)}>{v}</button>
                ))}
              </div>
            )}
          </div>
        </div>

        <button onClick={handleDelete} className="text-faint hover:text-danger text-sm shrink-0 p-1 rounded hover:bg-surface-hover transition-colors" title="刪除">
          ✕
        </button>
      </div>

      {/* Split content */}
      <div className="flex flex-1 overflow-hidden gap-0 min-h-0">
        {/* Left: Summary / Fulltext tabs */}
        <div className="flex flex-col overflow-hidden" style={{ width: `${split}%` }}>
          {/* Tab bar */}
          <div className="flex border-b border-border-soft mb-3 shrink-0">
            <button
              className={`text-[13px] px-3 py-2 border-b-2 -mb-px transition-colors ${leftTab === 'summary' ? 'border-accent text-accent font-medium' : 'border-transparent text-muted hover:text-text-strong'}`}
              onClick={() => setLeftTab('summary')}
            >
              AI 摘要
            </button>
            <button
              className={`text-[13px] px-3 py-2 border-b-2 -mb-px transition-colors ${leftTab === 'fulltext' ? 'border-accent text-accent font-medium' : 'border-transparent text-muted hover:text-text-strong'}`}
              onClick={() => setLeftTab('fulltext')}
            >
              原文
            </button>
          </div>

          <div className="overflow-y-auto pr-4 flex-1">
          {leftTab === 'summary' ? (
            <>
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
            <h3 className="cr-serif text-sm font-semibold text-text-strong mb-2 flex items-center gap-2">分類</h3>
            <div className="relative">
              <button
                className="text-sm border border-border bg-surface rounded-lg px-2.5 py-1 text-muted hover:bg-surface-hover"
                onClick={() => setTreeMenu(!treeMenu)}
              >
                {paper.tree_node ? paper.tree_node.name : '未分類'} ▾
              </button>
              {treeMenu && (
                <div className="absolute left-0 top-8 bg-surface border border-border rounded-lg shadow-lg z-20 py-1 text-sm max-h-48 overflow-y-auto">
                  <button className="block w-full text-left px-3 py-1.5 hover:bg-surface-hover"
                    onClick={() => handleMoveToTree(null)}>未分類</button>
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
                    onClick={() => {}}
                  />
                ))}
              </div>
            ) : (
              <p className="text-xs text-faint">尚無相關洞察，讀完後跟 AI 討論，洞察會自然沉澱。</p>
            )}
          </div>
            </>
          ) : (
            <FullTextView paper={paper} />
          )}
          </div>
        </div>

        {/* Split handle */}
        <div
          className="w-1.5 bg-border-soft hover:bg-accent-soft cursor-col-resize shrink-0 rounded-full my-4 transition-colors"
          onMouseDown={handleMouseDown}
        />

        {/* Right: Chat */}
        <div className="overflow-y-auto pl-4 flex flex-col min-h-0" style={{ width: `${100 - split}%` }}>
          <ChatPanel paperId={paperId} paper={paper} onSaveInsight={() => setShowInsightForm(true)} />
        </div>
      </div>

      {/* Drag overlay — captures mouse events so iframe doesn't steal mouseup */}
      {isDragging && (
        <div className="fixed inset-0 z-40 cursor-col-resize" style={{ userSelect: 'none' }} />
      )}

      {/* Insight form modal */}
      {showInsightForm && (
        <InsightForm
          insight={{ source_paper_id: paperId }}
          papers={papers.length > 0 ? papers : [paper]}
          onSave={async (data) => {
            await insightsApi.create(data);
            setShowInsightForm(false);
            insightsApi.related(paperId).then(setRelatedInsights).catch(() => {});
          }}
          onCancel={() => setShowInsightForm(false)}
        />
      )}
    </div>
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
