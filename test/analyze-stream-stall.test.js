import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.CO_READING_DB_PATH = `/tmp/co-reading-analyze-stall-${process.pid}.sqlite`;
const {
  collectStream, streamOpenAI, analyzePaper,
  StreamIdleError, StreamTimeoutError, StreamInterruptedError,
  resolveAnalyzeIdleTimeoutMs, MAX_TIMER_MS,
} = await import('../src/ai.js');

const encoder = new TextEncoder();

/**
 * 一個可編排的假 SSE Response。
 * steps：字串＝送這行；數字＝先等這麼多毫秒再送下一步；'hang'＝從此永遠不再有資料。
 */
function scriptedResponse(steps, { withCancel = true } = {}) {
  const state = { cancelled: 0, reads: 0 };
  let i = 0;
  const reader = {
    async read() {
      state.reads += 1;
      while (i < steps.length && typeof steps[i] === 'number') {
        await new Promise(r => setTimeout(r, steps[i++]));
      }
      if (i >= steps.length) return { done: true, value: undefined };
      const step = steps[i++];
      if (step === 'hang') return new Promise(() => {});
      return { done: false, value: encoder.encode(step) };
    },
  };
  if (withCancel) reader.cancel = async () => { state.cancelled += 1; };
  return { state, response: { ok: true, status: 200, body: { getReader: () => reader } } };
}

/** 一條「每 intervalMs 送一個字、永不結束」、但會服從 AbortSignal 的串流。 */
function endlessResponse(signal, intervalMs = 50) {
  const line = 'data: {"choices":[{"delta":{"content":"a"}}]}\n';
  return {
    ok: true,
    status: 200,
    body: {
      getReader: () => ({
        read: () => new Promise((resolve, reject) => {
          const timer = setTimeout(
            () => resolve({ done: false, value: encoder.encode(line) }),
            intervalMs,
          );
          signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            // undici 在 body 讀取階段被 abort 時丟的就是這顆（名字來自 signal.reason）。
            const err = new Error('The operation was aborted due to timeout');
            err.name = signal.reason?.name || 'TimeoutError';
            reject(err);
          }, { once: true });
        }),
        cancel: async () => {},
      }),
    },
  };
}

const openai = { format: 'openai' };
const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; });

// ── 2026-09-13 事故：通讀在 300.0s 整失敗，UI 上是一句原生英文 ──────────────────
// `The operation was aborted due to timeout`。同一篇她手按重試 22s 就過 ⇒ 第一發是
// 串流中途停滯。以下把「停滯」與「總逾時」兩條路都釘住。
describe('通讀串流：閒置逾時', () => {
  test('送了幾個 chunk 之後停住 → 閒置逾時拋 StreamIdleError，並且真的 cancel 了 reader', async () => {
    const { state, response } = scriptedResponse([
      'data: {"choices":[{"delta":{"content":"12345"}}]}\n',
      'data: {"choices":[{"delta":{"content":"678"}}]}\n',
      'data: {"choices":[{"delta":{"content":"90"}}]}\n',
      'hang',
    ]);

    const startedAt = Date.now();
    const err = await collectStream(openai, response, { idleTimeoutMs: 200 })
      .then(() => null, e => e);
    const elapsed = Date.now() - startedAt;

    assert.ok(err instanceof StreamIdleError, `應該是 StreamIdleError，實際是 ${err?.name}: ${err?.message}`);
    assert.ok(err instanceof StreamInterruptedError, '兩種逾時共用同一個錯誤形狀');
    assert.equal(err.kind, 'idle');
    assert.match(err.message, /上游串流中途停滯/);
    assert.match(err.message, /已收到 \d[\d,]* 字/);
    assert.match(err.message, /3 個片段/);
    assert.equal(err.receivedChunks, 3);
    assert.ok(err.receivedChars > 0, '收到的字數要算進去，不然查不出「停在哪」');
    assert.equal(state.cancelled, 1, '停滯後必須 cancel，否則那條 socket 沒人收');
    assert.ok(elapsed < 2000, `應該約 200ms 就失敗，實際 ${elapsed}ms`);
  });

  test('一直有 reasoning chunk 就不算停滯（推理模型思考時只送 reasoning_content）', async () => {
    const reasoning = 'data: {"choices":[{"delta":{"reasoning_content":"想"}}]}\n';
    const { response } = scriptedResponse([
      60, reasoning, 60, reasoning, 60, reasoning, 60, reasoning, 60,
      'data: {"choices":[{"delta":{"content":"{\\"title\\":\\"T\\"}"}}]}\n',
      'data: {"choices":[{"finish_reason":"stop","delta":{}}]}\n',
      'data: [DONE]\n',
    ]);
    // 總共超過 200ms，但每兩個 chunk 之間只隔 60ms ⇒ 計時器每次都被重置，不該誤殺。
    const collected = await collectStream(openai, response, { idleTimeoutMs: 200 });
    assert.equal(collected.choices[0].message.content, '{"title":"T"}');
    assert.equal(collected.choices[0].message.reasoning_content, '想想想想');
  });

  test('只有 content、沒有 reasoning 的那型也一樣不誤殺', async () => {
    const { response } = scriptedResponse([
      60, 'data: {"choices":[{"delta":{"content":"{\\"ti"}}]}\n',
      60, 'data: {"choices":[{"delta":{"content":"tle\\":\\"T\\"}"}}]}\n',
      60, 'data: [DONE]\n',
    ]);
    const collected = await collectStream(openai, response, { idleTimeoutMs: 200 });
    assert.equal(collected.choices[0].message.content, '{"title":"T"}');
  });

  test('stats 會回填收到的片段數與字數（給 [ANALYZE] 日誌用）', async () => {
    const stats = {};
    const { response } = scriptedResponse([
      'data: {"choices":[{"delta":{"content":"ab"}}]}\n',
      'data: [DONE]\n',
    ]);
    await collectStream(openai, response, { idleTimeoutMs: 5000, stats });
    assert.equal(stats.receivedChunks, 2);
    assert.ok(stats.receivedChars > 0);
    assert.ok(stats.elapsedMs >= 0);
  });
});

describe('通讀串流：總逾時不再漏原生英文', () => {
  test('永不結束的串流撞上總逾時 → 繁體的「AI 請求超時」，不是 aborted due to timeout', async () => {
    let calls = 0;
    global.fetch = async (_url, init) => { calls += 1; return endlessResponse(init.signal, 50); };

    const startedAt = Date.now();
    const err = await analyzePaper('全文', { timeoutMs: 300, idleTimeoutMs: 10_000, retries: 0 })
      .then(() => null, e => e);
    const elapsed = Date.now() - startedAt;

    assert.equal(calls, 1);
    assert.ok(err instanceof StreamTimeoutError, `應該是 StreamTimeoutError，實際是 ${err?.name}: ${err?.message}`);
    assert.equal(err.kind, 'timeout');
    assert.match(err.message, /AI 請求超時/);
    assert.doesNotMatch(err.message, /aborted due to timeout/,
      '這就是 9/13 漏到 UI 上那句英文，不能再出現');
    assert.match(err.message, /已收到 \d[\d,]* 字/);
    assert.ok(elapsed < 3000, `應該約 300ms 失敗，實際 ${elapsed}ms`);
  });
});

describe('聊天線不受影響（不傳 options ＝ 舊路徑）', () => {
  test('streamOpenAI 逐字輸出與改動前一字不差，且不碰 reader.cancel', async () => {
    // 故意做一個「沒有 cancel 方法」的 reader：舊路徑一旦偷偷去 cancel 就會 TypeError。
    const { state, response } = scriptedResponse([
      'data: {"choices":[{"delta":{"reasoning_content":"思考不該外洩"}}]}\n',
      120, 'data: {"choices":[{"delta":{"content":"你"}}]}\n',
      120, 'data: {"choices":[{"delta":{"content":"好"}}]}\ndata: [DONE]\n',
      'data: {"choices":[{"delta":{"content":"這段在 DONE 之後，不該出現"}}]}\n',
    ], { withCancel: false });

    const chunks = [];
    for await (const c of streamOpenAI(response)) chunks.push(c);
    assert.deepEqual(chunks, ['你', '好']);
    assert.equal(state.cancelled, 0);
  });

  test('collectStream 不帶 options 時也還是舊路徑', async () => {
    const { response } = scriptedResponse([
      'data: {"choices":[{"delta":{"content":"{\\"title\\":\\"T\\"}"}}]}\n',
      'data: [DONE]\n',
    ], { withCancel: false });
    const collected = await collectStream(openai, response);
    assert.equal(collected.choices[0].message.content, '{"title":"T"}');
  });
});

describe('ANALYZE_IDLE_TIMEOUT_MS 的 env clamp', () => {
  const original = process.env.ANALYZE_IDLE_TIMEOUT_MS;
  afterEach(() => {
    if (original === undefined) delete process.env.ANALYZE_IDLE_TIMEOUT_MS;
    else process.env.ANALYZE_IDLE_TIMEOUT_MS = original;
  });

  test('沒設 → 60s', () => {
    delete process.env.ANALYZE_IDLE_TIMEOUT_MS;
    assert.equal(resolveAnalyzeIdleTimeoutMs(), 60_000);
  });

  test('0／空字串／非數字 → 退回 60s，不拋', () => {
    for (const raw of ['0', '', '   ', 'abc', '-5000', 'NaN']) {
      process.env.ANALYZE_IDLE_TIMEOUT_MS = raw;
      assert.equal(resolveAnalyzeIdleTimeoutMs(), 60_000, `raw=${JSON.stringify(raw)}`);
    }
  });

  test('太小 → 抬到 5s；太大 → 壓到 setTimeout 天花板（否則計時器立刻觸發＝等於沒有逾時）', () => {
    process.env.ANALYZE_IDLE_TIMEOUT_MS = '3000';
    assert.equal(resolveAnalyzeIdleTimeoutMs(), 5_000);
    process.env.ANALYZE_IDLE_TIMEOUT_MS = '1e12';
    assert.equal(resolveAnalyzeIdleTimeoutMs(), MAX_TIMER_MS);
    process.env.ANALYZE_IDLE_TIMEOUT_MS = '120000';
    assert.equal(resolveAnalyzeIdleTimeoutMs(), 120_000);
  });
});
