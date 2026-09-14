// 工單 18 §2 A2／B3：洞察浮現卡的純函式層。
//
// 抽出來的三件事都是「規則」不是「畫面」，所以測得到、也不用假 DOM：
//   ① 來源區塊的三態（有那一問一答／只有 source_context／什麼都沒有）；
//   ② 分數的三檔文字（她不需要看到 0.58 這種數字）；
//   ③ 一路點下去的歷史堆疊上限 10。

/** 浮現卡中段 assistant 回覆先顯示多少字（可展開全文）。 */
export const SOURCE_EXCERPT_CHARS = 300;

/** 一路點相關洞察最多記幾層（§2 B3）。 */
export const HISTORY_MAX = 10;

/**
 * 來源區塊要顯示什麼。
 * @param {object} detail `GET /api/insights/:id` 的回應
 * @returns {{kind:'conversation'|'context'|'none', question:?object, answer:?object, context:string}}
 */
export function describeSourceBlock(detail) {
  const answer = detail?.source_message || null;
  const question = detail?.source_question || null;
  if (answer && (answer.content || '').trim()) {
    return { kind: 'conversation', question, answer, context: '' };
  }
  const context = (detail?.source_context || '').trim();
  if (context) return { kind: 'context', question: null, answer: null, context };
  return { kind: 'none', question: null, answer: null, context: '' };
}

/** 摘錄：超過 `SOURCE_EXCERPT_CHARS` 才需要「展開全文」。 */
export function excerpt(text, chars = SOURCE_EXCERPT_CHARS) {
  const full = String(text || '');
  if (full.length <= chars) return { text: full, truncated: false };
  return { text: `${full.slice(0, chars)}…`, truncated: true };
}

/**
 * 分數 → 三檔文字（§2 B3）。
 *
 * 刻度來自她真資料：分數是「bm25 對自己查自己正規化」的比值，近重複落在
 * 0.55–0.65（#5↔#9 = 0.58、#6↔#10 = 0.62，2026-09-14 唯讀副本），所以 0.55 以上
 * 叫「很像」；門檻 0.35 以上、0.42 以下是「略有關」。
 */
export function scoreLabel(score) {
  const n = Number(score);
  if (!Number.isFinite(n)) return '略有關';
  if (n >= 0.55) return '很像';
  if (n >= 0.42) return '有關';
  return '略有關';
}

/**
 * 往歷史堆疊推一張卡。超過 `HISTORY_MAX` 從最舊的那端丟。
 * 同一個 id 連點兩下不重複推（不然「←」要按兩次才動）。
 */
export function pushHistory(stack, id, max = HISTORY_MAX) {
  const prev = Array.isArray(stack) ? stack : [];
  if (!id) return prev;
  if (prev.length > 0 && prev[prev.length - 1] === id) return prev;
  const next = [...prev, id];
  return next.length > max ? next.slice(next.length - max) : next;
}

/** 「←」：回上一張，回傳 `{ stack, id }`；沒得回時 id 為 null。 */
export function popHistory(stack) {
  const prev = Array.isArray(stack) ? stack : [];
  if (prev.length === 0) return { stack: prev, id: null };
  const next = prev.slice(0, -1);
  return { stack: next, id: prev[prev.length - 1] };
}

/**
 * 「存為洞察」按下去的那一則 assistant，它是在回答哪一則 user（工單 18 §2 A1）。
 *
 * 往前找最近的一則 user——不是 `idx-1`：中間可能夾著別的角色，而且編輯／重生
 * 之後陣列裡的順序是 seq 排的、不保證一問一答貼在一起。找不到回 null。
 */
export function previousUserMessage(messages, idx) {
  const list = Array.isArray(messages) ? messages : [];
  for (let i = Math.min(idx, list.length) - 1; i >= 0; i--) {
    if (list[i]?.role === 'user') return list[i];
  }
  return null;
}
