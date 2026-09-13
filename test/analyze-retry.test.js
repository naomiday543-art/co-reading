import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.CO_READING_DB_PATH = `/tmp/co-reading-analyze-retry-${process.pid}.sqlite`;
const {
  analyzePaper, analyzeErrorKind, isRetryableAnalyzeError, describeAnalyzeError,
  resolveAnalyzeRetries, StreamIdleError, StreamTimeoutError,
} = await import('../src/ai.js');

const encoder = new TextEncoder();

/** 送幾行就停住不再有資料的串流（＝ 9/13 那一發的形狀）。 */
function stallingResponse() {
  return {
    ok: true,
    status: 200,
    body: {
      getReader: () => {
        let sent = false;
        return {
          async read() {
            if (sent) return new Promise(() => {});
            sent = true;
            return { done: false, value: encoder.encode('data: {"choices":[{"delta":{"content":"半句"}}]}\n') };
          },
          cancel: async () => {},
        };
      },
    },
  };
}

/** 一條乖乖回完整摘要 JSON 的串流。 */
function goodResponse(summary = {}) {
  const payload = JSON.stringify({
    title: 'T', authors: 'A', year: 2024,
    background: 'bg', methods: 'm', results: 'r', conclusions: 'c', limitations: 'l',
    ...summary,
  });
  const lines = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: payload } }] })}\n`,
    'data: {"choices":[{"finish_reason":"stop","delta":{}}],"usage":{"completion_tokens":42}}\n',
    'data: [DONE]\n',
  ];
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

/** 一個 HTTP 錯誤回應（makeRequest 會在讀完 body 之後丟 `API error <status>`）。 */
function httpErrorResponse(status, text = 'boom') {
  return { ok: false, status, text: async () => text };
}

/** 依序回傳排好的 response；記錄被呼叫幾次。 */
function queueFetch(makers) {
  const state = { calls: 0 };
  global.fetch = async () => {
    const maker = makers[Math.min(state.calls, makers.length - 1)];
    state.calls += 1;
    return maker();
  };
  return state;
}

const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; });

// 測試一律用 retryDelayMs=10：真實預設是 2s，沒必要讓測試陪等。
const fast = { idleTimeoutMs: 5_000, timeoutMs: 30_000, retryDelayMs: 10 };

describe('通讀自動重試：只救連線類', () => {
  test('第一發停滯、第二發正常 → 摘要拿得到，上游只多打一次', async () => {
    const state = queueFetch([stallingResponse, goodResponse]);
    const summary = await analyzePaper('全文', { ...fast, idleTimeoutMs: 150, paperId: 'p1' });
    assert.equal(state.calls, 2, '停滯那發之後應該自動重試一次');
    assert.equal(summary.title, 'T');
    assert.equal(summary.summary_bg, 'bg');
    assert.equal(summary.summary_limitations, 'l');
  });

  test('兩次都停滯 → fetch 只打 2 次，訊息說得出「已自動重試 1 次」', async () => {
    const state = queueFetch([stallingResponse, stallingResponse]);
    const err = await analyzePaper('全文', { ...fast, idleTimeoutMs: 150 }).then(() => null, e => e);
    assert.equal(state.calls, 2, '預設只重試 1 次，不能無限打');
    assert.match(err.message, /通讀失敗（已自動重試 1 次）/);
    assert.match(err.message, /上游串流中途停滯/);
    assert.match(err.message, /已收到 \d[\d,]* 字/);
    assert.match(err.message, /請稍後按「重新通讀」/);
    assert.ok(err.cause instanceof StreamIdleError, '原始錯誤要留在 cause 裡，別丟掉');
  });

  test('HTTP 400 是設定錯 → 一次都不重試（重打只會再錯一次並多花錢）', async () => {
    const state = queueFetch([() => httpErrorResponse(400, 'MissingSessionID')]);
    const err = await analyzePaper('全文', fast).then(() => null, e => e);
    assert.equal(state.calls, 1);
    assert.doesNotMatch(err.message, /已自動重試/);
    assert.match(err.message, /HTTP 400/);
    assert.match(err.message, /請檢查通讀模型設定/);
  });

  test('HTTP 502 是上游抖 → 重試，第二發成功', async () => {
    const state = queueFetch([() => httpErrorResponse(502, 'bad gateway'), goodResponse]);
    const summary = await analyzePaper('全文', fast);
    assert.equal(state.calls, 2);
    assert.equal(summary.title, 'T');
  });

  test('「格式不正確」是模型輸出問題 → 不重試（不再燒一次 8000 token 預算）', async () => {
    const empty = () => {
      const lines = ['data: {"choices":[{"delta":{"reasoning_content":"想到一半"}}]}\n',
        'data: {"choices":[{"finish_reason":"length","delta":{}}]}\n'];
      let i = 0;
      return {
        ok: true, status: 200,
        body: { getReader: () => ({
          read: async () => (i < lines.length
            ? { done: false, value: encoder.encode(lines[i++]) }
            : { done: true, value: undefined }),
          cancel: async () => {},
        }) },
      };
    };
    const state = queueFetch([empty, empty]);
    const err = await analyzePaper('全文', fast).then(() => null, e => e);
    assert.equal(state.calls, 1);
    assert.match(err.message, /格式不正確/, '既有的診斷訊息要原樣保留');
    assert.match(err.message, /輸出預算用盡/);
    assert.doesNotMatch(err.message, /已自動重試/);
  });

  test('fetch failed（網路／VPN 抖）→ 重試；兩次都掛就講人話', async () => {
    const boom = () => { const e = new Error('fetch failed'); e.cause = { code: 'ECONNRESET' }; throw e; };
    const state = queueFetch([boom, boom]);
    const err = await analyzePaper('全文', fast).then(() => null, e => e);
    assert.equal(state.calls, 2);
    assert.match(err.message, /連不上通讀模型/);
    assert.match(err.message, /ECONNRESET/);
    assert.match(err.message, /請檢查網路或 VPN/);
  });

  test('retries=0 時完全不重試，錯誤原物件原樣往上丟', async () => {
    const state = queueFetch([stallingResponse]);
    const err = await analyzePaper('全文', { ...fast, idleTimeoutMs: 150, retries: 0 })
      .then(() => null, e => e);
    assert.equal(state.calls, 1);
    assert.ok(err instanceof StreamIdleError);
    assert.doesNotMatch(err.message, /已自動重試/);
  });
});

describe('失敗分類與人話', () => {
  test('分類：停滯／總逾時／連線／輸出／HTTP', () => {
    assert.equal(analyzeErrorKind(new StreamIdleError(60_000, {})), 'idle');
    assert.equal(analyzeErrorKind(new StreamTimeoutError(300_000, {})), 'timeout');
    assert.equal(analyzeErrorKind(new Error('AI 請求超時（300s 沒有結果）')), 'timeout');
    assert.equal(analyzeErrorKind(new Error('API error 429: slow down')), 'http429');
    assert.equal(analyzeErrorKind(new Error('API error 401: bad key')), 'http401');
    assert.equal(analyzeErrorKind(new Error('fetch failed')), 'conn');
    assert.equal(analyzeErrorKind(new Error('AI 返回的摘要格式不正確（finish_reason=length，輸出預算用盡）: ')), 'output');
    assert.equal(analyzeErrorKind(new Error('論文沒有全文')), 'other');
  });

  test('該重試的只有連線類與 429/502/503/504', () => {
    for (const err of [
      new StreamIdleError(60_000, {}),
      new StreamTimeoutError(300_000, {}),
      new Error('AI 請求超時（300s 沒有結果）'),
      new Error('fetch failed'),
      new Error('API error 429: slow down'),
      new Error('API error 502: bad gateway'),
      new Error('API error 503: unavailable'),
      new Error('API error 504: gateway timeout'),
    ]) assert.equal(isRetryableAnalyzeError(err), true, err.message);

    for (const err of [
      new Error('API error 400: MissingSessionID'),
      new Error('API error 401: bad key'),
      new Error('API error 404: no such model'),
      new Error('AI 返回的摘要格式不正確（finish_reason=length，輸出預算用盡）: '),
      new Error('AI 返回的摘要無法解析為 JSON（finish_reason=stop）: {壞的'),
      new Error('論文沒有全文'),
    ]) assert.equal(isRetryableAnalyzeError(err), false, err.message);
  });

  test('既有三句保留原文，不被「人話化」蓋掉', () => {
    const format = 'AI 返回的摘要格式不正確（finish_reason=length，content=0 字，輸出預算用盡（調高 ANALYZE_MAX_TOKENS））: ';
    assert.equal(describeAnalyzeError(new Error(format)), format);
    const restart = '上次通讀被服務重啟打斷，請重新通讀';
    assert.equal(describeAnalyzeError(new Error(restart)), restart);
  });

  test('原生英文的 abort 訊息不會再原樣出現在錯誤裡', () => {
    const idle = new StreamIdleError(60_000, { receivedChunks: 3, receivedChars: 1204, elapsedMs: 62_000 });
    assert.match(idle.message, /上游串流中途停滯：60s 沒有新資料（已收到 1,204 字、3 個片段，共等 62s）/);
    const total = new StreamTimeoutError(300_000, { receivedChars: 0 });
    assert.match(total.message, /AI 請求超時：300s 內沒有完成（已收到 0 字）/);
    for (const e of [idle, total]) assert.doesNotMatch(e.message, /aborted|timeout$/i);
  });
});

describe('ANALYZE_RETRIES 的 env clamp', () => {
  const original = process.env.ANALYZE_RETRIES;
  afterEach(() => {
    if (original === undefined) delete process.env.ANALYZE_RETRIES;
    else process.env.ANALYZE_RETRIES = original;
  });

  test('沒設 → 1；0 是合法的（＝關掉自動重試）', () => {
    delete process.env.ANALYZE_RETRIES;
    assert.equal(resolveAnalyzeRetries(), 1);
    process.env.ANALYZE_RETRIES = '0';
    assert.equal(resolveAnalyzeRetries(), 0);
  });

  test('非數字／空 → 1；超出 [0,3] → 夾回來（重試會多燒輸出預算，不能讓人填 99）', () => {
    for (const raw of ['', '  ', 'abc', 'NaN']) {
      process.env.ANALYZE_RETRIES = raw;
      assert.equal(resolveAnalyzeRetries(), 1, `raw=${JSON.stringify(raw)}`);
    }
    process.env.ANALYZE_RETRIES = '99';
    assert.equal(resolveAnalyzeRetries(), 3);
    process.env.ANALYZE_RETRIES = '-4';
    assert.equal(resolveAnalyzeRetries(), 0);
    process.env.ANALYZE_RETRIES = '2';
    assert.equal(resolveAnalyzeRetries(), 2);
  });

  test('ANALYZE_RETRIES=2 時真的會打三次', async () => {
    const state = queueFetch([stallingResponse, stallingResponse, stallingResponse]);
    const err = await analyzePaper('全文', { ...fast, idleTimeoutMs: 120, retries: 2 })
      .then(() => null, e => e);
    assert.equal(state.calls, 3);
    assert.match(err.message, /已自動重試 2 次/);
  });
});
