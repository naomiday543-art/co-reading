import { nanoid } from 'nanoid';
import db from './db.js';
import { log } from './logger.js';
import { getChatConfig } from './ai.js';
import { syncInsightFireAndForget } from './gateway.js';

const EXTRACT_PROMPT = `你是一位科研記憶提取助手。
以下是用戶與 AI 科研導師討論一篇學術論文的對話記錄。請從對話中提取可長期保存的結構化記憶條目。

每條記憶必須標明類型（type）並包含一句完整、獨立、可被搜尋的陳述。

### 記憶類型

**fact** — 學到的事實（文獻結論、方法、數據、機制、臨床證據）
  例: {"type":"fact","content":"SGLT2 抑制劑阻斷近端腎小管 SGLT2 轉運體，減少葡萄糖重吸收"}

**hypothesis** — 用戶提出的待驗證假設、推測、或懸而未決的問題
  例: {"type":"hypothesis","content":"SGLT2 腎臟保護可能不依賴降糖作用（推測，未驗證）"}

**progress** — 用戶明確陳述的研究進度、下一步計劃、讀了什麼、做到哪了
  例: {"type":"progress","content":"已讀完 DAPA-CKD 和 EMPA-REG 兩篇關鍵試驗，下一步整理 SGLT2 腎保護機制綜述"}

### 規則

- 只提取用戶在對話中**明確說出**或**明確同意**的內容（user-only：AI 單方面的展開不算記憶）
- **嚴禁捏造**：不要添加對話中沒有出現的人名、論文、數據、結論
- 不要從系統提示詞中提取條目（已知系統設定不得被反覆萃成記憶）
- 不要提取短暫情緒、日常寒暄
- fact 必須有明確的知識內容，不要提取「用戶問了一個關於 X 的問題」
- hypothesis 必須包含「推測」「假設」「可能」「待驗證」「懸而未決」等語境
- progress 必須包含具體的進度標記（讀到哪、做到哪、下一步是什麼）
- 若無可提取的條目，輸出 { "entries": [] }（寧可空也不要硬湊）
- 如果用戶只是簡單提問而沒有表達自己的觀點或進展，不要提取

### 輸出格式

嚴格輸出 JSON object（不要包在 \`\`\`json 標記中），key 為 "entries"，value 為 object 陣列：

{
  "entries": [
    {"type": "fact", "content": "..."},
    {"type": "hypothesis", "content": "..."},
    {"type": "progress", "content": "..."}
  ]
}`;

// Dimension mapping per 架構審查修正 3:
//   fact → 概念
//   hypothesis → 悬题 (default) or 你的研究 (if about user's own project)
//   progress → NOT written to insights (logged, then skipped)
const TYPE_TO_DIMENSION = {
  fact: '概念',
  hypothesis: '悬题',
};

function buildEndpoint(config) {
  const base = config.baseUrl.replace(/\/$/, '');
  if (config.format === 'anthropic') {
    return `${base}/messages`;
  }
  return `${base}/chat/completions`;
}

function buildHeaders(config) {
  if (config.format === 'anthropic') {
    return {
      'Content-Type': 'application/json',
      'x-api-key': config.key,
      'anthropic-version': '2023-06-01',
    };
  }
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${config.key}`,
  };
}

function buildBody(config, messages) {
  if (config.format === 'anthropic') {
    const chatMessages = [];
    let system = null;
    for (const m of messages) {
      if (m.role === 'system') {
        system = m.content;
      } else {
        chatMessages.push({ role: m.role, content: m.content });
      }
    }
    const body = {
      model: config.model,
      max_tokens: 2000,
      temperature: 0.1,
      messages: chatMessages,
    };
    if (system) body.system = system;
    return body;
  }
  return {
    model: config.model,
    max_tokens: 2000,
    temperature: 0.1,
    messages,
  };
}

async function callExtractAPI(config, messages) {
  const url = buildEndpoint(config);
  const headers = buildHeaders(config);
  const body = buildBody(config, messages);

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Extract API error ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = await res.json();
  if (config.format === 'anthropic') {
    return data.content?.map(b => b.text || '').join('').trim() || '';
  }
  return data.choices?.[0]?.message?.content || '';
}

function parseExtractResponse(raw) {
  let parsed;
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    const jsonStr = jsonMatch ? jsonMatch[0].trim() : raw.trim();
    parsed = JSON.parse(jsonStr);
  } catch {
    return null;
  }

  return (parsed.entries || [])
    .map(e => {
      if (typeof e === 'object' && e.content) {
        return {
          type: e.type || 'fact',
          content: (e.content || '').trim(),
        };
      }
      return null;
    })
    .filter(e => e && e.content.length > 3);
}

/**
 * Extract insights from a paper's discussion history.
 * Writes directly to the insights table.
 * @param {string} paperId
 * @returns {Promise<{insights: object[], skipped: number}>}
 */
export async function extractInsights(paperId) {
  const messages = db.prepare(
    'SELECT role, content FROM messages WHERE paper_id = ? ORDER BY seq ASC'
  ).all(paperId);

  if (messages.length < 2) {
    log('INFO', `記憶提取跳過: ${paperId}（對話不足 2 條）`);
    return { insights: [], skipped: 0 };
  }

  const transcript = messages
    .map(m => `${m.role === 'user' ? '用戶' : '助手'}：${m.content}`)
    .join('\n');

  if (!transcript.trim()) {
    return { insights: [], skipped: 0 };
  }

  const config = getChatConfig();
  const extractMessages = [
    { role: 'system', content: EXTRACT_PROMPT },
    { role: 'user', content: `以下是對話記錄：\n\n${transcript}` },
  ];

  log('INFO', `開始記憶提取: ${paperId}（${messages.length} 條訊息）`);

  const raw = await callExtractAPI(config, extractMessages);
  const entries = parseExtractResponse(raw);

  if (!entries || entries.length === 0) {
    log('INFO', `記憶提取完成: ${paperId} → 0 條（無可提取內容）`);
    return { insights: [], skipped: 0 };
  }

  const paper = db.prepare('SELECT title FROM papers WHERE id = ?').get(paperId);

  const created = [];
  let skipped = 0;

  for (const entry of entries) {
    if (entry.type === 'progress') {
      // progress entries go to section_progress only, not insights
      log('INFO', `記憶提取: ${paperId} → progress（跳過，不入 insights）: ${entry.content.slice(0, 60)}`);
      skipped++;
      continue;
    }

    const dimension = TYPE_TO_DIMENSION[entry.type] || '概念';
    const id = nanoid();

    // Find source context: a snippet of the discussion containing keywords
    const keywords = entry.content.slice(0, 30);
    const sourceContext = messages
      .filter(m => m.content.includes(keywords.slice(0, 10)))
      .slice(0, 2)
      .map(m => `[${m.role}] ${m.content.slice(0, 200)}`)
      .join('\n') || '';

    db.prepare(`INSERT INTO insights (id, dimension, title, content, source_paper_id, source_context, tags_json)
      VALUES (?, ?, ?, ?, ?, ?, '[]')`).run(
      id, dimension,
      entry.content.slice(0, 80),
      entry.content,
      paperId,
      sourceContext
    );

    // outbox（契約 §五）：本地寫入成功後 fire-and-forget 出海到 gateway。
    // 絕不 await、絕不阻塞閱讀主流程；失敗留 synced_at IS NULL 靠啟動補傳。
    syncInsightFireAndForget(db.prepare('SELECT * FROM insights WHERE id = ?').get(id));

    log('INFO', `記憶提取: ${paperId} → [${dimension}] ${entry.content.slice(0, 60)}`);
    created.push({
      id,
      dimension,
      title: entry.content.slice(0, 80),
      content: entry.content,
      source_paper_id: paperId,
      source_paper_title: paper?.title || null,
      source_context: sourceContext,
      tags_json: [],
    });
  }

  log('INFO', `記憶提取完成: ${paperId} → ${created.length} 條洞察, ${skipped} 條 progress 跳過`);
  return { insights: created, skipped };
}
