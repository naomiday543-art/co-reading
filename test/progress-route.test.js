// 工單 21 §九：B1 `GET /api/directions/:nodeId/progress` 的路由測試。
//
// 紅線：**絕不打真 gateway**（她的生產）。全部走注入的假 fetch ＋ 記憶體 DB，
// 一如 `test/carryover.test.js`／`test/carryover-direction.test.js` 的做法。
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import Database from 'better-sqlite3';

import { coveredDigest } from '../src/carryover.js';
import { createDirectionsRouter } from '../src/routes/directions.js';
import {
  sessionKeyForDirection,
  listDirectionPapers,
  fetchDirectionClaims,
  buildDirectionProgress,
} from '../src/progress.js';

// 生產 schema 的切片：方向線只碰 tree_nodes / papers / messages / refine_cursor。
function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE papers (
      id TEXT PRIMARY KEY, title TEXT DEFAULT '', tree_node_id TEXT,
      created_at INTEGER DEFAULT 0
    );
    CREATE TABLE tree_nodes (
      id TEXT PRIMARY KEY, parent_id TEXT, name TEXT NOT NULL,
      description TEXT DEFAULT '', sort_order INTEGER DEFAULT 0
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY, paper_id TEXT NOT NULL, role TEXT NOT NULL,
      content TEXT NOT NULL, seq INTEGER, created_at INTEGER DEFAULT 0
    );
    CREATE TABLE refine_cursor (
      paper_id TEXT PRIMARY KEY, session_key TEXT NOT NULL, last_seq INTEGER NOT NULL,
      covered_digest TEXT NOT NULL, updated_at INTEGER NOT NULL
    );
  `);
  return db;
}

function addNode(db, { id, parentId = null, name, description = '' }) {
  db.prepare('INSERT INTO tree_nodes (id, parent_id, name, description) VALUES (?, ?, ?, ?)')
    .run(id, parentId, name, description);
  return id;
}

function addPaper(db, { id, title = '論文', nodeId = null, createdAt = 0, messages = 0 }) {
  db.prepare('INSERT INTO papers (id, title, tree_node_id, created_at) VALUES (?, ?, ?, ?)')
    .run(id, title, nodeId, createdAt);
  for (let i = 1; i <= messages; i++) {
    db.prepare('INSERT INTO messages (id, paper_id, role, content, seq) VALUES (?, ?, ?, ?, ?)')
      .run(`${id}-m${i}`, id, i % 2 ? 'user' : 'assistant', `訊息 ${i}`, i);
  }
  return id;
}

const config = { url: 'https://example.test/research', token: 'tok' };

// 姊妹單 §四 的回應形狀
const GATEWAY_BODY = {
  session_key: 'topic:dirNano',
  claims: [
    { id: 'c1', claim_kind: 'research_question', epistemic_origin: 'user_hypothesis', status: 'active', statement: '奈米塑膠在生殖道體液怎麼測？', paper_ids: [], superseded_by: null, merged_into: null, supersede_reason: null },
    { id: 'c2', claim_kind: 'finding', epistemic_origin: 'paper_reported', status: 'active', statement: 'PE 在富脂基質會偽陽性', paper_ids: ['pA'], superseded_by: null, merged_into: null, supersede_reason: null },
  ],
  relations: [
    { id: 'r1', from_id: 'c2', to_id: 'c1', kind: 'answers', note: null, created_at: 1 },
  ],
  counts: { active: 2, superseded: 0, merged: 0, relations: 1 },
};

function fakeGateway(handler) {
  const calls = [];
  const impl = async (url, opts) => {
    calls.push({ url, opts });
    const out = handler ? handler(calls.length, url, opts) : null;
    if (out instanceof Error) throw out;
    return out ?? {
      ok: true,
      status: 200,
      json: async () => GATEWAY_BODY,
      text: async () => '',
    };
  };
  impl.calls = calls;
  return impl;
}

function seedDirection(db) {
  addNode(db, { id: 'dirNano', name: 'nano plastics', description: '血液分佈' });
  addNode(db, { id: 'subBlood', parentId: 'dirNano', name: '血液' });
  addNode(db, { id: 'dirOther', name: '另一個方向' });
  addPaper(db, { id: 'pA', title: 'Rauert 2025', nodeId: 'dirNano', createdAt: 1, messages: 4 });
  addPaper(db, { id: 'pB', title: '子題底下那篇', nodeId: 'subBlood', createdAt: 2, messages: 2 });
  addPaper(db, { id: 'pOther', title: '別的方向', nodeId: 'dirOther', createdAt: 3, messages: 2 });
  addPaper(db, { id: 'pLoose', title: '沒掛方向', nodeId: null, createdAt: 4, messages: 2 });
  return db;
}

// ── 純函式層 ───────────────────────────────────────────────────

describe('listDirectionPapers（§三 B1：含子節點的論文）', () => {
  it('撈方向本身＋所有子孫節點底下的論文，別的方向與未分類的不進來', () => {
    const db = seedDirection(makeDb());
    const papers = listDirectionPapers('dirNano', { database: db });
    assert.deepEqual(papers.map(p => p.id), ['pA', 'pB']);
    assert.equal(papers[0].message_count, 4);
    assert.equal(papers[1].message_count, 2);
  });

  it('每篇帶 refine_state（never／fresh／new_messages）', () => {
    const db = seedDirection(makeDb());
    assert.equal(listDirectionPapers('dirNano', { database: db })[0].refine_state, 'never');

    // 精煉過且指紋對得上 ⇒ fresh
    db.prepare(`
      INSERT INTO refine_cursor (paper_id, session_key, last_seq, covered_digest, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run('pA', 'topic:dirNano', 4, coveredDigest('pA', 4, { database: db }), Date.now());
    assert.equal(listDirectionPapers('dirNano', { database: db })[0].refine_state, 'fresh');

    // 之後又聊了兩句 ⇒ new_messages（她按了才跑，不自動）
    db.prepare('INSERT INTO messages (id, paper_id, role, content, seq) VALUES (?, ?, ?, ?, ?)')
      .run('pA-m5', 'pA', 'user', '再問一句', 5);
    assert.equal(listDirectionPapers('dirNano', { database: db })[0].refine_state, 'new_messages');
  });

  it('改過舊訊息 ⇒ stale（只亮提示，逐篇精煉不納入）', () => {
    const db = seedDirection(makeDb());
    db.prepare(`
      INSERT INTO refine_cursor (paper_id, session_key, last_seq, covered_digest, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run('pA', 'topic:dirNano', 4, coveredDigest('pA', 4, { database: db }), Date.now());
    db.prepare('UPDATE messages SET content = ? WHERE id = ?').run('改過的內容', 'pA-m2');
    assert.equal(listDirectionPapers('dirNano', { database: db })[0].refine_state, 'stale');
  });
});

describe('fetchDirectionClaims（§三 B1：外呼形狀）', () => {
  it('打 /claims?session_key=…&include=superseded，帶 Bearer', async () => {
    const fetchImpl = fakeGateway();
    const r = await fetchDirectionClaims('topic:dirNano', { fetchImpl, config });
    assert.equal(r.ok, true);
    assert.equal(fetchImpl.calls.length, 1);
    const url = new URL(fetchImpl.calls[0].url);
    assert.equal(url.pathname, '/research/claims');
    assert.equal(url.searchParams.get('session_key'), 'topic:dirNano');
    assert.equal(url.searchParams.get('include'), 'superseded');
    assert.equal(fetchImpl.calls[0].opts.headers.Authorization, 'Bearer tok');
  });

  it('gateway 非 2xx ⇒ ok:false 帶 reason，不拋', async () => {
    const fetchImpl = fakeGateway(() => ({ ok: false, status: 503, json: async () => ({}), text: async () => 'upstream down' }));
    const r = await fetchDirectionClaims('topic:dirNano', { fetchImpl, config });
    assert.deepEqual(r, { ok: false, reason: 'http 503' });
  });

  it('連線炸掉 ⇒ ok:false 帶 reason，不拋', async () => {
    const fetchImpl = fakeGateway(() => new Error('socket hang up'));
    const r = await fetchDirectionClaims('topic:dirNano', { fetchImpl, config });
    assert.equal(r.ok, false);
    assert.match(r.reason, /socket hang up/);
  });

  it('沒設定 gateway ⇒ 零外呼', async () => {
    const fetchImpl = fakeGateway();
    const r = await fetchDirectionClaims('topic:dirNano', { fetchImpl, config: null });
    assert.deepEqual(r, { ok: false, reason: 'gateway not configured' });
    assert.equal(fetchImpl.calls.length, 0);
  });
});

describe('buildDirectionProgress（§三 B1：狀態碼由邏輯決定）', () => {
  it('非頂層節點 ⇒ 400', async () => {
    const db = seedDirection(makeDb());
    const r = await buildDirectionProgress('subBlood', { database: db, fetchImpl: fakeGateway(), config });
    assert.equal(r.ok, false);
    assert.equal(r.status, 400);
  });

  it('節點不存在 ⇒ 404，且不打 gateway', async () => {
    const db = seedDirection(makeDb());
    const fetchImpl = fakeGateway();
    const r = await buildDirectionProgress('nope', { database: db, fetchImpl, config });
    assert.equal(r.status, 404);
    assert.equal(fetchImpl.calls.length, 0);
  });

  it('gateway 失敗 ⇒ 502 帶 reason（不拋、不吞）', async () => {
    const db = seedDirection(makeDb());
    const fetchImpl = fakeGateway(() => ({ ok: false, status: 500, json: async () => ({}), text: async () => 'boom' }));
    const r = await buildDirectionProgress('dirNano', { database: db, fetchImpl, config });
    assert.equal(r.status, 502);
    assert.equal(r.reason, 'http 500');
  });

  it('session_key 是 topic:<方向 id>', () => {
    assert.equal(sessionKeyForDirection('dirNano'), 'topic:dirNano');
  });
});

// ── 路由層（真 express、假 gateway、記憶體 DB）─────────────────

describe('GET /api/directions/:nodeId/progress', () => {
  let server;
  let baseUrl;
  let db;
  let fetchImpl;
  let gatewayHandler = null;

  before(async () => {
    db = seedDirection(makeDb());
    fetchImpl = fakeGateway((n, url, opts) => (gatewayHandler ? gatewayHandler(n, url, opts) : null));
    const app = express();
    app.use(express.json());
    app.use('/api', createDirectionsRouter({ database: db, fetchImpl, config }));
    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => new Promise((resolve) => server.close(resolve)));

  it('正常：方向、線名、論文清單、claims／relations 原樣', async () => {
    gatewayHandler = null;
    const res = await fetch(`${baseUrl}/api/directions/dirNano/progress`);
    assert.equal(res.status, 200);
    const body = await res.json();

    assert.deepEqual(body.direction, { id: 'dirNano', name: 'nano plastics', description: '血液分佈' });
    assert.equal(body.session_key, 'topic:dirNano');
    assert.deepEqual(body.papers.map(p => p.id), ['pA', 'pB']);
    assert.equal(body.papers[0].title, 'Rauert 2025');
    assert.ok(body.papers.every(p => typeof p.refine_state === 'string'));
    // gateway 原樣（紅線 2：co-reading 不改一個欄位、不落庫）
    assert.deepEqual(body.claims, GATEWAY_BODY.claims);
    assert.deepEqual(body.relations, GATEWAY_BODY.relations);
    assert.deepEqual(body.counts, GATEWAY_BODY.counts);
    assert.equal(typeof body.fetched_at, 'number');
  });

  it('非頂層方向 ⇒ 400', async () => {
    const res = await fetch(`${baseUrl}/api/directions/subBlood/progress`);
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /頂層/);
  });

  it('節點不存在 ⇒ 404', async () => {
    const res = await fetch(`${baseUrl}/api/directions/ghost/progress`);
    assert.equal(res.status, 404);
  });

  it('gateway 502 ⇒ 502 帶 reason', async () => {
    gatewayHandler = () => ({ ok: false, status: 502, json: async () => ({}), text: async () => 'bad gateway' });
    const res = await fetch(`${baseUrl}/api/directions/dirNano/progress`);
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.reason, 'http 502');
    gatewayHandler = null;
  });

  it('空線（gateway 回 0 條）⇒ 200，papers 照常有', async () => {
    gatewayHandler = () => ({
      ok: true, status: 200, text: async () => '',
      json: async () => ({ session_key: 'topic:dirNano', claims: [], relations: [], counts: { active: 0, superseded: 0, merged: 0, relations: 0 } }),
    });
    const res = await fetch(`${baseUrl}/api/directions/dirNano/progress`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.claims, []);
    assert.deepEqual(body.relations, []);
    assert.equal(body.papers.length, 2);
    gatewayHandler = null;
  });

  it('gateway 回沒有 claims 欄位（形狀壞掉）⇒ 不炸，退成空陣列', async () => {
    gatewayHandler = () => ({ ok: true, status: 200, text: async () => '', json: async () => ({}) });
    const res = await fetch(`${baseUrl}/api/directions/dirNano/progress`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.claims, []);
    assert.deepEqual(body.relations, []);
    gatewayHandler = null;
  });
});
