import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useStore, COMPARE_MIN, compareKey } from '../store';
import { compareApi } from '../api';

// 表格的列順序＝摘要的五段，與後端 src/compare.js 的 COMPARE_DIMENSIONS 同一組。
const DIMENSIONS = ['背景', '方法', '結果', '結論', '局限'];

const ANALYSIS_SECTIONS = [
  { key: 'same', label: '相同之處', tone: 'text-fact' },
  { key: 'differ', label: '相異之處', tone: 'text-hyp' },
  { key: 'conflict', label: '打架之處', tone: 'text-danger' },
];

export default function Compare({ onNavigate }) {
  const { compareSelection, compareResult, setCompareResult } = useStore();

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [notAnalyzed, setNotAnalyzed] = useState(null);

  const key = useMemo(() => compareKey(compareSelection), [compareSelection]);
  // 同一組 ids 的結果在 store 記一份：返回 Library 再進來不重打，換了選擇才重打（§3.3）。
  const cached = compareResult && compareResult.key === key ? compareResult.data : null;
  const inFlight = useRef(null);

  const run = async ({ force = false } = {}) => {
    if (compareSelection.length < COMPARE_MIN) return;
    if (!force && cached) return;
    if (inFlight.current === key && !force) return;

    inFlight.current = key;
    setLoading(true);
    setError(null);
    setNotAnalyzed(null);
    try {
      const data = await compareApi.run(compareSelection);
      setCompareResult({ key, data });
    } catch (err) {
      setError(err.message || '對比失敗');
      setNotAnalyzed(err.notAnalyzed || null);
    } finally {
      setLoading(false);
      inFlight.current = null;
    }
  };

  // 進頁即對比（已經有同一組的結果就直接用）。
  useEffect(() => { run(); }, [key]);

  const back = () => onNavigate('library');

  // ── 篇數不足 ───────────────────────────────────────────────────────
  if (compareSelection.length < COMPARE_MIN) {
    return (
      <div className="max-w-5xl mx-auto">
        <Header onBack={back} />
        <div className="card p-8 text-center">
          <p className="cr-serif text-lg text-muted mb-2">至少要選 {COMPARE_MIN} 篇</p>
          <p className="text-[13.5px] text-faint mb-5">回論文列表勾選 2–4 篇已通讀的論文。</p>
          <button
            className="px-4 py-2 bg-accent text-accent-fg rounded-[10px] text-[13px] font-medium hover:bg-accent-hover shadow-sm"
            onClick={back}
          >
            回論文列表
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto">
      <Header onBack={back} />

      {/* 論文標題卡（可點進 detail）*/}
      {cached && (
        <div className="grid gap-3 mb-5" style={{ gridTemplateColumns: `repeat(auto-fit, minmax(200px, 1fr))` }}>
          {cached.papers.map((p, i) => (
            <div
              key={p.id}
              className="card p-4 cursor-pointer"
              onClick={() => onNavigate('detail', p.id)}
              data-testid="compare-paper-card"
            >
              <div className="cr-mono text-[11px] text-faint mb-1.5">論文 {i + 1}</div>
              <div className="cr-serif font-semibold text-[15px] leading-snug text-text-strong">
                {p.title || '未命名論文'}
              </div>
              <div className="text-[12px] text-muted mt-1.5">
                {[p.authors, p.year].filter(Boolean).join(' · ')}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div className="card p-8 text-center" data-testid="compare-loading">
          <p className="cr-serif text-lg text-text-strong mb-1.5">對比中…</p>
          <p className="text-[13px] text-muted">通常 30–60 秒。只讀五段摘要，不讀全文。</p>
        </div>
      )}

      {/* Error */}
      {!loading && error && (
        <div className="card p-6" data-testid="compare-error">
          <p className="cr-serif text-[17px] text-text-strong mb-2">對比沒跑完</p>
          <p className="text-[13.5px] text-text leading-relaxed">{error}</p>
          {notAnalyzed && notAnalyzed.length > 0 && (
            <ul className="mt-3 space-y-1.5">
              {notAnalyzed.map(p => (
                <li key={p.id} className="text-[13px] text-muted">
                  ·{' '}
                  <button
                    className="underline hover:text-text-strong"
                    onClick={() => onNavigate('detail', p.id)}
                  >
                    {p.title || p.id}
                  </button>
                  <span className="text-faint"> — 還沒通讀完</span>
                </li>
              ))}
            </ul>
          )}
          <div className="flex gap-2.5 mt-5">
            <button
              className="px-3.5 py-1.5 bg-accent text-accent-fg rounded-[10px] text-[13px] font-medium hover:bg-accent-hover shadow-sm"
              onClick={() => run({ force: true })}
            >
              重新對比
            </button>
            <button
              className="px-3 py-1.5 border border-border rounded-[10px] text-[13px] text-muted hover:text-text-strong hover:bg-surface-hover"
              onClick={back}
            >
              返回
            </button>
          </div>
        </div>
      )}

      {/* 結果 */}
      {!loading && !error && cached && (
        <>
          {/* 維度 × 論文 對比表 */}
          <div className="card mb-5 overflow-x-auto" data-testid="compare-table-wrap">
            <table className="w-full text-[13px]" data-testid="compare-table">
              <thead>
                <tr className="border-b border-border-soft">
                  <th className="text-left font-medium text-muted px-4 py-2.5 whitespace-nowrap align-bottom">
                    維度
                  </th>
                  {cached.papers.map((p, i) => (
                    <th
                      key={p.id}
                      className="text-left font-medium text-text-strong px-4 py-2.5 align-bottom"
                      style={{ minWidth: '220px' }}
                    >
                      <span className="cr-mono text-[10.5px] text-faint block">論文 {i + 1}</span>
                      <span className="cr-serif text-[13.5px] leading-snug">
                        {p.title || '未命名論文'}
                      </span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {DIMENSIONS.map(d => (
                  <tr key={d} className="border-b border-border-soft last:border-0 align-top">
                    <td className="px-4 py-3 cr-serif font-semibold text-text-strong whitespace-nowrap">
                      {d}
                    </td>
                    {cached.papers.map(p => (
                      <td
                        key={p.id}
                        className="px-4 py-3 text-text leading-relaxed whitespace-pre-wrap break-words"
                      >
                        {cached.table?.[d]?.[p.id] || '摘要未提及'}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* 三段分析 */}
          <div className="grid gap-3 mb-5" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))' }}>
            {ANALYSIS_SECTIONS.map(({ key: k, label, tone }) => {
              const items = cached.analysis?.[k] || [];
              return (
                <div key={k} className="card p-4" data-testid={`compare-analysis-${k}`}>
                  <div className={`cr-serif font-semibold text-[14px] mb-2 ${tone}`}>{label}</div>
                  {items.length === 0 ? (
                    <p className="text-[12.5px] text-faint">（沒有）</p>
                  ) : (
                    <ul className="space-y-1.5">
                      {items.map((item, i) => (
                        <li key={i} className="text-[13px] text-text leading-relaxed">· {item}</li>
                      ))}
                    </ul>
                  )}
                </div>
              );
            })}
          </div>

          {/* 對你的題目（沒有方向就不顯示）*/}
          {cached.analysis?.for_her && (
            <div className="card p-5 mb-5" data-testid="compare-for-her">
              <div className="cr-serif font-semibold text-[15px] text-text-strong mb-2">對你的題目</div>
              <p className="text-[13.5px] text-text leading-relaxed whitespace-pre-wrap">
                {cached.analysis.for_her}
              </p>
            </div>
          )}

          {/* 底部動作 */}
          <div className="flex items-center gap-2.5 flex-wrap pb-2">
            <div className="flex-1" />
            <button
              className="px-3 py-1.5 border border-border rounded-[10px] text-[13px] text-muted hover:text-text-strong hover:bg-surface-hover"
              onClick={() => run({ force: true })}
              data-testid="compare-rerun"
            >
              重新對比
            </button>
            <button
              className="px-3 py-1.5 border border-border rounded-[10px] text-[13px] text-muted hover:text-text-strong hover:bg-surface-hover"
              onClick={back}
            >
              返回
            </button>
          </div>

          <p className="text-[11.5px] text-faint mt-3 pb-2">
            只比到摘要抓得到的層次 · {cached.model}
            {typeof cached.elapsed_ms === 'number' && ` · ${(cached.elapsed_ms / 1000).toFixed(1)}s`}
          </p>
        </>
      )}
    </div>
  );
}

function Header({ onBack }) {
  return (
    <div className="flex items-end justify-between mb-5 gap-3 flex-wrap">
      <div>
        <h2 className="cr-serif text-2xl font-semibold text-text-strong">摘要對比</h2>
        <div className="mt-1 text-[13.5px] text-muted">維度 × 論文，只讀五段摘要</div>
      </div>
      <button
        className="px-3 py-1.5 border border-border rounded-[10px] text-[13px] text-muted hover:text-text-strong hover:bg-surface-hover"
        onClick={onBack}
      >
        ← 返回
      </button>
    </div>
  );
}
