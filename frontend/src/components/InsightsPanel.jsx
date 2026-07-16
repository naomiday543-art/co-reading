import React, { useEffect, useState } from 'react';
import { useStore } from '../store';
import { insightsApi } from '../api';
import InsightCard from './InsightCard';
import InsightForm from './InsightForm';

const DIMENSIONS = ['全部', '概念', '延伸', '你的研究', '闪回', '共振', '悬题'];

export default function InsightsPanel({ onNavigate }) {
  const { insights, setInsights, selectedInsightDimension, setSelectedInsightDimension, papers } = useStore();
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState(null);
  const [error, setError] = useState('');

  const loadInsights = async () => {
    try {
      const params = {};
      if (selectedInsightDimension) params.dimension = selectedInsightDimension;
      const data = await insightsApi.list(params);
      setInsights(data);
    } catch (err) {
      setError(err.message);
    }
    setLoading(false);
  };

  useEffect(() => { loadInsights(); }, [selectedInsightDimension]);

  const handleSave = async (data) => {
    if (editing) {
      await insightsApi.update(editing.id, data);
    } else {
      await insightsApi.create(data);
    }
    setShowForm(false);
    setEditing(null);
    loadInsights();
  };

  const handleDelete = async (id) => {
    if (!confirm('確定要刪除這條洞察嗎？')) return;
    await insightsApi.delete(id);
    loadInsights();
  };

  const handleEdit = (insight) => {
    setEditing(insight);
    setShowForm(true);
  };

  const handleCloseForm = () => {
    setShowForm(false);
    setEditing(null);
  };

  if (loading) {
    return <div className="flex items-center justify-center h-64 text-faint">載入中...</div>;
  }

  return (
    <div className="flex flex-col h-full max-w-5xl mx-auto w-full">
      {/* Header */}
      <div className="flex items-center justify-between mb-5">
        <h2 className="cr-serif text-2xl font-semibold text-text-strong">所有洞察</h2>
        <button
          className="text-[13px] bg-accent text-accent-fg px-3.5 py-2 rounded-[10px] font-medium hover:bg-accent-hover shadow-sm"
          onClick={() => setShowForm(true)}
        >
          + 新建洞察
        </button>
      </div>

      {/* Dimension filters */}
      <div className="flex gap-1.5 mb-5 flex-wrap">
        {DIMENSIONS.map(d => (
          <button
            key={d}
            className={`text-[11.5px] px-3 py-1 rounded-full border transition-colors ${
              (d === '全部' && !selectedInsightDimension) || d === selectedInsightDimension
                ? 'bg-accent-soft text-accent border-transparent font-medium'
                : 'border-border text-muted hover:bg-surface-hover'
            }`}
            onClick={() => setSelectedInsightDimension(d === '全部' ? null : d)}
          >
            {d}
          </button>
        ))}
      </div>

      {error && (
        <div className="p-3 text-sm text-danger bg-surface-alt border border-border-soft rounded-lg mb-3">{error}</div>
      )}

      {/* Insights grid */}
      {insights.length === 0 ? (
        <div className="text-center py-16 text-faint text-sm">
          <p className="cr-serif text-lg mb-2 text-muted">尚無洞察</p>
          <p>讀論文時，跟 AI 討論中自然產生的理解和連接會自動沉澱到這裡。</p>
          <p>也可以手動點「+ 新建洞察」開始。</p>
        </div>
      ) : (
        <div className="grid gap-3">
          {insights.map(ins => (
            <InsightCard
              key={ins.id}
              insight={ins}
              onClick={(insight) => {
                if (insight.source_paper_id) {
                  onNavigate('detail', insight.source_paper_id);
                }
              }}
              onEdit={handleEdit}
              onDelete={handleDelete}
            />
          ))}
        </div>
      )}

      {/* Form modal */}
      {showForm && (
        <InsightForm
          insight={editing}
          papers={papers}
          onSave={handleSave}
          onCancel={handleCloseForm}
        />
      )}
    </div>
  );
}
