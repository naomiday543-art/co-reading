import React, { useEffect, useMemo, useState } from 'react';
import { activityApi } from '../api';

const COLLAPSE_KEY = 'co-reading:activity-collapsed';

const RANGES = [
  { label: 'All', days: 0 },
  { label: '90d', days: 90 },
  { label: '30d', days: 30 },
];

// 維度 → 語意 token。與 InsightCard.jsx 的對映一致（概念=fact、延伸=progress、
// 悬题=hyp）；那裡的常數沒有 export，工單 04 §5 也把改動範圍限制在本檔，故在此複製。
const DIMENSION_TOKENS = {
  '概念': { soft: 'var(--fact-soft)', fg: 'var(--fact)' },
  '延伸': { soft: 'var(--progress-soft)', fg: 'var(--progress)' },
  '悬题': { soft: 'var(--hyp-soft)', fg: 'var(--hyp)' },
  '你的研究': { soft: 'var(--accent-soft)', fg: 'var(--accent)' },
  '闪回': { soft: 'var(--hyp-soft)', fg: 'var(--hyp)' },
  '共振': { soft: 'var(--progress-soft)', fg: 'var(--progress)' },
};

const CELL = 11;   // px
const GAP = 3;     // px
const MOBILE_WEEKS = 26;

// 分檔色階（工單 §4.1：0 / 1–2 / 3–5 / 6+，不用線性）
function levelColor(n) {
  if (!n) return 'var(--surface-alt)';
  if (n <= 2) return 'color-mix(in srgb, var(--accent) 30%, var(--surface-alt))';
  if (n <= 5) return 'color-mix(in srgb, var(--accent) 60%, var(--surface-alt))';
  return 'color-mix(in srgb, var(--accent) 100%, var(--surface-alt))';
}

function parseDay(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d, 12, 0, 0, 0);   // 正午錨點，避開 DST 日界
}

function fmtDay(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// 週一起始：列＝週，行＝週一…週日。範圍外的格子回 null（畫成透明佔位）。
function buildWeeks(from, to, byDay) {
  const start = parseDay(from);
  const end = parseDay(to);
  const startDow = (start.getDay() + 6) % 7;
  const endDow = (end.getDay() + 6) % 7;

  const cursor = new Date(start);
  cursor.setDate(cursor.getDate() - startDow);
  const gridEnd = new Date(end);
  gridEnd.setDate(gridEnd.getDate() + (6 - endDow));

  const weeks = [];
  while (cursor <= gridEnd) {
    const week = [];
    for (let i = 0; i < 7; i++) {
      const key = fmtDay(cursor);
      if (key >= from && key <= to) {
        week.push(byDay[key] || { day: key, messages: 0, insights: 0, papers: 0 });
      } else {
        week.push(null);
      }
      cursor.setDate(cursor.getDate() + 1);
    }
    weeks.push(week);
  }
  return weeks;
}

function monthLabelsFor(weeks) {
  const labels = new Array(weeks.length).fill(null);
  let lastMonth = null;
  weeks.forEach((week, i) => {
    const first = week.find(Boolean);
    if (!first) return;
    const month = parseDay(first.day).getMonth();
    if (month !== lastMonth) {
      // 只在該月至少佔了一整欄時標，避免月初擠在最後一欄被裁掉
      if (i < weeks.length - 1) labels[i] = `${month + 1}月`;
      lastMonth = month;
    }
  });
  return labels;
}

function StatCell({ label, value, valueColor, valueBg }) {
  return (
    <div className="rounded-[10px] border border-border-soft bg-surface-alt px-3 py-2">
      <div className="text-[11px] text-faint leading-tight">{label}</div>
      <div
        className="cr-mono text-[15px] font-semibold leading-snug mt-0.5 truncate"
        style={{ color: valueColor || 'var(--text-strong)', background: valueBg }}
        title={String(value)}
      >
        {value}
      </div>
    </div>
  );
}

function Legend() {
  return (
    <div className="flex items-center gap-3 mt-2.5 text-[11px] text-faint flex-wrap">
      <div className="flex items-center gap-1.5">
        <span>少</span>
        {[0, 1, 3, 6].map(n => (
          <span
            key={n}
            style={{
              width: CELL, height: CELL, borderRadius: 2,
              background: levelColor(n),
              border: '1px solid var(--border-soft)',
              display: 'inline-block',
            }}
          />
        ))}
        <span>多</span>
      </div>
      <div className="flex items-center gap-1.5">
        <span
          style={{
            width: CELL, height: CELL, borderRadius: 2,
            background: 'var(--surface-alt)', border: '1px solid var(--border-soft)',
            display: 'inline-block', position: 'relative',
          }}
        >
          <span style={{ position: 'absolute', right: 1, bottom: 1, width: 3, height: 3, borderRadius: '50%', background: 'var(--hyp)' }} />
        </span>
        <span>有洞察</span>
      </div>
    </div>
  );
}

export default function ActivityPanel() {
  const [days, setDays] = useState(0);        // 預設 All——她的資料目前只有三個月
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem(COLLAPSE_KEY) === '1'; } catch { return false; }
  });
  const [narrow, setNarrow] = useState(() =>
    typeof window !== 'undefined' ? window.innerWidth < 768 : false
  );

  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth < 768);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(false);
    // 面板自成一格：載入失敗只影響面板，不能讓 Library 整頁掛掉（工單 §4.3）。
    activityApi.get(days)
      .then(d => { if (!cancelled) { setData(d); setLoading(false); } })
      .catch(() => { if (!cancelled) { setError(true); setData(null); setLoading(false); } });
    return () => { cancelled = true; };
  }, [days]);

  const toggleCollapsed = () => {
    setCollapsed(prev => {
      const next = !prev;
      try { localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0'); } catch { /* private mode */ }
      return next;
    });
  };

  const byDay = useMemo(() => {
    const map = {};
    for (const d of data?.days || []) map[d.day] = d;
    return map;
  }, [data]);

  const weeks = useMemo(() => {
    if (!data) return [];
    const all = buildWeeks(data.from, data.to, byDay);
    return narrow ? all.slice(-MOBILE_WEEKS) : all;
  }, [data, byDay, narrow]);

  const monthLabels = useMemo(() => monthLabelsFor(weeks), [weeks]);

  const totals = data?.totals;
  const topDim = data?.dimensions?.[0] || null;
  const dimToken = topDim ? (DIMENSION_TOKENS[topDim.dimension] || DIMENSION_TOKENS['延伸']) : null;

  return (
    <div className="card p-4 mb-5">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-baseline gap-3 min-w-0">
          <h3 className="cr-serif text-[15px] font-semibold text-text-strong shrink-0">這段時間</h3>
          {collapsed && totals && (
            <span className="text-[12.5px] text-muted truncate">
              {totals.active_days} 個活躍日 · {totals.messages} 則訊息 · {totals.insights} 條洞察
            </span>
          )}
        </div>

        <div className="flex items-center gap-1.5">
          {RANGES.map(r => (
            <button
              key={r.label}
              onClick={() => setDays(r.days)}
              className={`cr-mono text-[11px] px-2 py-1 rounded-[7px] border transition-colors ${
                days === r.days
                  ? 'border-accent text-accent bg-accent-soft'
                  : 'border-border-soft text-faint hover:text-muted hover:border-border'
              }`}
            >
              {r.label}
            </button>
          ))}
          <button
            onClick={toggleCollapsed}
            aria-label={collapsed ? '展開活動面板' : '收合活動面板'}
            title={collapsed ? '展開' : '收合'}
            className="ml-1 p-1 rounded-[7px] text-faint hover:text-muted hover:bg-surface-hover"
          >
            <svg
              className="w-3.5 h-3.5 transition-transform"
              style={{ transform: collapsed ? 'rotate(-90deg)' : 'none' }}
              fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="m6 9 6 6 6-6" />
            </svg>
          </button>
        </div>
      </div>

      {!collapsed && (
        <div className="mt-3">
          {error ? (
            <div className="text-danger text-[13px]">活動資料載入失敗</div>
          ) : loading || !data ? (
            <div className="text-faint text-[13px]">載入中…</div>
          ) : (
            <>
              {/* Heatmap */}
              <div style={{ overflowX: 'auto' }} className="pb-1">
                <div style={{ display: 'inline-block', minWidth: 'min-content' }}>
                  <div className="flex" style={{ gap: GAP, height: 14 }}>
                    {weeks.map((_, i) => (
                      <div key={i} style={{ width: CELL, position: 'relative' }}>
                        {monthLabels[i] && (
                          <span
                            className="text-[10px] text-faint"
                            style={{ position: 'absolute', left: 0, top: 0, whiteSpace: 'nowrap' }}
                          >
                            {monthLabels[i]}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>

                  <div className="flex" style={{ gap: GAP }}>
                    {weeks.map((week, wi) => (
                      <div key={wi} className="flex flex-col" style={{ gap: GAP }}>
                        {week.map((cell, di) => (
                          cell ? (
                            <div
                              key={di}
                              title={`${cell.day} · ${cell.messages} 則訊息 · ${cell.insights} 條洞察`}
                              style={{
                                width: CELL, height: CELL, borderRadius: 2,
                                background: levelColor(cell.messages),
                                border: '1px solid var(--border-soft)',
                                position: 'relative',
                              }}
                            >
                              {cell.insights > 0 && (
                                <span
                                  style={{
                                    position: 'absolute', right: 0, bottom: 0,
                                    width: 3, height: 3, borderRadius: '50%',
                                    background: 'var(--hyp)',
                                  }}
                                />
                              )}
                            </div>
                          ) : (
                            <div key={di} style={{ width: CELL, height: CELL }} />
                          )
                        ))}
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              <Legend />

              {/* 八格統計 */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-3.5">
                <StatCell label="論文" value={totals.papers} />
                <StatCell label="訊息" value={totals.messages} />
                <StatCell label="洞察" value={totals.insights} />
                <StatCell label="活躍天數" value={totals.active_days} />
                <StatCell label="目前連續" value={data.streak.current} />
                <StatCell label="最長連續" value={data.streak.longest} />
                <StatCell
                  label="高峰時段"
                  value={data.peak_hour === null || data.peak_hour === undefined
                    ? '—'
                    : `${String(data.peak_hour).padStart(2, '0')}:00`}
                />
                <StatCell
                  label="最多的維度"
                  value={topDim ? `${topDim.dimension} ${topDim.count}` : '—'}
                  valueColor={dimToken ? dimToken.fg : undefined}
                />
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
