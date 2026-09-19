import React, { useState, useEffect } from 'react';
import { papersApi } from '../api';
import OriginBadge from './OriginBadge';

// 溯源視窗（工單 §5.3）——原樣從 `CarryoverPanel.jsx` 抽出來共用（工單 21 §六：
// 研究進度圖點節點也開這一顆）。行為一個字都沒改：仍走
// `GET /api/papers/:id/claims/:claimId/provenance` 代理，前端不直連 gateway。
// 代理只用 paperId 找 gateway 設定，所以呼叫端傳該 claim 的第一個 paper_id 就好。

export default function ProvenanceModal({ paperId, claimId, onClose }) {
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
