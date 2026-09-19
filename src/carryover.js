// Research carryover 薄客戶端（工單 §5.3，S5）——照 src/gateway.js 的形狀：
// 依賴注入（database / fetchImpl / config）、硬超時、失敗只 log 不拋、永不阻塞閱讀主流程。
//
// 角色分工（紅線 5）：consolidation engine 只住在 research-gateway。
// co-reading 只做三件事：① 觸發 refine、② 拿回 carryover 並注入、③ 提供溯源回跳。
//
// 拍板 #1/#3（2026-08-29）：注入=手動（按「帶上」才注入）；不做定時自動 refine。
// carryover_cache 是只讀快取，不是第二個記憶系統——gateway 是唯一事實源。

import { createHash } from 'node:crypto';

import db from './db.js';
import { getSetting } from './db.js';
import { directionOfPaper } from './directions.js';
import { getGatewayConfig } from './gateway.js';
import { log } from './logger.js';

const REFINE_TIMEOUT_MS = 200000; // gateway 內部 run 上限 180s，客戶端留餘裕
const FETCH_TIMEOUT_MS = 15000;

// gateway 契約的 session_key 正則是 `^(paper|topic):[A-Za-z0-9_-]+$`。
// 節點 id 是 nanoid，字元集剛好在裡面；萬一有人手塞了別的 id，退回單篇線而不是送出去被 422。
const KEY_SUFFIX_RE = /^[A-Za-z0-9_-]+$/;

export function sessionKeyFor(paperId) {
  return `paper:${paperId}`;
}

/**
 * 這一篇的精煉要送進哪條線（工單 20 §A1）。
 * 掛在方向底下（含子節點，沿 parent_id 走到頂層）→ 方向線 `topic:<節點 id>`；
 * 沒掛／查不到／id 不合契約 → 照舊單篇線 `paper:<id>`。
 * @returns {{ sessionKey: string, scope: 'direction'|'paper', direction: {id:string,name:string}|null }}
 */
export function resolveSessionKey(paperId, { database = db } = {}) {
  const fallback = { sessionKey: sessionKeyFor(paperId), scope: 'paper', direction: null };
  let direction = null;
  try {
    direction = directionOfPaper(paperId, { database });
  } catch (e) {
    // 方向查詢壞掉絕不能讓精煉掛掉——退回單篇線，行為與方向線出現以前一樣。
    log('WARN', `[CARRYOVER] 方向查詢失敗，退回單篇線: ${e.message}`);
    return fallback;
  }
  if (!direction) return fallback;
  if (!KEY_SUFFIX_RE.test(direction.id)) {
    log('WARN', '[CARRYOVER] direction id 不合契約，退回單篇線');
    return fallback;
  }
  return {
    sessionKey: `topic:${direction.id}`,
    scope: 'direction',
    direction: { id: direction.id, name: direction.name },
  };
}

// ── 每篇一個游標（工單 20 §A2/§A3）─────────────────────────────

/** seq<=lastSeq 那段對話的指紋；lastSeq 為 null 回空字串。 */
export function coveredDigest(paperId, lastSeq, { database = db } = {}) {
  if (lastSeq == null) return '';
  const rows = database
    .prepare('SELECT seq, role, content FROM messages WHERE paper_id = ? AND seq <= ? ORDER BY seq ASC')
    .all(paperId, lastSeq);
  const h = createHash('sha256');
  for (const m of rows) h.update(`${m.seq}|${m.role}|${m.content}\n`);
  return h.digest('hex');
}

export function getRefineCursor(paperId, { database = db } = {}) {
  const row = database.prepare('SELECT * FROM refine_cursor WHERE paper_id = ?').get(paperId);
  if (!row) return null;
  return {
    paperId: row.paper_id,
    sessionKey: row.session_key,
    lastSeq: row.last_seq,
    coveredDigest: row.covered_digest,
    updatedAt: row.updated_at,
  };
}

export function setRefineCursor({ paperId, sessionKey, lastSeq, digest, database = db }) {
  database.prepare(`
    INSERT INTO refine_cursor (paper_id, session_key, last_seq, covered_digest, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(paper_id) DO UPDATE SET
      session_key = excluded.session_key,
      last_seq = excluded.last_seq,
      covered_digest = excluded.covered_digest,
      updated_at = excluded.updated_at
  `).run(paperId, sessionKey, lastSeq, digest, Date.now());
}

/**
 * 這一篇相對於上次精煉的狀態（工單 20 §A3，她 9/18 拍板的手動型）。
 * `stale` 只亮提示，系統絕不自己重跑——要不要重來由她按鈕決定。
 * @returns {'never'|'fresh'|'stale'|'new_messages'}
 */
export function refineStaleness(paperId, { database = db } = {}) {
  const cursor = getRefineCursor(paperId, { database });
  if (!cursor) return 'never';
  if (coveredDigest(paperId, cursor.lastSeq, { database }) !== cursor.coveredDigest) return 'stale';
  const maxSeq = database.prepare('SELECT MAX(seq) AS m FROM messages WHERE paper_id = ?').get(paperId)?.m ?? null;
  if (maxSeq != null && maxSeq > cursor.lastSeq) return 'new_messages';
  return 'fresh';
}

/** .env 開關（工單 §10，預設值＝右欄） */
export const carryoverEnv = {
  autoInject: process.env.CARRYOVER_AUTO_INJECT === 'true', // 拍板 #1：預設手動
  autoRefine: process.env.CARRYOVER_AUTO_REFINE === 'true', // 拍板 #3：預設不定時
};

// ── 請求組裝（純函數，供測試）──────────────────────────────────

/**
 * 由本地 messages/insights 組出契約 §九 的 refine body。
 * 六個欄位一個不多（工單 20 紅線 1）：方向線只是換 `session_key`，payload 形狀不動。
 */
export function buildRefineRequest(paperId, { sinceSeq = null, database = db } = {}) {
  const resolved = resolveSessionKey(paperId, { database });
  const paper = database.prepare('SELECT id, title FROM papers WHERE id = ?').get(paperId);
  const transcript = database
    .prepare('SELECT seq, role, content FROM messages WHERE paper_id = ? ORDER BY seq ASC')
    .all(paperId)
    .map(m => ({ seq: m.seq, role: m.role, content: m.content }));
  const insights = database
    .prepare('SELECT id, dimension, title FROM insights WHERE source_paper_id = ? ORDER BY created_at ASC')
    .all(paperId);
  return {
    paper,
    transcript,
    resolved,
    body: {
      source: 'co-reading',
      session_key: resolved.sessionKey,
      paper_id: paperId,
      paper_title: paper?.title ?? '',
      transcript,
      since_seq: sinceSeq,
      insights,
    },
  };
}

// ── 快取讀寫 ───────────────────────────────────────────────────

export function cacheCarryover({ sessionKey, payload, version, lastSeq = null, database = db }) {
  database.prepare(`
    INSERT INTO carryover_cache (session_key, payload_json, version, last_seq, fetched_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(session_key) DO UPDATE SET
      payload_json = excluded.payload_json,
      version = excluded.version,
      last_seq = COALESCE(excluded.last_seq, carryover_cache.last_seq),
      fetched_at = excluded.fetched_at
  `).run(sessionKey, JSON.stringify(payload), version, lastSeq, Date.now());
}

export function getCachedCarryover(sessionKey, { database = db } = {}) {
  const row = database.prepare('SELECT * FROM carryover_cache WHERE session_key = ?').get(sessionKey);
  if (!row) return null;
  return { sessionKey, version: row.version, lastSeq: row.last_seq, fetchedAt: row.fetched_at, payload: JSON.parse(row.payload_json) };
}

/** 「帶上」開關（拍板 #1：手動注入）。settings 表 per-paper 記錄；env auto-inject 全域預設。 */
export function isCarryoverInjected(paperId, { database = db } = {}) {
  if (carryoverEnv.autoInject) return true;
  const row = database.prepare('SELECT value FROM settings WHERE key = ?').get('carryover_inject:' + paperId);
  return row?.value === '1';
}

export function setCarryoverInjected(paperId, enabled, { database = db } = {}) {
  database.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
    .run('carryover_inject:' + paperId, enabled ? '1' : '0');
  return enabled;
}

// ── 失敗文案（工單 22）────────────────────────────────────────
//
// gateway 失敗回 `{ error: { type, message, code, detail } }`（姊妹單 E2）。
// `code` 是穩定的機器碼；這張表把它翻成她看得懂的一句話——她按下「精煉」看到的
// 永遠是同一句「http 502」時，分不出沒錢／key 壞／模型下架／逾時（9/19 實錄）。
// 舊 gateway 沒有 `code` ⇒ 退回現況 `http <status>`，不假裝知道原因。
const REFINE_FAILURE_COPY = {
  provider_payment: '上游拒絕：帳戶餘額不足（去充值或換供應商）',
  provider_auth: '上游拒絕：金鑰無效或過期',
  provider_not_found: '上游找不到這個模型（檢查 REFINE_MODEL）',
  provider_missing_session: '上游缺 session 標頭（gateway 版本太舊）',
  provider_bad_request: '上游拒絕這個請求（參數或格式）',
  provider_rate_limited: '上游限流，等一下再按',
  provider_server_error: '上游暫時故障，等一下再按',
  provider_unreachable: '連不上上游（VPS 到供應商的網路）',
  provider_empty: '模型這次沒給合格的答案，再按一次通常就好',
  provider_invalid_stream: '模型這次沒給合格的答案，再按一次通常就好',
  output_parse: '模型這次沒給合格的答案，再按一次通常就好',
  output_schema: '模型這次沒給合格的答案，再按一次通常就好',
  timeout: '精煉逾時（對話太長或上游太慢），再按一次',
  config: 'gateway 沒設定精煉模型',
  input: '沒有新對話可精煉',
};

/**
 * 把 gateway 的失敗回應翻成一句中文。純函數，不外呼、不寫庫、不 log。
 * 表上沒有的 code（例如 `internal`）一律退回 `http <status>`——寧可誠實說不知道，
 * 也不要編一句安撫的話；`code` 仍原樣回去，日誌與回應裡看得到真碼。
 * @param {{ status?: number|string, body?: object }} args
 * @returns {{ reason: string, code: string|null, detail: string|null }}
 */
export function describeRefineFailure({ status, body } = {}) {
  const err = (body && typeof body === 'object' && body.error && typeof body.error === 'object')
    ? body.error
    : {};
  const code = typeof err.code === 'string' && err.code ? err.code : null;
  const detail = typeof err.detail === 'string' && err.detail ? err.detail : null;
  const type = typeof err.type === 'string' && err.type ? err.type : null;

  const copy = code ? REFINE_FAILURE_COPY[code] : null;
  const fallback = `http ${status ?? 'error'}${type ? `（${type}）` : ''}`;
  return { reason: copy || fallback, code, detail };
}

// ── 外呼 ───────────────────────────────────────────────────────

/**
 * 觸發精煉。無新訊息（≤ last_seq）→ 本地冪等短路，零外呼。
 * 失敗時 `reason` 是給她看的一句話（工單 22），`code`／`detail` 是機器碼與 gateway 的安全短句。
 * @returns {Promise<{ok:boolean, reason?:string, code?:string|null, detail?:string|null, run_id?:string, version?:number, idempotent?:boolean, stats?:object, carryover?:object}>}
 */
export async function requestRefine(paperId, { sinceSeq = undefined, database = db, fetchImpl = fetch, config = getGatewayConfig() } = {}) {
  if (!config || !config.url) return { ok: false, reason: 'gateway not configured' };
  const { sessionKey, scope, direction } = resolveSessionKey(paperId, { database });

  // 游標是 per-paper 的；線換了（例如她剛把這篇掛上方向）就 since_seq=null 全文重送，
  // 否則新線上會缺前半段對話。gateway 靠 transcript 指紋冪等，重送不會重算。
  const cursor = getRefineCursor(paperId, { database });
  const cursorSince = cursor && cursor.sessionKey === sessionKey ? cursor.lastSeq : null;

  const { transcript, body } = buildRefineRequest(paperId, {
    sinceSeq: sinceSeq === undefined ? cursorSince : sinceSeq,
    database,
  });

  const maxSeq = transcript.length > 0 ? Math.max(...transcript.map(m => m.seq ?? 0)) : null;
  if (body.since_seq != null && (maxSeq == null || maxSeq <= body.since_seq)) {
    const cached = getCachedCarryover(sessionKey, { database });
    if (cached) {
      return {
        ok: true, idempotent: true, version: cached.version, carryover: cached.payload,
        reason: 'no new messages', session_key: sessionKey, scope, direction,
      };
    }
    return { ok: false, reason: 'no new messages and nothing cached' };
  }

  try {
    const res = await fetchImpl(`${config.url}/sessions/refine`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(config.token ? { Authorization: `Bearer ${config.token}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REFINE_TIMEOUT_MS),
    });
    if (!res.ok) {
      // body 原文不進日誌（可能夾著上游回的原始訊息）；只留機器碼與 gateway 自己
      // 挑過的安全短句（姊妹單 E2 釘死 detail 的形狀）。
      let payload = {};
      try { payload = (await res.json()) ?? {}; } catch { payload = {}; }
      const { reason, code, detail } = describeRefineFailure({ status: res.status, body: payload });
      log('WARN', `精煉失敗 ${paperId}: HTTP ${res.status} code=${code ?? '-'} detail=${detail ?? '-'}`);
      return { ok: false, reason, code, detail };
    }
    const data = await res.json();
    cacheCarryover({
      sessionKey,
      payload: data.carryover,
      version: data.version,
      lastSeq: maxSeq,
      database,
    });
    if (maxSeq != null) {
      setRefineCursor({
        paperId,
        sessionKey,
        lastSeq: maxSeq,
        digest: coveredDigest(paperId, maxSeq, { database }),
        database,
      });
    }
    log('INFO', `精煉完成 ${paperId} → run ${data.run_id}（線 ${sessionKey}${direction ? `／方向「${direction.name}」` : ''}，idempotent=${data.idempotent}，claims 統計 ${JSON.stringify(data.stats)}）`);
    return {
      ok: true,
      run_id: data.run_id,
      version: data.version,
      idempotent: data.idempotent,
      stats: data.stats,
      carryover: data.carryover,
      session_key: sessionKey,
      scope,
      direction,
    };
  } catch (e) {
    log('WARN', `精煉異常 ${paperId}: ${e.message}`);
    return { ok: false, reason: e.message };
  }
}

/** 向 gateway 拉最新 carryover 並快取。失敗回 null（caller 可退回本地快取）。 */
export async function fetchCarryover(sessionKey, { database = db, fetchImpl = fetch, config = getGatewayConfig() } = {}) {
  if (!config || !config.url) return null;
  try {
    const res = await fetchImpl(`${config.url}/carryover/${encodeURIComponent(sessionKey)}`, {
      headers: config.token ? { Authorization: `Bearer ${config.token}` } : {},
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = await res.json();
    cacheCarryover({ sessionKey, payload: data.carryover, version: data.version, database });
    return { version: data.version, payload: data.carryover };
  } catch (e) {
    log('WARN', `拉取 carryover 異常 ${sessionKey}: ${e.message}`);
    return null;
  }
}

/** 向 gateway 拉一條 claim 的溯源（provenance）——前端經 co-reading 後端代理，不直連 gateway。 */
export async function fetchClaimProvenance(claimId, { fetchImpl = fetch, config = getGatewayConfig() } = {}) {
  if (!config || !config.url) return { ok: false, reason: 'gateway not configured' };
  try {
    const res = await fetchImpl(`${config.url}/claims/${encodeURIComponent(claimId)}/provenance`, {
      headers: config.token ? { Authorization: `Bearer ${config.token}` } : {},
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, reason: `http ${res.status}` };
    return { ok: true, provenance: await res.json() };
  } catch (e) {
    log('WARN', `拉取 provenance 異常 ${claimId}: ${e.message}`);
    return { ok: false, reason: e.message };
  }
}

// ── 注入渲染（§5.3：結構化摘要，每段最多 N 條、每條一行、必帶 origin 標記）──

const ORIGIN_LABELS = {
  paper_reported: '論文報告',
  author_interpretation: '作者解釋',
  experimental_observation: '實驗觀察',
  user_hypothesis: '你的假設，未驗證',
  ai_hypothesis: 'AI 推導，未驗證',
  methodological_speculation: '方法論推測，未驗證',
  background_knowledge: '背景知識',
  unresolved_disagreement: '未解爭議',
};

function renderItem(item) {
  const label = ORIGIN_LABELS[item.epistemic_origin] ?? item.epistemic_origin;
  return `- [${item.claim_kind}｜${label}] ${item.statement}`;
}

/** 把 carryover 渲染成注入文字（帶 origin、衝突醒目、每段限量）。 */
export function renderCarryoverForPrompt(carryover, { maxPerSection = 6 } = {}) {
  if (!carryover) return '';
  const sections = [];
  const push = (title, items, renderer = renderItem) => {
    if (!items || items.length === 0) return;
    sections.push(`${title}：\n` + items.slice(0, maxPerSection).map(renderer).join('\n'));
  };

  if (carryover.research_question) {
    sections.push(`研究問題：\n${renderItem(carryover.research_question)}`);
  }
  push('當前假設', carryover.hypotheses);
  push('已確認發現', carryover.confirmed_findings);
  push('方法論筆記', carryover.methodological_notes);
  push('已做的決定', carryover.decisions);
  push('開放問題', carryover.open_questions);
  push('下一步', carryover.next_actions);
  push('被否決的解釋', carryover.rejected_explanations,
    x => `- [被否決] ${x.statement}${x.rejected_because ? `（原因：${x.rejected_because}）` : ''}`);
  // 衝突永遠完整注入（不得只注入支持面——工單 §10.1 硬規則 2）
  push('⚠ 證據衝突（未解決，兩邊都站著）', carryover.conflicting_evidence,
    x => `- [衝突] ${x.statement} ⇄ ${x.counterpart_statement ?? '對立主張'}`);

  if (sections.length === 0) return '';
  return `\n\n【研究續窗】以下是本篇共讀此前累積的研究狀態（精煉自舊對話）。標記「未驗證」的是假設，不是論文事實；衝突證據兩邊都保留。\n${sections.join('\n')}`;
}

/** chatAboutPaper 注入入口：per-paper「帶上」開關 + 本地快取。 */
export function renderCarryoverForInjection(paperId, { database = db } = {}) {
  if (!isCarryoverInjected(paperId, { database })) return '';
  // 「帶上」仍是 per-paper 開關；注入的是這篇解析後那條線的 payload（方向線＝方向級內容）。
  const { sessionKey } = resolveSessionKey(paperId, { database });
  const cached = getCachedCarryover(sessionKey, { database });
  return renderCarryoverForPrompt(cached?.payload);
}
