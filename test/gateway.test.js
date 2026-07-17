import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import Database from 'better-sqlite3';
import { nanoid } from 'nanoid';
import {
  expandTreePath,
  buildInsightPayload,
  syncInsight,
  flushUnsynced,
} from '../src/gateway.js';

// In-memory DB mirroring the co-reading schema slice the outbox touches — keeps tests off data/.
function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE tree_nodes (id TEXT PRIMARY KEY, parent_id TEXT, name TEXT NOT NULL);
    CREATE TABLE papers (id TEXT PRIMARY KEY, title TEXT DEFAULT '', tree_node_id TEXT);
    CREATE TABLE insights (
      id TEXT PRIMARY KEY, dimension TEXT, title TEXT DEFAULT '', content TEXT DEFAULT '',
      source_paper_id TEXT, source_context TEXT DEFAULT '', tags_json TEXT DEFAULT '[]',
      external_ombre_id TEXT, synced_at INTEGER
    );
  `);
  return db;
}

function seedInsight(db, over = {}) {
  const id = over.id || nanoid();
  db.prepare(`INSERT INTO insights (id, dimension, title, content, source_paper_id, source_context, tags_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
    id, over.dimension || '概念', over.title || '標題', over.content || '低雲反饋影響氣候敏感度',
    over.source_paper_id || null, over.source_context || 'ctx', over.tags_json || '[]'
  );
  return db.prepare('SELECT * FROM insights WHERE id = ?').get(id);
}

const config = { url: 'https://example.test/research', token: 'tok' };
function okFetch(ombre_id = 'ombre_1') {
  const calls = [];
  const impl = async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, status: 200, json: async () => ({ ombre_id }), text: async () => '' };
  };
  impl.calls = calls;
  return impl;
}
function failFetch() {
  const calls = [];
  const impl = async (url, opts) => { calls.push({ url, opts }); throw new Error('ECONNREFUSED'); };
  impl.calls = calls;
  return impl;
}

describe('expandTreePath', () => {
  it('builds a root/.../leaf path from tree_nodes', () => {
    const db = makeDb();
    db.prepare('INSERT INTO tree_nodes (id, parent_id, name) VALUES (?,?,?)').run('r', null, '雲反饋');
    db.prepare('INSERT INTO tree_nodes (id, parent_id, name) VALUES (?,?,?)').run('c', 'r', '低雲');
    assert.strictEqual(expandTreePath('c', db), '雲反饋/低雲');
    assert.strictEqual(expandTreePath('r', db), '雲反饋');
    assert.strictEqual(expandTreePath(null, db), null);
    assert.strictEqual(expandTreePath('missing', db), null);
  });
});

describe('buildInsightPayload', () => {
  it('emits the §二 body incl. tree_path when the paper has a tree node', () => {
    const db = makeDb();
    db.prepare('INSERT INTO tree_nodes (id, parent_id, name) VALUES (?,?,?)').run('r', null, '雲反饋');
    db.prepare('INSERT INTO papers (id, title, tree_node_id) VALUES (?,?,?)').run('p1', 'Cloud Paper', 'r');
    const ins = seedInsight(db, { source_paper_id: 'p1', dimension: '悬题', tags_json: '["climate"]' });
    const body = buildInsightPayload(ins, db);
    assert.strictEqual(body.external_id, ins.id);
    assert.strictEqual(body.dimension, '悬题');
    assert.strictEqual(body.paper_id, 'p1');
    assert.strictEqual(body.paper_title, 'Cloud Paper');
    assert.strictEqual(body.tree_path, '雲反饋');
    assert.deepStrictEqual(body.tags, ['climate']);
  });
  it('omits tree_path when no tree node', () => {
    const db = makeDb();
    db.prepare('INSERT INTO papers (id, title, tree_node_id) VALUES (?,?,?)').run('p1', 'X', null);
    const body = buildInsightPayload(seedInsight(db, { source_paper_id: 'p1' }), db);
    assert.ok(!('tree_path' in body));
  });
});

describe('syncInsight', () => {
  let db, ins;
  beforeEach(() => { db = makeDb(); ins = seedInsight(db); });

  it('on 200 backfills external_ombre_id + synced_at', async () => {
    const fetchImpl = okFetch('ombre_42');
    const r = await syncInsight(ins, { database: db, fetchImpl, config });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.ombre_id, 'ombre_42');
    const row = db.prepare('SELECT * FROM insights WHERE id = ?').get(ins.id);
    assert.strictEqual(row.external_ombre_id, 'ombre_42');
    assert.ok(row.synced_at > 0);
    // POSTs to the /memory/insights endpoint with Bearer token
    assert.match(fetchImpl.calls[0].url, /\/memory\/insights$/);
    assert.strictEqual(fetchImpl.calls[0].opts.headers.Authorization, 'Bearer tok');
  });

  it('on network failure does NOT throw and leaves synced_at NULL', async () => {
    const r = await syncInsight(ins, { database: db, fetchImpl: failFetch(), config });
    assert.strictEqual(r.ok, false);
    const row = db.prepare('SELECT * FROM insights WHERE id = ?').get(ins.id);
    assert.strictEqual(row.synced_at, null);
    assert.strictEqual(row.external_ombre_id, null);
  });

  it('on HTTP 500 does NOT throw and leaves the row unsynced', async () => {
    const fetchImpl = async () => ({ ok: false, status: 500, text: async () => 'boom', json: async () => ({}) });
    const r = await syncInsight(ins, { database: db, fetchImpl, config });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(db.prepare('SELECT synced_at FROM insights WHERE id=?').get(ins.id).synced_at, null);
  });

  it('skips silently when gateway is not configured', async () => {
    const r = await syncInsight(ins, { database: db, fetchImpl: okFetch(), config: null });
    assert.strictEqual(r.ok, false);
    assert.match(r.reason, /not configured/);
  });
});

describe('flushUnsynced (startup backfill)', () => {
  it('only picks synced_at IS NULL rows and syncs them', async () => {
    const db = makeDb();
    const a = seedInsight(db, { content: 'pending A' });
    const b = seedInsight(db, { content: 'pending B' });
    // c already synced — must be skipped
    const c = seedInsight(db, { content: 'already synced C' });
    db.prepare('UPDATE insights SET synced_at = ?, external_ombre_id = ? WHERE id = ?').run(123, 'old', c.id);

    const fetchImpl = okFetch('ombre_x');
    const res = await flushUnsynced({ database: db, fetchImpl, config });
    assert.strictEqual(res.attempted, 2, 'only the two NULL rows attempted');
    assert.strictEqual(res.synced, 2);
    assert.strictEqual(fetchImpl.calls.length, 2, 'synced row C not re-sent');
    assert.ok(db.prepare('SELECT synced_at FROM insights WHERE id=?').get(a.id).synced_at > 0);
    assert.ok(db.prepare('SELECT synced_at FROM insights WHERE id=?').get(b.id).synced_at > 0);
    assert.strictEqual(db.prepare('SELECT synced_at FROM insights WHERE id=?').get(c.id).synced_at, 123);
  });
});
