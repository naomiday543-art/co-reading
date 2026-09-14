// 工單 17 §4.1–§4.5：討論線的輸出預算與空正文守門。
//
// 病的形狀（生產 2026-09-14 15:17）：
//   [CHAT] ok … chars_out=0 reasoning_chars=12133 finish=length
//   討論回覆: <paper>, assistant (0 字)
// 推理模型的思考鏈與正文共用同一個 completion 預算，寫死的 4096 被思考吃光，
// 正文是空字串——而舊版把這當成功回傳，路由照樣 INSERT，她看到一個空氣泡。
//
// 全部 mock（fetch 或本機假上游）——**絕不打真上游**（工單 17 §3 紅線）。
import { test, describe, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { nanoid } from 'nanoid';

process.env.CO_READING_DB_PATH = `/tmp/co-reading-chat-budget-${process.pid}.sqlite`;

import db, { setSetting } from '../src/db.js';
import {
  chatAboutPaper,
  ChatEmptyOutputError,
  StreamInterruptedError,
  analyzeErrorKind,
  isRetryableAnalyzeError,
  describeChatError,
  resolveChatMaxTokens,
  CHAT_MAX_TOKENS_CEILING,
} from '../src/ai.js';

const encoder = new TextEncoder();
const realFetch = global.fetch;

function makePaper(prefix = 'budget') {
  const id = `${prefix}_${nanoid(6)}`;
  db.prepare(`INSERT INTO papers (id, title, authors, year, full_text, summary_bg, summary_methods, summary_results, summary_conclusions, summary_limitations)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id, 'Budget Paper', 'A', 2024, 'FULLTEXT', 'bg', 'm', 'r', 'c', 'l'
  );
  return db.prepare('SELECT * FROM papers WHERE id = ?').get(id);
}

function dropPaper(id) {
  db.prepare('DELETE FROM messages WHERE paper_id = ?').run(id);
  db.prepare('DELETE FROM papers WHERE id = ?').run(id);
}

function sseResponse(lines) {
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

/**
 * 生產那一發的形狀：只有 reasoning、finish_reason=length、content 從頭到尾沒出現過。
 * `usage.completion_tokens` 剛好頂到預算——有些線不回 finish_reason，只留這個佐證。
 */
function budgetBurnedResponse({ reasoning = 12, maxTokens = 8192, finish = 'length' } = {}) {
  const lines = [];
  for (let i = 0; i < reasoning; i += 1) {
    lines.push('data: {"choices":[{"delta":{"reasoning_content":"想"}}]}\n');
  }
  lines.push(`data: ${JSON.stringify({ choices: [{ finish_reason: finish, delta: {} }] })}\n`);
  lines.push(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 17337, completion_tokens: maxTokens } })}\n`);
  lines.push('data: [DONE]\n');
  return sseResponse(lines);
}

/** 正常收尾但正文空（不是預算問題——例如上游把答案吞了）。 */
function emptyStopResponse({ reasoning = 0 } = {}) {
  const lines = [];
  for (let i = 0; i < reasoning; i += 1) {
    lines.push('data: {"choices":[{"delta":{"reasoning_content":"想"}}]}\n');
  }
  lines.push('data: {"choices":[{"finish_reason":"stop","delta":{}}]}\n');
  lines.push('data: [DONE]\n');
  return sseResponse(lines);
}

function goodResponse(content = '正常答案') {
  const lines = [...content].map(ch => `data: ${JSON.stringify({ choices: [{ delta: { content: ch } }] })}\n`);
  lines.push('data: {"choices":[{"finish_reason":"stop","delta":{}}]}\n');
  lines.push('data: [DONE]\n');
  return sseResponse(lines);
}

/** 送幾行 reasoning 之後就停住（連線類故障，走的是工單 12 那顆重試）。 */
function stallingResponse() {
  const lines = ['data: {"choices":[{"delta":{"reasoning_content":"想"}}]}\n'];
  let i = 0;
  return {
    ok: true,
    status: 200,
    body: {
      getReader: () => ({
        async read() {
          if (i < lines.length) return { done: false, value: encoder.encode(lines[i++]) };
          return new Promise(() => {});
        },
        cancel: async () => {},
      }),
    },
  };
}

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

const fast = { idleTimeoutMs: 150, timeoutMs: 30_000, retryDelayMs: 10 };

describe('討論輸出預算：空正文守門＋兩倍重打（工單 17 §4.1–§4.3）', () => {
  let paper;
  before(() => { paper = makePaper(); });
  after(() => dropPaper(paper.id));
  afterEach(() => { global.fetch = realFetch; });

  test('§4.1 第一發思考吃光預算（finish=length、正文 0 字）→ 自動用 2 倍預算重打，第二發回正文', async () => {
    const state = queueFetch([
      () => budgetBurnedResponse({ reasoning: 12, maxTokens: 8192 }),
      () => goodResponse('這篇在講膽固醇改變蛋白冠'),
    ]);
    const chunks = [];

    const answer = await chatAboutPaper(paper, [], '這篇在講什麼', c => chunks.push(c), fast);

    assert.equal(state.calls, 2, '預算被吃光要自己重打一次，不能把空氣泡端給她');
    assert.equal(answer, '這篇在講膽固醇改變蛋白冠');
    assert.equal(chunks.join(''), answer);
    assert.equal(state.bodies[0].max_tokens, 8192, '第一發＝CHAT_MAX_TOKENS 預設值');
    assert.equal(state.bodies[1].max_tokens, 16384, '第二發正好是第一發的兩倍');
  });

  test('§4.2 兩發都空 → kind=output 的錯誤、fetch 恰 2 次、訊息說得出該調哪顆旋鈕', async () => {
    const state = queueFetch([
      () => budgetBurnedResponse({ reasoning: 12, maxTokens: 8192 }),
      () => budgetBurnedResponse({ reasoning: 30, maxTokens: 16384 }),
    ]);

    const err = await chatAboutPaper(paper, [], '問題', () => {}, fast).then(() => null, e => e);

    assert.equal(state.calls, 2, '只重打一次——第三發同樣會空，只是多燒一次錢');
    assert.ok(err instanceof ChatEmptyOutputError, `應該是 ChatEmptyOutputError，實際 ${err?.name}`);
    assert.equal(analyzeErrorKind(err), 'output');
    assert.match(err.message, /模型把輸出預算全花在思考上/);
    assert.match(err.message, /思考 30 字/, '思考了多少字是唯一看得出真相的數字');
    assert.match(err.message, /正文 0 字/);
    assert.match(err.message, /CHAT_MAX_TOKENS/);
    assert.match(err.message, /非推理模型/);
    assert.doesNotMatch(err.message, /已自動重試/, '預算重打不算「連線類重試」，不該掛那個前綴');
    assert.equal(err.maxTokens, 16384, '報的是最後一發真的用了多大的預算');
    assert.equal(err.budgetExhausted, true);
  });

  test('§4.3 finish=stop 但正文空 → 不重打（那不是預算問題），錯誤照樣是 output', async () => {
    const state = queueFetch([() => emptyStopResponse({ reasoning: 3 }), () => goodResponse()]);

    const err = await chatAboutPaper(paper, [], '問題', () => {}, fast).then(() => null, e => e);

    assert.equal(state.calls, 1, '預算沒被吃光，重打一樣空');
    assert.ok(err instanceof ChatEmptyOutputError);
    assert.match(err.message, /模型回了空正文（finish=stop/);
    assert.doesNotMatch(err.message, /全花在思考上/);
    assert.equal(err.budgetExhausted, false);
  });

  test('finish_reason 缺席但 usage 頂到預算 → 一樣認得出是預算被吃光', async () => {
    const state = queueFetch([
      () => budgetBurnedResponse({ reasoning: 5, maxTokens: 8192, finish: null }),
      () => goodResponse('補上了'),
    ]);

    const answer = await chatAboutPaper(paper, [], '問題', () => {}, fast);

    assert.equal(state.calls, 2);
    assert.equal(answer, '補上了');
  });

  test('只有空白字元也算空正文（partial 要報 0，不能當半截答案保住）', async () => {
    const state = queueFetch([
      () => sseResponse([
        `data: ${JSON.stringify({ choices: [{ delta: { content: '  \n ' } }] })}\n`,
        'data: {"choices":[{"finish_reason":"stop","delta":{}}]}\n',
        'data: [DONE]\n',
      ]),
    ]);

    const err = await chatAboutPaper(paper, [], '問題', () => {}, fast).then(() => null, e => e);

    assert.equal(state.calls, 1);
    assert.ok(err instanceof ChatEmptyOutputError);
    assert.equal(err.partialChars ?? 0, 0);
  });

  test('預算已經在天花板時不再翻倍（32768 之上不是預算問題）', async () => {
    const state = queueFetch([() => budgetBurnedResponse({ maxTokens: CHAT_MAX_TOKENS_CEILING })]);

    const err = await chatAboutPaper(paper, [], '問題', () => {}, {
      ...fast, maxTokens: CHAT_MAX_TOKENS_CEILING,
    }).then(() => null, e => e);

    assert.equal(state.calls, 1);
    assert.equal(err.maxTokens, CHAT_MAX_TOKENS_CEILING);
  });

  test('§4.5 連線類重試與預算重打是兩顆計數器：先停滯、再空正文 ⇒ 最多 3 發', async () => {
    const state = queueFetch([
      stallingResponse,                                       // ① 連線類：重試一次
      () => budgetBurnedResponse({ reasoning: 12 }),          // ② 空正文：預算重打一次
      () => goodResponse('第三發才成功'),                      // ③
      () => goodResponse('不該有第四發'),
    ]);

    const answer = await chatAboutPaper(paper, [], '問題', () => {}, fast);

    assert.equal(state.calls, 3, '各自上限 1，不疊加超過各自上限');
    assert.equal(answer, '第三發才成功');
    assert.equal(state.bodies[1].max_tokens, 8192, '連線類重試不改預算');
    assert.equal(state.bodies[2].max_tokens, 16384, '預算重打才翻倍');
  });

  test('兩顆計數器各自獨立：預算重打過之後，連線類重試的額度仍在（反之亦然）', async () => {
    const state = queueFetch([
      () => budgetBurnedResponse({ reasoning: 12 }),          // ① 預算重打
      stallingResponse,                                       // ② 連線類重試
      () => goodResponse('收工'),                              // ③
    ]);

    const answer = await chatAboutPaper(paper, [], '問題', () => {}, fast);

    assert.equal(state.calls, 3);
    assert.equal(answer, '收工');
  });
});

describe('ChatEmptyOutputError 的分類（沿用 9/9 通讀線那套 kind=output）', () => {
  test('kind=output、不進連線類重試名單、人話原樣端出去', () => {
    const err = new ChatEmptyOutputError({
      reasoningChars: 12133, maxTokens: 4096, finishReason: 'length', budgetExhausted: true,
    });
    assert.ok(err instanceof StreamInterruptedError, '要吃得到既有的 kind 路由');
    assert.equal(analyzeErrorKind(err), 'output');
    assert.equal(isRetryableAnalyzeError(err), false, '重打同樣預算只會再空一次，還多燒一次錢');
    assert.equal(describeChatError(err), err.message, '訊息本來就是人話，不要再包一層');
    assert.match(err.message, /思考 12,133 字/);
  });
});

describe('CHAT_MAX_TOKENS 的 clamp（工單 17 §4.4）', () => {
  const saved = process.env.CHAT_MAX_TOKENS;
  afterEach(() => {
    if (saved === undefined) delete process.env.CHAT_MAX_TOKENS;
    else process.env.CHAT_MAX_TOKENS = saved;
    global.fetch = realFetch;
  });

  test('沒設 → 8192（工單拍板值，取代寫死的 4096）', () => {
    delete process.env.CHAT_MAX_TOKENS;
    assert.equal(resolveChatMaxTokens(), 8192);
  });

  test('0／空／非數字 → 退回 8192，不拋', () => {
    for (const raw of ['0', '', '   ', 'abc', '-1', 'NaN']) {
      process.env.CHAT_MAX_TOKENS = raw;
      assert.equal(resolveChatMaxTokens(), 8192, `raw=${JSON.stringify(raw)}`);
    }
  });

  test('太小抬到 1024、太大壓到 32768', () => {
    process.env.CHAT_MAX_TOKENS = '500';
    assert.equal(resolveChatMaxTokens(), 1024);
    process.env.CHAT_MAX_TOKENS = '1e9';
    assert.equal(resolveChatMaxTokens(), CHAT_MAX_TOKENS_CEILING);
    process.env.CHAT_MAX_TOKENS = '12000';
    assert.equal(resolveChatMaxTokens(), 12_000);
  });

  test('env 真的走進 body（不是只影響那顆 resolve 函式）', async () => {
    const paper = makePaper('env');
    try {
      process.env.CHAT_MAX_TOKENS = '2048';
      const state = queueFetch([() => goodResponse('好')]);
      await chatAboutPaper(paper, [], '問題', () => {}, fast);
      assert.equal(state.bodies[0].max_tokens, 2048);
    } finally {
      dropPaper(paper.id);
    }
  });
});

// ── 路由層：真 express + 真 SSE ───────────────────────────────────────────────
describe('討論路由：空正文絕不寫進 DB（工單 17 §2.1）', () => {
  let server, baseUrl, upstream, upstreamUrl;
  const scripts = [];
  const upstreamState = { calls: 0, maxTokens: [] };

  before(async () => {
    upstream = createServer((req, res) => {
      let body = '';
      req.on('data', c => (body += c));
      req.on('end', async () => {
        const script = scripts[Math.min(upstreamState.calls, scripts.length - 1)];
        upstreamState.calls += 1;
        try { upstreamState.maxTokens.push(JSON.parse(body).max_tokens); } catch {}
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
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
    upstreamState.maxTokens.length = 0;
  });

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

  /** 上游把預算全燒在思考上。 */
  function burnScript(reasoning = 12) {
    return async (res) => {
      for (let i = 0; i < reasoning; i += 1) {
        res.write('data: {"choices":[{"delta":{"reasoning_content":"想"}}]}\n\n');
      }
      res.write('data: {"choices":[{"finish_reason":"length","delta":{}}]}\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    };
  }

  function answerScript(text) {
    return async (res) => {
      for (const ch of text) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: ch } }] })}\n\n`);
      }
      res.write('data: [DONE]\n\n');
      res.end();
    };
  }

  test('兩發都空 → error 事件帶 partial=0 與可照做的 hint，DB 只剩孤兒 user（沒有 0 字 assistant）', async () => {
    scripts.push(burnScript(12), burnScript(40));

    const paper = makePaper('route_empty');
    try {
      const res = await fetch(`${baseUrl}/api/papers/${paper.id}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: '這篇在講什麼' }),
      });
      const events = await collectSse(res);

      const error = events.find(e => e.type === 'error');
      assert.ok(error, '要有 error 事件（不是靜悄悄畫一個空氣泡）');
      assert.equal(error.partial, 0);
      assert.match(error.message, /輸出預算/);
      assert.match(error.hint, /你的問題已保存/);
      assert.match(error.hint, /CHAT_MAX_TOKENS/);
      assert.equal(events.some(e => e.type === 'done'), false, '空正文不算 done');
      assert.equal(upstreamState.calls, 2, '預算重打一次');
      assert.deepEqual(upstreamState.maxTokens, [8192, 16384]);

      const rows = db.prepare('SELECT role, content FROM messages WHERE paper_id = ? ORDER BY seq').all(paper.id);
      assert.deepEqual(rows.map(r => r.role), ['user'], '紅線：0 字的 assistant 絕不進 DB');
    } finally {
      dropPaper(paper.id);
    }
  });

  test('第一發空、第二發有正文 → 她這一輪只看到正常答案，DB 一條完整的 assistant', async () => {
    scripts.push(burnScript(12), answerScript('第二發的答案'));

    const paper = makePaper('route_recover');
    try {
      const res = await fetch(`${baseUrl}/api/papers/${paper.id}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: '問題' }),
      });
      const events = await collectSse(res);

      assert.equal(events.some(e => e.type === 'error'), false);
      assert.ok(events.some(e => e.type === 'done'));

      const rows = db.prepare('SELECT role, content FROM messages WHERE paper_id = ? ORDER BY seq').all(paper.id);
      assert.deepEqual(rows.map(r => r.role), ['user', 'assistant']);
      assert.equal(rows[1].content, '第二發的答案');
    } finally {
      dropPaper(paper.id);
    }
  });

  test('「重新生成」撞到空正文 → 舊答案原封不動（絕不被 0 字覆蓋）', async () => {
    scripts.push(burnScript(12), burnScript(40));

    const paper = makePaper('route_regen');
    try {
      for (const [role, content, seq] of [['user', 'Q1', 1], ['assistant', '原本的好答案', 2]]) {
        db.prepare(
          'INSERT INTO messages (id, paper_id, role, content, created_at, seq) VALUES (?, ?, ?, ?, ?, ?)'
        ).run(nanoid(), paper.id, role, content, Date.now() + seq, seq);
      }

      const res = await fetch(`${baseUrl}/api/papers/${paper.id}/chat?regenerate=true`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const events = await collectSse(res);

      const error = events.find(e => e.type === 'error');
      assert.ok(error);
      assert.equal(error.partial, 0);
      assert.match(error.hint, /CHAT_MAX_TOKENS/);
      assert.doesNotMatch(error.hint, /你的問題已保存/, '重新生成沒有新寫 user 訊息，別說謊');

      const rows = db.prepare('SELECT role, content FROM messages WHERE paper_id = ? ORDER BY seq').all(paper.id);
      assert.deepEqual(rows.map(r => r.content), ['Q1', '原本的好答案'], '空正文不能把她的舊答案洗掉');
    } finally {
      dropPaper(paper.id);
    }
  });
});
