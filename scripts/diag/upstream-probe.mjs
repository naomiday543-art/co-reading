// 討論線真上游探針 —— 量 TTFT / 首個正文字 / 總時長 / chunk 數 / usage（含 cache hit）。
// 只讀她 DB 的唯讀副本取設定與論文；不經過 :3456；不寫任何她的檔案。
// 用法：node upstream-probe.mjs <shot: full|repeat|short> [paperId]
const SRC = process.env.CR_SRC || '/Users/laine/research-stack/co-reading/src';
const db = (await import(`${SRC}/db.js`)).default;
const { getSettings } = await import(`${SRC}/db.js`);
const { loadConstitution } = await import(`${SRC}/constitution.js`);
const { buildDirectionsContext } = await import(`${SRC}/directions.js`);
const { buildChatSystem, buildPaperBlock } = await import(`${SRC}/ai.js`);
const { opencodeSessionHeaders } = await import(`${SRC}/opencodeSession.js`);

const shot = process.argv[2] || 'full';
const paperId = process.argv[3] || '1XLeFeTWvPJO58Tvqyq7g';
const s = getSettings();
const baseUrl = s.ai_base_url, model = s.ai_model, key = s.ai_api_key;
const paper = db.prepare('SELECT * FROM papers WHERE id = ?').get(paperId);

const constitution = loadConstitution().text;
const directions = buildDirectionsContext(paper.id);
let system = buildChatSystem(paper, { constitution, format: 'openai', directionsBlock: directions.block });
if (shot === 'short') {
  // 對照組：論文全文砍到 20k 字（其餘一字不動），看首字等待是不是 prefill 主導
  const shortPaper = { ...paper, full_text: paper.full_text.slice(0, 20000) };
  system = buildChatSystem(shortPaper, { constitution, format: 'openai', directionsBlock: directions.block });
}
let userMessage = '用一句話說這篇在做什麼';
if (shot === 'warm-long') {
  // 前綴一字不動（＝shot 1 已經熱的那段），只換長問題：把 cache 效應與 decode 分開。
  userMessage = '請用大約 800 字，說明這篇論文的方法與主要結果。';
}
if (shot === 'cold-long') {
  // 前綴最前面塞一顆 nonce ⇒ 整段 26k token 前綴必定 cache miss（＝她上傳後問第一句的真實形狀），
  // 同時要一段長答案，好把 prefill 與 decode 兩段分開量。
  system = `[probe-nonce ${Date.now()}]\n` + system;
  userMessage = '請用大約 800 字，說明這篇論文的方法與主要結果。';
}

const body = {
  model,
  messages: [{ role: 'system', content: system }, { role: 'user', content: userMessage }],
  max_tokens: 4096,
  stream: true,
  temperature: 0.3,
  stream_options: { include_usage: true },
};
const headers = {
  'Content-Type': 'application/json',
  Authorization: `Bearer ${key}`,
  ...opencodeSessionHeaders(baseUrl, `paper:${paper.id}`),
};
const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;

console.log(`[probe ${shot}] model=${model} system=${system.length}字 (~${Math.round(system.length / 3.9)}tok) url=${url}`);

const t0 = Date.now();
const el = () => ((Date.now() - t0) / 1000).toFixed(2);
let res;
try {
  res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(300000) });
} catch (e) {
  console.log(`[probe ${shot}] FETCH FAIL @${el()}s: ${e.name} ${e.message} cause=${e.cause?.code || ''}`);
  process.exit(2);
}
const tHeaders = el();
console.log(`[probe ${shot}] headers @${tHeaders}s status=${res.status}`);
if (!res.ok) {
  console.log(`[probe ${shot}] BODY: ${(await res.text()).slice(0, 600)}`);
  process.exit(3);
}

const reader = res.body.getReader();
const dec = new TextDecoder();
let buf = '', rawChunks = 0, sseEvents = 0, contentChunks = 0, reasoningChunks = 0;
let content = '', reasoning = '', usage = null, finish = null;
let tFirstByte = null, tFirstSSE = null, tFirstReasoning = null, tFirstContent = null, tLastContent = null;
let maxGap = 0, lastAt = Date.now();

while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  const now = Date.now();
  maxGap = Math.max(maxGap, now - lastAt); lastAt = now;
  rawChunks++;
  if (tFirstByte === null) tFirstByte = el();
  buf += dec.decode(value, { stream: true });
  const lines = buf.split('\n'); buf = lines.pop() || '';
  for (const line of lines) {
    const t = line.trim();
    if (!t.startsWith('data: ')) continue;
    const d = t.slice(6);
    if (d === '[DONE]') continue;
    let j; try { j = JSON.parse(d); } catch { continue; }
    sseEvents++;
    if (tFirstSSE === null) tFirstSSE = el();
    const delta = j.choices?.[0]?.delta || {};
    if (delta.reasoning_content) {
      reasoningChunks++; reasoning += delta.reasoning_content;
      if (tFirstReasoning === null) tFirstReasoning = el();
    }
    if (delta.content) {
      contentChunks++; content += delta.content;
      if (tFirstContent === null) tFirstContent = el();
      tLastContent = el();
    }
    if (j.choices?.[0]?.finish_reason) finish = j.choices[0].finish_reason;
    if (j.usage) usage = j.usage;
  }
}
const tEnd = el();
console.log(JSON.stringify({
  shot, systemChars: system.length,
  t_headers_s: Number(tHeaders), t_first_byte_s: Number(tFirstByte), t_first_sse_s: Number(tFirstSSE),
  t_first_reasoning_s: tFirstReasoning && Number(tFirstReasoning),
  t_first_content_s: tFirstContent && Number(tFirstContent),
  t_last_content_s: tLastContent && Number(tLastContent),
  t_end_s: Number(tEnd),
  raw_chunks: rawChunks, sse_events: sseEvents, reasoning_chunks: reasoningChunks, content_chunks: contentChunks,
  reasoning_chars: reasoning.length, content_chars: content.length,
  max_gap_ms: maxGap, finish, usage,
}, null, 2));
console.log(`[probe ${shot}] content head: ${content.slice(0, 120).replace(/\n/g, ' ')}`);
