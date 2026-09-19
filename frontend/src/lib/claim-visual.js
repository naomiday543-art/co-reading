// claim 的視覺常數（工單 21 §六）——純資料，不 import React，好單測也好共用。
//
// 出身配色沿用續窗面板（`CarryoverPanel.jsx`）那一套，抽到這裡當共用常數：
// 論文報告＝實心 accent、你的假設／AI 推導＝虛線 muted、未解爭議＝danger。
// 紅線：只用既有語意色（CSS 變數），不寫死色碼——深色模式才會自己跟著翻。

export const ORIGIN_BADGE = {
  paper_reported: { label: '論文報告', cls: 'bg-accent text-accent-fg' },
  experimental_observation: { label: '實驗觀察', cls: 'bg-accent text-accent-fg' },
  author_interpretation: { label: '作者解釋', cls: 'bg-accent text-accent-fg' },
  user_hypothesis: { label: '你的假設·未驗證', cls: 'border border-dashed border-muted text-muted' },
  ai_hypothesis: { label: 'AI推導·未驗證', cls: 'border border-dashed border-muted text-muted' },
  methodological_speculation: { label: '方法論推測', cls: 'border border-dashed border-muted text-muted' },
  background_knowledge: { label: '背景知識', cls: 'bg-surface-hover text-muted' },
  unresolved_disagreement: { label: '未解爭議', cls: 'bg-danger/10 text-danger' },
};

/** 節點卡左緣那條 3px 色條：ORIGIN_BADGE 的同一組顏色，換成 CSS 變數。 */
export const ORIGIN_BAR = {
  paper_reported: 'var(--accent)',
  experimental_observation: 'var(--accent)',
  author_interpretation: 'var(--accent)',
  user_hypothesis: 'var(--muted)',
  ai_hypothesis: 'var(--muted)',
  methodological_speculation: 'var(--muted)',
  background_knowledge: 'var(--faint)',
  unresolved_disagreement: 'var(--danger)',
};

export function originBarColor(origin) {
  return ORIGIN_BAR[origin] || 'var(--border)';
}

export function originLabel(origin) {
  return ORIGIN_BADGE[origin]?.label ?? origin ?? '';
}

/** claim_kind 的中文（§六）。契約之外的種類原樣顯示，不吞。 */
export const CLAIM_KIND_LABELS = {
  research_question: '研究問題',
  hypothesis: '假設',
  finding: '發現',
  evidence: '證據',
  methodological_note: '方法論',
  decision: '決定',
  rejected_explanation: '被否決',
  open_question: '開放問題',
  next_action: '下一步',
};

export function claimKindLabel(kind) {
  return CLAIM_KIND_LABELS[kind] ?? kind ?? '';
}

/** 邊的樣式（§六）。`contradicts` 紅虛線 2px 是紅線 3 的可視化，不准調淡。 */
export const EDGE_STYLE = {
  tree: { stroke: 'var(--faint)', width: 1, dash: null },
  supports: { stroke: 'var(--fact)', width: 1.5, dash: null },
  partially_supports: { stroke: 'var(--fact)', width: 1.5, dash: null },
  refines: { stroke: 'var(--muted)', width: 1.5, dash: null },
  answers: { stroke: 'var(--progress)', width: 1.5, dash: null },
  contradicts: { stroke: 'var(--danger)', width: 2, dash: '6 4' },
  superseded_by: { stroke: 'var(--muted)', width: 1.5, dash: '4 4', arrow: true },
};

export function edgeStyle(kind, { crossPaper = false } = {}) {
  const base = EDGE_STYLE[kind] || EDGE_STYLE.tree;
  // 跨篇的橫線再粗 0.5px：她最在意的就是「這兩篇在打架」。
  return crossPaper ? { ...base, width: base.width + 0.5 } : base;
}

export const RELATION_LABELS = {
  supports: '支持',
  partially_supports: '部分支持',
  refines: '細化',
  answers: '回答',
  contradicts: '矛盾',
  superseded_by: '被取代',
};

export function relationLabel(kind) {
  return RELATION_LABELS[kind] ?? kind ?? '';
}

/** 論文短名 chip：標題前 14 字（§六）。 */
export function shortPaperTitle(title, max = 14) {
  const s = String(title || '').trim();
  if (!s) return '未命名論文';
  const chars = [...s];
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : s;
}

/** 精煉狀態的小標（§六 paper 節點）。 */
export const REFINE_STATE_LABELS = {
  never: '沒精煉',
  fresh: '已精煉',
  new_messages: '有新對話',
  stale: '對話改過',
};

export function refineStateLabel(state) {
  return REFINE_STATE_LABELS[state] ?? state ?? '';
}
