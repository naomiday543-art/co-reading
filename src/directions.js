// 研究方向 × 知識樹合流（工單 07 §3.1/§3.2）。
//
// 研究方向 = 知識樹的**頂層節點**（parent_id IS NULL），子節點是方向底下的子題，不當方向。
// 這個檔案**只讀**：把「她在做哪幾個方向」組成一段文字，給討論 system 與提取 system 注入。
// 紅線：沒有任何方向時 renderDirectionsBlock() 回空字串，注入點一個字都不加。
// 注入的描述原樣放進 prompt，不做任何改寫（工單 §5）。
import db from './db.js';
import { log } from './logger.js';

// 防 parent_id 成環或樹深到誇張：注入一段 prompt 不值得把伺服器轉死。
const MAX_DEPTH = 64;

export const DESCRIPTION_MAX = 2000;

const GUIDE_LINES = '判斷「延伸」「你的研究」時以這裡為準：跟這篇所屬方向直接相關的是「你的研究」；\n從這篇跳到她另一個方向的是「延伸」。';

// 「名字 — 描述」；描述為空的方向只印名字（工單 §3.2）。
function formatDirection(d) {
  const desc = (d.description || '').trim();
  return desc ? `${d.name} — ${desc}` : d.name;
}

function formatList(directions) {
  // 一個方向就照 §3.2 的範本接在標籤後面；多個才逐行列，避免多行描述串成一團。
  if (directions.length === 1) return formatDirection(directions[0]);
  return '\n' + directions.map(d => `- ${formatDirection(d)}`).join('\n');
}

/**
 * 所有研究方向（頂層節點），依 sort_order。
 * paperCount = 該方向**連同所有子題**底下的論文數（方向是一個領域，不只是一個資料夾）。
 * @returns {{ id: string, name: string, description: string, paperCount: number }[]}
 */
export function listDirections() {
  const nodes = db.prepare(
    'SELECT id, parent_id, name, description FROM tree_nodes ORDER BY sort_order, name'
  ).all();

  const directCounts = new Map();
  for (const row of db.prepare(
    'SELECT tree_node_id AS id, COUNT(*) AS n FROM papers WHERE tree_node_id IS NOT NULL GROUP BY tree_node_id'
  ).all()) {
    directCounts.set(row.id, row.n);
  }

  const childrenOf = new Map();
  for (const n of nodes) {
    const key = n.parent_id || null;
    if (!childrenOf.has(key)) childrenOf.set(key, []);
    childrenOf.get(key).push(n);
  }

  function subtreeCount(node, depth) {
    let total = directCounts.get(node.id) || 0;
    if (depth >= MAX_DEPTH) return total;
    for (const child of childrenOf.get(node.id) || []) {
      total += subtreeCount(child, depth + 1);
    }
    return total;
  }

  return (childrenOf.get(null) || []).map(n => ({
    id: n.id,
    name: n.name,
    description: n.description || '',
    paperCount: subtreeCount(n, 0),
  }));
}

/**
 * 這篇論文屬於哪個方向：沿 tree_node_id 的 parent_id 往上走到頂層節點。
 * 沒掛節點、節點不存在、論文不存在都回 null。
 * @param {string} paperId
 * @returns {{ id: string, name: string, description: string } | null}
 */
export function directionOfPaper(paperId) {
  const paper = db.prepare('SELECT tree_node_id FROM papers WHERE id = ?').get(paperId);
  if (!paper || !paper.tree_node_id) return null;

  const byId = db.prepare('SELECT id, parent_id, name, description FROM tree_nodes WHERE id = ?');
  let node = byId.get(paper.tree_node_id);
  if (!node) return null;

  let depth = 0;
  while (node.parent_id && depth++ < MAX_DEPTH) {
    const parent = byId.get(node.parent_id);
    if (!parent) break;
    node = parent;
  }

  return { id: node.id, name: node.name, description: node.description || '' };
}

/**
 * 注入用的方向區塊 + 給 log 用的中繼資料。
 * @param {string} paperId
 * @returns {{ block: string, directionName: string | null, total: number }}
 */
export function buildDirectionsContext(paperId) {
  try {
    const directions = listDirections();
    if (directions.length === 0) return { block: '', directionName: null, total: 0 };

    const own = directionOfPaper(paperId);
    const lines = ['【她的研究方向】'];

    if (own) {
      lines.push(`這篇論文屬於：${formatDirection(own)}`);
      const others = directions.filter(d => d.id !== own.id);
      if (others.length > 0) lines.push(`她另外還有的方向：${formatList(others)}`);
    } else {
      lines.push('這篇論文尚未歸入任何方向');
      lines.push(`她的研究方向：${formatList(directions)}`);
    }

    lines.push(GUIDE_LINES);

    return {
      block: lines.join('\n'),
      directionName: own ? own.name : null,
      total: directions.length,
    };
  } catch (err) {
    // 方向區塊壞掉絕不能讓討論／提取掛掉——退回「什麼都不注入」。
    log('ERROR', `[DIRECTIONS] 區塊組裝失敗，這輪不注入: ${err.message}`);
    return { block: '', directionName: null, total: 0 };
  }
}

/**
 * 注入用的方向區塊；沒有任何方向回 ''（紅線：注入點不得多一個換行）。
 * @param {string} paperId
 * @returns {string}
 */
export function renderDirectionsBlock(paperId) {
  return buildDirectionsContext(paperId).block;
}
