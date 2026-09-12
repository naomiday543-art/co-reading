// 工單 09：多篇摘要對比（POST /api/compare）。
//
// 紅線（工單 §5）：
//   P1  prompt **只含五段摘要**——full_text 放了哨兵字串，斷言它不出現在任何一次上游請求裡
//   P1  每篇每段各截 1500 字；整份 prompt < 40k 字
//   H1/H2  opencode.ai base 帶 x-opencode-session，其他 base 不帶
//   S*  串流拼接、缺格補齊、預算用盡、非 JSON 的收口
// 全部走 mock fetch（覆寫 globalThis.fetch）＋ 臨時 data dir，不打真上游、不碰她的 DB。
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { nanoid } from 'nanoid';

import db, { setSetting } from '../src/db.js';
import { renderDirectionsBlock } from '../src/directions.js';
import {
  buildComparePrompt,
  parseCompareResponse,
  COMPARE_DIMENSIONS,
  COMPARE_MAX_TOKENS,
  SECTION_MAX,
  NOT_MENTIONED,
} from '../src/compare.js';

// 哨兵：只出現在 full_text，絕不准進 prompt（工單 §5）。
const SENTINEL = 'SENTINEL_FULLTEXT_LEAK_7f3a9c';

// ── mock 上游 ───────────────────────────────────────────────────────

/** 把 SSE 文字做成能餵給 collectStream 的假 Response（抄 test/extract-dimensions.test.js）。 */
function sseResponse(lines) {
  const encoder = new TextEncoder();
  return {
    ok: true,
    status: 200,
    body: {
      getReader() {
        let i = 0;
        return {
          read: async () => (i < lines.length
            ? { done: false, value: encoder.encode(lines[i++]) }
            : { done: true, value: undefined }),
        };
      },
    },
    text: async () => lines.join(''),
  };
}

const chunk = (obj) => `data: ${JSON.stringify(obj)}\n\n`;

/** OpenAI 形狀：一串 content 片段 ＋ 一個收尾事件。 */
function openaiStream(parts, { finishReason = 'stop', reasoning = '' } = {}) {
  const lines = [];
  if (reasoning) lines.push(chunk({ choices: [{ delta: { reasoning_content: reasoning } }] }));
  for (const p of parts) lines.push(chunk({ choices: [{ delta: { content: p } }] }));
  lines.push(chunk({ choices: [{ delta: {}, finish_reason: finishReason }] }));
  lines.push('data: [DONE]\n\n');
  return sseResponse(lines);
}

const captured = [];
let nextResponse = null;
const realFetch = globalThis.fetch;
let serverOrigin = null;

function installFetch() {
  globalThis.fetch = async (url, opts = {}) => {
    // 測試自己要用 fetch 去打 express；只攔「上游」那一段。
    if (serverOrigin && String(url).startsWith(serverOrigin)) return realFetch(url, opts);
    captured.push({
      url: String(url),
      headers: opts.headers || {},
      body: JSON.parse(opts.body || '{}'),
    });
    if (typeof nextResponse === 'function') return nextResponse();
    return nextResponse ?? openaiStream([JSON.stringify(fullResult())]);
  };
}

function restoreFetch() {
  globalThis.fetch = realFetch;
}

/** 預設的「模型好好回答」結果：每個維度每篇都有字。 */
function fullResult(ids = paperIds) {
  const table = {};
  for (const d of COMPARE_DIMENSIONS) {
    table[d] = {};
    for (const id of ids) table[d][id] = `${d}-${id}`;
  }
  return {
    table,
    analysis: {
      same: ['兩篇都用 DLS 量粒徑'],
      differ: ['一篇 120 nm、一篇 50 nm'],
      conflict: ['對蛋白冠厚度的結論相反'],
      for_her: '對你的奈米塑膠題目意味著要先固定粒徑。',
    },
  };
}

// ── 臨時資料 ────────────────────────────────────────────────────────

const paperIds = [];
const nodeIds = [];

function addPaper({
  id = `cmp_${nanoid(8)}`,
  title = `對比論文 ${id}`,
  authors = 'Tang et al.',
  year = 2023,
  analyzeStatus = 'done',
  treeNodeId = null,
  sections = {},
} = {}) {
  db.prepare(`INSERT INTO papers (id, title, authors, year, full_text, analyze_status, tree_node_id,
      summary_bg, summary_methods, summary_results, summary_conclusions, summary_limitations)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id, title, authors, year, `前略 ${SENTINEL} 後略`, analyzeStatus, treeNodeId,
    sections.bg ?? '背景段落', sections.methods ?? '方法段落',
    sections.results ?? '結果段落', sections.conclusions ?? '結論段落',
    sections.limitations ?? '局限段落',
  );
  paperIds.push(id);
  return id;
}

function addNode(name, { description = '', sortOrder = 0 } = {}) {
  const id = `node_${nanoid(8)}`;
  db.prepare('INSERT INTO tree_nodes (id, name, description, sort_order) VALUES (?, ?, ?, ?)')
    .run(id, name, description, sortOrder);
  nodeIds.push(id);
  return id;
}

function clearAll() {
  for (const id of paperIds.splice(0)) {
    db.prepare('DELETE FROM insights WHERE source_paper_id = ?').run(id);
    db.prepare('DELETE FROM papers WHERE id = ?').run(id);
  }
  for (const id of nodeIds.splice(0)) {
    db.prepare('DELETE FROM tree_nodes WHERE id = ?').run(id);
  }
}

function useBase(baseUrl, format = 'openai') {
  setSetting('ai_base_url', baseUrl);
  setSetting('ai_format', format);
  setSetting('ai_model', 'fake-model');
  setSetting('ai_api_key', 'fake-key');
}

function paperRows(ids) {
  return ids.map(id => db.prepare('SELECT * FROM papers WHERE id = ?').get(id));
}

// ── P：prompt（只含摘要的紅線）────────────────────────────────────────

describe('P 對比 prompt 只含摘要', () => {
  after(clearAll);

  it('P1 每篇五段都在，含標題／作者／年份，且不含 full_text 任何片段', () => {
    const a = addPaper({ title: '膽固醇改變蛋白冠', authors: 'Tang', year: 2023 });
    const b = addPaper({ title: 'Nanoplastic shape', authors: 'Lee', year: 2024 });
    const { system, user } = buildComparePrompt(paperRows([a, b]));

    for (const d of COMPARE_DIMENSIONS) assert.ok(user.includes(`### ${d}`), `缺維度 ${d}`);
    assert.ok(user.includes('## 論文 1：《膽固醇改變蛋白冠》（Tang，2023）'), user.slice(0, 200));
    assert.ok(user.includes('## 論文 2：《Nanoplastic shape》（Lee，2024）'));
    assert.ok(user.includes('背景段落') && user.includes('局限段落'));

    assert.ok(!user.includes(SENTINEL), 'full_text 漏進 user 了');
    assert.ok(!system.includes(SENTINEL), 'full_text 漏進 system 了');
    clearAll();
  });

  it('P1b 每段截到 1500 字，整份 prompt < 40k 字（四篇滿載）', () => {
    const long = 'あ'.repeat(4000);
    const ids = [];
    for (let i = 0; i < 4; i++) {
      ids.push(addPaper({
        title: `長摘要論文 ${i}`,
        sections: {
          bg: long, methods: long, results: long, conclusions: long, limitations: long,
        },
      }));
    }
    const { system, user } = buildComparePrompt(paperRows(ids));

    // 每段被截成 1500 字 + 一個省略號：連續的「あ」最長一串就是 1500。
    const runs = user.match(/あ+/g) || [];
    assert.equal(runs.length, 20, '四篇 × 五段 = 20 段');
    for (const run of runs) assert.equal(run.length, SECTION_MAX, `段落沒截到 ${SECTION_MAX}`);
    assert.ok(user.includes(`${'あ'.repeat(SECTION_MAX)}…`), '截斷處應補省略號');

    assert.ok(
      system.length + user.length < 40000,
      `prompt 長度 ${system.length + user.length} 應 < 40000`,
    );
    clearAll();
  });

  it('P2 有方向：system 含【她的研究方向】；無方向：不含，且要求 for_her 留空', () => {
    const node = addNode('奈米塑膠', { description: '奈米塑膠在血液中的分佈' });
    const withDir = addPaper({ treeNodeId: node });
    const other = addPaper({ treeNodeId: node });

    const onDir = buildComparePrompt(paperRows([withDir, other]), {
      directionsBlock: renderDirectionsBlock(withDir),
    });
    assert.ok(onDir.system.includes('【她的研究方向】'), onDir.system.slice(0, 300));
    assert.ok(onDir.system.includes('奈米塑膠在血液中的分佈'));
    assert.ok(onDir.system.includes('analysis.for_her'));

    const offDir = buildComparePrompt(paperRows([withDir, other]), { directionsBlock: '' });
    assert.ok(!offDir.system.includes('【她的研究方向】'));
    assert.ok(
      offDir.system.includes('本次沒有她的研究方向資訊'),
      '無方向時要明確要求 for_her 空字串',
    );
    clearAll();
  });
});

// ── 解析收口（純函式）──────────────────────────────────────────────

describe('S 解析收口', () => {
  after(clearAll);

  it('S2 缺一個維度／缺一篇 → 補齊「摘要未提及」', () => {
    const a = addPaper();
    const b = addPaper();
    const papers = paperRows([a, b]);

    const raw = JSON.stringify({
      table: {
        背景: { [a]: 'A 的背景', [b]: 'B 的背景' },
        方法: { [a]: '只有 A 有方法' }, // 缺 b
        結果: { [a]: 'A', [b]: 'B' },
        結論: { [a]: 'A', [b]: 'B' },
        // 缺「局限」整個維度
      },
      analysis: { same: ['都用 DLS'] }, // 缺 differ / conflict / for_her
    });

    const parsed = parseCompareResponse(raw, papers);
    assert.deepEqual(Object.keys(parsed.table), COMPARE_DIMENSIONS);
    assert.equal(parsed.table.方法[b], NOT_MENTIONED, '缺的那一格要補');
    assert.equal(parsed.table.方法[a], '只有 A 有方法');
    assert.equal(parsed.table.局限[a], NOT_MENTIONED, '缺的整個維度要補');
    assert.equal(parsed.table.局限[b], NOT_MENTIONED);
    assert.deepEqual(parsed.analysis.differ, []);
    assert.deepEqual(parsed.analysis.conflict, []);
    assert.equal(parsed.analysis.for_her, '');
    clearAll();
  });

  it('S4 非 JSON → null（呼叫端轉 502）', () => {
    const a = addPaper();
    assert.equal(parseCompareResponse('我比不出來，抱歉。', paperRows([a])), null);
    assert.equal(parseCompareResponse('', paperRows([a])), null);
    clearAll();
  });
});

// ── 端點 ───────────────────────────────────────────────────────────

describe('POST /api/compare', () => {
  let server;
  let baseUrl;

  before(async () => {
    installFetch();
    const { startServer } = await import('../src/server.js');
    await new Promise((resolve) => {
      server = startServer(0, '127.0.0.1');
      server.once('listening', () => {
        baseUrl = `http://127.0.0.1:${server.address().port}`;
        serverOrigin = baseUrl;
        resolve();
      });
    });
  });

  after(() => {
    restoreFetch();
    serverOrigin = null;
    clearAll();
    if (server) server.close();
  });

  beforeEach(() => {
    captured.length = 0;
    nextResponse = null;
    clearAll();
    useBase('https://api.openai.com/v1');
  });

  const post = async (body) => {
    const res = await fetch(`${baseUrl}/api/compare`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };

  it('V1 少於 2 篇 / 多於 4 篇 → 400', async () => {
    const ids = [addPaper(), addPaper(), addPaper(), addPaper(), addPaper()];

    assert.equal((await post({ paper_ids: [ids[0]] })).status, 400);
    assert.equal((await post({ paper_ids: [] })).status, 400);
    assert.equal((await post({ paper_ids: ids })).status, 400, '5 篇要 400');
    assert.equal((await post({})).status, 400, '沒給 paper_ids 也 400');
    assert.equal(captured.length, 0, '驗證沒過不該打上游');
  });

  it('V2 任一篇不存在 → 404', async () => {
    const a = addPaper();
    const { status, body } = await post({ paper_ids: [a, 'no_such_paper'] });
    assert.equal(status, 404);
    assert.match(body.error, /不存在/);
    assert.equal(captured.length, 0);
  });

  it('V3 任一篇未通讀 → 400 + not_analyzed 列出哪幾篇', async () => {
    const done = addPaper({ title: '已通讀' });
    const pending = addPaper({ title: '還沒通讀', analyzeStatus: 'pending' });
    const failed = addPaper({ title: '通讀失敗', analyzeStatus: 'error' });

    const { status, body } = await post({ paper_ids: [done, pending, failed] });
    assert.equal(status, 400);
    assert.deepEqual(
      body.not_analyzed,
      [{ id: pending, title: '還沒通讀' }, { id: failed, title: '通讀失敗' }],
    );
    assert.equal(captured.length, 0);
  });

  it('R1 回應形狀：papers / table / analysis / model / elapsed_ms', async () => {
    const a = addPaper({ title: 'A 篇', authors: 'Tang', year: 2023 });
    const b = addPaper({ title: 'B 篇', authors: 'Lee', year: 2024 });
    nextResponse = openaiStream([JSON.stringify(fullResult([a, b]))]);

    const { status, body } = await post({ paper_ids: [a, b] });
    assert.equal(status, 200, JSON.stringify(body));
    assert.deepEqual(body.papers, [
      { id: a, title: 'A 篇', authors: 'Tang', year: 2023 },
      { id: b, title: 'B 篇', authors: 'Lee', year: 2024 },
    ]);
    assert.deepEqual(Object.keys(body.table), COMPARE_DIMENSIONS);
    assert.equal(body.table.方法[a], `方法-${a}`);
    assert.deepEqual(body.analysis.same, ['兩篇都用 DLS 量粒徑']);
    assert.equal(body.model, 'fake-model');
    assert.equal(typeof body.elapsed_ms, 'number');
    assert.ok(body.elapsed_ms >= 0);
  });

  it('P1c 上游請求的 body 裡沒有 full_text 哨兵', async () => {
    const a = addPaper();
    const b = addPaper();
    nextResponse = openaiStream([JSON.stringify(fullResult([a, b]))]);

    await post({ paper_ids: [a, b] });
    assert.equal(captured.length, 1);
    assert.ok(
      !JSON.stringify(captured[0].body).includes(SENTINEL),
      '上游請求裡出現了 full_text 哨兵',
    );
  });

  it('H1 opencode.ai base：帶 x-opencode-session（UUID 形狀）；body 是 stream:true', async () => {
    useBase('https://opencode.ai/zen/go/v1');
    const a = addPaper();
    const b = addPaper();
    nextResponse = openaiStream([JSON.stringify(fullResult([a, b]))]);

    await post({ paper_ids: [a, b] });
    assert.equal(captured.length, 1);
    const session = captured[0].headers['x-opencode-session'];
    assert.ok(session, JSON.stringify(captured[0].headers));
    assert.match(session, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(captured[0].url, 'https://opencode.ai/zen/go/v1/chat/completions');
    assert.equal(captured[0].body.stream, true);
    assert.equal(captured[0].body.max_tokens, COMPARE_MAX_TOKENS);
    assert.equal(captured[0].body.temperature, 0.2);
  });

  it('H1b scope 固定 compare：換一組論文 session 值不變', async () => {
    useBase('https://opencode.ai/zen/go/v1');
    const a = addPaper();
    const b = addPaper();
    const c = addPaper();

    nextResponse = openaiStream([JSON.stringify(fullResult([a, b]))]);
    await post({ paper_ids: [a, b] });
    nextResponse = openaiStream([JSON.stringify(fullResult([b, c]))]);
    await post({ paper_ids: [b, c] });

    assert.equal(captured.length, 2);
    assert.equal(
      captured[0].headers['x-opencode-session'],
      captured[1].headers['x-opencode-session'],
    );
  });

  it('H2 非 opencode base：不帶 x-opencode-session', async () => {
    useBase('https://api.openai.com/v1');
    const a = addPaper();
    const b = addPaper();
    nextResponse = openaiStream([JSON.stringify(fullResult([a, b]))]);

    await post({ paper_ids: [a, b] });
    assert.equal(captured.length, 1);
    assert.equal(captured[0].headers['x-opencode-session'], undefined);
  });

  it('S1 串流分兩段送達：拼成完整 JSON', async () => {
    const a = addPaper();
    const b = addPaper();
    const whole = JSON.stringify(fullResult([a, b]));
    const cut = Math.floor(whole.length / 2);
    nextResponse = openaiStream([whole.slice(0, cut), whole.slice(cut)]);

    const { status, body } = await post({ paper_ids: [a, b] });
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.table.結論[b], `結論-${b}`);
  });

  it('S3 預算用盡（finish_reason=length、正文空）→ 502 帶「輸出預算用盡」', async () => {
    const a = addPaper();
    const b = addPaper();
    nextResponse = openaiStream([], { finishReason: 'length', reasoning: '我先想想…' });

    const { status, body } = await post({ paper_ids: [a, b] });
    assert.equal(status, 502);
    assert.match(body.error, /輸出預算用盡/);
    assert.match(body.error, /COMPARE_MAX_TOKENS/);
  });

  it('S3b 正常收尾但正文沒 JSON → 從 reasoning 搶救', async () => {
    const a = addPaper();
    const b = addPaper();
    nextResponse = openaiStream([], {
      finishReason: 'stop',
      reasoning: JSON.stringify(fullResult([a, b])),
    });

    const { status, body } = await post({ paper_ids: [a, b] });
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.table.背景[a], `背景-${a}`);
  });

  it('S4 上游回非 JSON → 502', async () => {
    const a = addPaper();
    const b = addPaper();
    nextResponse = openaiStream(['我沒辦法對比這兩篇。']);

    const { status, body } = await post({ paper_ids: [a, b] });
    assert.equal(status, 502);
    assert.ok(body.error);
  });

  it('S5 上游 HTTP 錯誤 → 502，不是 500', async () => {
    const a = addPaper();
    const b = addPaper();
    nextResponse = () => ({ ok: false, status: 429, text: async () => 'rate limited' });

    const { status, body } = await post({ paper_ids: [a, b] });
    assert.equal(status, 502);
    assert.match(body.error, /429/);
  });
});
