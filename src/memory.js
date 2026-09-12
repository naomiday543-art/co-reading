import { nanoid } from 'nanoid';
import db from './db.js';
import { log } from './logger.js';
import {
  getChatConfig,
  buildEndpoint,
  buildHeaders,
  buildBody,
  collectStream,
  completionMeta,
  responseText,
  REQUEST_TIMEOUT_MS,
} from './ai.js';
import { syncInsightFireAndForget } from './gateway.js';
import { renderDirectionsBlock } from './directions.js';
// 六個維度的唯一事實源（工單 08 §3.2）。routes/insights.js 檔尾已 export，別在這裡複製一份。
import { DIMENSIONS } from './routes/insights.js';

export const EXTRACT_PROMPT = `你是一位科研記憶提取助手。
以下是用戶與 AI 科研導師討論一篇學術論文的對話記錄。請從對話中提取可長期保存的結構化記憶條目。

每條記憶必須標明類型（type）與維度（dimension），並包含一句完整、獨立、可被搜尋的陳述。

### 記憶類型

**fact** — 學到的事實（文獻結論、方法、數據、機制、臨床證據）
  例: {"type":"fact","dimension":"概念","content":"SGLT2 抑制劑阻斷近端腎小管 SGLT2 轉運體，減少葡萄糖重吸收"}

**hypothesis** — 用戶提出的待驗證假設、推測、或懸而未決的問題
  例: {"type":"hypothesis","dimension":"悬题","content":"SGLT2 腎臟保護可能不依賴降糖作用（推測，未驗證）"}

**progress** — 用戶明確陳述的研究進度、下一步計劃、讀了什麼、做到哪了
  例: {"type":"progress","dimension":"你的研究","content":"已讀完 DAPA-CKD 和 EMPA-REG 兩篇關鍵試驗，下一步整理 SGLT2 腎保護機制綜述"}

### 維度（dimension）——每條必填，六選一

**概念** — 從這篇論文學到的事實、機制、方法（type 通常是 fact）
**悬题** — 沒解決的疑問、推測、待驗證的假設（type 通常是 hypothesis）
**你的研究** — 直接關於她自己所屬方向的判斷或計畫（見【她的研究方向】：跟這篇所屬方向直接相關）
**延伸** — 從這篇跳到她**另一個**方向的連結（見【她的研究方向】：不是這篇所屬的那個）
**闪回** — 讀這篇時想起**另一篇**論文的具體內容（見【已有洞察】裡來自其他論文的條目）
**共振** — 這篇與**另一篇**論文的說法互相呼應或打架（見【已有洞察】；打架也算，保留矛盾）
判斷不了就用「概念」或「悬题」，不要硬湊跨論文維度。

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
- 每條都要填 dimension（六選一，見上）；拿不定主意就填「概念」或「悬题」

### 輸出格式

嚴格輸出 JSON object（不要包在 \`\`\`json 標記中），key 為 "entries"，value 為 object 陣列：

{
  "entries": [
    {"type": "fact", "dimension": "概念", "content": "..."},
    {"type": "hypothesis", "dimension": "悬题", "content": "..."},
    {"type": "progress", "dimension": "你的研究", "content": "..."}
  ]
}`;

// 工單 08 §3.2 起，dimension 由模型直出（六值）；這張表退為**兜底**：
//   模型沒填或填了六值以外的東西時才用 —— fact → 概念、hypothesis → 悬题。
//   progress 一律不入 insights（log 後跳過），與 gateway 契約的三 type 無關。
const TYPE_TO_DIMENSION = {
  fact: '概念',
  hypothesis: '悬题',
};

/**
 * 模型直出的 dimension 收口：六值照用，其餘一律兜底並留 WARN（工單 08 §3.2）。
 * @param {{type: string, dimension: string}} entry
 * @param {string} paperId
 * @returns {string}
 */
function resolveDimension(entry, paperId) {
  if (DIMENSIONS.includes(entry.dimension)) return entry.dimension;
  const fallback = TYPE_TO_DIMENSION[entry.type] || '概念';
  log(
    'WARN',
    `記憶提取: ${paperId} → 非法維度 ${JSON.stringify(entry.dimension || '')}`
    + `（type=${entry.type}）→ 兜底 [${fallback}]`,
  );
  return fallback;
}

/**
 * 提取用的 system（工單 07 §3.2 注入點 2）。
 * EXTRACT_PROMPT 在前、研究方向區塊接在後面；沒有任何方向時**逐字等於** EXTRACT_PROMPT
 * （§5 零回歸線）。本工單只加方向，不動 type／dimension 語義（那是批次三）。
 * @param {string} paperId
 * @returns {string}
 */
export function buildExtractSystem(paperId) {
  const directions = renderDirectionsBlock(paperId);
  return directions ? `${EXTRACT_PROMPT}\n\n${directions}` : EXTRACT_PROMPT;
}

/**
 * 提取的輸出預算。
 *
 * 2026-09-09 通讀事故的同一顆坑：推理模型的思考鏈與正文共用同一個 completion 預算，
 * 舊的 `max_tokens: 2000` 在 deepseek-v4-pro 這類模型上會被思考鏈吃光、正文留空字串。
 * 提取的輸出比摘要短（幾條 JSON），4000 是「正文夠用 + 給思考鏈留位」。
 */
export const EXTRACT_MAX_TOKENS = Number(process.env.EXTRACT_MAX_TOKENS) || 4000;

/**
 * 空正文的診斷字串。措辭與 ai.js 的 diagnoseCompletion 同形，只是把「調高」指向提取的旋鈕。
 */
function diagnoseExtract(meta, content) {
  const bits = [`finish_reason=${meta.finishReason ?? '未提供'}`, `content=${content.length} 字`];
  if (meta.reasoning) bits.push(`reasoning_content=${meta.reasoning.length} 字`);
  if (meta.toolCalls.length) bits.push(`tool_calls=${meta.toolCalls.length}`);
  if (meta.usage) bits.push(`usage=${JSON.stringify(meta.usage)}`);
  if (meta.truncated) bits.push('輸出預算用盡（調高 EXTRACT_MAX_TOKENS）');
  return bits.join('，');
}

/**
 * 從一次 completion 裡挖出「可能含 JSON 的那段文字」。規則與 analyze 的
 * extractAnalyzeJson 完全一致：正文沒有 `{…}` 且模型**正常收尾**時才從 reasoning 搶救；
 * 被截斷（finish_reason=length / max_tokens）的思考鏈裡躺的是寫壞一半的草稿 JSON，不救。
 * @param {{format?: string}} config
 * @param {object} data 串流重組出的非串流形狀
 * @returns {string}
 */
function extractCompletionSource(config, data) {
  const content = responseText(config, data);
  const meta = completionMeta(config, data);
  const diag = diagnoseExtract(meta, content);

  let source = content;
  if (!/\{[\s\S]*\}/.test(source) && meta.reasoning && !meta.truncated) {
    log('WARN', `記憶提取：正文沒有 JSON，改從 reasoning_content 搶救（${diag}）`);
    source = meta.reasoning;
  }

  if (!/\{[\s\S]*\}/.test(source)) {
    throw new Error(`AI 沒有返回可解析的提取結果（${diag}）: ${content.slice(0, 200)}`);
  }
  return source;
}

async function callExtractAPI(config, messages) {
  const url = buildEndpoint(config);
  // 紅線：scope 固定 'extract'（提取 prompt 的前綴與論文無關，不按論文分桶）。
  // baseUrl 一定要傳進去，buildHeaders 才判得出是不是 opencode.ai（缺標頭 → 400 MissingSessionID）。
  const headers = buildHeaders({ ...config, scope: 'extract' });
  const body = buildBody(config, {
    messages,
    stream: true, // 躲 OpenCode Go 的 60 秒非串流閘門（與 analyze 同一道修法）
    max_tokens: EXTRACT_MAX_TOKENS,
    temperature: 0.1,
  });

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      throw new Error(`記憶提取請求超時（${Math.round(REQUEST_TIMEOUT_MS / 1000)}s 沒有結果）`);
    }
    throw err;
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Extract API error ${res.status}: ${text.slice(0, 200)}`);
  }

  return extractCompletionSource(config, await collectStream(config, res));
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
          // 模型直出的 dimension；收口與兜底在 resolveDimension（這裡不過濾，壞值要留著進 WARN）
          dimension: typeof e.dimension === 'string' ? e.dimension.trim() : '',
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
    { role: 'system', content: buildExtractSystem(paperId) },
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

    const dimension = resolveDimension(entry, paperId);
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
