// 工單 21 §九 的假 fixture：**照 2026-09-19 py-GCMS 線的真實形狀**（§二）捏的，
// 但一個字都不是她的真資料——3 篇論文＋討論產生、33 條 claims、14 條關係、
// 其中 1 條跨篇 contradicts，外加 1 條被取代（真線目前 0 筆，開關要有東西測）。
//
// 分佈照真資料：finding 12／methodological_note 14／open_question 3／next_action 2／
// decision 1／research_question 1；三篇各 9／9／8 條＋7 條討論產生（無 paper 來源）。

const PAPERS = [
  { id: 'pRau', title: 'Rauert 2025 — 富脂基質的偽陽性', message_count: 24, refine_state: 'fresh' },
  { id: 'pPvc', title: 'PE/PVC 熱裂解行為', message_count: 18, refine_state: 'new_messages' },
  { id: 'pFlu', title: '生殖道體液前處理', message_count: 12, refine_state: 'never' },
];

const KINDS = [
  ['research_question', 1],
  ['finding', 12],
  ['methodological_note', 14],
  ['open_question', 3],
  ['next_action', 2],
  ['decision', 1],
];

const ORIGINS = [
  'paper_reported', 'experimental_observation', 'author_interpretation',
  'user_hypothesis', 'ai_hypothesis', 'methodological_speculation',
];

// 三篇各 9／9／8＝26 條有 paper 來源，剩下 7 條是「討論產生」（paper_ids 空）。
const PAPER_SLOTS = [
  ...Array(9).fill('pRau'),
  ...Array(9).fill('pPvc'),
  ...Array(8).fill('pFlu'),
  ...Array(7).fill(null),
];

function statementFor(i, kind) {
  // 22–51 字（真資料的區間），中英混排——換行規則要在這種字串上驗。
  const base = `Py-GC/MS 在富脂基質裡對 PE 的訊號會被脂質裂解產物墊高（第 ${i} 條，${kind}）`;
  return base.slice(0, 22 + (i % 30));
}

export function buildFixture() {
  const claims = [];
  const kindSeq = [];
  for (const [kind, n] of KINDS) for (let i = 0; i < n; i++) kindSeq.push(kind);

  for (let i = 0; i < 33; i++) {
    const kind = kindSeq[i];
    const paper = PAPER_SLOTS[i];
    claims.push({
      id: `c${i + 1}`,
      claim_kind: kind,
      epistemic_origin: ORIGINS[i % ORIGINS.length],
      origin_actor: i % 3 === 0 ? 'user' : 'ai',
      status: 'active',
      statement: statementFor(i + 1, kind),
      confidence: 0.6,
      created_at: 1000 + i,
      updated_at: 1000 + i,
      paper_ids: paper ? [paper] : [],
      superseded_by: null,
      merged_into: null,
      supersede_reason: null,
    });
  }

  // 被取代的那條（真線 0 筆，開關要有東西測）：c34 被 c2 取代。
  claims.push({
    id: 'c34',
    claim_kind: 'finding',
    epistemic_origin: 'ai_hypothesis',
    origin_actor: 'ai',
    status: 'superseded',
    statement: '早期結論：PE 訊號可直接當作暴露量，不需要扣背景',
    confidence: 0.3,
    created_at: 990,
    updated_at: 1400,
    paper_ids: ['pRau'],
    superseded_by: 'c2',
    merged_into: null,
    supersede_reason: '第 3 次討論確認脂質裂解會墊高訊號，原結論不成立',
  });

  // 14 條關係：supports 9／contradicts 2／refines 2／answers 1（真線的分佈）。
  const relations = [
    { id: 'r1', from_id: 'c2', to_id: 'c1', kind: 'answers', note: null, created_at: 2001 },
    { id: 'r2', from_id: 'c3', to_id: 'c2', kind: 'supports', note: null, created_at: 2002 },
    { id: 'r3', from_id: 'c4', to_id: 'c2', kind: 'supports', note: null, created_at: 2003 },
    { id: 'r4', from_id: 'c5', to_id: 'c3', kind: 'supports', note: null, created_at: 2004 },
    { id: 'r5', from_id: 'c6', to_id: 'c3', kind: 'supports', note: null, created_at: 2005 },
    { id: 'r6', from_id: 'c7', to_id: 'c4', kind: 'refines', note: null, created_at: 2006 },
    { id: 'r7', from_id: 'c8', to_id: 'c4', kind: 'supports', note: null, created_at: 2007 },
    { id: 'r8', from_id: 'c14', to_id: 'c13', kind: 'refines', note: null, created_at: 2008 },
    { id: 'r9', from_id: 'c15', to_id: 'c13', kind: 'supports', note: null, created_at: 2009 },
    { id: 'r10', from_id: 'c16', to_id: 'c15', kind: 'supports', note: null, created_at: 2010 },
    { id: 'r11', from_id: 'c24', to_id: 'c23', kind: 'supports', note: null, created_at: 2011 },
    { id: 'r12', from_id: 'c25', to_id: 'c23', kind: 'supports', note: null, created_at: 2012 },
    // 跨篇矛盾（pRau 的 c2 ⇄ pPvc 的 c13）——這一條是圖的靈魂，永不進樹、永不省略。
    { id: 'r13', from_id: 'c13', to_id: 'c2', kind: 'contradicts', note: 'PE 在 PVC 共存時的裂解碎片重疊，兩邊的判讀互斥', created_at: 2013 },
    // 同篇矛盾（都出自 pFlu）
    { id: 'r14', from_id: 'c23', to_id: 'c22', kind: 'contradicts', note: '同一批樣本兩次前處理結果打架', created_at: 2014 },
  ];

  return { direction: { id: 'dirPyGcms', name: 'py-GCMS', description: '生殖道體液的奈米塑膠定量' }, papers: PAPERS, claims, relations };
}

export const FIXTURE_FACTS = {
  papers: 3,
  claimsActive: 33,
  claimsSuperseded: 1,
  relations: 14,
  contradicts: 2,
  crossPaperContradicts: 1,
  discussionClaims: 7,
};
