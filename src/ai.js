import { getSetting, getSettings } from './db.js';
import db from './db.js';
import { log } from './logger.js';
import { searchInsights } from './search.js';
import { readFileSync, statSync } from 'fs';
import { renderVisualPages } from './pdf.js';
import { renderCarryoverForInjection } from './carryover.js';
import { opencodeSessionHeaders } from './opencodeSession.js';

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
 * SSE 行 → 已解析的 JSON 事件。兩種 wire format 共用。
 */
async function* sseEvents(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
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
 * @returns {object} 非串流形狀的回應物件
 */
export async function collectStream(config, response) {
  let content = '';
  let reasoning = '';
  let finishReason = null;
  let usage = null;

  if (config.format === 'anthropic') {
    for await (const event of sseEvents(response)) {
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

  for await (const event of sseEvents(response)) {
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

function responseText(config, data) {
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
 * 詳見 docs/work/report-analyze-slow-fail-20260909.md §A。
 */
export const ANALYZE_MAX_TOKENS = Number(process.env.ANALYZE_MAX_TOKENS) || 8000;

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
    log('WARN', `PDF 視覺通讀失敗，降級為純文字通讀: ${err.message}`);
  }
  return text;
}

export async function analyzePaper(fullText, { pdfPath } = {}) {
  const config = getAnalyzeConfig();
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

  // 串流，不是為了逐字顯示（通讀沒有逐字 UI），是為了躲 OpenCode Go 的 60 秒非串流閘門：
  // 實測 max_tokens=2000 就要 38.9 秒，預算拉到 8000 之後非串流必撞牆。
  const response = await makeRequest({ ...config, scope: 'analyze' }, {
    messages,
    max_tokens: ANALYZE_MAX_TOKENS,
    temperature: 0.2,
    stream: true,
  });

  const result = extractAnalyzeJson(config, await collectStream(config, response));

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
}

export async function chatAboutPaper(paper, history, userMessage, onChunk) {
  const config = getChatConfig();

  const fullText = paper.full_text.length > 100000
    ? paper.full_text.slice(0, 100000) + '\n[全文已截斷]'
    : paper.full_text;

  // Stable part: paper info + full text + instructions — eligible for prompt cache
  const stableSystem = `你是一位科研導師，正在幫助用戶閱讀和理解一篇學術論文。

以下是這篇論文的信息：
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
${fullText}

回答要求：
1. 基於論文內容準確回答，不要編造論文中沒有的信息
2. 如果論文中沒有相關內容，明確告知用戶
3. 用清晰、易懂的語言解釋
4. 適當引用論文中的具體段落或數據
5. 使用用戶提問時所用的語言回答`;

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

  // Build system: array with cache_control for anthropic, plain string for openai
  let systemForRequest;
  if (config.format === 'anthropic') {
    systemForRequest = [
      { type: 'text', text: stableSystem, cache_control: { type: 'ephemeral' } },
    ];
    if (insightText) {
      systemForRequest.push({ type: 'text', text: insightText });
    }
  } else {
    systemForRequest = stableSystem + insightText;
  }

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
