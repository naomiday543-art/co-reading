import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import Database from 'better-sqlite3';
import {
  sessionKeyFor,
  buildRefineRequest,
  requestRefine,
  fetchCarryover,
  getCachedCarryover,
  cacheCarryover,
  isCarryoverInjected,
  setCarryoverInjected,
  renderCarryoverForPrompt,
  renderCarryoverForInjection,
  carryoverEnv,
} from '../src/carryover.js';

// In-memory DB：只建 carryover 客戶端碰到的表切片，不碰 data/（紅線 12）
function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE papers (id TEXT PRIMARY KEY, title TEXT DEFAULT '');
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
  `);
  return db;
}

function seedPaper(db, id = 'p1') {
  db.prepare('INSERT INTO papers (id, title) VALUES (?, ?)').run(id, 'Cloud Feedback Review');
  let i = 0;
  const addMsg = (role, content) => {
    db.prepare('INSERT INTO messages (id, paper_id, role, content, seq) VALUES (?, ?, ?, ?, ?)')
      .run(`${id}-m${++i}`, id, role, content, i);
  };
  addMsg('user', '我覺得低雲反饋是最大不確定源');
  addMsg('assistant', '這篇的 Figure 3 支持這個方向');
  addMsg('user', '那濕靜力能呢？');
  addMsg('assistant', '文中沒有直接討論，可以作為假設');
  db.prepare('INSERT INTO insights (id, dimension, title, source_paper_id) VALUES (?, ?, ?, ?)')
    .run('ins1', '概念', '雲反饋要點', id);
  return { addMsg, maxSeq: () => i };
}

const config = { url: 'https://example.test/research', token: 'tok' };

function fakeFetch(handler) {
  const calls = [];
  const impl = async (url, opts) => {
    calls.push({ url, opts });
    const out = handler(calls.length, url, opts);
    if (out instanceof Error) throw out;
    return out;
  };
  impl.calls = calls;
  return impl;
}

const refineOk = (over = {}) => fakeFetch(() => ({
  ok: true,
  status: 200,
  json: async () => ({
    run_id: 'run-1', carryover_id: 'co-1', version: 1, idempotent: false,
    stats: { created: 2 },
    carryover: { carryover_version: 'rc-1', session_key: 'paper:p1', hypotheses: [], ...over.carryover },
    ...over.top,
  }),
  text: async () => '',
}));

describe('buildRefineRequest', () => {
  it('組出契約 §九 body：session_key、全量 transcript（seq 排序）、insights', () => {
    const db = makeDb();
    seedPaper(db);
    const { body } = buildRefineRequest('p1', { database: db });
    assert.strictEqual(body.source, 'co-reading');
    assert.strictEqual(body.session_key, 'paper:p1');
    assert.strictEqual(body.paper_id, 'p1');
    assert.strictEqual(body.paper_title, 'Cloud Feedback Review');
    assert.strictEqual(body.transcript.length, 4);
    assert.strictEqual(body.transcript[0].seq, 1);
    assert.deepStrictEqual(body.insights.map(i => i.id), ['ins1']);
  });
});

describe('requestRefine', () => {
  it('未配置 gateway → ok:false，不外呼', async () => {
    const db = makeDb();
    seedPaper(db);
    const r = await requestRefine('p1', { database: db, config: null });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'gateway not configured');
  });

  it('happy path：POST /sessions/refine、Bearer token、快取落地含 last_seq', async () => {
    const db = makeDb();
    seedPaper(db);
    const f = refineOk();
    const r = await requestRefine('p1', { database: db, fetchImpl: f, config });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.version, 1);
    assert.strictEqual(f.calls.length, 1);
    assert.strictEqual(f.calls[0].url, 'https://example.test/research/sessions/refine');
    assert.strictEqual(f.calls[0].opts.headers.Authorization, 'Bearer tok');
    const sentBody = JSON.parse(f.calls[0].opts.body);
    assert.strictEqual(sentBody.session_key, 'paper:p1');
    assert.ok(sentBody.opts_removed !== true);

    const cached = getCachedCarryover('paper:p1', { database: db });
    assert.strictEqual(cached.version, 1);
    assert.strictEqual(cached.lastSeq, 4);
  });

  it('無新訊息 → 本地冪等短路（零外呼）', async () => {
    const db = makeDb();
    seedPaper(db);
    const f = refineOk();
    await requestRefine('p1', { database: db, fetchImpl: f, config });
    const r2 = await requestRefine('p1', { database: db, fetchImpl: f, config });
    assert.strictEqual(r2.ok, true);
    assert.strictEqual(r2.idempotent, true);
    assert.strictEqual(f.calls.length, 1);
  });

  it('有新訊息 → 只送增量（since_seq=上次 last_seq，body 帶全量由 gateway 過濾）', async () => {
    const db = makeDb();
    const { addMsg } = seedPaper(db);
    const f = refineOk();
    await requestRefine('p1', { database: db, fetchImpl: f, config });
    addMsg('user', '新的追問');
    const r2 = await requestRefine('p1', { database: db, fetchImpl: f, config });
    assert.strictEqual(r2.ok, true);
    assert.strictEqual(f.calls.length, 2);
    const sentBody = JSON.parse(f.calls[1].opts.body);
    assert.strictEqual(sentBody.since_seq, 4, 'delta since last refined seq');
  });

  it('HTTP 500 → ok:false、快取不動、不拋', async () => {
    const db = makeDb();
    seedPaper(db);
    const f = fakeFetch(() => ({ ok: false, status: 500, text: async () => 'boom', json: async () => ({}) }));
    const r = await requestRefine('p1', { database: db, fetchImpl: f, config });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'http 500');
    assert.strictEqual(getCachedCarryover('paper:p1', { database: db }), null);
  });

  it('網路異常 → 只 log 不拋', async () => {
    const db = makeDb();
    seedPaper(db);
    const f = fakeFetch(() => new Error('ECONNREFUSED'));
    const r = await requestRefine('p1', { database: db, fetchImpl: f, config });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'ECONNREFUSED');
  });
});

describe('fetchCarryover', () => {
  it('200 → 快取；404 → null', async () => {
    const db = makeDb();
    const ok = fakeFetch(() => ({
      ok: true, status: 200,
      json: async () => ({ session_key: 'paper:p1', version: 3, carryover: { carryover_version: 'rc-1', session_key: 'paper:p1' } }),
    }));
    const r = await fetchCarryover('paper:p1', { database: db, fetchImpl: ok, config });
    assert.strictEqual(r.version, 3);
    assert.strictEqual(getCachedCarryover('paper:p1', { database: db }).version, 3);

    const miss = fakeFetch(() => ({ ok: false, status: 404, json: async () => ({}) }));
    const r2 = await fetchCarryover('paper:ghost', { database: db, fetchImpl: miss, config });
    assert.strictEqual(r2, null);
  });
});

describe('inject 開關（拍板 #1：手動）', () => {
  it('預設不注入；「帶上」後注入；env auto-inject 全域開', async () => {
    const db = makeDb();
    seedPaper(db);
    cacheCarryover({ sessionKey: 'paper:p1', payload: { carryover_version: 'rc-1', hypotheses: [] }, version: 1, database: db });

    assert.strictEqual(isCarryoverInjected('p1', { database: db }), false);
    assert.strictEqual(renderCarryoverForInjection('p1', { database: db }), '', 'not injected without opt-in');

    setCarryoverInjected('p1', true, { database: db });
    assert.strictEqual(isCarryoverInjected('p1', { database: db }), true);
    // 空內容 carryover 注入仍為空字串（渲染層判空）
    assert.strictEqual(renderCarryoverForInjection('p1', { database: db }), '');

    setCarryoverInjected('p1', false, { database: db });
    assert.strictEqual(isCarryoverInjected('p1', { database: db }), false);
    assert.strictEqual(carryoverEnv.autoInject, false, 'env default off');
  });
});

describe('renderCarryoverForPrompt（§10.1 精神：origin 必標、衝突必現）', () => {
  it('每條帶 origin 標記；未驗證假設明示；衝突段醒目', () => {
    const text = renderCarryoverForPrompt({
      research_question: { claim_kind: 'research_question', statement: '雲反饋如何調節敏感度？', epistemic_origin: 'user_hypothesis' },
      hypotheses: [
        { claim_kind: 'hypothesis', statement: 'Y：濕靜力能是調節子', epistemic_origin: 'user_hypothesis' },
      ],
      confirmed_findings: [
        { claim_kind: 'finding', statement: 'CMIP6 均值為正', epistemic_origin: 'paper_reported' },
      ],
      conflicting_evidence: [
        { claim_kind: 'evidence', statement: 'B 的反證', epistemic_origin: 'paper_reported', counterpart_statement: 'X 主張' },
      ],
    });
    assert.ok(text.includes('【研究續窗】'));
    assert.ok(text.includes('[hypothesis｜你的假設，未驗證] Y'));
    assert.ok(text.includes('[finding｜論文報告] CMIP6'));
    assert.ok(text.includes('證據衝突'));
    assert.ok(text.includes('B 的反證 ⇄ X 主張'));
    assert.ok(text.includes('不是論文事實'));
  });

  it('空 carryover → 空字串（不注入垃圾）', () => {
    assert.strictEqual(renderCarryoverForPrompt(null), '');
    assert.strictEqual(renderCarryoverForPrompt({}), '');
  });

  it('每段限量 maxPerSection，超量截斷', () => {
    const text = renderCarryoverForPrompt({
      hypotheses: Array.from({ length: 10 }, (_, i) => ({ claim_kind: 'hypothesis', statement: `假設 ${i}`, epistemic_origin: 'user_hypothesis' })),
    }, { maxPerSection: 3 });
    assert.ok(text.includes('假設 2'));
    assert.ok(!text.includes('假設 3'), 'items beyond cap dropped');
  });
});
