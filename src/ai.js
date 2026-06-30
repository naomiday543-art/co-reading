import { getSetting, getSettings } from './db.js';
import db from './db.js';
import { log } from './logger.js';
import { searchInsights } from './search.js';

function resolveConfig(prefix) {
  const dbSettings = getSettings();
  const key = dbSettings[`${prefix}_api_key`] || process.env[`${prefix.toUpperCase()}_API_KEY`];
  const baseUrl = dbSettings[`${prefix}_base_url`] || process.env[`${prefix.toUpperCase()}_BASE_URL`];
  const model = dbSettings[`${prefix}_model`] || process.env[`${prefix.toUpperCase()}_MODEL`];
  const format = dbSettings[`${prefix}_format`] || process.env[`${prefix.toUpperCase()}_FORMAT`];

  return {
    key,
    baseUrl,
    model,
    format: format || 'openai',
  };
}

export function getChatConfig() {
  const config = resolveConfig('ai');
  return {
    key: config.key || '',
    baseUrl: config.baseUrl || 'https://api.openai.com/v1',
    model: config.model || 'gpt-4o',
    format: config.format || 'openai',
  };
}

export function getAnalyzeConfig() {
  let config = resolveConfig('analyze');

  // Fall back to main AI config if analyze config is not set
  if (!config.key && !config.baseUrl && !config.model) {
    config = resolveConfig('ai');
  }
  if (!config.key) {
    const mainConfig = resolveConfig('ai');
    config.key = mainConfig.key;
  }
  if (!config.baseUrl) {
    const mainConfig = resolveConfig('ai');
    config.baseUrl = mainConfig.baseUrl;
  }
  if (!config.model) {
    const mainConfig = resolveConfig('ai');
    config.model = mainConfig.model;
  }

  return {
    key: config.key || '',
    baseUrl: config.baseUrl || 'https://api.openai.com/v1',
    model: config.model || 'gpt-4o',
    format: config.format || 'openai',
  };
}

function buildHeaders({ key, format }) {
  if (format === 'anthropic') {
    return {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    };
  }
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${key}`,
  };
}

function buildBody({ model, format }, { messages, stream, max_tokens, temperature }) {
  if (format === 'anthropic') {
    let system = null;
    const chatMessages = [];
    for (const m of messages) {
      if (m.role === 'system') {
        system = m.content;
      } else {
        chatMessages.push({ role: m.role, content: m.content });
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
    messages,
    max_tokens: max_tokens || 4096,
    stream: stream || false,
    temperature: temperature !== undefined ? temperature : 0.7,
  };
}

function buildEndpoint({ baseUrl, format }) {
  const base = baseUrl.replace(/\/$/, '');
  if (format === 'anthropic') {
    return `${base}/messages`;
  }
  // Handle OpenRouter, DeepSeek, and other OpenAI-compatible endpoints
  return `${base}/chat/completions`;
}

async function makeRequest(config, params) {
  const url = buildEndpoint(config);
  const headers = buildHeaders(config);
  const body = buildBody(config, params);

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    let errorText = '';
    try { errorText = await response.text(); } catch {}
    throw new Error(`API error ${response.status}: ${errorText.slice(0, 200)}`);
  }

  return response;
}

async function* streamAnthropic(response) {
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
        const json = JSON.parse(data);
        if (json.type === 'content_block_delta' && json.delta?.text) {
          yield json.delta.text;
        }
      } catch {
        // skip unparseable lines
      }
    }
  }
}

async function* streamOpenAI(response) {
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
        const json = JSON.parse(data);
        const delta = json.choices?.[0]?.delta?.content;
        if (delta) yield delta;
      } catch {
        // skip unparseable lines
      }
    }
  }
}

export async function analyzePaper(fullText) {
  const config = getAnalyzeConfig();
  const text = fullText.length > 100000 ? fullText.slice(0, 100000) + '\n[全文已截斷]' : fullText;

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
    { role: 'user', content: text },
  ];

  const response = await makeRequest(config, {
    messages,
    max_tokens: 2000,
    temperature: 0.2,
    stream: false,
  });

  const raw = await response.text();
  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    // Try to extract from response
  }

  let content;
  if (config.format === 'anthropic') {
    json = JSON.parse(raw);
    content = json.content?.[0]?.text || '';
  } else {
    json = JSON.parse(raw);
    content = json.choices?.[0]?.message?.content || '';
  }

  // Try to parse the content as JSON (it might have markdown code blocks)
  let result;
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      result = JSON.parse(jsonMatch[0]);
    } catch {
      throw new Error('AI 返回的摘要無法解析為 JSON: ' + content.slice(0, 200));
    }
  } else {
    throw new Error('AI 返回的摘要格式不正確: ' + content.slice(0, 200));
  }

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

  const response = await makeRequest(config, {
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

  const response = await makeRequest(config, {
    messages,
    max_tokens: 10,
    temperature: 0,
    stream: false,
  });

  if (response.ok) return { ok: true };
  const text = await response.text();
  return { ok: false, error: text.slice(0, 200) };
}
