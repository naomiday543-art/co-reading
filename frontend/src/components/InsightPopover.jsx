import React, { useEffect, useState } from 'react';
import { insightsApi } from '../api';
import { describeSourceBlock, excerpt } from '../lib/insight-source';

// 工單 18 §2 A2：點洞察卡片浮出來的那張卡。
// 桌機是置中的 popover，窄螢幕是貼底的抽屜（CSS 在 index.html 的 .cr-insight-pop*）。
//
// 三段：上＝洞察本身；中＝出自的對話（一問一答，可展開全文）；下＝動作。
// （底部的「相關洞察」等 B 部分的聯想做完再掛上來。）

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

export default function InsightPopover({
  insightId,
  onClose,
  onGoChat,
  onGoPaper,
  onEdit,
  onDelete,
}) {
  const [currentId, setCurrentId] = useState(insightId);
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState(false);

  useEffect(() => { setCurrentId(insightId); }, [insightId]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError('');
    setExpanded(false);
    insightsApi.get(currentId).then(d => {
      if (!alive) return;
      setDetail(d);
      setLoading(false);
    }).catch(err => {
      if (!alive) return;
      setError(err.message || '載入失敗');
      setLoading(false);
    });
    return () => { alive = false; };
  }, [currentId]);

  // Esc 關掉（跟閱讀模式抽屜一致的手感）
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const source = describeSourceBlock(detail);
  const answerText = source.answer
    ? (expanded ? { text: source.answer.content, truncated: false } : excerpt(source.answer.content))
    : null;

  return (
    <div className="cr-insight-pop-backdrop" onClick={onClose}>
      <div className="cr-insight-pop" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true">
        {loading && <div className="py-10 text-center text-sm text-faint">載入中...</div>}
        {!loading && error && <div className="py-8 text-center text-sm text-danger">{error}</div>}

        {!loading && !error && detail && (
          <>
            {/* ── 上：洞察本身 ───────────────────────────────── */}
            <div className="flex items-start gap-2 mb-2">
              <Pill dim={detail.dimension} />
              <h3 className="cr-serif text-base font-semibold text-text-strong flex-1 min-w-0">
                {detail.title}
              </h3>
              <button
                className="text-sm text-faint hover:text-text-strong shrink-0 px-1"
                onClick={onClose}
                title="關閉（Esc）"
              >
                ✕
              </button>
            </div>

            <p className="text-[13px] text-text leading-relaxed whitespace-pre-wrap mb-2.5">
              {detail.content}
            </p>

            {Array.isArray(detail.tags_json) && detail.tags_json.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mb-2.5">
                {detail.tags_json.map(t => (
                  <span key={t} className="text-[11px] text-muted bg-surface-alt border border-border-soft rounded-full px-2 py-0.5">
                    {t}
                  </span>
                ))}
              </div>
            )}

            {detail.source_paper_title && (
              <p className="text-xs text-faint mb-3 truncate">出自《{detail.source_paper_title}》</p>
            )}

            {/* ── 中：出自的對話 ─────────────────────────────── */}
            <div className="border-t border-border-soft pt-3 mb-3">
              <h4 className="text-xs font-semibold text-muted mb-2">出自的對話</h4>

              {source.kind === 'conversation' && (
                <div className="space-y-2">
                  {source.question && (
                    <div className="cr-insight-pop-q">
                      <span className="cr-mono text-[10px] text-faint block mb-1">她問</span>
                      <p className="text-[12.5px] text-text leading-relaxed whitespace-pre-wrap">
                        {source.question.content}
                      </p>
                    </div>
                  )}
                  <div className="cr-insight-pop-a">
                    <span className="cr-mono text-[10px] text-faint block mb-1">回覆</span>
                    <p className="text-[12.5px] text-muted leading-relaxed whitespace-pre-wrap">
                      {answerText.text}
                    </p>
                    {(answerText.truncated || expanded) && (
                      <button
                        className="text-[11.5px] text-accent hover:underline mt-1"
                        onClick={() => setExpanded(v => !v)}
                      >
                        {expanded ? '收起' : '展開全文'}
                      </button>
                    )}
                  </div>
                </div>
              )}

              {source.kind === 'context' && (
                <p className="text-[12.5px] text-muted leading-relaxed whitespace-pre-wrap cr-insight-pop-a">
                  {source.context}
                </p>
              )}

              {source.kind === 'none' && (
                <p className="text-xs text-faint">沒有記錄來源對話</p>
              )}
            </div>

            {/* ── 下：動作 ───────────────────────────────────── */}
            <div className="flex flex-wrap gap-2 mb-1">
              {source.kind === 'conversation' && detail.source_paper_id && (
                <button
                  className="text-[12.5px] bg-accent text-accent-fg px-3 py-1.5 rounded-[10px] font-medium hover:bg-accent-hover shadow-sm"
                  onClick={() => onGoChat?.(detail.source_paper_id, detail.source_message_id)}
                >
                  去對話
                </button>
              )}
              {detail.source_paper_id && (
                <button
                  className="text-[12.5px] px-3 py-1.5 rounded-[10px] border border-border text-muted hover:bg-surface-hover"
                  onClick={() => onGoPaper?.(detail.source_paper_id)}
                >
                  去論文
                </button>
              )}
              {onEdit && (
                <button
                  className="text-[12.5px] px-3 py-1.5 rounded-[10px] border border-border text-muted hover:bg-surface-hover"
                  onClick={() => onEdit(detail)}
                >
                  編輯
                </button>
              )}
              {onDelete && (
                <button
                  className="text-[12.5px] px-3 py-1.5 rounded-[10px] border border-border text-muted hover:text-danger hover:bg-surface-hover"
                  onClick={() => onDelete(detail.id)}
                >
                  刪除
                </button>
              )}
            </div>

          </>
        )}
      </div>
    </div>
  );
}
