import React from 'react';
import TagBadge from './TagBadge';

// Status pill styling — maps to the semantic tokens from the design language.
const statusStyles = {
  unread: { label: '待讀', dot: 'var(--faint)', cls: 'bg-surface-alt border border-border-soft text-muted' },
  reading: { label: '閱讀中', dot: 'var(--hyp)', cls: 'bg-hyp-soft text-hyp' },
  done: { label: '已讀', dot: 'var(--fact)', cls: 'bg-fact-soft text-fact' },
};

// 對比勾選（工單 09 §3.3）只在呼叫端傳了 onToggleSelect 時才出現——沒傳的用法
// （未來其他頁面）長相與行為完全照舊。整卡點擊開論文的行為零回歸：checkbox 自己
// stopPropagation，不讓事件冒泡到外層的 onClick。
export default function PaperCard({ paper, onClick, onRefresh, selected = false, onToggleSelect }) {
  const st = statusStyles[paper.status] || statusStyles.unread;
  const analyzing = paper.analyze_status === 'analyzing';
  // 沒通讀完就沒有五段摘要，對比無料可吃。
  const comparable = paper.analyze_status === 'done';
  const hasSummary = paper.summary_bg || paper.summary_conclusions;
  const snippet = paper.summary_conclusions
    ? paper.summary_conclusions.slice(0, 120) + '…'
    : paper.summary_bg
      ? paper.summary_bg.slice(0, 120) + '…'
      : null;

  return (
    <div className="card p-5 cursor-pointer" onClick={() => onClick(paper.id)}>
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          {/* Title */}
          <h3 className="cr-serif font-semibold text-[19px] leading-snug text-text-strong">
            {paper.title || paper.pdf_filename || '未命名論文'}
          </h3>

          {/* Authors / Year / DOI */}
          <p className="text-[12.5px] text-muted mt-2">
            {[paper.authors, paper.doi ? `DOI: ${paper.doi}` : null].filter(Boolean).join(' · ')}
            {paper.year && <span className="cr-mono text-[11.5px]"> · {paper.year}</span>}
          </p>
        </div>

        <div className="shrink-0 flex items-center gap-2.5">
          {/* Status pill */}
          <div className={`flex items-center gap-1.5 pl-2 pr-2.5 py-1 rounded-full text-[11.5px] font-medium whitespace-nowrap ${st.cls}`}>
            <span
              className={`w-1.5 h-1.5 rounded-full inline-block ${analyzing || paper.status === 'reading' ? 'cr-pulse-dot' : ''}`}
              style={{ backgroundColor: st.dot }}
            />
            {st.label}
          </div>

          {/* 對比勾選（工單 09 §3.3）*/}
          {onToggleSelect && (
            <input
              type="checkbox"
              className="w-4 h-4 accent-[var(--accent)] cursor-pointer disabled:cursor-not-allowed disabled:opacity-40"
              checked={selected}
              disabled={!comparable}
              title={comparable ? '選入對比' : '先通讀才能對比'}
              aria-label={comparable ? `選入對比：${paper.title || paper.pdf_filename || '未命名論文'}` : '先通讀才能對比'}
              data-testid="compare-checkbox"
              onClick={e => e.stopPropagation()}
              onChange={e => { e.stopPropagation(); onToggleSelect(paper.id); }}
            />
          )}
        </div>
      </div>

      {/* Summary snippet */}
      {snippet && (
        <div className="mt-3.5 text-[13.5px] leading-relaxed text-text line-clamp-2">
          <span className="cr-mono text-[11px] tracking-wide text-faint pr-2">AI 摘要</span>
          {snippet}
        </div>
      )}

      {/* Analyze status hints */}
      {analyzing && (
        <div className="mt-3 text-[12px] text-hyp cr-mono">正在通讀中…</div>
      )}
      {paper.analyze_status === 'error' && (
        <div className="mt-3 text-[12px] text-danger" title={paper.analyze_error}>通讀失敗</div>
      )}

      {/* Footer: tags + meta */}
      {(paper.tags && paper.tags.length > 0) && (
        <div className="mt-3.5 flex flex-wrap gap-1.5">
          {paper.tags.map(tag => (
            <TagBadge key={tag.id} tag={tag} small />
          ))}
        </div>
      )}
    </div>
  );
}
