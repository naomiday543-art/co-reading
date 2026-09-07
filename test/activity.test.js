import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import db from '../src/db.js';
import { nanoid } from 'nanoid';

// 固定資料以「今天 localtime 正午」為錨（工單 04 §7），往回減整天，避免日界誤差。
const DAY_MS = 86400000;
const NOON = new Date().setHours(12, 0, 0, 0);

const tsAt = (k, offsetMs = 0) => NOON - k * DAY_MS + offsetMs;

function dayStr(k) {
  const d = new Date(NOON - k * DAY_MS);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

let seqCounter = 0;

function reset() {
  db.exec('DELETE FROM messages; DELETE FROM insights; DELETE FROM papers;');
  seqCounter = 0;
}

function addPaper(id, k) {
  db.prepare('INSERT INTO papers (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run(id, 'Activity Test Paper', tsAt(k), tsAt(k));
}

function addMessage(paperId, role, k, { content = 'ping', offsetMs = 0 } = {}) {
  seqCounter += 1;
  db.prepare('INSERT INTO messages (id, paper_id, role, content, created_at, seq) VALUES (?, ?, ?, ?, ?, ?)')
    .run(nanoid(), paperId, role, content, tsAt(k, offsetMs), seqCounter);
}

function addInsight(paperId, dimension, k) {
  db.prepare(
    'INSERT INTO insights (id, dimension, title, content, source_paper_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(nanoid(), dimension, 'insight title', 'insight content', paperId, tsAt(k), tsAt(k));
}

// 基本資料：P1 上傳於 D-2；user 訊息 D-2 ×3、D-1 ×2、D0 ×1；assistant 訊息 D-2 ×3。
function seedBasic() {
  reset();
  addPaper('act_p1', 2);
  for (let i = 0; i < 3; i++) addMessage('act_p1', 'user', 2, { offsetMs: i * 1000 });
  for (let i = 0; i < 3; i++) addMessage('act_p1', 'assistant', 2, { offsetMs: 500 + i * 1000 });
  for (let i = 0; i < 2; i++) addMessage('act_p1', 'user', 1, { offsetMs: i * 1000 });
  addMessage('act_p1', 'user', 0);
}

describe('GET /api/activity', () => {
  let server;
  let baseUrl;

  before(async () => {
    const { startServer } = await import('../src/server.js');
    await new Promise((resolve) => {
      server = startServer(0, '127.0.0.1');
      server.once('listening', () => {
        baseUrl = `http://127.0.0.1:${server.address().port}`;
        resolve();
      });
    });
  });

  after(() => {
    reset();
    if (server) server.close();
  });

  const get = async (qs = '') => {
    const res = await fetch(`${baseUrl}/api/activity${qs}`);
    return { status: res.status, body: await res.json() };
  };

  it('buckets by local day, counts only user messages', async () => {
    seedBasic();
    const { status, body } = await get();
    assert.equal(status, 200);
    assert.equal(body.days.length, 3, '應含 D-2 / D-1 / D0 三天');

    const d2 = body.days.find(d => d.day === dayStr(2));
    assert.deepStrictEqual(
      { messages: d2.messages, insights: d2.insights, papers: d2.papers },
      { messages: 3, insights: 0, papers: 1 },
      'assistant 訊息不計入'
    );
    assert.equal(body.days.find(d => d.day === dayStr(1)).messages, 2);
    assert.equal(body.days.find(d => d.day === dayStr(0)).messages, 1);
    assert.equal(body.to, dayStr(0));
  });

  it('marks insight days and ranks dimensions', async () => {
    seedBasic();
    addInsight('act_p1', '概念', 1);
    addInsight('act_p1', '悬题', 1);

    const { body } = await get();
    assert.equal(body.days.find(d => d.day === dayStr(1)).insights, 2);
    assert.equal(body.dimensions.length, 2);
    // 依 count 降序（此處兩者同為 1，斷言排序不遞增即可）
    assert.ok(body.dimensions[0].count >= body.dimensions[1].count);
    const byDim = Object.fromEntries(body.dimensions.map(d => [d.dimension, d.count]));
    assert.deepStrictEqual(byDim, { 概念: 1, 悬题: 1 });
  });

  it('reports totals over the range', async () => {
    seedBasic();
    addInsight('act_p1', '概念', 1);
    addInsight('act_p1', '悬题', 1);

    const { body } = await get();
    assert.deepStrictEqual(body.totals, {
      messages: 6,
      insights: 2,
      papers: 1,
      active_days: 3,
    });
  });

  it('computes current and longest streak on consecutive days', async () => {
    seedBasic();
    const { body } = await get();
    assert.deepStrictEqual(body.streak, { current: 3, longest: 3 });
  });

  it('grants one day of grace when today has no activity', async () => {
    reset();
    addPaper('act_p2', 1);
    addMessage('act_p2', 'user', 1);

    const { body } = await get();
    assert.equal(body.streak.current, 1, '今天無活動時從昨天起算');
    assert.equal(body.streak.longest, 1);
  });

  it('breaks the streak across a gap', async () => {
    reset();
    addPaper('act_p3', 5);
    addMessage('act_p3', 'user', 5);
    addMessage('act_p3', 'user', 4);
    addMessage('act_p3', 'user', 1);

    const { body } = await get();
    assert.equal(body.streak.longest, 2);
    assert.equal(body.streak.current, 1);
  });

  it('returns the modal hour as peak_hour', async () => {
    seedBasic();
    const { body } = await get();
    assert.equal(body.peak_hour, 12);
  });

  it('honours ?days=1 (today only)', async () => {
    seedBasic();
    const { status, body } = await get('?days=1');
    assert.equal(status, 200);
    assert.equal(body.from, dayStr(0));
    assert.equal(body.to, dayStr(0));
    assert.equal(body.days.length, 1);
    assert.equal(body.days[0].day, dayStr(0));
  });

  it('honours ?days=0 (all — from = earliest activity day)', async () => {
    seedBasic();
    const { status, body } = await get('?days=0');
    assert.equal(status, 200);
    assert.equal(body.from, dayStr(2));
    assert.equal(body.to, dayStr(0));
  });

  it('rejects invalid days with 400', async () => {
    seedBasic();
    for (const qs of ['?days=abc', '?days=-1', '?days=9999', '?days=1.5']) {
      const { status, body } = await get(qs);
      assert.equal(status, 400, `${qs} 應回 400`);
      assert.ok(body.error, `${qs} 應帶 error`);
    }
  });

  it('returns an all-zero shape on an empty DB', async () => {
    reset();
    const { status, body } = await get();
    assert.equal(status, 200);
    assert.deepStrictEqual(body.days, []);
    assert.deepStrictEqual(body.totals, { messages: 0, insights: 0, papers: 0, active_days: 0 });
    assert.deepStrictEqual(body.streak, { current: 0, longest: 0 });
    assert.equal(body.peak_hour, null);
    assert.deepStrictEqual(body.dimensions, []);
  });

  it('returns an all-zero shape on an empty DB with days=0', async () => {
    reset();
    const { status, body } = await get('?days=0');
    assert.equal(status, 200);
    assert.equal(body.from, body.to);
    assert.deepStrictEqual(body.days, []);
  });

  it('never leaks message or insight content', async () => {
    reset();
    addPaper('act_p4', 1);
    addMessage('act_p4', 'user', 1, { content: 'SECRET_MARKER_xyz' });
    db.prepare(
      'INSERT INTO insights (id, dimension, title, content, source_paper_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(nanoid(), '概念', 'SECRET_TITLE_xyz', 'SECRET_BODY_xyz', 'act_p4', tsAt(1), tsAt(1));

    for (const qs of ['', '?days=0', '?days=30']) {
      const { body } = await get(qs);
      const raw = JSON.stringify(body);
      assert.ok(!raw.includes('SECRET_MARKER_xyz'), `${qs}: 不得外洩訊息內容`);
      assert.ok(!raw.includes('SECRET_TITLE_xyz'), `${qs}: 不得外洩洞察標題`);
      assert.ok(!raw.includes('SECRET_BODY_xyz'), `${qs}: 不得外洩洞察內容`);
      assert.ok(!raw.includes('"content"'), `${qs}: 回應不得有 content 欄位`);
      assert.ok(!raw.includes('"title"'), `${qs}: 回應不得有 title 欄位`);
    }
  });
});
