// 工單 21 §五「必測」：佈局引擎的兩趟走。
//
// 這個檔案的存在理由是調研報告的坑①——d3-hierarchy 的 `stratify()` 遇到多父、多根、
// 有環會直接拋例外，而她的資料三種都會踩。所以每一種都必須有一條測試釘住「不拋，
// 而且降級的邊還在圖上」。`contradicts` 永不進樹（紅線 3）也在這裡守。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  layoutProgress,
  estimateLines,
  nodeHeight,
  edgePath,
  nodeIndex,
  claimNodeId,
  paperNodeId,
  directionNodeId,
  GROUP_NODE_ID,
  CARD_W,
} from '../frontend/src/lib/progressLayout.js';
import { buildFixture, FIXTURE_FACTS } from './fixtures/progress-direction.js';

const direction = { id: 'dirX', name: '測試方向', description: '' };

const claim = (id, over = {}) => ({
  id,
  claim_kind: 'finding',
  epistemic_origin: 'paper_reported',
  status: 'active',
  statement: `主張 ${id}`,
  created_at: Number(String(id).replace(/\D/g, '')) || 0,
  paper_ids: [],
  superseded_by: null,
  merged_into: null,
  supersede_reason: null,
  ...over,
});

const rel = (id, from, to, kind, over = {}) => ({
  id, from_id: from, to_id: to, kind, note: null, created_at: Number(String(id).replace(/\D/g, '')) || 0, ...over,
});

const treeParentOf = (layout, nodeId) => layout.treeEdges.find(e => e.to === nodeId)?.from ?? null;

describe('估高（排版用，真正換行交給瀏覽器）', () => {
  // 卡寬 220px、字 12px ⇒ 一行 16 個中文字（偏離工單的 24，理由見 lib 裡的註解）
  it('一行 16 字，最多 3 行', () => {
    assert.equal(estimateLines('短句'), 1);
    assert.equal(estimateLines('一'.repeat(16)), 1);
    assert.equal(estimateLines('一'.repeat(17)), 2);
    assert.equal(estimateLines('一'.repeat(32)), 2);
    assert.equal(estimateLines('一'.repeat(33)), 3);
    assert.equal(estimateLines('一'.repeat(400)), 3); // 再長也只算 3 行（line-clamp）
    assert.equal(estimateLines(''), 1);
  });

  it('中英混排照字元數算，不靠拉丁寬度查找表（坑②）', () => {
    assert.ok(estimateLines('Py-GC/MS 在富脂基質中產生偽陽性') <= 2);
    assert.ok(nodeHeight({ kind: 'claim', data: { statement: '一'.repeat(60) } })
      > nodeHeight({ kind: 'claim', data: { statement: '短' } }));
  });
});

describe('§五 必測①：多父', () => {
  it('一條 claim 同時 supports 兩個目標 ⇒ 不拋，只有一條進樹，另一條降級成橫線', () => {
    const layout = layoutProgress({
      direction,
      papers: [{ id: 'p1', title: '甲' }],
      claims: [claim('a1', { paper_ids: ['p1'] }), claim('a2', { paper_ids: ['p1'] }), claim('a3', { paper_ids: ['p1'] })],
      relations: [rel('r1', 'a3', 'a1', 'supports'), rel('r2', 'a3', 'a2', 'supports')],
    });

    const intoA3 = layout.treeEdges.filter(e => e.to === claimNodeId('a3'));
    assert.equal(intoA3.length, 1);
    assert.equal(intoA3[0].from, claimNodeId('a1')); // 第一條（created_at 較早）當結構父

    const downgraded = layout.overlayEdges.filter(e => e.downgraded);
    assert.equal(downgraded.length, 1);
    assert.equal(downgraded[0].to, claimNodeId('a2'));
    assert.equal(layout.warnings.filter(w => w.type === 'multi_parent').length, 1);
  });
});

describe('§五 必測②：有環', () => {
  it('a→b→a 不拋；後成環的那條降級成橫線，圖仍是一棵樹', () => {
    const layout = layoutProgress({
      direction,
      papers: [{ id: 'p1', title: '甲' }],
      claims: [claim('b1', { paper_ids: ['p1'] }), claim('b2', { paper_ids: ['p1'] })],
      relations: [rel('r1', 'b1', 'b2', 'supports'), rel('r2', 'b2', 'b1', 'supports')],
    });

    // 每個節點最多一個父 ⇒ treeEdges 數 = 節點數 - 1
    assert.equal(layout.treeEdges.length, layout.nodes.length - 1);
    assert.equal(layout.warnings.filter(w => w.type === 'cycle').length, 1);
    assert.equal(layout.overlayEdges.filter(e => e.downgraded).length, 1);
  });

  it('三節點長環 a→b→c→a 也不拋', () => {
    const layout = layoutProgress({
      direction,
      claims: [claim('d1'), claim('d2'), claim('d3')],
      relations: [rel('r1', 'd1', 'd2', 'refines'), rel('r2', 'r2' && 'd2', 'd3', 'refines'), rel('r3', 'd3', 'd1', 'refines')],
    });
    assert.equal(layout.treeEdges.length, layout.nodes.length - 1);
    assert.ok(layout.warnings.some(w => w.type === 'cycle'));
  });
});

describe('§五 必測③：多根', () => {
  it('兩個 research_question 都掛根，不拋（stratify 會在這裡死）', () => {
    const layout = layoutProgress({
      direction,
      claims: [
        claim('q1', { claim_kind: 'research_question' }),
        claim('q2', { claim_kind: 'research_question' }),
      ],
    });
    const rootId = directionNodeId('dirX');
    assert.equal(treeParentOf(layout, claimNodeId('q1')), rootId);
    assert.equal(treeParentOf(layout, claimNodeId('q2')), rootId);
  });
});

describe('§五 必測④⑤：孤兒的保底父', () => {
  it('沒有任何關係、但有來源論文 ⇒ 掛那篇論文（真資料 42% 靠這條不飄走）', () => {
    const layout = layoutProgress({
      direction,
      papers: [{ id: 'p1', title: '甲', refine_state: 'fresh' }],
      claims: [claim('o1', { paper_ids: ['p1'] })],
    });
    assert.equal(treeParentOf(layout, claimNodeId('o1')), paperNodeId('p1'));
    assert.equal(treeParentOf(layout, paperNodeId('p1')), directionNodeId('dirX'));
  });

  it('沒有關係也沒有論文（討論產生）⇒ 掛「討論（跨篇）」', () => {
    const layout = layoutProgress({ direction, claims: [claim('o2')] });
    assert.equal(treeParentOf(layout, claimNodeId('o2')), GROUP_NODE_ID);
    assert.equal(treeParentOf(layout, GROUP_NODE_ID), directionNodeId('dirX'));
  });

  it('沒有東西要掛就不建「討論」節點', () => {
    const layout = layoutProgress({
      direction,
      papers: [{ id: 'p1', title: '甲' }],
      claims: [claim('o3', { paper_ids: ['p1'] })],
    });
    assert.equal(layout.nodes.some(n => n.id === GROUP_NODE_ID), false);
  });

  it('只列有 claims 的論文——沒有 claims 的那篇不進圖', () => {
    const layout = layoutProgress({
      direction,
      papers: [{ id: 'p1', title: '有' }, { id: 'p2', title: '沒有' }],
      claims: [claim('o4', { paper_ids: ['p1'] })],
    });
    assert.ok(layout.nodes.some(n => n.id === paperNodeId('p1')));
    assert.equal(layout.nodes.some(n => n.id === paperNodeId('p2')), false);
  });
});

describe('§五 必測⑥：contradicts 永不進樹（紅線 3）', () => {
  it('兩條 claim 只有 contradicts ⇒ 兩條都掛各自的論文，矛盾走 overlay', () => {
    const layout = layoutProgress({
      direction,
      papers: [{ id: 'pA', title: '甲' }, { id: 'pB', title: '乙' }],
      claims: [claim('x1', { paper_ids: ['pA'] }), claim('x2', { paper_ids: ['pB'] })],
      relations: [rel('r1', 'x2', 'x1', 'contradicts', { note: '兩邊判讀互斥' })],
    });

    assert.equal(treeParentOf(layout, claimNodeId('x1')), paperNodeId('pA'));
    assert.equal(treeParentOf(layout, claimNodeId('x2')), paperNodeId('pB'));

    const overlay = layout.overlayEdges.filter(e => e.kind === 'contradicts');
    assert.equal(overlay.length, 1);
    assert.equal(overlay[0].note, '兩邊判讀互斥');
    assert.equal(overlay[0].crossPaper, true);
    // treeEdges 裡不可能出現這一條
    assert.equal(
      layout.treeEdges.some(e => e.from === claimNodeId('x2') && e.to === claimNodeId('x1')),
      false,
    );
  });

  it('同一篇裡的矛盾 crossPaper=false', () => {
    const layout = layoutProgress({
      direction,
      papers: [{ id: 'pA', title: '甲' }],
      claims: [claim('y1', { paper_ids: ['pA'] }), claim('y2', { paper_ids: ['pA'] })],
      relations: [rel('r1', 'y2', 'y1', 'contradicts')],
    });
    assert.equal(layout.overlayEdges[0].crossPaper, false);
  });
});

describe('§五 必測⑦：「顯示走過的路」開關兩態', () => {
  const input = {
    direction,
    papers: [{ id: 'pA', title: '甲' }],
    claims: [
      claim('n1', { paper_ids: ['pA'] }),
      claim('old', {
        status: 'superseded', superseded_by: 'n1', paper_ids: ['pA'],
        supersede_reason: '第 3 次討論推翻',
      }),
    ],
    relations: [],
  };

  it('關（預設）：被取代的不畫、也不佔位置（Wikidata 式預設過濾）', () => {
    const layout = layoutProgress(input);
    assert.equal(layout.nodes.some(n => n.id === claimNodeId('old')), false);
    assert.equal(layout.overlayEdges.some(e => e.kind === 'superseded_by'), false);
  });

  it('開：舊節點出現，並多一條「被誰取代」的線，帶取代理由', () => {
    const layout = layoutProgress({ ...input, showSuperseded: true });
    assert.ok(layout.nodes.some(n => n.id === claimNodeId('old')));
    const edge = layout.overlayEdges.find(e => e.kind === 'superseded_by');
    assert.equal(edge.from, claimNodeId('old'));
    assert.equal(edge.to, claimNodeId('n1'));
    assert.equal(edge.note, '第 3 次討論推翻');
  });

  it('merged 的 claim 跟 superseded 同一個開關', () => {
    const layout = layoutProgress({
      direction,
      claims: [claim('m1'), claim('m2', { status: 'merged', merged_into: 'm1' })],
    });
    assert.equal(layout.nodes.some(n => n.id === claimNodeId('m2')), false);
    const on = layoutProgress({
      direction,
      claims: [claim('m1'), claim('m2', { status: 'merged', merged_into: 'm1' })],
      showSuperseded: true,
    });
    assert.ok(on.nodes.some(n => n.id === claimNodeId('m2')));
  });

  it('矛盾邊的另一端被藏起來 ⇒ 不靜靜消失，記一筆 warning（紅線 3）', () => {
    const layout = layoutProgress({
      direction,
      papers: [{ id: 'pA', title: '甲' }],
      claims: [
        claim('k1', { paper_ids: ['pA'] }),
        claim('kOld', { status: 'superseded', superseded_by: 'k1', paper_ids: ['pA'] }),
      ],
      relations: [rel('r1', 'kOld', 'k1', 'contradicts')],
    });
    assert.equal(layout.overlayEdges.filter(e => e.kind === 'contradicts').length, 0);
    assert.equal(layout.warnings.filter(w => w.type === 'contradicts_hidden').length, 1);
  });
});

// gateway 姊妹單的兩個已知行為（2026-09-19 交付說明）
describe('gateway 的懸空邊：略過、記一筆、絕不拋', () => {
  it('relations 指向不在 claims 清單裡的節點 ⇒ 不拋，warnings 記一筆', () => {
    const layout = layoutProgress({
      direction,
      papers: [{ id: 'pA', title: '甲' }],
      claims: [claim('g1', { paper_ids: ['pA'] })],
      relations: [
        rel('r1', 'g1', 'ghost', 'supports'),   // 目標不存在
        rel('r2', 'ghost2', 'g1', 'refines'),   // 來源不存在
      ],
    });
    assert.equal(treeParentOf(layout, claimNodeId('g1')), paperNodeId('pA')); // 退回保底父
    assert.equal(layout.treeEdges.length, layout.nodes.length - 1);
    assert.equal(layout.warnings.filter(w => w.type === 'dangling_edge').length, 2);
  });

  it('懸空的 contradicts 也不拋，單獨報（紅線 3：矛盾不能靜靜消失）', () => {
    const layout = layoutProgress({
      direction,
      claims: [claim('g3')],
      relations: [rel('r1', 'g3', 'ghost', 'contradicts')],
    });
    assert.equal(layout.overlayEdges.length, 0);
    assert.equal(layout.warnings.filter(w => w.type === 'contradicts_hidden').length, 1);
  });

  it('沒見過的關係種類（契約將來加的）既不進樹也不炸', () => {
    const layout = layoutProgress({
      direction,
      papers: [{ id: 'pA', title: '甲' }],
      claims: [claim('g4', { paper_ids: ['pA'] }), claim('g5', { paper_ids: ['pA'] })],
      relations: [rel('r1', 'g5', 'g4', 'inspires')],
    });
    assert.equal(treeParentOf(layout, claimNodeId('g5')), paperNodeId('pA'));
    assert.equal(layout.overlayEdges.length, 0);
  });
});

describe('同毫秒的關係順序不穩 ⇒ 先按 (created_at, id) 排再取第一條', () => {
  it('同一批資料換輸入順序，畫出來的結構父一樣', () => {
    const claims = [claim('s1'), claim('s2'), claim('s3', { paper_ids: [] })];
    const relations = [
      rel('rB', 's3', 's2', 'supports', { created_at: 5000 }),
      rel('rA', 's3', 's1', 'supports', { created_at: 5000 }), // 同毫秒，id 較小
    ];
    const one = layoutProgress({ direction, claims, relations });
    const two = layoutProgress({ direction, claims, relations: [...relations].reverse() });

    assert.equal(treeParentOf(one, claimNodeId('s3')), claimNodeId('s1'));
    assert.equal(treeParentOf(two, claimNodeId('s3')), claimNodeId('s1'));
    assert.deepEqual(one.treeEdges, two.treeEdges);
  });
});

describe('§五 必測⑧：空線', () => {
  it('0 條 claims ⇒ 只有根，沒有邊，bounds 仍然是正數', () => {
    const layout = layoutProgress({ direction, papers: [{ id: 'p1', title: '還沒精煉' }], claims: [], relations: [] });
    assert.equal(layout.nodes.length, 1);
    assert.equal(layout.nodes[0].kind, 'direction');
    assert.deepEqual(layout.treeEdges, []);
    assert.deepEqual(layout.overlayEdges, []);
    assert.ok(layout.bounds.width > 0 && layout.bounds.height > 0);
  });

  it('連 direction 都沒傳也不炸', () => {
    const layout = layoutProgress();
    assert.equal(layout.nodes.length, 1);
  });
});

describe('座標', () => {
  it('同一層的節點不重疊，且全部在畫布裡（左→右水平樹）', () => {
    const layout = layoutProgress(buildFixture());
    const byColumn = new Map();
    for (const n of layout.nodes) {
      if (!byColumn.has(n.x)) byColumn.set(n.x, []);
      byColumn.get(n.x).push(n);
    }
    for (const col of byColumn.values()) {
      col.sort((a, b) => a.y - b.y);
      for (let i = 1; i < col.length; i++) {
        assert.ok(col[i].y >= col[i - 1].y + col[i - 1].h, '同一層的節點重疊了');
      }
    }
    for (const n of layout.nodes) {
      assert.ok(n.x >= 0 && n.y >= 0);
      assert.ok(n.x + n.w <= layout.bounds.width);
      assert.ok(n.y + n.h <= layout.bounds.height);
      assert.equal(n.w, CARD_W);
    }
  });

  it('層與層之間拉開（子節點一定在父的右邊）', () => {
    const layout = layoutProgress(buildFixture());
    const index = nodeIndex(layout);
    for (const e of layout.treeEdges) {
      assert.ok(index.get(e.to).x > index.get(e.from).x);
    }
  });

  it('edgePath 從父的右緣長到子的左緣', () => {
    const from = { x: 0, y: 0, w: 220, h: 60 };
    const to = { x: 260, y: 100, w: 220, h: 60 };
    assert.equal(edgePath(from, to), 'M 220 30 C 244 30, 236 130, 260 130');
    assert.equal(edgePath(null, to), '');
  });
});

describe('§九：真資料形狀的假 fixture（3 篇＋討論、33 claims、14 關係）', () => {
  it('關閉「走過的路」：38 個節點、37 條樹邊、2 條矛盾橫線、0 warning', () => {
    const layout = layoutProgress(buildFixture());

    const byKind = (kind) => layout.nodes.filter(n => n.kind === kind).length;
    assert.equal(byKind('direction'), 1);
    assert.equal(byKind('paper'), FIXTURE_FACTS.papers);
    assert.equal(byKind('group'), 1);
    assert.equal(byKind('claim'), FIXTURE_FACTS.claimsActive);
    assert.equal(layout.nodes.length, 38);

    // 每個非根節點恰好一個父
    assert.equal(layout.treeEdges.length, 37);

    const contradicts = layout.overlayEdges.filter(e => e.kind === 'contradicts');
    assert.equal(contradicts.length, FIXTURE_FACTS.contradicts);
    assert.equal(contradicts.filter(e => e.crossPaper).length, FIXTURE_FACTS.crossPaperContradicts);
    assert.equal(layout.overlayEdges.length, 2); // 被取代的那條藏著 ⇒ 沒有 superseded_by 線
    assert.deepEqual(layout.warnings, []);

    // 7 條「討論產生」全部掛在討論節點底下
    assert.equal(
      layout.treeEdges.filter(e => e.from === GROUP_NODE_ID).length,
      FIXTURE_FACTS.discussionClaims,
    );
  });

  it('打開「走過的路」：多 1 個節點、多 1 條 superseded_by 線', () => {
    const layout = layoutProgress({ ...buildFixture(), showSuperseded: true });
    assert.equal(layout.nodes.length, 39);
    assert.equal(layout.treeEdges.length, 38);
    assert.equal(layout.overlayEdges.filter(e => e.kind === 'superseded_by').length, 1);
    assert.equal(layout.overlayEdges.length, 3);
  });

  it('研究問題掛根、論文節點掛根，claims 沒有一條飄在外面', () => {
    const layout = layoutProgress(buildFixture());
    const rootId = directionNodeId('dirPyGcms');
    const rootChildren = layout.treeEdges.filter(e => e.from === rootId).map(e => e.to);
    assert.ok(rootChildren.includes(claimNodeId('c1')));   // 研究問題
    assert.ok(rootChildren.includes(paperNodeId('pRau')));
    assert.ok(rootChildren.includes(GROUP_NODE_ID));
    // 根之外每個節點都被連到
    const connected = new Set(layout.treeEdges.map(e => e.to));
    for (const n of layout.nodes) {
      if (n.id === rootId) continue;
      assert.ok(connected.has(n.id), `${n.id} 沒有結構父`);
    }
  });
});
