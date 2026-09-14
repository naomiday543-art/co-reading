// 工單 12 §5：討論線串流韌性的釘子。
//
// 全部 mock fetch——**絕不打真上游**（工單 12 §4 紅線；診斷那三發已經夠了）。
// 分兩層：
//   ① `chatAboutPaper` 層：閒置逾時、條件式重試、reasoning 不外洩、usage/cache_hit。
//   ② 路由層（真 express + 真 SSE）：thinking 節流、error 帶 partial/hint、
//      中止時上游連線被收掉且 DB 沒有 assistant 列、重新生成放寬。
import { test, describe, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { nanoid } from 'nanoid';

process.env.CO_READING_DB_PATH = `/tmp/co-reading-chat-resilience-${process.pid}.sqlite`;

import db from '../src/db.js';
import { setSetting } from '../src/db.js';
import {
  chatAboutPaper, buildBody,
  StreamIdleError, ChatAbortedError,
  resolveChatIdleTimeoutMs, resolveChatRetries, resolveChatStreamUsage,
  describeChatError, MAX_TIMER_MS,
} from '../src/ai.js';
import { thinkingLabel, THINKING_LABEL_DELAY_MS } from '../frontend/src/store.js';

const encoder = new TextEncoder();
const realFetch = global.fetch;

function makePaper(prefix = 'chat_res') {
  const id = `${prefix}_${nanoid(6)}`;
  db.prepare(`INSERT INTO papers (id, title, authors, year, full_text, summary_bg, summary_methods, summary_results, summary_conclusions, summary_limitations)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id, 'Resilience Paper', 'A', 2024, 'FULLTEXT', 'bg', 'm', 'r', 'c', 'l'
  );
  return db.prepare('SELECT * FROM papers WHERE id = ?').get(id);
}

function dropPaper(id) {
  db.prepare('DELETE FROM messages WHERE paper_id = ?').run(id);
  db.prepare('DELETE FROM papers WHERE id = ?').run(id);
}

/** 送幾行 reasoning 之後就停住不再有資料（＝報告 11 §5 那發 31.2s 的形狀，只是更長）。 */
function stallingResponse() {
  const lines = [
    'data: {"choices":[{"delta":{"reasoning_content":"想"}}]}\n',
    'data: {"choices":[{"delta":{"reasoning_content":"想"}}]}\n',
    'data: {"choices":[{"delta":{"reasoning_content":"想"}}]}\n',
  ];
  let i = 0;
  return {
    ok: true,
    status: 200,
    body: {
      getReader: () => ({
        async read() {
          if (i < lines.length) return { done: false, value: encoder.encode(lines[i++]) };
          return new Promise(() => {});       // hang
        },
        cancel: async () => {},
      }),
    },
  };
}

/** 先吐正文再停住——「已經上屏才壞掉」那一型。 */
function partialThenStallResponse(text = '半句話') {
  let sent = false;
  return {
    ok: true,
    status: 200,
    body: {
      getReader: () => ({
        async read() {
          if (sent) return new Promise(() => {});
          sent = true;
          return {
            done: false,
            value: encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n`),
          };
        },
        cancel: async () => {},
      }),
    },
  };
}

/** 一條正常回完的串流；可帶 usage（含 cached_tokens）。 */
function goodResponse({ content = '你好', usage = null, reasoning = 0 } = {}) {
  const lines = [];
  for (let i = 0; i < reasoning; i += 1) {
    lines.push('data: {"choices":[{"delta":{"reasoning_content":"想"}}]}\n');
  }
  for (const ch of content) {
    lines.push(`data: ${JSON.stringify({ choices: [{ delta: { content: ch } }] })}\n`);
  }
  lines.push('data: {"choices":[{"finish_reason":"stop","delta":{}}]}\n');
  if (usage) lines.push(`data: ${JSON.stringify({ choices: [], usage })}\n`);
  lines.push('data: [DONE]\n');
  let i = 0;
  return {
    ok: true,
    status: 200,
    body: {
      getReader: () => ({
        read: async () => (i < lines.length
          ? { done: false, value: encoder.encode(lines[i++]) }
          : { done: true, value: undefined }),
        cancel: async () => {},
      }),
    },
  };
}

function httpErrorResponse(status, text = 'boom') {
  return { ok: false, status, text: async () => text };
}

/** 依序回傳排好的 response，並記下每次的 request body。 */
function queueFetch(makers) {
  const state = { calls: 0, bodies: [] };
  global.fetch = async (_url, init) => {
    state.bodies.push(JSON.parse(init.body));
    const maker = makers[Math.min(state.calls, makers.length - 1)];
    state.calls += 1;
    return maker();
  };
  return state;
}

// 真實預設是 2s，測試沒必要陪等。
const fast = { idleTimeoutMs: 150, timeoutMs: 30_000, retryDelayMs: 10 };

describe('討論串流：閒置逾時＋條件式重試（工單 12 §5.1–§5.3）', () => {
  let paper;
  before(() => { paper = makePaper(); });
  after(() => dropPaper(paper.id));
  afterEach(() => { global.fetch = realFetch; });

  test('§5.1 停滯在首字之前 → 自動重試一次，第二發正常 ⇒ 回覆完整、fetch 打 2 次', async () => {
    const state = queueFetch([stallingResponse, () => goodResponse({ content: '完整答案' })]);
    const chunks = [];

    const answer = await chatAboutPaper(paper, [], '這篇在講什麼', c => chunks.push(c), fast);

    assert.equal(state.calls, 2, '首字前停滯應該自動重試一次');
    assert.equal(answer, '完整答案');
    assert.equal(chunks.join(''), '完整答案');
  });

  test('§5.2 已經吐過正文再停滯 → 不重試，錯誤是繁體，且帶得出 partialChars', async () => {
    const state = queueFetch([() => partialThenStallResponse('半句話'), () => goodResponse()]);
    const chunks = [];

    const err = await chatAboutPaper(paper, [], '問題', c => chunks.push(c), fast)
      .then(() => null, e => e);

    assert.equal(state.calls, 1, '已經上屏的半截絕不重打');
    assert.equal(chunks.join(''), '半句話', '半截要真的已經送到呼叫端手上');
    assert.ok(err instanceof StreamIdleError, `應該是 StreamIdleError，實際 ${err?.name}`);
    assert.match(err.message, /上游串流中途停滯/);
    assert.doesNotMatch(err.message, /aborted due to timeout/, '不能漏出原生英文');
    assert.doesNotMatch(err.message, /已自動重試/);
    assert.equal(err.partialChars, 3);
  });

  test('§5.3 HTTP 400 是設定錯 → 一次都不重試，訊息說「討論模型」不是「通讀模型」', async () => {
    const state = queueFetch([() => httpErrorResponse(400, 'MissingSessionID')]);

    const err = await chatAboutPaper(paper, [], '問題', () => {}, fast).then(() => null, e => e);

    assert.equal(state.calls, 1);
    assert.match(err.message, /HTTP 400/);
    assert.match(err.message, /請檢查討論模型設定/);
    assert.doesNotMatch(err.message, /通讀模型/);
  });

  test('兩次都停滯 → fetch 只打 2 次，訊息前綴「回覆失敗（已自動重試 1 次）」', async () => {
    const state = queueFetch([stallingResponse, stallingResponse]);

    const err = await chatAboutPaper(paper, [], '問題', () => {}, fast).then(() => null, e => e);

    assert.equal(state.calls, 2, '預設只重試 1 次');
    assert.match(err.message, /回覆失敗（已自動重試 1 次）/);
    assert.match(err.message, /上游串流中途停滯/);
    assert.ok(err.cause instanceof StreamIdleError);
  });

  test('HTTP 502 是上游抖 → 重試，第二發成功', async () => {
    const state = queueFetch([() => httpErrorResponse(502, 'bad gateway'), () => goodResponse({ content: 'ok' })]);
    const answer = await chatAboutPaper(paper, [], '問題', () => {}, fast);
    assert.equal(state.calls, 2);
    assert.equal(answer, 'ok');
  });

  test('retries=0 時不重試（env 旋鈕真的關得掉）', async () => {
    const state = queueFetch([stallingResponse, () => goodResponse()]);
    await chatAboutPaper(paper, [], '問題', () => {}, { ...fast, retries: 0 }).then(() => null, e => e);
    assert.equal(state.calls, 1);
  });
});

describe('討論串流：reasoning 不外洩、usage 拿得到（工單 12 §5.4、§5.6）', () => {
  let paper;
  before(() => { paper = makePaper(); });
  after(() => dropPaper(paper.id));
  afterEach(() => { global.fetch = realFetch; });

  test('reasoning_content 只進 onReasoning，一個字都不進正文', async () => {
    queueFetch([() => goodResponse({ content: '答案', reasoning: 4 })]);
    const chunks = [];
    const reasoning = [];

    const answer = await chatAboutPaper(paper, [], '問題', c => chunks.push(c), {
      ...fast, onReasoning: t => reasoning.push(t),
    });

    assert.equal(answer, '答案');
    assert.equal(chunks.join(''), '答案');
    assert.equal(reasoning.join(''), '想想想想', 'onReasoning 才是思考鏈的唯一出口');
    assert.doesNotMatch(answer, /想/, 'reasoning 絕不能混進正文（會被寫進 DB 與下一輪 prompt）');
  });

  test('§5.6 預設送 stream_options.include_usage；CHAT_STREAM_USAGE=false 時 body 沒有這顆', async () => {
    const usage = { prompt_tokens: 26853, completion_tokens: 100, prompt_tokens_details: { cached_tokens: 26624 } };

    const on = queueFetch([() => goodResponse({ usage })]);
    await chatAboutPaper(paper, [], '問題', () => {}, fast);
    assert.deepEqual(on.bodies[0].stream_options, { include_usage: true });

    process.env.CHAT_STREAM_USAGE = 'false';
    try {
      const off = queueFetch([() => goodResponse({ usage })]);
      await chatAboutPaper(paper, [], '問題', () => {}, fast);
      assert.equal('stream_options' in off.bodies[0], false, '關掉就真的不送這顆欄位');
    } finally {
      delete process.env.CHAT_STREAM_USAGE;
    }
  });

  test('紅線：通讀／提取／對比共用的 buildBody 預設不送 stream_options', () => {
    const body = buildBody({ model: 'm', format: 'openai' }, { messages: [], stream: true });
    assert.equal('stream_options' in body, false, '沒人要求就不能偷偷改別條線的 body');
    assert.deepEqual(
      buildBody({ model: 'm', format: 'openai' }, { messages: [], stream: false, streamUsage: true }).stream_options,
      undefined,
      '非串流請求送這顆沒有意義',
    );
  });
});

describe('env 旋鈕的 clamp（CHAT_IDLE_TIMEOUT_MS／CHAT_RETRIES／CHAT_STREAM_USAGE）', () => {
  const saved = {
    idle: process.env.CHAT_IDLE_TIMEOUT_MS,
    retries: process.env.CHAT_RETRIES,
    usage: process.env.CHAT_STREAM_USAGE,
  };
  afterEach(() => {
    for (const [key, env] of [['idle', 'CHAT_IDLE_TIMEOUT_MS'], ['retries', 'CHAT_RETRIES'], ['usage', 'CHAT_STREAM_USAGE']]) {
      if (saved[key] === undefined) delete process.env[env];
      else process.env[env] = saved[key];
    }
  });

  test('閒置逾時沒設 → 45s（工單拍板值）', () => {
    delete process.env.CHAT_IDLE_TIMEOUT_MS;
    assert.equal(resolveChatIdleTimeoutMs(), 45_000);
  });

  test('0／空／非數字 → 退回 45s，不拋', () => {
    for (const raw of ['0', '', '   ', 'abc', '-1', 'NaN']) {
      process.env.CHAT_IDLE_TIMEOUT_MS = raw;
      assert.equal(resolveChatIdleTimeoutMs(), 45_000, `raw=${JSON.stringify(raw)}`);
    }
  });

  test('太小抬到 5s、太大壓到 setTimeout 天花板', () => {
    process.env.CHAT_IDLE_TIMEOUT_MS = '1000';
    assert.equal(resolveChatIdleTimeoutMs(), 5_000);
    process.env.CHAT_IDLE_TIMEOUT_MS = '1e12';
    assert.equal(resolveChatIdleTimeoutMs(), MAX_TIMER_MS);
    process.env.CHAT_IDLE_TIMEOUT_MS = '90000';
    assert.equal(resolveChatIdleTimeoutMs(), 90_000);
  });

  test('重試次數預設 1，clamp [0,3]', () => {
    delete process.env.CHAT_RETRIES;
    assert.equal(resolveChatRetries(), 1);
    process.env.CHAT_RETRIES = '0';
    assert.equal(resolveChatRetries(), 0);
    process.env.CHAT_RETRIES = '99';
    assert.equal(resolveChatRetries(), 3);
    process.env.CHAT_RETRIES = 'abc';
    assert.equal(resolveChatRetries(), 1);
  });

  test('usage 預設開，只有明確的 false/0/off/no 才關', () => {
    delete process.env.CHAT_STREAM_USAGE;
    assert.equal(resolveChatStreamUsage(), true);
    for (const raw of ['false', '0', 'off', 'NO']) {
      process.env.CHAT_STREAM_USAGE = raw;
      assert.equal(resolveChatStreamUsage(), false, `raw=${raw}`);
    }
    process.env.CHAT_STREAM_USAGE = 'true';
    assert.equal(resolveChatStreamUsage(), true);
  });
});

describe('describeChatError／thinkingLabel（給她看的那幾句話）', () => {
  test('連線類講「討論模型」並提 VPN', () => {
    const err = new Error('fetch failed');
    err.cause = { code: 'ECONNRESET' };
    const msg = describeChatError(err);
    assert.match(msg, /連不上討論模型/);
    assert.match(msg, /請檢查網路或 VPN/);
  });

  test('停滯／逾時那兩句本來就是人話，原樣沿用', () => {
    const err = new StreamIdleError(45_000, { receivedChars: 812, receivedChunks: 9, elapsedMs: 46_000 });
    assert.equal(describeChatError(err), err.message);
    assert.match(err.message, /45s 沒有新資料/);
  });

  test('thinkingLabel：前 2 秒不報數字（不閃 0），之後帶秒數與字數', () => {
    const t0 = 1_000_000;
    assert.equal(thinkingLabel(t0, 0, t0 + THINKING_LABEL_DELAY_MS - 1), '正在思考…');
    assert.equal(thinkingLabel(t0, 420, t0 + 1_500), '正在思考…', '字數先到也不能提前報時');
    assert.equal(thinkingLabel(t0, 420, t0 + 8_200), '正在思考…（已想 8 秒 · 420 字）');
    assert.equal(thinkingLabel(t0, 0, t0 + 8_200), '正在思考…（已想 8 秒）', 'chars=0 時不硬報一個 0');
    assert.equal(thinkingLabel(null, 0), '正在思考…');
  });
});

// ── 路由層：真 express + 真 SSE ───────────────────────────────────────────────
describe('討論路由：thinking 節流、error 帶 partial/hint、中止、重新生成放寬', () => {
  let server, baseUrl, upstream, upstreamUrl;
  const scripts = [];              // 每發上游請求要怎麼回
  const upstreamState = { calls: 0, closed: 0 };

  before(async () => {
    // 真的 HTTP 上游（不是 mock fetch）——中止那條必須看得到 socket 真的被收掉。
    upstream = createServer((req, res) => {
      let body = '';
      req.on('data', c => (body += c));
      req.on('end', async () => {
        const script = scripts[Math.min(upstreamState.calls, scripts.length - 1)];
        upstreamState.calls += 1;
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        req.on('close', () => { upstreamState.closed += 1; });
        await script(res, req);
      });
    });
    await new Promise(r => upstream.listen(0, '127.0.0.1', r));
    upstreamUrl = `http://127.0.0.1:${upstream.address().port}/v1`;

    setSetting('ai_base_url', upstreamUrl);
    setSetting('ai_format', 'openai');
    setSetting('ai_model', 'fake');
    setSetting('ai_api_key', 'fake');

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
    if (server) server.close();
    if (upstream) upstream.close();
  });

  afterEach(() => {
    scripts.length = 0;
    upstreamState.calls = 0;
    upstreamState.closed = 0;
  });

  /** 收完整條 SSE，回傳解析後的事件陣列。 */
  async function collectSse(res) {
    const events = [];
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith('data: ')) continue;
        try { events.push(JSON.parse(t.slice(6))); } catch {}
      }
    }
    return events;
  }

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  test('§5.4 thinking 事件節流：100 顆 reasoning chunk → thinking ≤ 3 顆，delta 逐字不變', async () => {
    scripts.push(async (res) => {
      for (let i = 0; i < 100; i += 1) {
        res.write('data: {"choices":[{"delta":{"reasoning_content":"想"}}]}\n\n');
        await sleep(10);                       // 總共約 1 秒 ⇒ 500ms 節流下最多 2–3 發
      }
      for (const ch of '你好嗎') {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: ch } }] })}\n\n`);
      }
      res.write('data: [DONE]\n\n');
      res.end();
    });

    const paper = makePaper('thr');
    try {
      const res = await fetch(`${baseUrl}/api/papers/${paper.id}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: '問題' }),
      });
      const events = await collectSse(res);

      const thinking = events.filter(e => e.type === 'thinking');
      const thinkingDone = events.filter(e => e.type === 'thinking_done');
      const deltas = events.filter(e => e.type === 'delta');

      assert.ok(thinking.length > 0, '至少要送得出一發，不然畫面還是三個點');
      assert.ok(thinking.length <= 3, `節流 500ms 下應該 ≤3 發，實際 ${thinking.length}`);
      assert.ok(thinking.every(e => typeof e.chars === 'number'), 'thinking 只帶字數');
      assert.ok(thinking.every(e => !('text' in e) && !('content' in e)),
        '紅線：思考內容絕不能送到前端');
      assert.equal(thinkingDone.length, 1, '正文第一個 delta 到時補一發，只補一發');
      assert.equal(thinkingDone[0].chars, 100);
      assert.equal(typeof thinkingDone[0].seconds, 'number');
      assert.deepEqual(deltas.map(d => d.content), ['你', '好', '嗎'], 'delta 逐字與改前相同');

      const saved = db.prepare(
        'SELECT content FROM messages WHERE paper_id = ? AND role = ? ORDER BY seq'
      ).all(paper.id, 'assistant');
      assert.equal(saved.length, 1);
      assert.equal(saved[0].content, '你好嗎', '紅線：reasoning 不進 DB');
    } finally {
      dropPaper(paper.id);
    }
  });

  test('§5.2（路由層）吐過正文再壞掉 → error 帶 partial>0 與 hint，DB 只剩孤兒 user', async () => {
    scripts.push(async (res) => {
      res.write('data: {"choices":[{"delta":{"content":"半截"}}]}\n\n');
      await sleep(50);            // 先讓那半截真的飛出去，再斷
      // 上游直接斷線（她 VPN 被踢就是這個形狀）
      res.destroy();
    });

    const paper = makePaper('partial');
    try {
      const res = await fetch(`${baseUrl}/api/papers/${paper.id}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: '問題' }),
      });
      const events = await collectSse(res);

      const error = events.find(e => e.type === 'error');
      assert.ok(error, '要有 error 事件');
      assert.equal(error.partial, 2, 'partial ＝ 已吐正文長度，前端靠它決定要不要留半截');
      assert.match(error.hint, /你的問題已保存/);
      assert.equal(upstreamState.calls, 1, '已經吐過正文就不重打');

      const rows = db.prepare('SELECT role FROM messages WHERE paper_id = ? ORDER BY seq').all(paper.id);
      assert.deepEqual(rows.map(r => r.role), ['user'], '失敗的 assistant 不寫 DB');
    } finally {
      dropPaper(paper.id);
    }
  });

  test('§5.5 client 中止 → 上游的 req close 被觸發、DB 沒有 assistant 列', async () => {
    scripts.push(async (res) => {
      res.write('data: {"choices":[{"delta":{"reasoning_content":"想"}}]}\n\n');
      await sleep(5_000);            // 她在這段中間按下「停止」
      res.end();
    });

    const paper = makePaper('abort');
    const controller = new AbortController();
    try {
      const pending = fetch(`${baseUrl}/api/papers/${paper.id}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: '問題' }),
        signal: controller.signal,
      }).then(r => collectSse(r)).catch(e => e);

      await sleep(300);
      controller.abort();
      const outcome = await pending;
      assert.ok(outcome instanceof Error, '前端這端收到的是 AbortError');

      // 等後端把 abort 傳到上游
      for (let i = 0; i < 50 && upstreamState.closed === 0; i += 1) await sleep(20);
      assert.equal(upstreamState.closed, 1, '上游那條連線必須真的被收掉，不能繼續燒');

      const rows = db.prepare('SELECT role FROM messages WHERE paper_id = ? ORDER BY seq').all(paper.id);
      assert.deepEqual(rows.map(r => r.role), ['user'], '中止的回答不寫 DB');
    } finally {
      dropPaper(paper.id);
    }
  });

  test('§3.2 放寬：孤兒 user 尾巴時「重新生成」等價「繼續」（不再 400）', async () => {
    scripts.push(async (res) => {
      res.write('data: {"choices":[{"delta":{"content":"補答"}}]}\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    });

    const paper = makePaper('orphan');
    try {
      // 歷史：user → assistant → user（最後這條沒被回答，就是上一輪失敗留下的孤兒尾巴）
      const rows = [
        ['user', 'Q1', 1], ['assistant', 'A1', 2], ['user', 'Q2', 3],
      ];
      for (const [role, content, seq] of rows) {
        db.prepare(
          'INSERT INTO messages (id, paper_id, role, content, created_at, seq) VALUES (?, ?, ?, ?, ?, ?)'
        ).run(nanoid(), paper.id, role, content, Date.now() + seq, seq);
      }

      const res = await fetch(`${baseUrl}/api/papers/${paper.id}/chat?regenerate=true`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      assert.equal(res.status, 200, '不再是 400');
      const events = await collectSse(res);
      assert.ok(events.some(e => e.type === 'done'));

      const saved = db.prepare(
        'SELECT role, content FROM messages WHERE paper_id = ? ORDER BY seq'
      ).all(paper.id);
      assert.deepEqual(saved.map(m => m.role), ['user', 'assistant', 'user', 'assistant'],
        '接在孤兒 user 後面新增一條，不是覆蓋舊的 A1');
      assert.equal(saved[1].content, 'A1', '舊回答原封不動');
      assert.equal(saved[3].content, '補答');
    } finally {
      dropPaper(paper.id);
    }
  });

  test('完全沒有 AI 回覆過時，「重新生成」仍然 400（那不是孤兒尾巴，是還沒開始）', async () => {
    const paper = makePaper('noai');
    try {
      db.prepare(
        'INSERT INTO messages (id, paper_id, role, content, created_at, seq) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(nanoid(), paper.id, 'user', 'Q', Date.now(), 1);

      const res = await fetch(`${baseUrl}/api/papers/${paper.id}/chat?regenerate=true`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      assert.equal(res.status, 400);
      assert.equal(upstreamState.calls, 0, '不該白打一發上游');
    } finally {
      dropPaper(paper.id);
    }
  });

  test('§5.8 全文截斷旗標：100,001 字 → true；100,000 → false', async () => {
    const big = makePaper('trunc_big');
    const edge = makePaper('trunc_edge');
    try {
      db.prepare('UPDATE papers SET full_text = ? WHERE id = ?').run('字'.repeat(100_001), big.id);
      db.prepare('UPDATE papers SET full_text = ? WHERE id = ?').run('字'.repeat(100_000), edge.id);

      const a = await (await fetch(`${baseUrl}/api/papers/${big.id}`)).json();
      assert.equal(a.full_text_truncated, true);
      assert.equal(a.full_text_chars, 100_001);
      assert.equal(a.full_text_limit, 100_000);

      const b = await (await fetch(`${baseUrl}/api/papers/${edge.id}`)).json();
      assert.equal(b.full_text_truncated, false, '剛好等於上限不算截斷（buildPaperBlock 用的是 >）');
      assert.equal(b.full_text_chars, 100_000);
    } finally {
      dropPaper(big.id);
      dropPaper(edge.id);
    }
  });
});

// ChatAbortedError 的形狀（路由靠 instanceof 判「這不是故障」）
describe('ChatAbortedError', () => {
  test('kind=aborted，訊息是人話', () => {
    const err = new ChatAbortedError(120);
    assert.equal(err.kind, 'aborted');
    assert.equal(err.receivedChars, 120);
    assert.equal(err.message, '已停止生成');
  });
});
