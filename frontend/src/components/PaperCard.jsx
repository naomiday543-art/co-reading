import React from 'react';
import TagBadge from './TagBadge';

const statusIcons = {
  unread: '📥',
  reading: '📖',
  done: '✅',
};

const statusLabels = {
  unread: '待讀',
  reading: '閱讀中',
  done: '已讀',
};

export default function PaperCard({ paper, onClick, onRefresh }) {
  const statusLabel = statusLabels[paper.status] || '待讀';
  const statusIcon = statusIcons[paper.status] || '📥';
  const hasSummary = paper.summary_bg || paper.summary_conclusions;
  const snippet = paper.summary_conclusions
    ? paper.summary_conclusions.slice(0, 80) + '...'
    : paper.summary_bg
      ? paper.summary_bg.slice(0, 80) + '...'
      : null;

  return (
    <div className="card p-4 cursor-pointer" onClick={() => onClick(paper.id)}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          {/* Title */}
          <h3 className="font-medium text-gray-900 truncate">
            {paper.title || paper.pdf_filename || '未命名論文'}
          </h3>

          {/* Authors / Year / DOI */}
          <p className="text-sm text-gray-500 mt-0.5">
            {[paper.authors, paper.year, paper.doi ? `DOI: ${paper.doi}` : null]
              .filter(Boolean).join('  ')}
          </p>

          {/* Tags */}
          {(paper.tags && paper.tags.length > 0) && (
            <div className="flex flex-wrap gap-1 mt-1.5">
              {paper.tags.map(tag => (
                <TagBadge key={tag.id} tag={tag} small />
              ))}
            </div>
          )}

          {/* Summary snippet */}
          {snippet && (
            <p className="text-sm text-gray-600 mt-1.5 line-clamp-2">
              AI 摘要: {snippet}
            </p>
          )}
        </div>

        {/* Status */}
        <div className="shrink-0 flex flex-col items-end gap-1">
          <span className="text-xs text-gray-500 flex items-center gap-1">
            {statusIcon} {statusLabel}
          </span>

          {/* Analyze status */}
          {paper.analyze_status === 'analyzing' && (
            <span className="text-xs text-primary">AI 通讀中...</span>
          )}
          {paper.analyze_status === 'error' && (
            <span className="text-xs text-red-500" title={paper.analyze_error}>通讀失敗</span>
          )}
          {paper.analyze_status === 'pending' && !hasSummary && (
            <span className="text-xs text-gray-400">[開始 AI 通讀]</span>
          )}
        </div>
      </div>
    </div>
  );
}
