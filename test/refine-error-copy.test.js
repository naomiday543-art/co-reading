// 工單 22：精煉失敗時，把 gateway 的 `code` 翻成她看得懂的一句話。
//
// 9/19 實錄：她按「精煉」看到的永遠是「精煉失敗：http 502」——沒錢／key 壞／
// 模型下架／逾時全長一個樣。gateway 姊妹單（refine-error-transparency）在回應裡
// 加了穩定的 `error.code`／`error.detail`；這裡釘住「每個 code 一句對」、
// 「舊 gateway（沒 code）退回現況」、「body 原文不進日誌」。
//
// 紅線：絕不打真 gateway。全部走注入／覆寫的假 fetch。
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';

import { describeRefineFailure, requestRefine } from '../src/carryover.js';
import { dataPaths } from '../src/paths.js';

const config = { url: 'https://example.test/research', token: 'tok' };

// gateway 失敗回應的形狀（姊妹單 E2）：{ error: { type, message, code, detail } }
function gatewayError({ type = 'refine_upstream', message = 'refine failed', code, detail } = {}) {
  const error = { type, message };
  if (code !== undefined) error.code = code;
  if (detail !== undefined) error.detail = detail;
  return { error };
}

describe('describeRefineFailure：每個 code 一句對（工單 22 §二 C1）', () => {
  const table = [
    ['provider_payment', '上游拒絕：帳戶餘額不足（去充值或換供應商）'],
    ['provider_auth', '上游拒絕：金鑰無效或過期'],
    ['provider_not_found', '上游找不到這個模型（檢查 REFINE_MODEL）'],
    ['provider_missing_session', '上游缺 session 標頭（gateway 版本太舊）'],
    ['provider_bad_request', '上游拒絕這個請求（參數或格式）'],
    ['provider_rate_limited', '上游限流，等一下再按'],
    ['provider_server_error', '上游暫時故障，等一下再按'],
    ['provider_unreachable', '連不上上游（VPS 到供應商的網路）'],
    ['provider_empty', '模型這次沒給合格的答案，再按一次通常就好'],
    ['provider_invalid_stream', '模型這次沒給合格的答案，再按一次通常就好'],
    ['output_parse', '模型這次沒給合格的答案，再按一次通常就好'],
    ['output_schema', '模型這次沒給合格的答案，再按一次通常就好'],
    ['timeout', '精煉逾時（對話太長或上游太慢），再按一次'],
    ['config', 'gateway 沒設定精煉模型'],
    ['input', '沒有新對話可精煉'],
  ];

  for (const [code, sentence] of table) {
    it(`${code} → 「${sentence}」`, () => {
      const out = describeRefineFailure({ status: 502, body: gatewayError({ code, detail: 'HTTP 402' }) });
      assert.equal(out.reason, sentence);
      assert.equal(out.code, code);
      assert.equal(out.detail, 'HTTP 402');
    });
  }

  it('每句都是繁體、用「你」不用「妳」，且不含機器碼', () => {
    for (const [code, sentence] of table) {
      assert.ok(!sentence.includes('妳'), `${code} 用了「妳」`);
      assert.ok(!sentence.includes(code), `${code} 把機器碼漏進文案`);
      assert.ok(!/[a-z]+_[a-z]+/.test(sentence.replace('REFINE_MODEL', '')), `${code} 夾了 snake_case`);
    }
  });

  it('舊 gateway（沒有 code）→ 退回現況 http <status>', () => {
    const out = describeRefineFailure({ status: 502, body: {} });
    assert.equal(out.reason, 'http 502');
    assert.equal(out.code, null);
    assert.equal(out.detail, null);
  });

  it('沒有 code 但有 type → http <status>（type）', () => {
    const out = describeRefineFailure({ status: 502, body: gatewayError({ type: 'refine_upstream' }) });
    assert.equal(out.reason, 'http 502（refine_upstream）');
    assert.equal(out.code, null);
  });

  it('表上沒有的 code（例如 internal）→ 退回 http <status>，但 code 原樣留著', () => {
    const out = describeRefineFailure({ status: 500, body: gatewayError({ type: 'refine_internal', code: 'internal' }) });
    assert.equal(out.reason, 'http 500（refine_internal）');
    assert.equal(out.code, 'internal');
  });

  it('body 是 null／非物件／error 不是物件 → 不炸，退回 http <status>', () => {
    assert.equal(describeRefineFailure({ status: 503, body: null }).reason, 'http 503');
    assert.equal(describeRefineFailure({ status: 503, body: 'boom' }).reason, 'http 503');
    assert.equal(describeRefineFailure({ status: 503, body: { error: 'boom' } }).reason, 'http 503');
    assert.equal(describeRefineFailure({}).reason, 'http error');
  });
});

// ── requestRefine 接線（§二 C2）─────────────────────────────────

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE papers (id TEXT PRIMARY KEY, title TEXT DEFAULT '', tree_node_id TEXT);
    CREATE TABLE tree_nodes (
      id TEXT PRIMARY KEY, parent_id TEXT, name TEXT NOT NULL,
      description TEXT DEFAULT '', sort_order INTEGER DEFAULT 0
    );
    CREATE TABLE refine_cursor (
      paper_id TEXT PRIMARY KEY, session_key TEXT NOT NULL, last_seq INTEGER NOT NULL,
      covered_digest TEXT NOT NULL, updated_at INTEGER NOT NULL
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
  `);
  db.prepare('INSERT INTO papers (id, title) VALUES (?, ?)').run('p1', '奈米塑膠與蛋白冠');
  db.prepare('INSERT INTO messages (id, paper_id, role, content, seq) VALUES (?, ?, ?, ?, ?)')
    .run('p1-m1', 'p1', 'user', '這篇的樣本量夠嗎', 1);
  db.prepare('INSERT INTO messages (id, paper_id, role, content, seq) VALUES (?, ?, ?, ?, ?)')
    .run('p1-m2', 'p1', 'assistant', 'n=12，偏小', 2);
  return db;
}

const failingGateway = (status, body) => async () => ({
  ok: false,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

describe('requestRefine：失敗回 reason／code／detail，日誌不印 body 原文', () => {
  it('402 帶 provider_payment → 她看得懂的一句話', async () => {
    const db = makeDb();
    const f = failingGateway(502, gatewayError({
      type: 'refine_upstream', code: 'provider_payment', detail: 'HTTP 402',
    }));
    const r = await requestRefine('p1', { database: db, fetchImpl: f, config });
    assert.equal(r.ok, false);
    assert.equal(r.reason, '上游拒絕：帳戶餘額不足（去充值或換供應商）');
    assert.equal(r.code, 'provider_payment');
    assert.equal(r.detail, 'HTTP 402');
  });

  it('日誌印 code=／detail=，不印 gateway body 原文（可能夾上游原話）', async () => {
    const db = makeDb();
    const secret = 'insufficient-balance-for-account-sk-LEAKME';
    const f = failingGateway(502, {
      error: {
        type: 'refine_upstream', message: 'refine provider request failed',
        code: 'provider_payment', detail: 'HTTP 402',
      },
      upstream_raw: secret,
    });
    await requestRefine('p1', { database: db, fetchImpl: f, config });

    const lines = readFileSync(dataPaths.logPath, 'utf-8').trim().split('\n');
    const line = lines.reverse().find(l => l.includes('精煉失敗 p1'));
    assert.ok(line, '應該有一條精煉失敗 WARN');
    assert.ok(line.includes('code=provider_payment'), line);
    assert.ok(line.includes('detail=HTTP 402'), line);
    assert.ok(!line.includes(secret), '日誌漏了 gateway body 原文');
    assert.ok(!line.includes('sk-'), '日誌可能夾帶金鑰片段');
  });

  it('舊 gateway（回應沒有 error.code）→ 行為與改前逐字相同：http 500', async () => {
    const db = makeDb();
    const f = failingGateway(500, {});
    const r = await requestRefine('p1', { database: db, fetchImpl: f, config });
    assert.equal(r.reason, 'http 500');
    assert.equal(r.code, null);
    assert.equal(r.detail, null);
  });

  it('回應根本不是 JSON（res.json() 拋）→ 不炸，退回 http <status>', async () => {
    const db = makeDb();
    const f = async () => ({ ok: false, status: 504, json: async () => { throw new Error('not json'); } });
    const r = await requestRefine('p1', { database: db, fetchImpl: f, config });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'http 504');
  });
});

// ── 路由（§二 C2：502 body 帶 error／code／detail）────────────────

describe('POST /api/papers/:id/refine：502 帶翻譯過的一句話', () => {
  let server; let baseUrl; let realFetch; let db; let papersRouter;

  before(async () => {
    ({ default: db } = await import('../src/db.js'));
    const { setSetting } = await import('../src/db.js');
    ({ default: papersRouter } = await import('../src/routes/papers.js'));
    setSetting('gateway_url', config.url);
    setSetting('gateway_token', config.token);

    db.exec("DELETE FROM messages; DELETE FROM papers WHERE id = 'wo22-p';");
    db.prepare('INSERT INTO papers (id, title) VALUES (?, ?)').run('wo22-p', '奈米塑膠與蛋白冠');
    db.prepare('INSERT INTO messages (id, paper_id, role, content, seq) VALUES (?, ?, ?, ?, ?)')
      .run('wo22-m1', 'wo22-p', 'user', '這篇的樣本量夠嗎', 1);
    db.prepare('INSERT INTO messages (id, paper_id, role, content, seq) VALUES (?, ?, ?, ?, ?)')
      .run('wo22-m2', 'wo22-p', 'assistant', 'n=12，偏小', 2);

    realFetch = globalThis.fetch;
    globalThis.fetch = failingGateway(502, gatewayError({
      type: 'refine_upstream', code: 'provider_payment', detail: 'HTTP 402',
    }));

    const app = express();
    app.use(express.json());
    app.use('/api/papers', papersRouter);
    server = app.listen(0);
    await new Promise(r => server.once('listening', r));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => {
    globalThis.fetch = realFetch;
    server?.close();
  });

  it('gateway 回 402/provider_payment → 502「精煉失敗：上游拒絕：帳戶餘額不足…」＋code＋detail', async () => {
    const res = await realFetch(`${baseUrl}/api/papers/wo22-p/refine`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.error, '精煉失敗：上游拒絕：帳戶餘額不足（去充值或換供應商）');
    assert.equal(body.code, 'provider_payment');
    assert.equal(body.detail, 'HTTP 402');
  });
});
