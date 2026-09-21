import React, { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { papersApi } from '../api';
import OriginBadge from './OriginBadge';
import ProvenanceModal from './ProvenanceModal';

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

// headContainer（工單 26 §D5）：ChatPanel 那顆「穩定容器」。有值就把**觸發列**
// portal 進去（它住在跨欄工作列的右半／閱讀模式時的抽屜頭部），卡片／錯誤／溯源彈窗
// 留在原地。state、effect、API 呼叫一行都沒改——精煉要跑一分鐘，這顆元件不能重掛。
export default function CarryoverPanel({ paperId, messageCount, headContainer = null }) {
  const [carryover, setCarryover] = useState(null);
  const [injected, setInjected] = useState(false);
  const [refining, setRefining] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState('');
  const [provClaimId, setProvClaimId] = useState(null);
  // 工單 20：這篇的精煉送進哪條線（方向線／單篇線），以及相對上次精煉的狀態。
  const [meta, setMeta] = useState({ scope: 'paper', direction: null, refineState: 'never' });

  const load = useCallback(async () => {
    try {
      const r = await papersApi.getCarryover(paperId);
      setCarryover(r.carryover ?? null); // 還沒精煉過＝null，但線名／狀態照樣拿得到
      setInjected(r.injected);
      setMeta({ scope: r.scope ?? 'paper', direction: r.direction ?? null, refineState: r.refine_state ?? 'never' });
    } catch {
      setCarryover(null); // 尚未精煉過
      setMeta({ scope: 'paper', direction: null, refineState: 'never' });
    }
  }, [paperId]);

  useEffect(() => { load(); }, [load]);

  const handleRefine = async ({ full = false } = {}) => {
    setRefining(true);
    setError('');
    try {
      const r = await papersApi.refine(paperId, { full });
      setCarryover(r.carryover);
      setExpanded(true);
      await load(); // 線／狀態跟著更新（重新精煉之後 stale 提示要消失）
    } catch (e) {
      setError(e.message);
    } finally {
      setRefining(false);
    }
  };

  // 她 9/18 拍板的手動型：只亮提示，系統絕不自己重跑。
  const stale = meta.refineState === 'stale';
  const lineLabel = meta.scope === 'direction' && meta.direction
    ? `研究續窗 · 方向：${meta.direction.name}`
    : '研究續窗 · 本篇';

  const handleToggleInject = async () => {
    try {
      const r = await papersApi.setCarryoverInject(paperId, !injected);
      setInjected(r.injected);
    } catch (e) {
      setError(e.message);
    }
  };

  const c = carryover;

  // 觸發列（三個動作都要留、都要能按，工單 26 §三）。order 讓它在頭部那一排排成
  // 討論(0) → 精煉／帶上(1) → 提取洞察(2) → 研究續窗 meta(3)；沒 portal 時 order
  // 在原本那個 flex 容器裡也成立，相對次序一樣。
  const triggerRow = (
    <>
      <button
        className="cr-chip shrink-0"
        style={{ order: 1 }}
        onClick={() => handleRefine()}
        disabled={refining || (messageCount ?? 0) < 2}
        title={meta.scope === 'direction' && meta.direction
          ? `把本次共讀精煉成結構化研究狀態，餵進「${meta.direction.name}」這條研究線（跨論文累積）。可能需要一分鐘。`
          : '把本次共讀精煉成結構化研究狀態（研究問題/假設/證據/衝突），存在 research-gateway。可能需要一分鐘。'}
      >
        {refining ? '… 精煉中' : '✦ 精煉本次共讀'}
      </button>
      {c && (
        <button
          className={`cr-chip shrink-0${injected ? ' cr-chip--on' : ''}`}
          style={{ order: 1 }}
          onClick={handleToggleInject}
          title="把 carryover 摘要注入後續對話（手動，預設關）"
        >
          {injected ? '✓ 已帶上' : '帶上'}
        </button>
      )}
      {c && (
        <button
          className="cr-chat-head-meta"
          style={{ order: 3 }}
          onClick={() => setExpanded(!expanded)}
          title={meta.scope === 'direction'
            ? '這條線上累積的是整個方向底下所有論文的研究狀態'
            : '這篇還沒掛到任何方向，續窗只累積這一篇'}
        >
          {expanded ? '收起' : lineLabel}
        </button>
      )}
      {!c && meta.scope === 'direction' && meta.direction && (
        <span
          className="cr-chat-head-meta"
          style={{ order: 3 }}
          title="這篇還沒精煉過；按下去會餵進這個方向的研究線（跨論文累積）"
        >
          → 方向：{meta.direction.name}
        </span>
      )}
    </>
  );

  // 留在原地的那些：stale 提示、錯誤、carryover 卡、溯源彈窗
  const body = (
    <>
      {/* 對話改過了：只提示，不自動重跑（她 9/18 拍板的手動型） */}
      {stale && (
        <div className="flex items-center gap-2 flex-wrap mt-1">
          <span className="text-xs text-danger">⚠ 這篇的對話改過了</span>
          <button
            className="text-xs px-1.5 py-0.5 rounded-md border border-danger/40 text-danger hover:bg-danger/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={() => handleRefine({ full: true })}
            disabled={refining}
            title="把這篇的對話全文重送一次，改過的地方會走取代流程更新既有結論"
          >
            重新精煉這篇
          </button>
        </div>
      )}
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
    </>
  );

  // 觸發列搬走之後，沒內容的時候就別再留一條 12px 的空白在討論區頂上
  const hasBody = stale || !!error || (c && expanded);

  if (headContainer) {
    return (
      <>
        {createPortal(triggerRow, headContainer)}
        <div className={hasBody ? 'mb-3' : ''}>{body}</div>
      </>
    );
  }

  // 拿不到頭部容器（別處單獨用這個元件）：照舊整塊畫在原地，功能一顆不少
  return (
    <div className="mb-3">
      <div className="flex items-center gap-2 flex-wrap">{triggerRow}</div>
      {body}
    </div>
  );
}
