// Research carryover 薄客戶端（工單 §5.3，S5）——照 src/gateway.js 的形狀：
// 依賴注入（database / fetchImpl / config）、硬超時、失敗只 log 不拋、永不阻塞閱讀主流程。
//
// 角色分工（紅線 5）：consolidation engine 只住在 research-gateway。
// co-reading 只做三件事：① 觸發 refine、② 拿回 carryover 並注入、③ 提供溯源回跳。
//
// 拍板 #1/#3（2026-08-29）：注入=手動（按「帶上」才注入）；不做定時自動 refine。
// carryover_cache 是只讀快取，不是第二個記憶系統——gateway 是唯一事實源。

import db from './db.js';
import { getSetting } from './db.js';
import { getGatewayConfig } from './gateway.js';
import { log } from './logger.js';

const REFINE_TIMEOUT_MS = 200000; // gateway 內部 run 上限 180s，客戶端留餘裕
const FETCH_TIMEOUT_MS = 15000;

export function sessionKeyFor(paperId) {
  return `paper:${paperId}`;
}

/** .env 開關（工單 §10，預設值＝右欄） */
export const carryoverEnv = {
  autoInject: process.env.CARRYOVER_AUTO_INJECT === 'true', // 拍板 #1：預設手動
  autoRefine: process.env.CARRYOVER_AUTO_REFINE === 'true', // 拍板 #3：預設不定時
};

// ── 請求組裝（純函數，供測試）──────────────────────────────────

/** 由本地 messages/insights 組出契約 §九 的 refine body。 */
export function buildRefineRequest(paperId, { sinceSeq = null, database = db } = {}) {
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
    body: {
      source: 'co-reading',
      session_key: sessionKeyFor(paperId),
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

// ── 外呼 ───────────────────────────────────────────────────────

/**
 * 觸發精煉。無新訊息（≤ last_seq）→ 本地冪等短路，零外呼。
 * @returns {Promise<{ok:boolean, reason?:string, run_id?:string, version?:number, idempotent?:boolean, stats?:object, carryover?:object}>}
 */
export async function requestRefine(paperId, { sinceSeq = undefined, database = db, fetchImpl = fetch, config = getGatewayConfig() } = {}) {
  if (!config || !config.url) return { ok: false, reason: 'gateway not configured' };
  const sessionKey = sessionKeyFor(paperId);

  const { transcript, body } = buildRefineRequest(paperId, {
    sinceSeq: sinceSeq === undefined ? getCachedCarryover(sessionKey, { database })?.lastSeq ?? null : sinceSeq,
    database,
  });

  const maxSeq = transcript.length > 0 ? Math.max(...transcript.map(m => m.seq ?? 0)) : null;
  if (body.since_seq != null && (maxSeq == null || maxSeq <= body.since_seq)) {
    const cached = getCachedCarryover(sessionKey, { database });
    if (cached) return { ok: true, idempotent: true, version: cached.version, carryover: cached.payload, reason: 'no new messages' };
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
      const text = await res.text().catch(() => '');
      log('WARN', `精煉失敗 ${paperId}: HTTP ${res.status} ${text.slice(0, 160)}`);
      return { ok: false, reason: `http ${res.status}` };
    }
    const data = await res.json();
    cacheCarryover({
      sessionKey,
      payload: data.carryover,
      version: data.version,
      lastSeq: maxSeq,
      database,
    });
    log('INFO', `精煉完成 ${paperId} → run ${data.run_id}（idempotent=${data.idempotent}，claims 統計 ${JSON.stringify(data.stats)}）`);
    return {
      ok: true,
      run_id: data.run_id,
      version: data.version,
      idempotent: data.idempotent,
      stats: data.stats,
      carryover: data.carryover,
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
  const cached = getCachedCarryover(sessionKeyFor(paperId), { database });
  return renderCarryoverForPrompt(cached?.payload);
}
