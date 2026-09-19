import React, { useMemo } from 'react';
import { edgePath, nodeIndex } from '../lib/progressLayout';
import {
  originBarColor, originLabel, claimKindLabel, edgeStyle,
  relationLabel, shortPaperTitle, refineStateLabel,
} from '../lib/claim-visual';

// 研究進度圖的渲染層（工單 21 §六）。
//
// 形狀是調研報告坑②的解法：**SVG 只畫邊，節點是真 HTML 絕對定位疊在上面**——
// 中英混排的換行交給瀏覽器排，不靠任何寬度查找表。這個元件不算座標、不決定誰掛誰，
// 那些全在 `lib/progressLayout.js`；它只負責把算好的東西畫出來。
//
// 紅線 1：圖唯讀。這裡沒有任何 onChange／拖曳／連線的 handler，只有「點開溯源」。

const DIM_OPACITY = 0.18;

function paperIdsOf(node) {
  if (node.kind === 'paper') return [node.data?.id];
  if (node.kind === 'claim') return Array.isArray(node.data?.paper_ids) ? node.data.paper_ids : [];
  return [];
}

function ClaimCard({ node, dimmed, onClick, paperTitleOf }) {
  const c = node.data || {};
  const superseded = (c.status ?? 'active') !== 'active';
  const paperId = (Array.isArray(c.paper_ids) ? c.paper_ids : [])[0];
  const title = [
    c.statement,
    `出身：${originLabel(c.epistemic_origin)}`,
    superseded && c.supersede_reason ? `原本是：${c.supersede_reason}` : null,
  ].filter(Boolean).join('\n');

  return (
    <button
      type="button"
      onClick={() => onClick?.(node)}
      title={title}
      className={`absolute text-left rounded-lg border bg-surface shadow-sm overflow-hidden flex flex-col
        ${superseded ? 'border-dashed border-border' : 'border-border'}
        hover:border-accent hover:shadow-md transition-[border-color,box-shadow,opacity]`}
      style={{
        left: node.x, top: node.y, width: node.w, height: node.h,
        opacity: dimmed ? DIM_OPACITY : (superseded ? 0.45 : 1),
      }}
    >
      <span
        className="absolute left-0 top-0 bottom-0"
        style={{ width: 3, background: originBarColor(c.epistemic_origin) }}
      />
      <span className={`cr-node-statement flex-1 pl-3 pr-2 pt-1.5 text-[12px] leading-[20px] text-text ${superseded ? 'line-through' : ''}`}>
        {c.statement || '（沒有內容）'}
      </span>
      <span className="flex items-center gap-1 pl-3 pr-2 pb-1 shrink-0">
        <span className="text-[10px] text-faint shrink-0">{claimKindLabel(c.claim_kind)}</span>
        {superseded && <span className="text-[10px] px-1 rounded bg-surface-hover text-muted shrink-0">被取代</span>}
        {paperId && (
          <span className="text-[10px] px-1 rounded bg-surface-hover text-muted truncate">
            {shortPaperTitle(paperTitleOf(paperId))}
          </span>
        )}
      </span>
    </button>
  );
}

function PlainCard({ node, dimmed, children, tone = '' }) {
  return (
    <div
      className={`absolute rounded-lg border border-border bg-surface-alt shadow-sm overflow-hidden px-3 py-2 ${tone}`}
      style={{ left: node.x, top: node.y, width: node.w, height: node.h, opacity: dimmed ? DIM_OPACITY : 1 }}
    >
      {children}
    </div>
  );
}

export default function ProgressGraph({ layout, highlightPaperId = null, onClaimClick, papers = [] }) {
  const index = useMemo(() => nodeIndex(layout), [layout]);
  const paperTitles = useMemo(() => new Map(papers.map(p => [p.id, p.title])), [papers]);
  const paperTitleOf = (id) => paperTitles.get(id) ?? id;

  const isDim = (node) => {
    if (!highlightPaperId) return false;
    if (node.kind === 'direction' || node.kind === 'group') return false;
    return !paperIdsOf(node).includes(highlightPaperId);
  };

  const edgeDim = (a, b) => {
    if (!highlightPaperId) return false;
    return isDim(index.get(a) || {}) && isDim(index.get(b) || {});
  };

  return (
    <div className="relative" style={{ width: layout.bounds.width, height: layout.bounds.height }}>
      {/* 邊層：絕對定位、不吃滑鼠（節點才是可點的） */}
      <svg
        className="absolute inset-0 pointer-events-none"
        width={layout.bounds.width}
        height={layout.bounds.height}
      >
        <defs>
          <marker id="cr-progress-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M 0 0 L 8 4 L 0 8 z" fill="var(--muted)" />
          </marker>
        </defs>

        {/* 樹邊：細實線曲線 */}
        {layout.treeEdges.map((e) => {
          const from = index.get(e.from);
          const to = index.get(e.to);
          if (!from || !to) return null;
          const style = edgeStyle('tree');
          return (
            <path
              key={`t:${e.from}->${e.to}`}
              d={edgePath(from, to)}
              fill="none"
              stroke={style.stroke}
              strokeWidth={style.width}
              opacity={edgeDim(e.from, e.to) ? DIM_OPACITY : 0.8}
            />
          );
        })}

        {/* 橫線：矛盾（紅虛線）、降級的多父邊、被取代。畫在樹邊之上 */}
        {layout.overlayEdges.map((e) => {
          const from = index.get(e.from);
          const to = index.get(e.to);
          if (!from || !to) return null;
          const style = edgeStyle(e.kind, { crossPaper: e.crossPaper });
          const label = [
            `${relationLabel(e.kind)}${e.crossPaper ? '（跨篇）' : ''}`,
            e.kind === 'superseded_by' && e.note ? `原本是：${e.note}` : e.note,
          ].filter(Boolean).join('\n');
          return (
            <path
              key={`o:${e.id}`}
              d={edgePath(from, to)}
              fill="none"
              stroke={style.stroke}
              strokeWidth={style.width}
              strokeDasharray={style.dash || undefined}
              markerEnd={style.arrow ? 'url(#cr-progress-arrow)' : undefined}
              opacity={edgeDim(e.from, e.to) ? DIM_OPACITY : 1}
            >
              <title>{label}</title>
            </path>
          );
        })}
      </svg>

      {/* 節點層：真 HTML，換行交給瀏覽器（坑②） */}
      {layout.nodes.map((node) => {
        const dimmed = isDim(node);
        if (node.kind === 'claim') {
          return (
            <ClaimCard
              key={node.id}
              node={node}
              dimmed={dimmed}
              onClick={onClaimClick}
              paperTitleOf={paperTitleOf}
            />
          );
        }
        if (node.kind === 'direction') {
          return (
            <PlainCard key={node.id} node={node} dimmed={false} tone="bg-accent-soft border-accent">
              <div className="cr-serif text-[14px] font-semibold text-text-strong truncate">{node.data?.name || '未命名方向'}</div>
              <div className="cr-node-desc text-[11px] text-muted">{node.data?.description || '研究方向'}</div>
            </PlainCard>
          );
        }
        if (node.kind === 'paper') {
          return (
            <PlainCard key={node.id} node={node} dimmed={dimmed}>
              <div className="cr-node-desc text-[12px] font-semibold text-text-strong leading-[18px]" title={node.data?.title}>
                {node.data?.title || '未命名論文'}
              </div>
              <div className="text-[10px] text-faint mt-0.5">{refineStateLabel(node.data?.refine_state)}</div>
            </PlainCard>
          );
        }
        return (
          <PlainCard key={node.id} node={node} dimmed={false}>
            <div className="text-[12px] font-medium text-muted">{node.data?.label}</div>
          </PlainCard>
        );
      })}
    </div>
  );
}
