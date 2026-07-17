// co-reading → research-gateway 洞察出海管線（outbox pattern，契約 CO-READING-INTEGRATION.md §五）。
//
// 鐵律：發貨失敗絕不阻塞閱讀主流程。extractInsights 先寫本地成功，再 fire-and-forget 呼叫此模組；
// POST 失敗只留 synced_at IS NULL，靠啟動補傳（flushUnsynced）重試，external_id 冪等保證不重複。
//
// 知識樹紅線（契約 §二/§三 + gateway LIBRARY-DESIGN §1.3）：樹「結構」100% 歸 co-reading，
// 出海時只把 paper.tree_node_id 展開成 `tree:<路徑>` 字串，塞進 body.tree_path（M3.c）。

import db from './db.js';
import { getSetting } from './db.js';
import { log } from './logger.js';

/** 把一個 tree_node_id 沿 parent 展開成 "根/.../葉" 路徑字串。無節點 → null。
 *  接受注入的 database 以便測試（預設用共享的 co-reading.db）。 */
export function expandTreePath(treeNodeId, database = db) {
  if (!treeNodeId) return null;
  const stmt = database.prepare('SELECT id, parent_id, name FROM tree_nodes WHERE id = ?');
  const parts = [];
  const seen = new Set();
  let cur = treeNodeId;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const node = stmt.get(cur);
    if (!node) break;
    parts.unshift(node.name);
    cur = node.parent_id;
  }
  return parts.length ? parts.join('/') : null;
}

/** 由一條 insight row 組出契約 §二 的 POST body。tree_path 從 source_paper_id 的 tree_node_id 展開。 */
export function buildInsightPayload(insight, database = db) {
  const paper = insight.source_paper_id
    ? database.prepare('SELECT title, tree_node_id FROM papers WHERE id = ?').get(insight.source_paper_id)
    : null;
  const tree_path = paper ? expandTreePath(paper.tree_node_id, database) : null;
  let tags = [];
  try { tags = JSON.parse(insight.tags_json || '[]'); } catch { tags = []; }

  // 契約 §五：source_context 必帶（非空）。提取器的關鍵詞回找會撲空（改寫後的洞察
  // 匹配不中原話），存量 13 條裡 9 條為空——兜底用誠實的最小來源標注，不編造對話。
  const source_context = (insight.source_context || '').trim()
    || (paper?.title
      ? `出自《${paper.title}》（提取時未保留對話片段）`
      : '（存量洞察，來源上下文未保留）');

  const body = {
    external_id: insight.id,
    title: insight.title || '',
    content: insight.content || '',
    dimension: insight.dimension,
    paper_id: insight.source_paper_id || '',
    paper_title: paper?.title || '',
    source_context,
    tags,
  };
  if (tree_path) body.tree_path = tree_path; // M3.c，僅在有樹路徑時帶
  return body;
}

/** 讀取 gateway 連線設定（Settings 頁可配）。未配置 → null（同步整體跳過，不報錯）。 */
export function getGatewayConfig(getSettingFn = getSetting) {
  const url = (getSettingFn('gateway_url') || '').replace(/\/$/, '');
  const token = getSettingFn('gateway_token') || '';
  if (!url) return null;
  return { url, token };
}

/**
 * 同步單條洞察到 gateway。成功 → 回填 external_ombre_id + synced_at；失敗 → 不拋、不改 row（留 NULL 補傳）。
 * 依賴注入：database / fetchImpl / config 皆可覆寫，方便測試與避免碰生產 DB。
 * @returns {Promise<{ ok: boolean, ombre_id?: string, reason?: string }>}
 */
export async function syncInsight(insight, {
  database = db,
  fetchImpl = fetch,
  config = getGatewayConfig(),
} = {}) {
  if (!config || !config.url) return { ok: false, reason: 'gateway not configured' };

  try {
    const body = buildInsightPayload(insight, database);
    const res = await fetchImpl(`${config.url}/memory/insights`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(config.token ? { Authorization: `Bearer ${config.token}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      log('WARN', `洞察出海失敗 ${insight.id}: HTTP ${res.status} ${text.slice(0, 120)}`);
      return { ok: false, reason: `http ${res.status}` };
    }
    const data = await res.json().catch(() => ({}));
    const ombre_id = data.ombre_id || null;
    database.prepare(
      'UPDATE insights SET external_ombre_id = ?, synced_at = ? WHERE id = ?'
    ).run(ombre_id, Date.now(), insight.id);
    log('INFO', `洞察已出海 ${insight.id} → ombre ${ombre_id}`);
    return { ok: true, ombre_id };
  } catch (e) {
    // 網路/超時/任何錯誤：絕不外拋（fire-and-forget 保證），留待補傳
    log('WARN', `洞察出海異常 ${insight.id}: ${e.message}`);
    return { ok: false, reason: e.message };
  }
}

/** fire-and-forget：extractInsights 寫入後呼叫。永不阻塞、永不拋。傳整個 insight row。 */
export function syncInsightFireAndForget(insight, opts = {}) {
  Promise.resolve()
    .then(() => syncInsight(insight, opts))
    .catch((e) => log('WARN', `洞察出海 fire-and-forget 吞錯 ${insight?.id}: ${e.message}`));
}

/** 啟動補傳：撈所有 synced_at IS NULL 的洞察，逐條重送。冪等鍵保證不重複。 */
export async function flushUnsynced({ database = db, fetchImpl = fetch, config = getGatewayConfig() } = {}) {
  if (!config || !config.url) return { attempted: 0, synced: 0 };
  const pending = database.prepare('SELECT * FROM insights WHERE synced_at IS NULL').all();
  let synced = 0;
  for (const insight of pending) {
    const r = await syncInsight(insight, { database, fetchImpl, config });
    if (r.ok) synced++;
  }
  if (pending.length) log('INFO', `啟動補傳：${synced}/${pending.length} 條洞察出海`);
  return { attempted: pending.length, synced };
}
