/**
 * 選段引用（工單 14）——「選一段文字直接問它」的共用規則。
 *
 * 這個檔只有純函式，沒有 DB、沒有 I/O：
 * 送出當輪（`routes/chat.js` 的預設送出）與歷史回放（`getHistory`）**必須走同一個
 * `renderQuotedMessage`**，否則第二輪的 prompt 前綴跟第一輪不一樣，cache 每輪都冷
 * （工單 14 §3.1「規則要跟送出當輪一致」、§5.2 的釘子）。
 *
 * 偏移一律以 `papers.full_text` 原字串為準（工單 13 保證不改它）。後端收到 quote 一定要
 * 先過 `validateQuote`：`full_text.slice(start,end) === text` 不成立就 400，寧可讓她重選
 * 一次，也不要讓前端算錯的偏移悄悄把「別段」餵給模型（§3.1）。
 */

/** 一次最多引用多少字（§3.1）。再長就不是「選一段問它」了。 */
export const QUOTE_MAX_CHARS = 4000;

/** 變動區裡選段前後各取多少字的原文當位置脈絡（§3.2）。 */
export const QUOTE_CONTEXT_RADIUS = 600;

/** 只選了段、沒打問題時替她問的那句（§3.2）。 */
export const DEFAULT_QUOTE_QUESTION = '請解釋這段在說什麼、它在全文裡的作用，以及它與前後文的關係';

/** 每輪都附在 user 訊息尾巴的答題指令（§3.2；憲章不動，工單 13 在改憲章）。 */
export const QUOTE_ANSWER_INSTRUCTION =
  '回答時先引用你依據的原文句子（用「」標出），再說你的理解；原文沒寫的要說是你的推測。';

/** 段落切分的唯一定義：連續兩個以上換行。前端 `fulltext-offsets.js` 用同一條。 */
const PARAGRAPH_SPLIT = /\n{2,}/g;

/**
 * DB 的 `messages.quote`（TEXT，可能是 ''／null／壞 JSON）或前端傳來的物件 → 正規化的 quote。
 * 任何解不出來的東西都回 null（呼叫端當作「這則訊息沒有引用」），絕不拋。
 *
 * @returns {{text: string, start: number, end: number, page: number|null}|null}
 */
export function parseQuote(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  let obj = raw;
  if (typeof raw === 'string') {
    try { obj = JSON.parse(raw); } catch { return null; }
  }
  if (!obj || typeof obj !== 'object') return null;
  const text = typeof obj.text === 'string' ? obj.text : null;
  const start = Number(obj.start);
  const end = Number(obj.end);
  if (text === null || !Number.isInteger(start) || !Number.isInteger(end)) return null;
  return {
    text,
    start,
    end,
    page: Number.isInteger(obj.page) ? obj.page : null,
  };
}

/**
 * 後端的硬閘門（§3.1）。
 *
 * @param {string} fullText `papers.full_text` 原字串
 * @param {any} raw 前端送來的 quote
 * @returns {{ok: true, quote: object} | {ok: false, error: string}}
 */
export function validateQuote(fullText, raw) {
  const quote = parseQuote(raw);
  if (!quote) return { ok: false, error: '引用格式不正確' };

  const source = typeof fullText === 'string' ? fullText : '';
  const { text, start, end } = quote;

  if (!text.trim()) return { ok: false, error: '引用內容為空' };
  if (start < 0 || end <= start) return { ok: false, error: '引用範圍不合法' };
  if (end - start > QUOTE_MAX_CHARS) {
    return { ok: false, error: `引用最多 ${QUOTE_MAX_CHARS} 字，這次選了 ${end - start} 字` };
  }
  if (end > source.length) return { ok: false, error: '引用範圍超出原文長度' };
  // 這一條才是真正的閘門：偏移算錯時 slice 出來的是別段，寧可 400 也不要悄悄問錯地方。
  if (source.slice(start, end) !== text) {
    return { ok: false, error: '選取內容與原文不一致' };
  }

  return { ok: true, quote: { text, start, end, page: quote.page ?? null } };
}

/**
 * 這個偏移落在第幾段（1-based，顯示用的近似值）。
 * 規則：以 `\n{2,}` 切段、跳過全空白的段，數「開頭在 offset 之前（含）」的段有幾個。
 */
export function paragraphIndexAt(fullText, offset) {
  if (typeof fullText !== 'string' || !fullText) return 1;
  const target = Math.max(0, Math.min(offset, fullText.length));
  const re = new RegExp(PARAGRAPH_SPLIT.source, 'g');
  let count = 0;
  let pos = 0;
  let m;
  const bump = (segStart, segEnd) => {
    if (!fullText.slice(segStart, segEnd).trim()) return;
    if (segStart <= target) count += 1;
  };
  while ((m = re.exec(fullText)) !== null) {
    bump(pos, m.index);
    pos = m.index + m[0].length;
    if (pos > target) break;
  }
  if (pos <= target) bump(pos, fullText.length);
  return Math.max(1, count);
}

/** 顯示用的字元範圍：偏移是 0-based [start,end)，人看的是 1-based 閉區間。 */
export function formatQuoteRange(quote) {
  return `${quote.start + 1}–${quote.end}`;
}

/** 引用原文排成 markdown 引言（多行也要每行帶 `> `）。 */
function blockquote(text) {
  return text.split('\n').map(line => `> ${line}`).join('\n');
}

/**
 * 送給模型的那一則 user 訊息（§3.2）。
 *
 * **送出當輪與歷史回放共用這一顆**——輸出只依賴 (quote, message, fullText)，
 * 三者都不會變，所以同一輪在第 N 次回放時逐字相同（§5.2）。
 *
 * @param {object|null} quote 已經過 validateQuote 的 quote
 * @param {string} message 她打的字（可能是空字串）
 * @param {string} fullText 用來算「約第幾段」
 */
export function renderQuotedMessage(quote, message, fullText) {
  // 沒有引用時原樣回傳（**不 trim**）——沒選段的那些輪，送出的字串要與工單 14 之前逐字相同。
  if (!quote) return message || '';
  const typed = (message || '').trim();

  const paragraph = paragraphIndexAt(fullText, quote.start);
  const question = typed || DEFAULT_QUOTE_QUESTION;

  return [
    `【引用原文（全文第 ${formatQuoteRange(quote)} 字，約第 ${paragraph} 段）】`,
    blockquote(quote.text),
    '',
    question,
    '',
    `（${QUOTE_ANSWER_INSTRUCTION}）`,
  ].join('\n');
}

/**
 * 變動區的位置脈絡（§3.2）：選段前後各 600 字的原文。
 *
 * 接在 `insightText` 之後——**絕不能進穩定前綴**（憲章＋論文區塊），那兩塊逐字不變
 * 才有 prompt cache 可命中（§4 紅線）。
 *
 * @returns {string} 沒有 quote 或沒有前後文時回空字串（呼叫端直接串接，不必判斷）
 */
export function buildQuoteContextBlock(fullText, quote, { radius = QUOTE_CONTEXT_RADIUS } = {}) {
  if (!quote) return '';
  const source = typeof fullText === 'string' ? fullText : '';
  if (!source) return '';

  const beforeStart = Math.max(0, quote.start - radius);
  const before = source.slice(beforeStart, quote.start);
  const after = source.slice(quote.end, Math.min(source.length, quote.end + radius));

  const parts = [
    `\n\n她這一輪引用的是全文第 ${formatQuoteRange(quote)} 字`
    + `（約第 ${paragraphIndexAt(source, quote.start)} 段）。以下是那一段在原文裡的位置脈絡，`
    + '用來判斷它在講什麼、承接什麼：',
  ];
  if (before.trim()) {
    parts.push(`【選段前文】\n${beforeStart > 0 ? '…' : ''}${before}`);
  } else {
    parts.push('【選段前文】（這段就在全文開頭，前面沒有內容）');
  }
  if (after.trim()) {
    parts.push(`【選段後文】\n${after}${quote.end + radius < source.length ? '…' : ''}`);
  } else {
    parts.push('【選段後文】（這段已經到全文結尾，後面沒有內容）');
  }
  return parts.join('\n');
}

/** `[CHAT] start` 那行的 `quote=` 欄（§3.4）。 */
export function quoteLogLabel(quote) {
  return quote ? `${quote.end - quote.start}字` : 'none';
}
