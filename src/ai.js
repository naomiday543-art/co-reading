import { getSetting, getSettings } from './db.js';
import db from './db.js';
import { log } from './logger.js';
import { searchInsights } from './search.js';
import { readFileSync, statSync } from 'fs';
import { renderVisualPages } from './pdf.js';
import { renderCarryoverForInjection } from './carryover.js';
import { opencodeSessionHeaders } from './opencodeSession.js';
import { loadConstitution } from './constitution.js';
import { buildDirectionsContext, renderDirectionsBlock } from './directions.js';

function resolveConfig(prefix) {
  const dbSettings = getSettings();
  const key = dbSettings[`${prefix}_api_key`] || process.env[`${prefix.toUpperCase()}_API_KEY`];
  const baseUrl = dbSettings[`${prefix}_base_url`] || process.env[`${prefix.toUpperCase()}_BASE_URL`];
  const model = dbSettings[`${prefix}_model`] || process.env[`${prefix.toUpperCase()}_MODEL`];
  const format = dbSettings[`${prefix}_format`] || process.env[`${prefix.toUpperCase()}_FORMAT`];
  const visionMode = dbSettings[`${prefix}_vision_mode`] || process.env[`${prefix.toUpperCase()}_VISION_MODE`];
  const visionModel = dbSettings[`${prefix}_vision_model`] || process.env[`${prefix.toUpperCase()}_VISION_MODEL`];
  // 明確的能力宣告（三態）：'true' | 'false' | 未設。未設時才退回名字猜測。
  const visionCapableRaw = dbSettings[`${prefix}_vision_capable`]
    ?? process.env[`${prefix.toUpperCase()}_VISION_CAPABLE`];
  const visionCapable = visionCapableRaw === undefined || visionCapableRaw === null || `${visionCapableRaw}`.trim() === ''
    ? undefined
    : !['0', 'false', 'off', 'no'].includes(`${visionCapableRaw}`.trim().toLowerCase());

  return {
    key,
    baseUrl,
    model,
    format,
    visionMode,
    visionModel,
    visionCapable,
  };
}

export function getChatConfig() {
  const config = resolveConfig('ai');
  return {
    key: config.key || '',
    baseUrl: config.baseUrl || 'https://api.openai.com/v1',
    model: config.model || 'gpt-4o',
    format: config.format || 'openai',
    visionMode: config.visionMode || 'auto',
    visionCapable: config.visionCapable,
  };
}

export function getAnalyzeConfig() {
  const config = resolveConfig('analyze');
  const mainConfig = resolveConfig('ai');

  return {
    key: config.key || mainConfig.key || '',
    baseUrl: config.baseUrl || mainConfig.baseUrl || 'https://api.openai.com/v1',
    model: config.model || mainConfig.model || 'gpt-4o',
    format: config.format || mainConfig.format || 'openai',
    visionMode: config.visionMode || mainConfig.visionMode || 'auto',
    visionModel: config.visionModel || config.model || mainConfig.model || 'gpt-4o',
    visionCapable: config.visionCapable ?? mainConfig.visionCapable,
  };
}

export function buildHeaders({ key, format, baseUrl, scope }) {
  // OpenCode Go 要求 x-opencode-session（缺了 400 MissingSessionID）；非 opencode 網域回空物件。
  const session = opencodeSessionHeaders(baseUrl, scope);
  if (format === 'anthropic') {
    return {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      ...session,
    };
  }
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${key}`,
    ...session,
  };
}

export function serializeContent(content, format) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  if (format === 'anthropic') {
    return content.map(part => {
      if (part.type === 'text') {
        return {
          type: 'text',
          text: part.text || '',
          ...(part.cache_control ? { cache_control: part.cache_control } : {}),
        };
      }
      if (part.type === 'image') {
        return {
          type: 'image',
          source: { type: 'base64', media_type: part.mediaType, data: part.data },
        };
      }
      if (part.type === 'document') {
        return {
          type: 'document',
          source: { type: 'base64', media_type: part.mediaType, data: part.data },
          ...(part.title ? { title: part.title } : {}),
        };
      }
      return part;
    });
  }

  return content.flatMap(part => {
    if (part.type === 'text') return [{ type: 'text', text: part.text || '' }];
    if (part.type === 'image') {
      return [{
        type: 'image_url',
        image_url: { url: `data:${part.mediaType};base64,${part.data}`, detail: 'high' },
      }];
    }
    // Chat Completions has no portable PDF content part. Callers should render
    // PDF pages to images before reaching this boundary.
    return [];
  });
}

export function isVisionEnabled(config) {
  if (config.visionMode === 'on') return true;
  if (config.visionMode === 'off') return false;
  // 明確宣告永遠壓過名字猜測。名字猜測會把 text-only 的 provider 誤判成看得懂圖：
  // Antigravity 的 `gemini-3.7-flash-low` 命中下面的 /gemini/ 卻只吃文字
  // （headless stream input 只接受 text content block），送圖過去就是靜默丟失。
  // 設 `<PREFIX>_VISION_CAPABLE=false` 即可否決，無論名字長什麼樣。
  if (config.visionCapable === false) return false;
  if (config.visionCapable === true) return true;
  const target = `${config.model || ''} ${config.baseUrl || ''}`.toLowerCase();
  return /claude|vision|gpt-4o|gpt-4\.1|gpt-5|gemini/.test(target);
}

export function buildBody({ model, format }, { messages, stream, max_tokens, temperature }) {
  if (format === 'anthropic') {
    let system = null;
    const chatMessages = [];
    for (const m of messages) {
      if (m.role === 'system') {
        system = serializeContent(m.content, 'anthropic');
      } else {
        chatMessages.push({ role: m.role, content: serializeContent(m.content, 'anthropic') });
      }
    }
    const body = {
      model,
      max_tokens: max_tokens || 4096,
      messages: chatMessages,
      stream: stream || false,
    };
    if (system) body.system = system;
    if (temperature !== undefined) body.temperature = temperature;
    return body;
  }

  return {
    model,
    messages: messages.map(m => ({ ...m, content: serializeContent(m.content, 'openai') })),
    max_tokens: max_tokens || 4096,
    stream: stream || false,
    temperature: temperature !== undefined ? temperature : 0.7,
  };
}

export function buildEndpoint({ baseUrl, format }) {
  const base = baseUrl.replace(/\/$/, '');
  if (format === 'anthropic') {
    return `${base}/messages`;
  }
  // Handle OpenRouter, DeepSeek, and other OpenAI-compatible endpoints
  return `${base}/chat/completions`;
}

/**
 * 任何一次上游請求的絕對上限。
 *
 * 原本 `makeRequest` 完全沒有 timeout／AbortSignal：上游不回就永遠等下去，
 * 通讀會卡在 analyze_status='analyzing' 直到有人手動刪論文。
 * 預設 300s 不是「期待它跑這麼久」，而是「絕不無限」。
 */
export const REQUEST_TIMEOUT_MS = Number(process.env.AI_REQUEST_TIMEOUT_MS) || 300_000;

async function makeRequest(config, params) {
  const url = buildEndpoint(config);
  const headers = buildHeaders(config);
  const body = buildBody(config, params);
  const timeoutMs = params.timeoutMs || REQUEST_TIMEOUT_MS;

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      // 這顆 signal 同時蓋住「等標頭」與「讀 body」兩段——串流讀到一半上游靜默斷線也會收到 abort。
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      throw new Error(`AI 請求超時（${Math.round(timeoutMs / 1000)}s 沒有結果）`);
    }
    throw err;
  }

  if (!response.ok) {
    let errorText = '';
    try { errorText = await response.text(); } catch {}
    throw new Error(`API error ${response.status}: ${errorText.slice(0, 200)}`);
  }

  return response;
}

/**
 * 串流「中途停滯」與「總逾時」共用的錯誤形狀。
 *
 * 2026-09-13 事故：通讀在 300.0s 整失敗，訊息是原生 DOMException 的
 * `The operation was aborted due to timeout`，直接被 SummaryView 印給使用者看。
 * 原因是 `AbortSignal.timeout` 在**讀 body** 的階段觸發時，拋錯的是 `sseEvents()`
 * 裡的 `reader.read()`，不在 `makeRequest` 那圈 try/catch 的範圍內——那圈只蓋得到
 * 「等標頭」。同一篇論文她手按重試 22s 就過，所以不是論文長、不是預算、不是 prompt，
 * 是第一發的連線在串流途中停滯。
 *
 * 兩顆逾時疊著用：總逾時（300s，絕不無限）＋閒置逾時（60s，兩個 chunk 之間的最長間隔）。
 * 兩者都翻成這個形狀，錯誤訊息一律繁體、且帶「等了多久／收到多少」方便下次查。
 */
export class StreamInterruptedError extends Error {
  constructor(message, { kind, receivedChunks = 0, receivedChars = 0, elapsedMs = 0 } = {}) {
    super(message);
    this.name = 'StreamInterruptedError';
    this.kind = kind;
    this.receivedChunks = receivedChunks;
    this.receivedChars = receivedChars;
    this.elapsedMs = elapsedMs;
  }
}

/** 兩個 chunk 之間等太久（上游掛住／網路抖）。 */
export class StreamIdleError extends StreamInterruptedError {
  constructor(idleTimeoutMs, stats) {
    super(
      `上游串流中途停滯：${formatSeconds(idleTimeoutMs)}s 沒有新資料`
      + `（已收到 ${formatCount(stats.receivedChars)} 字、${formatCount(stats.receivedChunks)} 個片段，`
      + `共等 ${formatSeconds(stats.elapsedMs)}s）`,
      { ...stats, kind: 'idle' },
    );
    this.name = 'StreamIdleError';
    this.idleTimeoutMs = idleTimeoutMs;
  }
}

/** 總逾時在讀 body 的階段打到（就是 9/13 那發漏出英文的位置）。 */
export class StreamTimeoutError extends StreamInterruptedError {
  constructor(totalTimeoutMs, stats) {
    super(
      `AI 請求超時：${formatSeconds(totalTimeoutMs)}s 內沒有完成`
      + `（已收到 ${formatCount(stats.receivedChars)} 字）`,
      { ...stats, kind: 'timeout' },
    );
    this.name = 'StreamTimeoutError';
    this.totalTimeoutMs = totalTimeoutMs;
  }
}

function formatSeconds(ms) {
  const seconds = ms / 1000;
  // 測試用的毫秒級逾時不能顯示成「0s 沒有新資料」，那句話會看不懂。
  return seconds >= 1 ? `${Math.round(seconds)}` : seconds.toFixed(1);
}

function formatCount(n) {
  return Number(n || 0).toLocaleString('en-US');
}

/**
 * 一次 `reader.read()`，配一顆每次重新計時的閒置計時器。
 *
 * `Promise.race` 對兩邊都掛了 handler，所以計時器贏了之後那顆還在跑的 read()
 * 之後若自己 reject，也不會變成 unhandled rejection。
 */
function readWithIdleTimeout(reader, idleTimeoutMs) {
  let timer;
  const idle = new Promise((_, reject) => {
    timer = setTimeout(() => reject(IDLE_SIGNAL), idleTimeoutMs);
  });
  return Promise.race([reader.read(), idle]).finally(() => clearTimeout(timer));
}

const IDLE_SIGNAL = Symbol('sse-idle-timeout');

/**
 * SSE 行 → 已解析的 JSON 事件。兩種 wire format 共用。
 *
 * @param {object} response
 * @param {object} [options]
 * @param {number} [options.idleTimeoutMs] >0 時啟用閒置逾時（兩個 chunk 之間的最長間隔）
 * @param {number} [options.totalTimeoutMs] >0 時把讀 body 階段的原生 TimeoutError/AbortError
 *   翻成 StreamTimeoutError（帶這個秒數）
 * @param {{receivedChunks?: number, receivedChars?: number, elapsedMs?: number}} [options.stats]
 *   可選的統計回填容器，給日誌用
 *
 * **不傳 options 時走的是與改動前逐字相同的路徑**（沒有計時器、沒有錯誤翻譯）——
 * 聊天線的 streamOpenAI／streamAnthropic 就靠這個保持行為不變。
 */
async function* sseEvents(response, { idleTimeoutMs = 0, totalTimeoutMs = 0, stats } = {}) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const startedAt = Date.now();
  let receivedChunks = 0;
  let receivedChars = 0;
  const guarded = idleTimeoutMs > 0 || totalTimeoutMs > 0;
  const snapshot = () => ({
    receivedChunks,
    receivedChars,
    elapsedMs: Date.now() - startedAt,
  });
  const publish = () => {
    if (stats) Object.assign(stats, snapshot());
  };

  while (true) {
    let chunk;
    if (!guarded) {
      chunk = await reader.read();
    } else {
      try {
        chunk = idleTimeoutMs > 0
          ? await readWithIdleTimeout(reader, idleTimeoutMs)
          : await reader.read();
      } catch (err) {
        publish();
        if (err === IDLE_SIGNAL) {
          try { await reader.cancel?.(); } catch {}
          throw new StreamIdleError(idleTimeoutMs, snapshot());
        }
        if (totalTimeoutMs > 0 && (err?.name === 'TimeoutError' || err?.name === 'AbortError')) {
          throw new StreamTimeoutError(totalTimeoutMs, snapshot());
        }
        throw err;
      }
    }

    const { done, value } = chunk;
    if (done) break;

    receivedChunks += 1;
    const text = decoder.decode(value, { stream: true });
    receivedChars += text.length;
    publish();

    buffer += text;
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data: ')) continue;
      const data = trimmed.slice(6);
      if (data === '[DONE]') return;
      try {
        yield JSON.parse(data);
      } catch {
        // skip unparseable lines
      }
    }
  }
}

/**
 * 把一條串流收完，重組成「跟非串流回應同一個形狀」的物件，
 * 好讓 extractAnalyzeJson / responseText / completionMeta 一份邏輯吃兩條路。
 *
 * 為什麼通讀要走串流：OpenCode Go 的**非串流**請求 60 秒必斷，而實測同一篇論文
 * 在 max_tokens=2000（完成 1,968 tokens）時就已經要 38.9 秒——把預算拉到 8000
 * 之後非串流鐵定撞牆。串流的首字節很早到，之後一路有資料流，躲開那道 60 秒閘。
 * @param {object} [streamOptions] 透傳給 sseEvents（idleTimeoutMs／totalTimeoutMs／stats）。
 *   不傳＝與改動前完全相同的路徑。
 * @returns {object} 非串流形狀的回應物件
 */
export async function collectStream(config, response, streamOptions) {
  let content = '';
  let reasoning = '';
  let finishReason = null;
  let usage = null;

  if (config.format === 'anthropic') {
    for await (const event of sseEvents(response, streamOptions)) {
      if (event.type === 'content_block_delta') {
        if (event.delta?.text) content += event.delta.text;
        if (event.delta?.thinking) reasoning += event.delta.thinking;
      }
      if (event.type === 'message_delta') {
        if (event.delta?.stop_reason) finishReason = event.delta.stop_reason;
        if (event.usage) usage = { ...(usage || {}), ...event.usage };
      }
      if (event.type === 'message_start' && event.message?.usage) usage = event.message.usage;
    }
    return {
      content: [
        ...(reasoning ? [{ type: 'thinking', thinking: reasoning }] : []),
        { type: 'text', text: content },
      ],
      stop_reason: finishReason,
      ...(usage ? { usage } : {}),
    };
  }

  for await (const event of sseEvents(response, streamOptions)) {
    const choice = event.choices?.[0];
    if (choice?.delta?.content) content += choice.delta.content;
    if (choice?.delta?.reasoning_content) reasoning += choice.delta.reasoning_content;
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    if (event.usage) usage = event.usage;
  }
  return {
    choices: [{
      finish_reason: finishReason,
      message: { role: 'assistant', content, ...(reasoning ? { reasoning_content: reasoning } : {}) },
    }],
    ...(usage ? { usage } : {}),
  };
}

export async function* streamAnthropic(response) {
  for await (const json of sseEvents(response)) {
    if (json.type === 'content_block_delta' && json.delta?.text) {
      yield json.delta.text;
    }
  }
}

export async function* streamOpenAI(response) {
  for await (const json of sseEvents(response)) {
    const delta = json.choices?.[0]?.delta?.content;
    if (delta) yield delta;
  }
}

// 提取線（memory.js）也要從同一份 wire format 規則裡挖正文——工單 08 §3.1 把那邊的
// 私有傳輸層刪掉接回這裡，所以這顆從檔案私有升為 export。函式體一字未動。
export function responseText(config, data) {
  if (config.format === 'anthropic') {
    return data.content?.filter(part => part.type === 'text').map(part => part.text || '').join('').trim() || '';
  }
  return data.choices?.[0]?.message?.content || '';
}

/**
 * 通讀的輸出預算。
 *
 * 推理模型（deepseek-v4-pro 這類）的思考鏈與正文**共用同一個 completion 預算**：
 * 2026-09-09 對真實上游實測同一篇論文（OpenCode Go / deepseek-v4-pro，59,615 字全文）——
 *   max_tokens=2000 → finish_reason='stop'、completion_tokens=1968（reasoning 1421）
 *                     ＝只剩 32 tokens 餘裕，思考鏈一長就翻車
 *   max_tokens=600  → finish_reason='length'、reasoning_tokens=600、content 長度 0
 * 第二組就是生產事故的形狀：HTTP 200、外層 JSON 合法、正文整個是空字串，
 * 於是錯誤訊息印成「AI 返回的摘要格式不正確: 」冒號後面什麼都沒有。
 * 完整重放數據見 commit cea1c15 的訊息（分支 fix/analyze-opencode）。
 */
export const ANALYZE_MAX_TOKENS = Number(process.env.ANALYZE_MAX_TOKENS) || 8000;

/** `setTimeout` 的 runtime 天花板；超過這個值計時器會立刻觸發（= 等於沒有逾時）。 */
export const MAX_TIMER_MS = 2_147_483_647;

function clampNumber(raw, { min, max, fallback }) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/**
 * 通讀串流的閒置逾時：兩個 chunk 之間最長可以隔多久。
 *
 * 預設 60s——推理模型思考時 `reasoning_content` 一樣逐 chunk 送，正常情況不會 60 秒
 * 一個字都沒有（9/9 實測整篇 38.9–53s 跑完）。總逾時 300s 保留，兩顆疊著用。
 * 每次呼叫都重讀 env：改 env 重啟即生效，也讓測試不必重新 import 模組。
 * 空／非數字 → 預設；0 或超大值 → clamp 到 [5s, setTimeout 天花板]。
 */
export function resolveAnalyzeIdleTimeoutMs() {
  const raw = process.env.ANALYZE_IDLE_TIMEOUT_MS;
  if (raw === undefined || raw === null || `${raw}`.trim() === '') return 60_000;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 60_000;
  return clampNumber(n, { min: 5_000, max: MAX_TIMER_MS, fallback: 60_000 });
}

/**
 * 連線類失敗自動重試幾次。預設 1——她不該需要知道「第一發停滯、手按一下就好」這件事。
 * clamp 到 [0, 3]：重試等於最壞情況多燒一次 ANALYZE_MAX_TOKENS 的輸出預算，不能讓人填 99。
 */
export function resolveAnalyzeRetries() {
  const raw = process.env.ANALYZE_RETRIES;
  if (raw === undefined || raw === null || `${raw}`.trim() === '') return 1;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 1;
  return clampNumber(n, { min: 0, max: 3, fallback: 1 });
}

/** 兩次嘗試之間的固定間隔。只重試一次，沒必要做指數退避。 */
export const ANALYZE_RETRY_DELAY_MS = 2_000;

function httpStatusOf(message) {
  const m = /^API error (\d{3})\b/.exec(message || '');
  return m ? Number(m[1]) : null;
}

function isConnectionFailure(err) {
  const code = `${err?.code || ''} ${err?.cause?.code || ''}`;
  if (/ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|ENOTFOUND|EAI_AGAIN|UND_ERR_/.test(code)) return true;
  return /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|UND_ERR_|socket hang up|network error|terminated/i
    .test(`${err?.message || ''}`);
}

/**
 * 把一次通讀失敗歸成一類，給日誌與「該不該重試」共用。
 * @returns {'idle'|'timeout'|'conn'|'output'|`http${number}`|'other'}
 */
export function analyzeErrorKind(err) {
  if (err instanceof StreamInterruptedError) return err.kind;
  const message = `${err?.message || ''}`;
  // 模型輸出的問題（空正文／預算用盡／JSON 壞掉）重打大概率同樣結果，還多燒一次預算。
  if (/摘要格式不正確|摘要無法解析為 JSON|輸出預算用盡/.test(message)) return 'output';
  if (/AI 請求超時/.test(message)) return 'timeout';
  const status = httpStatusOf(message);
  if (status) return `http${status}`;
  if (isConnectionFailure(err)) return 'conn';
  return 'other';
}

/**
 * 只對「連線／停滯類」重試。
 *
 * 4xx 是設定錯（base URL／key／模型名），重打只會再錯一次並多花錢；
 * 「格式不正確」「輸出預算用盡」是模型輸出問題，同樣不該重打。
 */
export function isRetryableAnalyzeError(err) {
  const kind = analyzeErrorKind(err);
  if (kind === 'idle' || kind === 'timeout' || kind === 'conn') return true;
  const status = kind.startsWith('http') ? Number(kind.slice(4)) : null;
  return status !== null && [429, 502, 503, 504].includes(status);
}

/**
 * 錯誤 → 給她看的那一句（繁體、帶「等了多久、收到多少」）。
 * 既有的「格式不正確」「輸出預算用盡」「上次通讀被服務重啟打斷」保留原文。
 */
export function describeAnalyzeError(err) {
  const message = `${err?.message || '未知錯誤'}`;
  const kind = analyzeErrorKind(err);
  if (kind === 'idle' || kind === 'timeout') return message; // 這兩句本來就是人話
  if (kind === 'conn') {
    const code = err?.cause?.code || err?.code;
    const detail = `${message}${code ? ` / ${code}` : ''}`.slice(0, 80);
    return `連不上通讀模型（${detail}）——請檢查網路或 VPN`;
  }
  if (kind.startsWith('http')) {
    const status = Number(kind.slice(4));
    const detail = message.replace(/^API error \d{3}: ?/, '').slice(0, 80);
    const tail = status >= 500 || status === 429
      ? '請稍後再試'
      : '請檢查通讀模型設定（base URL／API key／模型名）';
    return `上游回了 HTTP ${status}${detail ? `（${detail}）` : ''}——${tail}`;
  }
  return message;
}

function finalAnalyzeError(err, retriesUsed) {
  const human = describeAnalyzeError(err);
  if (retriesUsed > 0) {
    const wrapped = new Error(`通讀失敗（已自動重試 ${retriesUsed} 次）：${human}。請稍後按「重新通讀」`);
    wrapped.cause = err;
    return wrapped;
  }
  // 沒重試過而且訊息本來就是人話時，原物件原樣往上丟（型別資訊對呼叫端有用）。
  if (human === `${err?.message || ''}`) return err;
  const wrapped = new Error(human);
  wrapped.cause = err;
  return wrapped;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * 把兩種 wire format 的「這次生成怎麼收尾的」抽成同一個形狀，給診斷訊息用。
 */
export function completionMeta(config, data) {
  if (config.format === 'anthropic') {
    const parts = Array.isArray(data?.content) ? data.content : [];
    return {
      finishReason: data?.stop_reason || null,
      truncated: data?.stop_reason === 'max_tokens',
      reasoning: parts.filter(p => p.type === 'thinking').map(p => p.thinking || '').join(''),
      toolCalls: parts.filter(p => p.type === 'tool_use'),
      usage: data?.usage || null,
    };
  }
  const choice = data?.choices?.[0];
  const message = choice?.message || {};
  return {
    finishReason: choice?.finish_reason || null,
    truncated: choice?.finish_reason === 'length',
    reasoning: message.reasoning_content || message.reasoning || '',
    toolCalls: Array.isArray(message.tool_calls) ? message.tool_calls : [],
    usage: data?.usage || null,
  };
}

function diagnoseCompletion(meta, content) {
  const bits = [`finish_reason=${meta.finishReason ?? '未提供'}`, `content=${content.length} 字`];
  if (meta.reasoning) bits.push(`reasoning_content=${meta.reasoning.length} 字`);
  if (meta.toolCalls.length) bits.push(`tool_calls=${meta.toolCalls.length}`);
  if (meta.usage) bits.push(`usage=${JSON.stringify(meta.usage)}`);
  if (meta.truncated) bits.push('輸出預算用盡（調高 ANALYZE_MAX_TOKENS）');
  return bits.join('，');
}

/**
 * 從一次 completion 裡挖出摘要 JSON。失敗時的錯誤訊息必須帶夠診斷資訊——
 * 舊版只印 content.slice(0,200)，正文是空字串時錯誤訊息等於一片空白，查不出任何東西。
 * @param {{format?: string}} config
 * @param {object} data 上游回的完整 JSON（或串流重組出的等價物）
 * @returns {object} 解析出的摘要物件
 */
export function extractAnalyzeJson(config, data) {
  const content = responseText(config, data);
  const meta = completionMeta(config, data);
  const diag = diagnoseCompletion(meta, content);

  // 答案跑錯欄位的變體：有些 provider 把正文塞進 reasoning_content 而 content 留空。
  // 只在模型「正常收尾」時才從思考欄搶救——被截斷的思考鏈裡常躺著寫壞一半的草稿 JSON，
  // 撿回來會悄悄變成半成品摘要，比直接報錯更糟。
  let source = content;
  if (!/\{[\s\S]*\}/.test(source) && meta.reasoning && !meta.truncated) {
    source = meta.reasoning;
  }

  const jsonMatch = source.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(`AI 返回的摘要格式不正確（${diag}）: ${content.slice(0, 200)}`);
  }
  try {
    return JSON.parse(jsonMatch[0]);
  } catch {
    throw new Error(`AI 返回的摘要無法解析為 JSON（${diag}）: ${source.slice(0, 200)}`);
  }
}

async function buildAnalyzeUserContent(config, fullText, pdfPath) {
  const text = fullText.length > 100000 ? `${fullText.slice(0, 100000)}\n[全文已截斷]` : fullText;
  if (!pdfPath || !isVisionEnabled(config)) return text;

  if (config.format === 'anthropic') {
    const bytes = statSync(pdfPath).size;
    // Anthropic's standard request ceiling is 32 MB including base64 overhead.
    if (bytes <= 22 * 1024 * 1024) {
      return [
        {
          type: 'document',
          mediaType: 'application/pdf',
          data: readFileSync(pdfPath).toString('base64'),
          title: 'paper.pdf',
        },
        { type: 'text', text: '請通讀這份論文，圖、表、頁面布局與正文都要納入分析。' },
      ];
    }
  }

  try {
    const visualPages = await renderVisualPages(pdfPath, { maxPages: 8, dpi: 120 });
    if (visualPages.length > 0) {
      const visionConfig = { ...config, model: config.visionModel || config.model };
      const response = await makeRequest({ ...visionConfig, scope: 'analyze' }, {
        messages: [
          {
            role: 'system',
            content: '你是科研圖表審讀助手。只描述圖片中可驗證的圖、表、座標、圖例、數值趨勢與頁碼；不要推測看不清的內容。',
          },
          {
            role: 'user',
            content: [
              { type: 'text', text: '逐頁讀取以下論文圖表頁，輸出帶頁碼的視覺證據筆記，供另一個模型和正文交叉驗證。' },
              ...visualPages,
            ],
          },
        ],
        max_tokens: 3000,
        temperature: 0.1,
        stream: true,
      });
      const visualNotes = responseText(visionConfig, await collectStream(visionConfig, response));
      if (visualNotes) {
        return `${text}\n\n[視覺模型對圖表頁的證據筆記]\n${visualNotes}\n\n請把上述視覺筆記與正文交叉驗證；若衝突，以明確可核對的原文與圖表為準。`;
      }
    }
  } catch (err) {
    // 缺 poppler 不是「失敗」，是這台機器沒有這個能力——renderVisualPages 的探測
    // 已經在整個進程裡抱怨過一次了，不要每篇論文再複述一遍假警報。
    if (err.code !== 'PDFTOPPM_MISSING') {
      log('WARN', `PDF 視覺通讀失敗，降級為純文字通讀: ${err.message}`);
    }
  }
  return text;
}

/**
 * @param {string} fullText
 * @param {object} [options]
 * @param {string} [options.pdfPath]
 * @param {number} [options.idleTimeoutMs] 覆蓋閒置逾時（預設讀 ANALYZE_IDLE_TIMEOUT_MS）
 * @param {number} [options.timeoutMs] 覆蓋單次請求的總逾時（預設 REQUEST_TIMEOUT_MS）
 */
export async function analyzePaper(fullText, {
  pdfPath, paperId, idleTimeoutMs, timeoutMs, retries, retryDelayMs,
} = {}) {
  const config = getAnalyzeConfig();
  const idleMs = idleTimeoutMs ?? resolveAnalyzeIdleTimeoutMs();
  const totalMs = timeoutMs ?? REQUEST_TIMEOUT_MS;
  const maxRetries = retries ?? resolveAnalyzeRetries();
  const delayMs = retryDelayMs ?? ANALYZE_RETRY_DELAY_MS;
  const tag = paperId || 'unknown';
  // 視覺筆記只做一次：它自己也要打一次上游，不該跟著主請求重試燒兩遍。
  const userContent = await buildAnalyzeUserContent(config, fullText, pdfPath);

  const messages = [
    {
      role: 'system',
      content: `你是一位科研論文分析專家。請通讀以下論文全文，生成結構化摘要。

嚴格輸出以下 JSON 格式（不要包含 \`\`\`json 標記）：
{
  "title": "論文標題（從內容中提取）",
  "authors": "作者列表，逗號分隔",
  "year": 2024,
  "background": "研究背景與動機（2-4 句）",
  "methods": "研究方法（2-4 句）",
  "results": "主要結果（2-4 句）",
  "conclusions": "結論（2-4 句）",
  "limitations": "局限性（1-3 句）"
}`,
    },
    { role: 'user', content: userContent },
  ];

  let lastError = null;
  let retriesUsed = 0;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt += 1) {
    const startedAt = Date.now();
    const streamStats = {};
    log('INFO', `[ANALYZE] attempt=${attempt} paper=${tag} model=${config.model} chars_in=${fullText.length}`);

    try {
      // 串流，不是為了逐字顯示（通讀沒有逐字 UI），是為了躲 OpenCode Go 的 60 秒非串流閘門：
      // 實測 max_tokens=2000 就要 38.9 秒，預算拉到 8000 之後非串流必撞牆。
      const response = await makeRequest({ ...config, scope: 'analyze' }, {
        messages,
        max_tokens: ANALYZE_MAX_TOKENS,
        temperature: 0.2,
        stream: true,
        timeoutMs: totalMs,
      });

      // 通讀沒有逐字 UI，沒人會看著它停住——停滯要由程式自己發現，不能傻等滿 300s。
      const collected = await collectStream(config, response, {
        idleTimeoutMs: idleMs,
        totalTimeoutMs: totalMs,
        stats: streamStats,
      });
      const result = extractAnalyzeJson(config, collected);
      const meta = completionMeta(config, collected);

      log('INFO', `[ANALYZE] attempt=${attempt} ok elapsed=${elapsedSeconds(startedAt)}s`
        + ` chunks=${streamStats.receivedChunks ?? 0}`
        + ` chars_out=${responseText(config, collected).length}`
        + ` finish=${meta.finishReason ?? '未提供'}`
        + ` usage=${meta.usage ? JSON.stringify(meta.usage) : 'none'}`);

      return {
        title: result.title || '',
        authors: result.authors || '',
        year: result.year || null,
        summary_bg: result.background || '',
        summary_methods: result.methods || '',
        summary_results: result.results || '',
        summary_conclusions: result.conclusions || '',
        summary_limitations: result.limitations || '',
      };
    } catch (err) {
      lastError = err;
      const kind = analyzeErrorKind(err);
      log('WARN', `[ANALYZE] attempt=${attempt} fail elapsed=${elapsedSeconds(startedAt)}s kind=${kind}`
        + ` chunks=${streamStats.receivedChunks ?? 0} chars_out=${streamStats.receivedChars ?? 0}`);

      if (attempt > maxRetries || !isRetryableAnalyzeError(err)) break;

      retriesUsed = attempt;
      log('INFO', `[ANALYZE] retry ${attempt}/${maxRetries} paper=${tag} reason=${kind}`);
      await sleep(delayMs);
    }
  }

  throw finalAnalyzeError(lastError, retriesUsed);
}

function elapsedSeconds(startedAt) {
  return ((Date.now() - startedAt) / 1000).toFixed(1);
}

// 論文區塊：標題/作者/年份/AI 摘要/全文。措辭逐字沿用工單 05 之前的 stableSystem，只是拿掉了身份句。
export function buildPaperBlock(paper) {
  const fullText = paper.full_text.length > 100000
    ? paper.full_text.slice(0, 100000) + '\n[全文已截斷]'
    : paper.full_text;

  return `以下是這篇論文的信息：
標題：${paper.title}
作者：${paper.authors}
年份：${paper.year || '未知'}

AI 摘要：
- 背景：${paper.summary_bg}
- 方法：${paper.summary_methods}
- 結果：${paper.summary_results}
- 結論：${paper.summary_conclusions}
- 局限：${paper.summary_limitations}

以下是論文全文（供你參考回答問題，不需要重複全文內容）：
${fullText}`;
}

// system 的穩定前綴 = 憲章（單獨一個 cache block，永遠最前）+ 論文區塊（第二個 cache block）。
// 換論文不打掉憲章緩存；改憲章只冷一次。變動區（洞察/續窗）由呼叫端接在後面。
//
// 研究方向區塊（工單 07 §3.2 注入點 1）接在論文區塊之後、**同一個 cache block 內**，
// 不另開 cache_control：方向很少變，冷一次可接受。沒有任何方向時區塊是空字串，
// 這裡連換行都不加 ⇒ 輸出與工單 07 之前逐字相同（§5 零回歸線）。
// directionsBlock 可由呼叫端傳入（討論線已經為了 log 查過一次，不用再查）。
export function buildChatSystem(paper, { constitution, format, directionsBlock }) {
  const directions = directionsBlock === undefined ? renderDirectionsBlock(paper.id) : directionsBlock;
  const paperBlock = directions
    ? `${buildPaperBlock(paper)}\n\n${directions}`
    : buildPaperBlock(paper);
  if (format === 'anthropic') {
    return [
      { type: 'text', text: constitution, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: paperBlock, cache_control: { type: 'ephemeral' } },
    ];
  }
  return constitution + '\n\n' + paperBlock;
}

export async function chatAboutPaper(paper, history, userMessage, onChunk) {
  const config = getChatConfig();
  const { text: constitution, source: constitutionSource } = loadConstitution();

  // 方向區塊查一次：一份給 system，一份給 log（工單 07 §3.2——討論用的要看得見）。
  const directions = buildDirectionsContext(paper.id);
  log('INFO', `[DIRECTIONS] paper=${paper.id} direction=${directions.directionName || 'none'} total=${directions.total}`);

  const stableSystem = buildChatSystem(paper, {
    constitution,
    format: config.format,
    directionsBlock: directions.block,
  });

  // Variable part: injected insights — changes per-turn, not cached
  let insightText = '';

  try {
    const ownInsights = db.prepare(
      'SELECT dimension, title, content FROM insights WHERE source_paper_id = ? ORDER BY updated_at DESC LIMIT 5'
    ).all(paper.id);

    if (ownInsights.length > 0) {
      insightText += '\n\n用戶之前從這篇論文提煉的洞察：\n';
      for (const ins of ownInsights) {
        insightText += `- [${ins.dimension}] ${ins.title}: ${ins.content.slice(0, 200)}\n`;
      }
      insightText += '在回答時，適時引用和關聯這些洞察，幫助用戶建立跨論文的理解。';
    }

    // Cross-paper related insights via FTS5 trigram search
    const related = searchInsights(userMessage, { excludePaperId: paper.id, limit: 3 });

    if (related.length > 0) {
      const paperTitles = new Map();
      for (const ins of related) {
        if (ins.source_paper_id && !paperTitles.has(ins.source_paper_id)) {
          const p = db.prepare('SELECT title FROM papers WHERE id = ?').get(ins.source_paper_id);
          paperTitles.set(ins.source_paper_id, p?.title || null);
        }
      }

      insightText += '\n\n來自其他論文的相關洞察：\n';
      for (const ins of related) {
        const paperTitle = ins.source_paper_id ? paperTitles.get(ins.source_paper_id) : null;
        insightText += `- [${ins.dimension}] ${ins.title}（來自《${paperTitle || '未知'}》）: ${ins.content.slice(0, 150)}\n`;
      }
    }
  } catch (err) {
    console.error('[INSIGHT-INJECT] failed:', err.message);
  }

  // 研究續窗（carryover）：手動「帶上」才注入（拍板 #1）。
  // 只接在變動區（insightText 之後）——絕不能插進 stableSystem，否則每輪打掉 prompt cache。
  // 注入的是結構化摘要（每條一行、必帶 origin 標記、衝突醒目），不是 transcript（紅線 8）。
  try {
    const carryoverText = renderCarryoverForInjection(paper.id);
    if (carryoverText) insightText += carryoverText;
  } catch (err) {
    console.error('[CARRYOVER-INJECT] failed:', err.message);
  }

  // Build system: [憲章 block, 論文 block, (變動區)] for anthropic; plain string for openai
  let systemForRequest;
  if (config.format === 'anthropic') {
    systemForRequest = [...stableSystem];
    if (insightText) {
      systemForRequest.push({ type: 'text', text: insightText });
    }
  } else {
    systemForRequest = stableSystem + insightText;
  }
  log('INFO', `[CONSTITUTION] source=${constitutionSource} format=${config.format}`);

  const messages = [
    { role: 'system', content: systemForRequest },
    ...history.map(h => ({ role: h.role, content: h.content })),
  ];
  if (userMessage) {
    messages.push({ role: 'user', content: userMessage });
  }

  const response = await makeRequest({ ...config, scope: `paper:${paper.id}` }, {
    messages,
    max_tokens: 4096,
    temperature: 0.3,
    stream: true,
  });

  const streamGen = config.format === 'anthropic' ? streamAnthropic : streamOpenAI;

  let fullResponse = '';
  for await (const chunk of streamGen(response)) {
    fullResponse += chunk;
    onChunk(chunk);
  }

  return fullResponse;
}

export async function testConnection({ base_url, api_key, model, format }) {
  const config = {
    baseUrl: base_url,
    key: api_key,
    model,
    format,
  };

  const messages = [{ role: 'user', content: 'Hi' }];

  const response = await makeRequest({ ...config, scope: 'test' }, {
    messages,
    max_tokens: 10,
    temperature: 0,
    stream: false,
  });

  if (response.ok) return { ok: true };
  const text = await response.text();
  return { ok: false, error: text.slice(0, 200) };
}
