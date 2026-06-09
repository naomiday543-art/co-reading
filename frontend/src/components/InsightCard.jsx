import React from 'react';

const DIMENSIONS = {
  '概念': { color: '#6366f1', bg: 'bg-indigo-50', text: 'text-indigo-700' },
  '延伸': { color: '#10b981', bg: 'bg-emerald-50', text: 'text-emerald-700' },
  '你的研究': { color: '#f59e0b', bg: 'bg-amber-50', text: 'text-amber-700' },
  '闪回': { color: '#ef4444', bg: 'bg-red-50', text: 'text-red-700' },
  '共振': { color: '#8b5cf6', bg: 'bg-violet-50', text: 'text-violet-700' },
  '悬题': { color: '#06b6d4', bg: 'bg-cyan-50', text: 'text-cyan-700' },
};

export default function InsightCard({ insight, onClick, onEdit, onDelete, compact }) {
  const dim = DIMENSIONS[insight.dimension] || DIMENSIONS['延伸'];

  if (compact) {
    return (
      <div
        className="border border-gray-200 rounded-lg p-2.5 hover:shadow-sm cursor-pointer transition-shadow"
        onClick={() => onClick?.(insight)}
      >
        <div className="flex items-center gap-2 mb-1">
          <span className={`text-xs px-1.5 py-0.5 rounded-full ${dim.bg} ${dim.text}`}>
            {insight.dimension}
          </span>
          <span className="text-sm font-medium text-gray-800 truncate">{insight.title}</span>
        </div>
        <p className="text-xs text-gray-500 line-clamp-2">{insight.content}</p>
      </div>
    );
  }

  return (
    <div className="border border-gray-200 rounded-lg p-3 hover:shadow-sm transition-shadow">
      <div className="flex items-center justify-between mb-1.5">
        <div className="flex items-center gap-2 min-w-0">
          <span className={`text-xs px-1.5 py-0.5 rounded-full shrink-0 ${dim.bg} ${dim.text}`}>
            {insight.dimension}
          </span>
          <h4
            className="text-sm font-medium text-gray-800 truncate cursor-pointer hover:text-primary"
            onClick={() => onClick?.(insight)}
          >
            {insight.title}
          </h4>
        </div>
        <div className="flex gap-1 shrink-0 ml-2">
          {onEdit && (
            <button
              className="text-xs text-gray-400 hover:text-primary"
              onClick={(e) => { e.stopPropagation(); onEdit(insight); }}
              title="編輯"
            >
              ✏️
            </button>
          )}
          {onDelete && (
            <button
              className="text-xs text-gray-400 hover:text-red-500"
              onClick={(e) => { e.stopPropagation(); onDelete(insight.id); }}
              title="刪除"
            >
              🗑️
            </button>
          )}
        </div>
      </div>
      <p className="text-sm text-gray-600 line-clamp-2 mb-2">{insight.content}</p>
      <div className="flex items-center justify-between text-xs text-gray-400">
        {insight.source_paper_title ? (
          <span className="truncate max-w-[70%]">📄 {insight.source_paper_title}</span>
        ) : (
          <span />
        )}
        <span>{fmtDate(insight.updated_at || insight.created_at)}</span>
      </div>
    </div>
  );
}

function fmtDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
