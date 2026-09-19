// 工單 20：方向線——精煉餵進論文所屬的研究方向，而不是單篇。
// 覆蓋 §六 的六條驗證：鍵解析、每篇游標、staleness、full 全文重送、出海 body、零回歸。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import {
  resolveSessionKey,
  sessionKeyFor,
  buildRefineRequest,
  requestRefine,
  getRefineCursor,
  coveredDigest,
  refineStaleness,
  renderCarryoverForInjection,
  setCarryoverInjected,
  cacheCarryover,
} from '../src/carryover.js';

// 生產 schema 的切片（papers.tree_node_id + tree_nodes 才走得到方向查詢）。不碰 data/。
function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE papers (id TEXT PRIMARY KEY, title TEXT DEFAULT '', tree_node_id TEXT);
    CREATE TABLE tree_nodes (
      id TEXT PRIMARY KEY, parent_id TEXT, name TEXT NOT NULL,
      description TEXT DEFAULT '', sort_order INTEGER DEFAULT 0
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY, paper_id TEXT NOT NULL, role TEXT NOT NULL,
      content TEXT NOT NULL, seq INTEGER, created_at INTEGER DEFAULT 0
    );
    CREATE TABLE insights (
      id TEXT PRIMARY KEY, dimension TEXT, title TEXT DEFAULT '',
      source_paper_id TEXT, created_at INTEGER DEFAULT 0
    );
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '');
    CREATE TABLE carryover_cache (
      session_key TEXT PRIMARY KEY, payload_json TEXT NOT NULL,
      version INTEGER NOT NULL, last_seq INTEGER, fetched_at INTEGER NOT NULL
    );
    CREATE TABLE refine_cursor (
      paper_id TEXT PRIMARY KEY, session_key TEXT NOT NULL, last_seq INTEGER NOT NULL,
      covered_digest TEXT NOT NULL, updated_at INTEGER NOT NULL
    );
  `);
  return db;
}

function addNode(db, { id, parentId = null, name }) {
  db.prepare('INSERT INTO tree_nodes (id, parent_id, name) VALUES (?, ?, ?)').run(id, parentId, name);
  return id;
}

function seedPaper(db, { id = 'p1', title = 'Py-GC/MS 在富脂基質', nodeId = null } = {}) {
  db.prepare('INSERT INTO papers (id, title, tree_node_id) VALUES (?, ?, ?)').run(id, title, nodeId);
  let i = 0;
  const addMsg = (role, content) => {
    db.prepare('INSERT INTO messages (id, paper_id, role, content, seq) VALUES (?, ?, ?, ?, ?)')
      .run(`${id}-m${++i}`, id, role, content, i);
    return i;
  };
  addMsg('user', '脂質裂解會不會做出 PE 的假陽性？');
  addMsg('assistant', 'Rauert 2025 就是在講這件事');
  addMsg('user', '那 PVC 呢？');
  addMsg('assistant', 'PVC 在 200–300°C 先分解，去蛋白流程救不回來');
  return { addMsg, maxSeq: () => i };
}

const config = { url: 'https://example.test/research', token: 'tok' };

function fakeGateway() {
  const calls = [];
  const impl = async (url, opts) => {
    calls.push({ url, opts, body: JSON.parse(opts.body) });
    return {
      ok: true,
      status: 200,
      json: async () => ({
        run_id: `run-${calls.length}`, version: calls.length, idempotent: false,
        stats: { created: 3 },
        carryover: { carryover_version: 'rc-1', hypotheses: [] },
      }),
      text: async () => '',
    };
  };
  impl.calls = calls;
  return impl;
}

// ── §六 1：鍵解析 ──────────────────────────────────────────────

describe('resolveSessionKey（工單 20 §A1）', () => {
  it('掛在頂層方向 → topic:<節點 id>', () => {
    const db = makeDb();
    addNode(db, { id: 'dirNano', name: 'nano plastics' });
    seedPaper(db, { nodeId: 'dirNano' });
    const r = resolveSessionKey('p1', { database: db });
    assert.equal(r.sessionKey, 'topic:dirNano');
    assert.equal(r.scope, 'direction');
    assert.deepEqual(r.direction, { id: 'dirNano', name: 'nano plastics' });
  });

  it('掛在子節點 → 仍然是頂層方向的 topic: 線（一張圖只到頂層）', () => {
    const db = makeDb();
    addNode(db, { id: 'dirNano', name: 'nano plastics' });
    addNode(db, { id: 'subBlood', parentId: 'dirNano', name: '血液分佈' });
    addNode(db, { id: 'subDeep', parentId: 'subBlood', name: '蛋白冠' });
    seedPaper(db, { nodeId: 'subDeep' });
    const r = resolveSessionKey('p1', { database: db });
    assert.equal(r.sessionKey, 'topic:dirNano');
    assert.equal(r.scope, 'direction');
  });

  it('沒掛方向 → paper:<id>，direction 為 null', () => {
    const db = makeDb();
    seedPaper(db);
    const r = resolveSessionKey('p1', { database: db });
    assert.equal(r.sessionKey, 'paper:p1');
    assert.equal(r.scope, 'paper');
    assert.equal(r.direction, null);
  });

  it('節點 id 有契約外字元 → 退回單篇線（不送出去被 gateway 打回）', () => {
    const db = makeDb();
    addNode(db, { id: 'dir/壞:id', name: '手塞的' });
    seedPaper(db, { nodeId: 'dir/壞:id' });
    const r = resolveSessionKey('p1', { database: db });
    assert.equal(r.sessionKey, 'paper:p1');
    assert.equal(r.scope, 'paper');
    assert.equal(r.direction, null);
  });

  it('論文不存在／方向表查不到 → 單篇線，不拋', () => {
    const db = makeDb();
    assert.equal(resolveSessionKey('ghost', { database: db }).sessionKey, 'paper:ghost');
    const noTree = new Database(':memory:');
    noTree.exec(`CREATE TABLE papers (id TEXT PRIMARY KEY, title TEXT DEFAULT '');`);
    noTree.prepare('INSERT INTO papers (id) VALUES (?)').run('p9');
    assert.equal(resolveSessionKey('p9', { database: noTree }).sessionKey, 'paper:p9');
  });
});

// ── §六 5：出海 body ───────────────────────────────────────────

describe('出海 body（紅線 1：六欄一個不加）', () => {
  it('方向線：session_key=topic:<id>、paper_id 仍是該篇', async () => {
    const db = makeDb();
    addNode(db, { id: 'dirPygcms', name: 'py-GCMS' });
    seedPaper(db, { nodeId: 'dirPygcms' });
    const f = fakeGateway();
    const r = await requestRefine('p1', { database: db, fetchImpl: f, config });
    assert.equal(r.ok, true);
    assert.equal(r.session_key, 'topic:dirPygcms');
    assert.equal(r.scope, 'direction');

    const body = f.calls[0].body;
    assert.equal(body.session_key, 'topic:dirPygcms');
    assert.equal(body.paper_id, 'p1');
    assert.equal(body.paper_title, 'Py-GC/MS 在富脂基質');
    assert.deepEqual(
      Object.keys(body).sort(),
      ['insights', 'paper_id', 'paper_title', 'session_key', 'since_seq', 'source', 'transcript'],
      'payload 欄位一個不多一個不少'
    );
  });

  it('未掛方向的論文：body 與方向線出現以前逐字相同', () => {
    const db = makeDb();
    seedPaper(db, { id: 'p1', title: 'Cloud Feedback Review' });
    db.prepare('INSERT INTO insights (id, dimension, title, source_paper_id) VALUES (?, ?, ?, ?)')
      .run('ins1', '概念', '雲反饋要點', 'p1');
    const { body } = buildRefineRequest('p1', { database: db });
    assert.deepEqual(body, {
      source: 'co-reading',
      session_key: 'paper:p1',
      paper_id: 'p1',
      paper_title: 'Cloud Feedback Review',
      transcript: [
        { seq: 1, role: 'user', content: '脂質裂解會不會做出 PE 的假陽性？' },
        { seq: 2, role: 'assistant', content: 'Rauert 2025 就是在講這件事' },
        { seq: 3, role: 'user', content: '那 PVC 呢？' },
        { seq: 4, role: 'assistant', content: 'PVC 在 200–300°C 先分解，去蛋白流程救不回來' },
      ],
      since_seq: null,
      insights: [{ id: 'ins1', dimension: '概念', title: '雲反饋要點' }],
    });
  });
});

// ── §六 2：每篇一個游標 ────────────────────────────────────────

describe('refine_cursor（工單 20 §A2）', () => {
  it('首次 since_seq=null；成功後落游標；同線第二次送 last_seq', async () => {
    const db = makeDb();
    addNode(db, { id: 'dirNano', name: 'nano plastics' });
    const { addMsg } = seedPaper(db, { nodeId: 'dirNano' });
    const f = fakeGateway();

    await requestRefine('p1', { database: db, fetchImpl: f, config });
    assert.equal(f.calls[0].body.since_seq, null);
    const cursor = getRefineCursor('p1', { database: db });
    assert.equal(cursor.sessionKey, 'topic:dirNano');
    assert.equal(cursor.lastSeq, 4);
    assert.equal(cursor.coveredDigest, coveredDigest('p1', 4, { database: db }));

    addMsg('user', '那生殖道體液呢？');
    await requestRefine('p1', { database: db, fetchImpl: f, config });
    assert.equal(f.calls[1].body.since_seq, 4, '同一條線走增量');
    assert.equal(getRefineCursor('p1', { database: db }).lastSeq, 5);
  });

  it('線換了（掛上方向）→ since_seq=null 全文重送，新線不缺前半段', async () => {
    const db = makeDb();
    const { addMsg } = seedPaper(db); // 先沒掛方向
    const f = fakeGateway();

    await requestRefine('p1', { database: db, fetchImpl: f, config });
    assert.equal(f.calls[0].body.session_key, 'paper:p1');
    assert.equal(getRefineCursor('p1', { database: db }).sessionKey, 'paper:p1');

    // 她把這篇掛到方向底下，然後又聊了一句
    addNode(db, { id: 'dirNano', name: 'nano plastics' });
    db.prepare('UPDATE papers SET tree_node_id = ? WHERE id = ?').run('dirNano', 'p1');
    addMsg('user', '掛上方向之後再問一句');

    await requestRefine('p1', { database: db, fetchImpl: f, config });
    assert.equal(f.calls[1].body.session_key, 'topic:dirNano');
    assert.equal(f.calls[1].body.since_seq, null, '換線＝全文重送');
    assert.equal(getRefineCursor('p1', { database: db }).sessionKey, 'topic:dirNano');
  });

  it('游標是 per-paper：同方向第二篇自己從零開始，不吃第一篇的游標', async () => {
    const db = makeDb();
    addNode(db, { id: 'dirNano', name: 'nano plastics' });
    seedPaper(db, { id: 'pA', nodeId: 'dirNano' });
    seedPaper(db, { id: 'pB', title: '第二篇', nodeId: 'dirNano' });
    const f = fakeGateway();

    await requestRefine('pA', { database: db, fetchImpl: f, config });
    await requestRefine('pB', { database: db, fetchImpl: f, config });

    assert.equal(f.calls[1].body.since_seq, null, '第二篇沒被第一篇的游標擋掉');
    assert.equal(f.calls[1].body.session_key, 'topic:dirNano', '兩篇同一條線');
    assert.equal(f.calls[1].body.paper_id, 'pB');
    assert.equal(getRefineCursor('pA', { database: db }).lastSeq, 4);
    assert.equal(getRefineCursor('pB', { database: db }).lastSeq, 4);
  });
});

// ── §六 3：staleness（她 9/18 拍板的手動型）───────────────────

describe('refineStaleness（工單 20 §A3）', () => {
  it('無游標 → never', () => {
    const db = makeDb();
    seedPaper(db);
    assert.equal(refineStaleness('p1', { database: db }), 'never');
  });

  it('精煉完沒動過 → fresh；加新訊息 → new_messages', async () => {
    const db = makeDb();
    const { addMsg } = seedPaper(db);
    const f = fakeGateway();
    await requestRefine('p1', { database: db, fetchImpl: f, config });
    assert.equal(refineStaleness('p1', { database: db }), 'fresh');

    addMsg('user', '追問');
    assert.equal(refineStaleness('p1', { database: db }), 'new_messages');
  });

  it('改掉 seq<=last_seq 的舊訊息 → stale（只亮提示，系統不自己重跑）', async () => {
    const db = makeDb();
    seedPaper(db);
    const f = fakeGateway();
    await requestRefine('p1', { database: db, fetchImpl: f, config });

    db.prepare('UPDATE messages SET content = ? WHERE paper_id = ? AND seq = ?')
      .run('她把第三則改掉了', 'p1', 3);
    assert.equal(refineStaleness('p1', { database: db }), 'stale');
    assert.equal(f.calls.length, 1, '偵測到 stale 不會觸發任何外呼');
  });

  it('既改過舊訊息又有新訊息 → stale 優先（要她重跑全文，不是接著增量）', async () => {
    const db = makeDb();
    const { addMsg } = seedPaper(db);
    const f = fakeGateway();
    await requestRefine('p1', { database: db, fetchImpl: f, config });
    db.prepare('UPDATE messages SET content = ? WHERE paper_id = ? AND seq = ?').run('改了', 'p1', 2);
    addMsg('user', '又問了一句');
    assert.equal(refineStaleness('p1', { database: db }), 'stale');
  });
});

// ── §六 4：full:true 全文重送 ─────────────────────────────────

describe('重新精煉這篇（full:true）', () => {
  it('sinceSeq=null 蓋掉游標 → body.since_seq=null，游標與指紋一起更新', async () => {
    const db = makeDb();
    seedPaper(db);
    const f = fakeGateway();
    await requestRefine('p1', { database: db, fetchImpl: f, config });

    db.prepare('UPDATE messages SET content = ? WHERE paper_id = ? AND seq = ?').run('改過的第二則', 'p1', 2);
    assert.equal(refineStaleness('p1', { database: db }), 'stale');

    // 路由層 full:true ⇒ requestRefine(sinceSeq: null)
    const r = await requestRefine('p1', { database: db, fetchImpl: f, config, sinceSeq: null });
    assert.equal(r.ok, true);
    assert.equal(f.calls[1].body.since_seq, null);
    assert.equal(f.calls[1].body.transcript.length, 4, '全文重送');
    assert.equal(refineStaleness('p1', { database: db }), 'fresh', '重跑之後指紋對齊');
  });
});

// ── 注入：per-paper 開關 × 方向線 payload ─────────────────────

describe('renderCarryoverForInjection 跟著解析後那條線走', () => {
  it('掛方向的論文注入 topic: 線的 payload', () => {
    const db = makeDb();
    addNode(db, { id: 'dirNano', name: 'nano plastics' });
    seedPaper(db, { nodeId: 'dirNano' });
    cacheCarryover({
      sessionKey: 'topic:dirNano',
      payload: {
        hypotheses: [{ claim_kind: 'hypothesis', statement: '方向線上的假設', epistemic_origin: 'user_hypothesis' }],
      },
      version: 1,
      database: db,
    });
    cacheCarryover({
      sessionKey: sessionKeyFor('p1'),
      payload: {
        hypotheses: [{ claim_kind: 'hypothesis', statement: '舊單篇線的假設', epistemic_origin: 'user_hypothesis' }],
      },
      version: 1,
      database: db,
    });

    setCarryoverInjected('p1', true, { database: db });
    const text = renderCarryoverForInjection('p1', { database: db });
    assert.ok(text.includes('方向線上的假設'));
    assert.ok(!text.includes('舊單篇線的假設'), '不得撈到殘留的單篇線快取');
  });

  it('沒按「帶上」一個字都不注入（拍板 #1 不變）', () => {
    const db = makeDb();
    addNode(db, { id: 'dirNano', name: 'nano plastics' });
    seedPaper(db, { nodeId: 'dirNano' });
    cacheCarryover({
      sessionKey: 'topic:dirNano',
      payload: { hypotheses: [{ claim_kind: 'hypothesis', statement: 'x', epistemic_origin: 'user_hypothesis' }] },
      version: 1,
      database: db,
    });
    assert.equal(renderCarryoverForInjection('p1', { database: db }), '');
  });
});
