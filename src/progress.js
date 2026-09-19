// 研究進度（工單 21 §三 B1）——一個方向一張圖的資料來源。
//
// 角色：**純代理 + 本地補料**。gateway 是 claims 的唯一事實源（紅線 2），這裡
// 不落庫、不快取、不改一個欄位——拿到什麼就原樣往前端送。co-reading 只負責兩件
// gateway 不知道的事：① 這個方向底下有哪些論文、② 每篇相對上次精煉的狀態。
//
// 依賴注入照 `src/carryover.js` 的風格（database / fetchImpl / config 三個口），
// 這樣路由測試可以整條走假 gateway，永遠不碰她的生產線。

import db from './db.js';
import { refineStaleness } from './carryover.js';
import { getGatewayConfig } from './gateway.js';
import { log } from './logger.js';

const FETCH_TIMEOUT_MS = 15000; // 與 carryover.js 的 GET 同一個數字
const MAX_DEPTH = 64; // 防 parent_id 成環（同 directions.js）

// gateway 契約的 session_key 正則是 `^(paper|topic):[A-Za-z0-9_-]+$`。
const KEY_SUFFIX_RE = /^[A-Za-z0-9_-]+$/;

export function sessionKeyForDirection(nodeId) {
  return `topic:${nodeId}`;
}

/**
 * 這個方向（含所有子孫節點）底下的論文清單。
 * 方向＝頂層節點，但論文可以掛在子題上——沿 parent_id 收集整棵子樹再撈。
 * @returns {{ id: string, title: string, message_count: number, refine_state: string }[]}
 */
export function listDirectionPapers(nodeId, { database = db } = {}) {
  const nodes = database.prepare('SELECT id, parent_id FROM tree_nodes').all();
  const childrenOf = new Map();
  for (const n of nodes) {
    const key = n.parent_id || null;
    if (!childrenOf.has(key)) childrenOf.set(key, []);
    childrenOf.get(key).push(n.id);
  }

  const ids = [];
  const seen = new Set();
  const walk = (id, depth) => {
    if (seen.has(id) || depth > MAX_DEPTH) return;
    seen.add(id);
    ids.push(id);
    for (const child of childrenOf.get(id) || []) walk(child, depth + 1);
  };
  walk(nodeId, 0);

  const placeholders = ids.map(() => '?').join(',');
  const papers = database
    .prepare(`SELECT id, title FROM papers WHERE tree_node_id IN (${placeholders}) ORDER BY created_at ASC, id ASC`)
    .all(...ids);

  const counts = new Map();
  for (const row of database.prepare('SELECT paper_id, COUNT(*) AS n FROM messages GROUP BY paper_id').all()) {
    counts.set(row.paper_id, row.n);
  }

  return papers.map(p => ({
    id: p.id,
    title: p.title || '',
    message_count: counts.get(p.id) || 0,
    refine_state: refineStaleness(p.id, { database }),
  }));
}

/**
 * 向 gateway 拉整條線的 claims ＋ relations（姊妹單 §四 的形狀）。
 * `include=superseded`：被取代的也拿回來——畫不畫是前端那顆開關的事（Wikidata 式
 * 預設過濾），但資料要在手上，否則開關一打開又要再跑一趟。
 * 失敗只回 `{ok:false, reason}`，不拋（照 carryover.js 的風格）。
 */
export async function fetchDirectionClaims(sessionKey, { fetchImpl = fetch, config = getGatewayConfig() } = {}) {
  if (!config || !config.url) return { ok: false, reason: 'gateway not configured' };
  const url = `${config.url}/claims?session_key=${encodeURIComponent(sessionKey)}&include=superseded`;
  try {
    const res = await fetchImpl(url, {
      headers: config.token ? { Authorization: `Bearer ${config.token}` } : {},
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      log('WARN', `[PROGRESS] 拉 claims 失敗 ${sessionKey}: HTTP ${res.status} ${text.slice(0, 160)}`);
      return { ok: false, reason: `http ${res.status}` };
    }
    const data = await res.json();
    return {
      ok: true,
      claims: Array.isArray(data.claims) ? data.claims : [],
      relations: Array.isArray(data.relations) ? data.relations : [],
      counts: data.counts ?? null,
    };
  } catch (e) {
    log('WARN', `[PROGRESS] 拉 claims 異常 ${sessionKey}: ${e.message}`);
    return { ok: false, reason: e.message };
  }
}

/**
 * B1 的整包：方向 → 論文清單（本地）＋ claims／relations（gateway）。
 * 回 `{ ok, status, body|reason }`，HTTP 狀態碼由路由照 status 送，邏輯本身可單測。
 */
export async function buildDirectionProgress(nodeId, {
  database = db,
  fetchImpl = fetch,
  config = getGatewayConfig(),
} = {}) {
  const node = database
    .prepare('SELECT id, parent_id, name, description FROM tree_nodes WHERE id = ?')
    .get(nodeId);
  if (!node) return { ok: false, status: 404, reason: '節點不存在' };
  // 一張圖只到頂層方向（§三 B1）：子題要看圖就看它所屬的方向那一張。
  if (node.parent_id) return { ok: false, status: 400, reason: '不是頂層方向（研究進度圖一個方向一張）' };
  if (!KEY_SUFFIX_RE.test(node.id)) return { ok: false, status: 400, reason: '節點 id 不合 session_key 契約' };

  const sessionKey = sessionKeyForDirection(node.id);
  const papers = listDirectionPapers(node.id, { database });
  const claims = await fetchDirectionClaims(sessionKey, { fetchImpl, config });
  if (!claims.ok) return { ok: false, status: 502, reason: claims.reason };

  return {
    ok: true,
    status: 200,
    body: {
      direction: { id: node.id, name: node.name, description: node.description || '' },
      session_key: sessionKey,
      papers,
      claims: claims.claims,
      relations: claims.relations,
      counts: claims.counts,
      fetched_at: Date.now(),
    },
  };
}
