import React from 'react';

// Dimension → semantic token. The three core dimensions follow the design spec
// (概念=fact, 延伸=progress, 悬题=hyp); the rest reuse the same token palette.
const DIMENSIONS = {
  '概念': { soft: 'var(--fact-soft)', fg: 'var(--fact)' },
  '延伸': { soft: 'var(--progress-soft)', fg: 'var(--progress)' },
  '悬题': { soft: 'var(--hyp-soft)', fg: 'var(--hyp)' },
  '你的研究': { soft: 'var(--accent-soft)', fg: 'var(--accent)' },
  '闪回': { soft: 'var(--hyp-soft)', fg: 'var(--hyp)' },
  '共振': { soft: 'var(--progress-soft)', fg: 'var(--progress)' },
};

function Pill({ dim }) {
  const d = DIMENSIONS[dim] || DIMENSIONS['延伸'];
  return (
    <span
      className="cr-mono text-[10.5px] font-semibold tracking-wide px-2 py-0.5 rounded-full shrink-0"
      style={{ background: d.soft, color: d.fg }}
    >
      {dim}
    </span>
  );
}

export default function InsightCard({ insight, onClick, onEdit, onDelete, compact }) {
  if (compact) {
    return (
      <div
        className="card p-3 cursor-pointer"
        onClick={() => onClick?.(insight)}
      >
        <div className="flex items-center gap-2 mb-1">
          <Pill dim={insight.dimension} />
          <span className="cr-serif text-sm font-semibold text-text-strong truncate">{insight.title}</span>
        </div>
        <p className="text-xs text-muted line-clamp-2 leading-relaxed">{insight.content}</p>
      </div>
    );
  }

  return (
    <div className="card p-3.5">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2 min-w-0">
          <Pill dim={insight.dimension} />
          <h4
            className="cr-serif text-sm font-semibold text-text-strong truncate cursor-pointer hover:text-accent"
            onClick={() => onClick?.(insight)}
          >
            {insight.title}
          </h4>
        </div>
        <div className="flex gap-1.5 shrink-0 ml-2">
          {onEdit && (
            <button
              className="text-xs text-faint hover:text-accent"
              onClick={(e) => { e.stopPropagation(); onEdit(insight); }}
              title="編輯"
            >
              ✎
            </button>
          )}
          {onDelete && (
            <button
              className="text-xs text-faint hover:text-danger"
              onClick={(e) => { e.stopPropagation(); onDelete(insight.id); }}
              title="刪除"
            >
              ✕
            </button>
          )}
        </div>
      </div>
      <p className="text-[13px] text-text line-clamp-2 mb-2.5 leading-relaxed">{insight.content}</p>
      <div className="flex items-center justify-between text-xs text-faint">
        {insight.source_paper_title ? (
          <span className="truncate max-w-[70%]">{insight.source_paper_title}</span>
        ) : (
          <span />
        )}
        <span className="cr-mono">{fmtDate(insight.updated_at || insight.created_at)}</span>
      </div>
    </div>
  );
}

function fmtDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
