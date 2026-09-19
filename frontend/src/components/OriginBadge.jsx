import React from 'react';
import { ORIGIN_BADGE } from '../lib/claim-visual';

// 出身標籤（紅線 2 的可視化，不是裝飾）：論文報告＝實心、你的假設＝虛線框、衝突＝醒目色。
// 從 `CarryoverPanel.jsx` 抽出來共用（續窗面板、溯源視窗、研究進度圖三處同一顆）。
export default function OriginBadge({ origin }) {
  const b = ORIGIN_BADGE[origin] || { label: origin, cls: 'bg-surface-hover text-muted' };
  return <span className={`text-[10px] px-1.5 py-0.5 rounded ${b.cls}`}>{b.label}</span>;
}
