// 多篇摘要對比（工單 09 §3.1；上位方案 §3.3／§4.3）。
//
// 為什麼只吃摘要：單篇全文 45k–147k 字，兩篇疊起來十幾萬 token，慢且貴。
// 每篇都有五段結構化摘要（她六篇各 526–2161 字），那正是「方法對比」的料。
// 紅線（工單 §5）：**對比 prompt 只含摘要**，full_text 一個字都不准進來。
//
// 傳輸層一律借 ai.js（工單 08 §3.1 示範過的那一套）：buildEndpoint / buildHeaders /
// buildBody / collectStream / completionMeta / responseText。這個檔只 import ai.js，
// ai.js 不得 import 它（工單 §2）。
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
import { renderDirectionsBlock } from './directions.js';

/** 對比表的五個維度，順序固定（= 摘要的五段）。 */
export const COMPARE_DIMENSIONS = ['背景', '方法', '結果', '結論', '局限'];

/** 維度 → papers 表的摘要欄位。 */
const SECTION_FIELDS = [
  ['背景', 'summary_bg'],
  ['方法', 'summary_methods'],
  ['結果', 'summary_results'],
  ['結論', 'summary_conclusions'],
  ['局限', 'summary_limitations'],
];

/** 單篇單段進 prompt 的字數上限（工單 §3.1）。四篇 × 五段 × 1500 ＋ 骨架 < 40k 字。 */
export const SECTION_MAX = 1500;

/** 比不出來的格子一律填這句——模型填、後端補齊也填同一句（工單 §3.1）。 */
export const NOT_MENTIONED = '摘要未提及';

/** 對比的篇數閘：少於 2 篇沒得比，多於 4 篇 prompt 會脹破上限（工單 §3.1 / §9）。 */
export const MIN_PAPERS = 2;
export const MAX_PAPERS = 4;

/**
 * 對比的輸出預算。
 *
 * 與 ANALYZE_MAX_TOKENS / EXTRACT_MAX_TOKENS 同一顆坑（2026-09-09 通讀事故）：推理模型的
 * 思考鏈與正文共用同一個 completion 預算，預算太小就是「HTTP 200、正文空字串」。
 * 對比要吐的是一張 5 × 4 的表 ＋ 三段分析，比提取長得多，6000 是「正文夠用 ＋ 給思考鏈留位」。
 */
export const COMPARE_MAX_TOKENS = Number(process.env.COMPARE_MAX_TOKENS) || 6000;

const COMPARE_SYSTEM_BASE = `你是科研導師，正在替研究者對比幾篇論文的結構化摘要。只能依據下面給的摘要，摘要沒寫的不要編；比不出來的格子寫「${NOT_MENTIONED}」。用摘要本身的語言回答。`;

function truncateSection(text) {
  const s = (text || '').trim();
  if (!s) return '';
  return s.length > SECTION_MAX ? `${s.slice(0, SECTION_MAX)}…` : s;
}

/** `《標題》（作者，年份）`；作者／年份缺了就不印那一截，不留空括號。 */
function paperHeading(paper, index) {
  const meta = [paper.authors, paper.year].map(v => `${v ?? ''}`.trim()).filter(Boolean).join('，');
  const title = (paper.title || '').trim() || '未命名論文';
  return `## 論文 ${index + 1}：《${title}》${meta ? `（${meta}）` : ''}`;
}

/**
 * 輸出格式段。table 的 key 必須是 paper_id，所以這裡把「論文 N = <id>」的對照表
 * 明確寫給模型——user 段的標題行維持工單 §3.1 的格式，不塞 id 進去。
 */
function renderOutputSpec(papers) {
  const idMap = papers.map((p, i) => `論文 ${i + 1} = ${p.id}`).join('、');
  const sampleIds = papers.map(p => `"${p.id}": "…"`).join(', ');
  return [
    '### 輸出格式',
    '',
    '嚴格輸出一個 JSON object（不要包在 ```json 標記中），只有 table 與 analysis 兩個 key：',
    '',
    '{',
    `  "table": { ${COMPARE_DIMENSIONS.map(d => `"${d}": {…}`).join(', ')} },`,
    '  "analysis": { "same": ["…"], "differ": ["…"], "conflict": ["…"], "for_her": "…" }',
    '}',
    '',
    `- table 的五個 key 固定是：${COMPARE_DIMENSIONS.join('、')}，一個都不能少。`,
    `- 每個維度底下是「paper_id → 那一格的文字」，paper_id 對照：${idMap}。`,
    `  例如 "${COMPARE_DIMENSIONS[0]}": { ${sampleIds} }。`,
    `- 某篇在某維度比不出來就寫「${NOT_MENTIONED}」，不要省略那個 key、不要編。`,
    '- analysis.same／differ／conflict 是字串陣列：相同之處、相異之處、互相打架之處；沒有就給空陣列。',
    '- conflict 是「兩篇說法矛盾」，有就保留矛盾，不要替它們圓場。',
  ].join('\n');
}

/**
 * 組對比用的 system ＋ user。純函式：不碰 DB、不發請求（工單 §3.1）。
 * @param {object[]} papers 已查好的論文列（含 id / title / authors / year / summary_*）
 * @param {{ directionsBlock?: string }} [opts] directionsBlock 空字串＝沒有方向，一個字都不加
 * @returns {{ system: string, user: string }}
 */
export function buildComparePrompt(papers, { directionsBlock = '' } = {}) {
  const systemParts = [COMPARE_SYSTEM_BASE];

  if (directionsBlock) {
    systemParts.push(directionsBlock);
    systemParts.push(
      'analysis.for_her：一段話，對照上面【她的研究方向】說這組對比對她的題目意味著什麼。'
    );
  } else {
    // 無方向時 for_her 沒有對照對象——明確要求留空，免得模型自己編一個方向出來。
    systemParts.push('本次沒有她的研究方向資訊：analysis.for_her 請給空字串 ""，不要自己猜她在做什麼。');
  }

  systemParts.push(renderOutputSpec(papers));

  const userParts = ['以下是要對比的論文摘要。'];
  for (const [index, paper] of papers.entries()) {
    const lines = [paperHeading(paper, index)];
    for (const [dimension, field] of SECTION_FIELDS) {
      lines.push(`### ${dimension}`);
      lines.push(truncateSection(paper[field]) || NOT_MENTIONED);
    }
    userParts.push(lines.join('\n'));
  }

  return { system: systemParts.join('\n\n'), user: userParts.join('\n\n') };
}

/**
 * 空正文的診斷字串。措辭與 ai.js 的 diagnoseCompletion 同形，只是把「調高」指向對比的旋鈕。
 */
function diagnoseCompare(meta, content) {
  const bits = [`finish_reason=${meta.finishReason ?? '未提供'}`, `content=${content.length} 字`];
  if (meta.reasoning) bits.push(`reasoning_content=${meta.reasoning.length} 字`);
  if (meta.toolCalls.length) bits.push(`tool_calls=${meta.toolCalls.length}`);
  if (meta.usage) bits.push(`usage=${JSON.stringify(meta.usage)}`);
  if (meta.truncated) bits.push('輸出預算用盡（調高 COMPARE_MAX_TOKENS）');
  return bits.join('，');
}

/**
 * 從一次 completion 裡挖出「可能含 JSON 的那段文字」。規則與 analyze／extract 完全一致：
 * 正文沒有 `{…}` 且模型**正常收尾**時才從 reasoning 搶救；被截斷（finish_reason=length /
 * max_tokens）的思考鏈裡躺的是寫壞一半的草稿 JSON，不救。
 */
function extractCompletionSource(config, data) {
  const content = responseText(config, data);
  const meta = completionMeta(config, data);
  const diag = diagnoseCompare(meta, content);

  let source = content;
  if (!/\{[\s\S]*\}/.test(source) && meta.reasoning && !meta.truncated) {
    log('WARN', `[COMPARE] 正文沒有 JSON，改從 reasoning_content 搶救（${diag}）`);
    source = meta.reasoning;
  }

  if (!/\{[\s\S]*\}/.test(source)) {
    throw new Error(`AI 沒有返回可解析的對比結果（${diag}）: ${content.slice(0, 200)}`);
  }
  return source;
}

async function callCompareAPI(config, messages) {
  const url = buildEndpoint(config);
  // scope 固定 'compare'：對比 prompt 的前綴與論文組合無關，不按論文分桶。
  // baseUrl 一定要傳進去，buildHeaders 才判得出是不是 opencode.ai（缺標頭 → 400 MissingSessionID）。
  const headers = buildHeaders({ ...config, scope: 'compare' });
  const body = buildBody(config, {
    messages,
    stream: true, // 躲 OpenCode Go 的 60 秒非串流閘門（與 analyze／extract 同一道修法）
    max_tokens: COMPARE_MAX_TOKENS,
    temperature: 0.2,
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
      throw new Error(`對比請求超時（${Math.round(REQUEST_TIMEOUT_MS / 1000)}s 沒有結果）`);
    }
    throw err;
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Compare API error ${res.status}: ${text.slice(0, 200)}`);
  }

  return extractCompletionSource(config, await collectStream(config, res));
}

function asStringList(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map(v => (typeof v === 'string' ? v : `${v ?? ''}`))
    .map(s => s.trim())
    .filter(Boolean);
}

/**
 * 把模型吐的 JSON 收口成固定形狀（工單 §3.1「解析」）：
 * table 五個維度都要在，每格每篇都要有——缺的補「摘要未提及」；analysis 三陣列缺的補 []。
 * 解析失敗回 null（呼叫端轉 502）。
 * @param {string} raw
 * @param {object[]} papers
 * @returns {{ table: object, analysis: object } | null}
 */
export function parseCompareResponse(raw, papers) {
  let parsed;
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(jsonMatch ? jsonMatch[0].trim() : raw.trim());
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;

  const rawTable = parsed.table && typeof parsed.table === 'object' ? parsed.table : {};
  const table = {};
  for (const dimension of COMPARE_DIMENSIONS) {
    const rawCells = rawTable[dimension] && typeof rawTable[dimension] === 'object'
      ? rawTable[dimension]
      : {};
    const cells = {};
    for (const paper of papers) {
      const cell = rawCells[paper.id];
      const text = typeof cell === 'string' ? cell.trim() : '';
      cells[paper.id] = text || NOT_MENTIONED;
    }
    table[dimension] = cells;
  }

  const rawAnalysis = parsed.analysis && typeof parsed.analysis === 'object' ? parsed.analysis : {};
  const analysis = {
    same: asStringList(rawAnalysis.same),
    differ: asStringList(rawAnalysis.differ),
    conflict: asStringList(rawAnalysis.conflict),
    for_her: typeof rawAnalysis.for_her === 'string' ? rawAnalysis.for_her.trim() : '',
  };

  return { table, analysis };
}

/**
 * 對比一組論文。不快取、不落庫（純計算；她要留就自己存洞察）。
 * @param {object[]} papers 2–4 篇，已確認存在且 analyze_status='done'
 * @returns {Promise<{ table: object, analysis: object, model: string, elapsed_ms: number }>}
 */
export async function comparePapers(papers) {
  const config = getChatConfig();
  // 方向以**第一篇**取：buildDirectionsContext 已經把「她另外還有的方向」寫進同一個區塊，
  // 所以其他篇的方向以「另有」形式天然含在內（工單 §3.1）。
  const { system, user } = buildComparePrompt(papers, {
    directionsBlock: renderDirectionsBlock(papers[0].id),
  });

  const startedAt = Date.now();
  const raw = await callCompareAPI(config, [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]);
  const elapsed_ms = Date.now() - startedAt;

  const parsed = parseCompareResponse(raw, papers);
  if (!parsed) {
    throw new Error(`AI 返回的對比結果不是合法 JSON: ${raw.slice(0, 200)}`);
  }

  return { ...parsed, model: config.model, elapsed_ms };
}
