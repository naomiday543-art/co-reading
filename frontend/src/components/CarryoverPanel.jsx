import React, { useState, useEffect, useCallback } from 'react';
import { papersApi } from '../api';

// 出身標籤的視覺分級（紅線 2 的可視化，不是裝飾）：
// 論文報告＝實心、你的假設＝虛線框、衝突＝醒目色。絕不能長一樣。
const ORIGIN_BADGE = {
  paper_reported: { label: '論文報告', cls: 'bg-accent text-accent-fg' },
  experimental_observation: { label: '實驗觀察', cls: 'bg-accent text-accent-fg' },
  author_interpretation: { label: '作者解釋', cls: 'bg-accent text-accent-fg' },
  user_hypothesis: { label: '你的假設·未驗證', cls: 'border border-dashed border-muted text-muted' },
  ai_hypothesis: { label: 'AI推導·未驗證', cls: 'border border-dashed border-muted text-muted' },
  methodological_speculation: { label: '方法論推測', cls: 'border border-dashed border-muted text-muted' },
  background_knowledge: { label: '背景知識', cls: 'bg-surface-hover text-muted' },
  unresolved_disagreement: { label: '未解爭議', cls: 'bg-danger/10 text-danger' },
};

function OriginBadge({ origin }) {
  const b = ORIGIN_BADGE[origin] || { label: origin, cls: 'bg-surface-hover text-muted' };
  return <span className={`text-[10px] px-1.5 py-0.5 rounded ${b.cls}`}>{b.label}</span>;
}

function ClaimItem({ item, conflict, onProvenance }) {
  return (
    <button
      className="block w-full text-left text-xs px-2 py-1.5 rounded-md hover:bg-surface-hover transition-colors"
      onClick={() => onProvenance?.(item.claim_id)}
      title="查看來源與溯源"
    >
      <span className="flex items-start gap-1.5">
        <OriginBadge origin={item.epistemic_origin} />
        <span className={`flex-1 ${conflict ? 'text-danger' : 'text-text'}`}>
          {item.statement}
          {conflict && item.counterpart_statement && (
            <span className="text-faint"> ⇄ {item.counterpart_statement}</span>
          )}
        </span>
      </span>
    </button>
  );
}

function Section({ title, items, conflict, onProvenance }) {
  if (!items || items.length === 0) return null;
  return (
    <div className={conflict ? 'bg-danger/5 border border-danger/30 rounded-lg p-2' : ''}>
      <div className={`text-[11px] font-semibold mb-1 ${conflict ? 'text-danger' : 'text-muted'}`}>
        {conflict ? '⚠ ' : ''}{title}
      </div>
      <div className="space-y-0.5">
        {items.slice(0, 6).map((x, i) => (
          <ClaimItem key={x.claim_id ?? i} item={x} conflict={conflict} onProvenance={onProvenance} />
        ))}
      </div>
    </div>
  );
}

function ProvenanceModal({ paperId, claimId, onClose }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    papersApi.claimProvenance(paperId, claimId)
      .then(setData)
      .catch(e => setError(e.message));
  }, [paperId, claimId]);

  const c = data?.claim;
  const src = (s) => (
    <li key={s.id} className="text-xs text-muted">
      [{s.source_kind}]
      {s.paper_id ? ` 論文 ${s.paper_id}` : ''}
      {s.locator_text ? `（${s.locator_text}）` : ''}
      {` · 可得性: ${s.availability}`}
      {s.doi ? ` · DOI: ${s.doi}` : ''}
    </li>
  );

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-surface border border-border rounded-xl max-w-lg w-full max-h-[70vh] overflow-y-auto p-4 space-y-3"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-2">
          <h4 className="cr-serif text-sm font-semibold">溯源</h4>
          <button className="text-faint hover:text-accent text-sm" onClick={onClose}>✕</button>
        </div>
        {error && <p className="text-xs text-danger">{error}</p>}
        {!data && !error && <p className="text-xs text-muted">載入中…</p>}
        {c && (
          <>
            <div>
              <OriginBadge origin={c.epistemic_origin} />
              <p className="text-sm mt-1">{c.statement}</p>
              <p className="text-[10px] text-faint mt-0.5">
                kind: {c.claim_kind} · origin_actor: {c.origin_actor} · status: {c.status}
                {c.confidence != null ? ` · confidence: ${c.confidence}` : ''}
              </p>
            </div>
            <div>
              <div className="text-[11px] font-semibold text-muted mb-1">來源</div>
              {data.sources.length === 0
                ? <p className="text-xs text-danger">無可得來源（provenance: unavailable）</p>
                : <ul className="space-y-1">{data.sources.map(src)}</ul>}
            </div>
            {(data.relations?.incoming?.length > 0 || data.relations?.outgoing?.length > 0) && (
              <div>
                <div className="text-[11px] font-semibold text-muted mb-1">關係</div>
                <ul className="space-y-1 text-xs text-muted">
                  {data.relations.incoming.map(r => (
                    <li key={r.id}>← {r.kind}（來自：{r.from_statement ?? r.from_id}）</li>
                  ))}
                  {data.relations.outgoing.map(r => (
                    <li key={r.id}>→ {r.kind}（指向：{r.to_statement ?? r.to_id}）</li>
                  ))}
                </ul>
              </div>
            )}
            {data.revisions?.length > 0 && (
              <div>
                <div className="text-[11px] font-semibold text-muted mb-1">修改歷史（{data.revisions.length}）</div>
                <ul className="space-y-1 text-xs text-faint">
                  {data.revisions.map(r => (
                    <li key={r.id}>{r.reason}：{r.snapshot.statement}</li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export default function CarryoverPanel({ paperId, messageCount }) {
  const [carryover, setCarryover] = useState(null);
  const [injected, setInjected] = useState(false);
  const [refining, setRefining] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState('');
  const [provClaimId, setProvClaimId] = useState(null);

  const load = useCallback(async () => {
    try {
      const r = await papersApi.getCarryover(paperId);
      setCarryover(r.carryover);
      setInjected(r.injected);
    } catch {
      setCarryover(null); // 尚未精煉過
    }
  }, [paperId]);

  useEffect(() => { load(); }, [load]);

  const handleRefine = async () => {
    setRefining(true);
    setError('');
    try {
      const r = await papersApi.refine(paperId);
      setCarryover(r.carryover);
      setExpanded(true);
    } catch (e) {
      setError(e.message);
    } finally {
      setRefining(false);
    }
  };

  const handleToggleInject = async () => {
    try {
      const r = await papersApi.setCarryoverInject(paperId, !injected);
      setInjected(r.injected);
    } catch (e) {
      setError(e.message);
    }
  };

  const c = carryover;

  return (
    <div className="mb-3">
      {/* 觸發列：精煉按鈕 + 帶上開關 */}
      <div className="flex items-center gap-2 flex-wrap">
        <button
          className="text-xs text-muted hover:text-accent flex items-center gap-1 px-1 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          onClick={handleRefine}
          disabled={refining || (messageCount ?? 0) < 2}
          title="把本次共讀精煉成結構化研究狀態（研究問題/假設/證據/衝突），存在 research-gateway"
        >
          {refining ? '… 精煉中（可能需要一分鐘）' : '✦ 精煉本次共讀'}
        </button>
        {c && (
          <button
            className={`text-xs px-1.5 py-0.5 rounded-md border transition-colors ${injected
              ? 'border-accent text-accent'
              : 'border-border text-muted hover:text-accent'}`}
            onClick={handleToggleInject}
            title="把 carryover 摘要注入後續對話（手動，預設關）"
          >
            {injected ? '✓ 已帶上' : '帶上'}
          </button>
        )}
        {c && (
          <button
            className="text-xs text-faint hover:text-accent transition-colors"
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? '收起' : `研究續窗 v${carryover ? 1 : ''}`}
          </button>
        )}
      </div>
      {error && <p className="text-xs text-danger mt-1">{error}</p>}

      {/* carryover 卡片：分段顯示，衝突段醒目，每條可點擊溯源 */}
      {c && expanded && (
        <div className="mt-2 border border-border rounded-lg p-2.5 space-y-2.5 bg-surface">
          {c.research_question && (
            <div>
              <div className="text-[11px] font-semibold text-muted mb-1">研究問題</div>
              <ClaimItem item={c.research_question} onProvenance={setProvClaimId} />
            </div>
          )}
          <Section title="當前假設" items={c.hypotheses} onProvenance={setProvClaimId} />
          <Section title="已確認發現" items={c.confirmed_findings} onProvenance={setProvClaimId} />
          <Section title="方法論筆記" items={c.methodological_notes} onProvenance={setProvClaimId} />
          <Section title="決定" items={c.decisions} onProvenance={setProvClaimId} />
          <Section title="開放問題" items={c.open_questions} onProvenance={setProvClaimId} />
          <Section title="下一步" items={c.next_actions} onProvenance={setProvClaimId} />
          <Section title="證據衝突（未解決）" items={c.conflicting_evidence} conflict onProvenance={setProvClaimId} />
          {c.omitted && (
            <p className="text-[10px] text-faint border-t border-border-soft pt-1.5">
              掃描 {c.omitted.messages_scanned} 條訊息，噪音 {c.omitted.noise_dropped} 條。
              {c.omitted.note}
            </p>
          )}
        </div>
      )}

      {provClaimId && (
        <ProvenanceModal paperId={paperId} claimId={provClaimId} onClose={() => setProvClaimId(null)} />
      )}
    </div>
  );
}
