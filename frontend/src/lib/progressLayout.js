// 研究進度圖的佈局引擎（工單 21 §五）——純函式，不碰 React、不碰 DOM，可單元測。
//
// **兩趟走**（調研報告坑①，不可省）：d3-hierarchy 的 `stratify()` 遇到多父、多根、
// 有環會直接 `throw`，而她的資料三種都會踩。所以這裡自己挑一棵生成樹：
//   ① 只用「往外長」的關係（answers／refines／supports／partially_supports）選結構父，
//      一個節點最多一個父；多的、成環的、指向看不見節點的，全部降級成疊圖層的橫線。
//   ② 把這棵乾淨的樹丟給 `d3.tree()` 拿座標。
//   ③ `contradicts` **永不參與佈局**（紅線 3），事後照兩端算好的座標疊上去。
//
// 節點高度只是「排版用的估算」：真正的換行交給瀏覽器（HTML 節點層疊在 SVG 邊層上，
// 坑②）。估錯一行不會壞版面，只會多／少一點空白。

import { hierarchy, tree as d3tree } from 'd3-hierarchy';

/** 能當結構邊的關係（「往外長」的那幾種）。順序＝挑結構父時的偏好順序。 */
export const TREE_RELATION_KINDS = ['answers', 'refines', 'supports', 'partially_supports'];

/** `contradicts` 不在上面那張表裡——它永遠是橫線，不是樹枝。 */
export const OVERLAY_ONLY_KINDS = ['contradicts'];

export const CARD_W = 220;      // 節點卡寬（§六）
export const COL_W = 260;       // 每一層的水平間距
export const ROW_GAP = 12;      // 相鄰節點的垂直留白
export const LINE_H = 20;       // 一行 statement 的高
export const MARGIN = 24;       // 畫布邊距
export const CLAIM_CHROME_H = 34; // 卡片上下 padding ＋ 底部那行小字
export const DIRECTION_H = 64;
export const PAPER_H = 64;
export const GROUP_H = 44;

export const GROUP_NODE_ID = 'group:discussion';
export const GROUP_LABEL = '討論（跨篇）';

const MAX_DEPTH = 512; // 防呆：成環檢查往上走的上限

export const directionNodeId = (id) => `direction:${id}`;
export const paperNodeId = (id) => `paper:${id}`;
export const claimNodeId = (id) => `claim:${id}`;

/**
 * 一行放得下幾個中文字。
 *
 * **偏離工單 §五（≤24／≤48）**：卡寬 220px 扣掉色條與左右 padding 剩約 200px，
 * statement 是 12px，一個中文字就是 12px ⇒ 一行只放得下 16 個字。照 24 估會把
 * 兩行的句子當一行，卡片高度不夠、字被 `overflow:hidden` 切掉。估算的用途是排版，
 * 排得對才有意義，所以照量到的數字走（拉丁字母更窄，中文是最壞情況）。
 */
export const CHARS_PER_LINE = 16;
export const MAX_LINES = 3; // 與 CSS 的 `-webkit-line-clamp:3` 同一個數字

/**
 * statement 要幾行。只用來排版；真正的換行與截斷交給瀏覽器（坑②）。
 */
export function estimateLines(statement = '') {
  const len = [...String(statement || '')].length;
  return Math.min(MAX_LINES, Math.max(1, Math.ceil(len / CHARS_PER_LINE)));
}

/** 節點高度估算（排版用）。 */
export function nodeHeight(node) {
  if (node.kind === 'direction') return DIRECTION_H;
  if (node.kind === 'paper') return PAPER_H;
  if (node.kind === 'group') return GROUP_H;
  return CLAIM_CHROME_H + estimateLines(node.data?.statement) * LINE_H;
}

const isActive = (claim) => (claim?.status ?? 'active') === 'active';

/**
 * 穩定排序：`(created_at, id)`。
 * gateway 同毫秒插入的 relations 順序不保證，而「第一條 outgoing 當結構父」的結果
 * 必須每次一樣——否則同一批資料會畫出兩張不同的圖。
 */
function sortedByTime(rows = []) {
  return [...rows].sort((a, b) => {
    const ta = Number(a?.created_at ?? 0);
    const tb = Number(b?.created_at ?? 0);
    if (ta !== tb) return ta - tb;
    return String(a?.id ?? '').localeCompare(String(b?.id ?? ''));
  });
}

function paperIdsOf(claim) {
  return Array.isArray(claim?.paper_ids) ? claim.paper_ids.filter(Boolean) : [];
}

/**
 * 一張圖。
 *
 * @param {object} input
 * @param {{id:string,name:string,description?:string}} input.direction
 * @param {{id:string,title:string,message_count?:number,refine_state?:string}[]} input.papers
 * @param {object[]} input.claims gateway 原樣（含 superseded／merged）
 * @param {object[]} input.relations gateway 原樣（整條線，一列一條）
 * @param {boolean} [input.showSuperseded] 「顯示走過的路」開關，預設關（Wikidata 式預設過濾）
 * @param {Set<string>|string[]} [input.collapsed] 收起來的節點 id（工單 23）。收起的節點自己
 *   留在圖上（多帶 `collapsed`／`hiddenClaims`／`hiddenOverlays`），後代整棵不進 `nodes`。
 *   空集合或不給 ⇒ 輸出與工單 21 逐位相同。
 * @returns {{nodes:object[],treeEdges:object[],overlayEdges:object[],warnings:object[],bounds:{width:number,height:number}}}
 */
export function layoutProgress({
  direction = null,
  papers = [],
  claims = [],
  relations = [],
  showSuperseded = false,
  collapsed = null,
} = {}) {
  const warnings = [];
  const warn = (type, message, extra = {}) => warnings.push({ type, message, ...extra });

  const rootId = directionNodeId(direction?.id ?? 'root');

  // ── 可見集合 ────────────────────────────────────────────────
  const allClaims = new Map();
  for (const c of claims || []) {
    if (c && c.id != null && !allClaims.has(c.id)) allClaims.set(c.id, c);
  }
  const visible = sortedByTime([...allClaims.values()].filter(c => isActive(c) || showSuperseded));
  const visibleById = new Map(visible.map(c => [c.id, c]));

  const paperMeta = new Map((papers || []).filter(Boolean).map(p => [p.id, p]));

  // ── 節點表 ─────────────────────────────────────────────────
  const nodes = new Map();
  const childrenOf = new Map();
  const parentOf = new Map();

  const addNode = (node) => {
    if (!nodes.has(node.id)) {
      nodes.set(node.id, node);
      childrenOf.set(node.id, []);
    }
    return nodes.get(node.id);
  };
  const attach = (childId, parentId) => {
    parentOf.set(childId, parentId);
    childrenOf.get(parentId).push(childId);
  };

  addNode({ id: rootId, kind: 'direction', data: direction || { id: 'root', name: '未命名方向' } });

  // 論文節點：**只列有 claims 的**（§五）。順序照 B1 給的順序（上傳序）。
  const papersWithClaims = new Set();
  for (const c of visible) {
    const first = paperIdsOf(c)[0];
    if (first) papersWithClaims.add(first);
  }
  const orderedPaperIds = [
    ...(papers || []).map(p => p?.id).filter(id => id && papersWithClaims.has(id)),
    ...[...papersWithClaims].filter(id => !paperMeta.has(id)),
  ];
  for (const pid of orderedPaperIds) {
    const meta = paperMeta.get(pid) || { id: pid, title: '' };
    addNode({ id: paperNodeId(pid), kind: 'paper', data: meta });
  }

  // 討論（跨篇）節點：有東西掛進去才建（§五）。
  let groupCreated = false;
  const ensureGroup = () => {
    if (!groupCreated) {
      addNode({ id: GROUP_NODE_ID, kind: 'group', data: { label: GROUP_LABEL } });
      attach(GROUP_NODE_ID, rootId);
      groupCreated = true;
    }
    return GROUP_NODE_ID;
  };

  // claim 節點先全部建起來（結構父下一步才決定）。
  for (const c of visible) addNode({ id: claimNodeId(c.id), kind: 'claim', data: c });

  // ── 第一趟：挑結構父 ────────────────────────────────────────
  const rels = sortedByTime((relations || []).filter(r => r && r.from_id != null && r.to_id != null));
  const outgoing = new Map();
  for (const r of rels) {
    if (!outgoing.has(r.from_id)) outgoing.set(r.from_id, []);
    outgoing.get(r.from_id).push(r);
  }

  let overlayEdges = [];
  const pushOverlay = (relation, extra = {}) => {
    const fromId = claimNodeId(relation.from_id);
    const toId = claimNodeId(relation.to_id);
    if (!nodes.has(fromId) || !nodes.has(toId)) return false;
    overlayEdges.push({
      id: relation.id ?? `${relation.from_id}->${relation.to_id}:${relation.kind}`,
      from: fromId,
      to: toId,
      kind: relation.kind,
      note: relation.note ?? null,
      crossPaper: isCrossPaper(visibleById.get(relation.from_id), visibleById.get(relation.to_id)),
      ...extra,
    });
    return true;
  };

  // 在「每個節點最多一個父」的圖上，加一條 child→parent 會成環，
  // 等價於「從 parent 往上走得到 child」。所以每次指派前走一次就夠。
  const wouldCycle = (childId, parentId) => {
    let cur = parentId;
    for (let i = 0; cur && i < MAX_DEPTH; i++) {
      if (cur === childId) return true;
      cur = parentOf.get(cur);
    }
    return false;
  };

  for (const claim of visible) {
    const id = claimNodeId(claim.id);

    // 研究問題直接掛根（§五）——它是這條線的頭，不掛在論文底下。
    if (claim.claim_kind === 'research_question') {
      attach(id, rootId);
      for (const r of outgoing.get(claim.id) || []) {
        if (TREE_RELATION_KINDS.includes(r.kind)) pushOverlay(r, { downgraded: true });
      }
      continue;
    }

    const candidates = (outgoing.get(claim.id) || []).filter(r => TREE_RELATION_KINDS.includes(r.kind));
    let structuralParent = null;

    for (const r of candidates) {
      const targetNodeId = claimNodeId(r.to_id);
      if (structuralParent) {
        // 多父：只留第一條當結構邊，其餘降級成橫線（§五）。
        if (pushOverlay(r, { downgraded: true })) {
          warn('multi_parent', `「${short(claim.statement)}」有多個父，只有第一條進樹`, {
            claim_id: claim.id, relation_id: r.id ?? null,
          });
        }
        continue;
      }
      // 目標不在可見集合（被取代而藏起來，或 gateway 回了懸空邊）——不能當結構父，
      // 也畫不出橫線。統一由下面的懸空邊巡查記 warning，這裡直接略過（絕不拋）。
      if (!nodes.has(targetNodeId)) continue;
      if (wouldCycle(id, targetNodeId)) {
        if (pushOverlay(r, { downgraded: true })) {
          warn('cycle', `「${short(claim.statement)}」的 ${r.kind} 會成環，降級成橫線`, {
            claim_id: claim.id, relation_id: r.id ?? null,
          });
        }
        continue;
      }
      structuralParent = targetNodeId;
    }

    if (structuralParent) {
      attach(id, structuralParent);
      continue;
    }

    // 保底父＝它出自的論文（42% 的孤兒就是靠這條不飄走）；還沒有 → 討論（跨篇）。
    const firstPaper = paperIdsOf(claim)[0];
    if (firstPaper && nodes.has(paperNodeId(firstPaper))) {
      attach(id, paperNodeId(firstPaper));
    } else {
      attach(id, ensureGroup());
    }
  }

  // 論文節點掛根。childrenOf 的順序就是畫出來的上下序，所以最後統一排一次：
  // 研究問題（線的頭）→ 論文（上傳序）→ 討論（跨篇）。
  for (const pid of orderedPaperIds) attach(paperNodeId(pid), rootId);
  const rootRank = (id) => (nodes.get(id).kind === 'claim' ? 0 : nodes.get(id).kind === 'paper' ? 1 : 2);
  const rootChildren = childrenOf.get(rootId);
  rootChildren.sort((a, b) => rootRank(a) - rootRank(b));

  // ── 懸空邊巡查 ─────────────────────────────────────────────
  // gateway 的 `relations` 是整條線的邊，**可能指向不在 claims 清單裡的節點**
  // （被取代、被合併、或預設回應沒帶回來）。兩端任一端找不到節點就略過、記一筆，
  // 永不拋——圖少一條線可以，整頁白掉不行。contradicts 另外報（紅線 3 要看得見）。
  for (const r of rels) {
    if (visibleById.has(r.from_id) && visibleById.has(r.to_id)) continue;
    if (OVERLAY_ONLY_KINDS.includes(r.kind)) continue;
    warn('dangling_edge', `一條 ${r.kind} 的端點不在圖上，已略過`, {
      relation_id: r.id ?? null, kind: r.kind, from_id: r.from_id, to_id: r.to_id,
    });
  }

  // ── contradicts＋被取代：事後疊上去（永不參與佈局，紅線 3）──
  for (const r of rels) {
    if (!OVERLAY_ONLY_KINDS.includes(r.kind)) continue;
    if (!pushOverlay(r)) {
      warn('contradicts_hidden', '一條矛盾邊的另一端不在圖上（多半是被取代了，打開「顯示走過的路」看看）', {
        relation_id: r.id ?? null, from_id: r.from_id, to_id: r.to_id,
      });
    }
  }
  for (const claim of visible) {
    if (isActive(claim) || !claim.superseded_by) continue;
    const successor = claimNodeId(claim.superseded_by);
    if (!nodes.has(successor)) continue;
    overlayEdges.push({
      id: `superseded:${claim.id}`,
      from: claimNodeId(claim.id),
      to: successor,
      kind: 'superseded_by',
      note: claim.supersede_reason ?? null,
      crossPaper: isCrossPaper(claim, visibleById.get(claim.superseded_by)),
    });
  }

  // ── 修剪：收起的節點把後代藏起來（工單 23 D1）──────────────
  //
  // 位置是刻意的：**結構樹已經建完、座標還沒算**。上面挑結構父／降級多父與成環／
  // 懸空邊巡查／contradicts 疊圖那幾段規則一個字都沒動——收合只做兩件事：
  //   ① 把整棵子樹從「要排版的集合」拿掉（bounds 跟著縮，這才是她要的「收起來圖就變小」）；
  //   ② 把橫線兩端各自換成**最近的可見祖先**——矛盾永不因收合而消失（紅線 3）：
  //      不是畫到收起的卡上，就是記在那張卡的 `hiddenOverlays` 裡。
  //
  // 收起的節點自己留著（她要看得到「這裡還有東西」）；`collapsed` 空、或收的是沒有
  // 子節點的葉子、或收的是方向根（不可收）⇒ 整段跳過，輸出與工單 21 逐位相同（紅線 2）。
  const collapsedInput = collapsed instanceof Set ? collapsed : new Set(collapsed || []);
  const collapsedNodes = new Set(
    [...collapsedInput].filter(
      id => id !== rootId && nodes.has(id) && (childrenOf.get(id) || []).length > 0,
    ),
  );
  const hidden = new Set();       // 被藏起來的節點：不進 nodes、不進 treeEdges
  const collapseMeta = new Map(); // 收起節點 id → { collapsed, hiddenClaims, hiddenOverlays }

  if (collapsedNodes.size > 0) {
    const descendantsOf = (id) => {
      const out = [];
      const seen = new Set();
      const stack = [...(childrenOf.get(id) || [])];
      while (stack.length > 0) {
        const cur = stack.pop();
        if (seen.has(cur)) continue;
        seen.add(cur);
        out.push(cur);
        stack.push(...(childrenOf.get(cur) || []));
      }
      return out;
    };

    // 每個收起節點各自算自己的後代（不能共用 `hidden`：巢狀收合時外層要含內層的）。
    for (const id of collapsedNodes) {
      const meta = {
        collapsed: true,
        hiddenClaims: 0,
        hiddenOverlays: {
          contradicts: 0, supports: 0, refines: 0, answers: 0,
          partially_supports: 0, superseded_by: 0,
        },
      };
      for (const d of descendantsOf(id)) {
        hidden.add(d);
        if (nodes.get(d)?.kind === 'claim') meta.hiddenClaims += 1;
      }
      collapseMeta.set(id, meta);
    }

    // 沿結構父往上走到第一個沒被藏的（自己沒被藏就是自己）。根永遠可見 ⇒ 一定走得到。
    const nearestVisible = (id) => {
      let cur = id;
      for (let i = 0; cur && i < MAX_DEPTH; i++) {
        if (!hidden.has(cur)) return cur;
        cur = parentOf.get(cur);
      }
      return null;
    };
    const bump = (id, kind) => {
      const meta = collapseMeta.get(id);
      if (!meta) return;
      meta.hiddenOverlays[kind] = (meta.hiddenOverlays[kind] || 0) + 1;
    };

    const kept = [];
    const mergedByPair = new Map();
    for (const e of overlayEdges) {
      const from = nearestVisible(e.from);
      const to = nearestVisible(e.to);
      if (!from || !to) continue; // 走不到可見祖先（理論上不會）——寧可少一條線也不炸
      const retargeted = from !== e.from || to !== e.to;

      if (retargeted && from === to) {
        // 兩端被同一張收起卡藏住：畫不出線（自己連自己），只在卡上留計數。一條邊記一次。
        bump(from, e.kind);
        continue;
      }
      if (from !== e.from) bump(from, e.kind);
      if (to !== e.to) bump(to, e.kind);

      // 同一對可見端點＋同一種關係的多條邊疊在一起看不出幾條 ⇒ 併成一條，`count` 記筆數。
      const key = `${from} ${to} ${e.kind}`;
      const prev = mergedByPair.get(key);
      if (prev) {
        prev.count = (prev.count || 1) + 1;
        continue;
      }
      const next = retargeted ? { ...e, from, to, retargeted: true } : { ...e };
      mergedByPair.set(key, next);
      kept.push(next);
    }
    overlayEdges = kept;
  }

  // ── 第二趟：算座標 ─────────────────────────────────────────
  const buildData = (id, depth = 0) => ({
    id,
    children: (depth > MAX_DEPTH || collapsedNodes.has(id))
      ? []
      : (childrenOf.get(id) || []).map(c => buildData(c, depth + 1)),
  });

  const root = hierarchy(buildData(rootId));
  const heightOf = (d3node) => nodeHeight(nodes.get(d3node.data.id));
  d3tree()
    .nodeSize([1, COL_W]) // x 的單位交給 separation 直接給像素
    .separation((a, b) => (heightOf(a) + heightOf(b)) / 2 + ROW_GAP)(root);

  let minY = Infinity;
  let maxBottom = -Infinity;
  let maxRight = -Infinity;
  const placed = [];
  root.each((d3node) => {
    const node = nodes.get(d3node.data.id);
    const h = nodeHeight(node);
    const left = d3node.y;
    const top = d3node.x - h / 2;
    placed.push({ node, left, top, h });
    if (top < minY) minY = top;
  });

  const shiftY = MARGIN - (Number.isFinite(minY) ? minY : 0);
  const out = placed.map(({ node, left, top, h }) => {
    const x = left + MARGIN;
    const y = top + shiftY;
    maxRight = Math.max(maxRight, x + CARD_W);
    maxBottom = Math.max(maxBottom, y + h);
    const meta = collapseMeta.get(node.id);
    return { id: node.id, kind: node.kind, x, y, w: CARD_W, h, data: node.data, ...(meta || {}) };
  });

  const treeEdges = [];
  for (const [parent, children] of childrenOf.entries()) {
    if (hidden.has(parent)) continue;
    for (const child of children) {
      if (hidden.has(child)) continue;
      treeEdges.push({ from: parent, to: child });
    }
  }

  return {
    nodes: out,
    treeEdges,
    overlayEdges,
    warnings,
    bounds: {
      width: Math.max(maxRight + MARGIN, CARD_W + MARGIN * 2),
      height: Math.max(maxBottom + MARGIN, MARGIN * 2),
    },
  };
}

function isCrossPaper(fromClaim, toClaim) {
  const a = paperIdsOf(fromClaim);
  const b = paperIdsOf(toClaim);
  if (a.length === 0 || b.length === 0) return false; // 討論產生的（無來源論文）不算跨篇
  return !a.some(id => b.includes(id));
}

function short(text = '', max = 16) {
  const s = String(text || '');
  return [...s].length > max ? `${[...s].slice(0, max).join('')}…` : s;
}

/** 方便前端查座標：id → 節點。 */
export function nodeIndex(layout) {
  return new Map((layout?.nodes || []).map(n => [n.id, n]));
}

/**
 * 哪些卡片該長出那顆展開／收縮的小三角（工單 23 D1 第 2 點：`結構子節點數 > 0`）。
 *
 * 從輸出反推而不是在每個節點上多掛一個 `collapsible` 欄位，是為了守紅線 2：
 * `collapsed` 空的時候輸出要與工單 21 **逐位相同**，多一個布林欄就不是了。
 * 展開的節點看 `treeEdges` 有沒有子邊；收起的節點子邊已經被修掉，認 `collapsed` 旗標。
 * 方向根不可收（D1 第 2 點），所以排除。
 */
export function collapsibleIds(layout) {
  const kindOf = new Map((layout?.nodes || []).map(n => [n.id, n.kind]));
  const ids = new Set();
  for (const e of layout?.treeEdges || []) {
    if (kindOf.get(e.from) !== 'direction') ids.add(e.from);
  }
  for (const n of layout?.nodes || []) {
    if (n.collapsed && n.kind !== 'direction') ids.add(n.id);
  }
  return ids;
}

/**
 * 一條邊的貝茲路徑（左→右水平樹）。`from`／`to` 是 layout 的節點物件。
 * 樹邊從父的右緣長到子的左緣；overlay 兩端都走右緣→左緣，方向由座標決定。
 */
export function edgePath(from, to) {
  if (!from || !to) return '';
  const x1 = from.x + from.w;
  const y1 = from.y + from.h / 2;
  const x2 = to.x;
  const y2 = to.y + to.h / 2;
  const dx = Math.max(24, Math.abs(x2 - x1) / 2);
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
}
