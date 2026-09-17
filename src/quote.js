/**
 * 選段引用（工單 14；工單 19 加上「引用 AI 先前的回覆」）——共用規則。
 *
 * 這個檔只有純函式，沒有 DB、沒有 I/O：
 * 送出當輪（`routes/chat.js` 的預設送出）與歷史回放（`getHistory`）**必須走同一個
 * `renderQuotedMessage`**，否則第二輪的 prompt 前綴跟第一輪不一樣，cache 每輪都冷
 * （工單 14 §3.1「規則要跟送出當輪一致」、§5.2 的釘子）。
 *
 * **兩種來源，一套骨架**（工單 19 §2.1）：
 * - `source` 缺省（＝`'paper'`）：偏移以 `papers.full_text` 原字串為準（工單 13 保證不改它）。
 *   這一型的行為、DB 裡存的 JSON、送給模型的字串，與工單 14 **逐字相同**（§3 紅線），
 *   所以正規化後的物件**刻意不塞 `source: 'paper'` 這個鍵**——缺省就是缺省。
 * - `source: 'message'`：偏移以那則 assistant 回覆 `content` 的**純文字投影**為準
 *   （`markdownPlain.js`），不是原始 markdown；另外必帶 `message_id`。
 *
 * 後端收到 quote 一定要先過 `validateQuote`：`sourceText.slice(start,end) === text`
 * 不成立就 400，寧可讓她重選一次，也不要讓前端算錯的偏移悄悄把「別段」餵給模型（§3.1）。
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

/** 引用 AI 自己先前回答那一型的答題指令（工單 19 §2.3）。 */
export const QUOTE_REPLY_ANSWER_INSTRUCTION =
  '回答時先說明你先前那句話的意思與依據，再回應她的問題；若先前說錯了，直接承認並更正。';

/** 引用了 AI 的回答、卻一個字都沒打時替她問的那句（工單 19；對應 `DEFAULT_QUOTE_QUESTION`）。 */
export const DEFAULT_REPLY_QUOTE_QUESTION = '請說明你這段話的意思，以及你是根據論文裡的什麼這樣說的';

/** 引用 AI 回答時，變動區最多放多少字的那則回答全文（§2.3）。 */
export const QUOTE_MESSAGE_CONTEXT_MAX = 2000;

/** 那則回答超過上限時，改取選段前後各多少字（§2.3）。 */
export const QUOTE_MESSAGE_CONTEXT_RADIUS = 800;

/** 變動區裡「她當時問的那句」最多放多少字（§2.3）。 */
export const QUOTE_MESSAGE_QUESTION_MAX = 300;

/** quote 的來源：沒寫就是引用論文原文（工單 14 的唯一形狀）。 */
export function quoteSource(quote) {
  return quote && quote.source === 'message' ? 'message' : 'paper';
}

/** 段落切分的唯一定義：連續兩個以上換行。前端 `fulltext-offsets.js` 用同一條。 */
const PARAGRAPH_SPLIT = /\n{2,}/g;

/**
 * DB 的 `messages.quote`（TEXT，可能是 ''／null／壞 JSON）或前端傳來的物件 → 正規化的 quote。
 * 任何解不出來的東西都回 null（呼叫端當作「這則訊息沒有引用」），絕不拋。
 *
 * 來源（工單 19 §2.1）：`source: 'message'` 時**必須**帶得出 `message_id`，否則一律
 * 當成解不出來。其它值（含缺省、`'paper'`、亂填）一律是論文原文那一型，而且
 * **回傳的物件不帶 `source` 鍵**——工單 14 存進 DB 的 JSON 形狀要逐字不變（§3 紅線）。
 *
 * @returns {{text: string, start: number, end: number, page: number|null,
 *            source?: 'message', message_id?: string}|null}
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

  const base = {
    text,
    start,
    end,
    page: Number.isInteger(obj.page) ? obj.page : null,
  };

  if (obj.source === 'message') {
    const messageId = typeof obj.message_id === 'string' ? obj.message_id.trim() : '';
    if (!messageId) return null;
    return { ...base, source: 'message', message_id: messageId };
  }
  return base;
}

/**
 * 後端的硬閘門（§3.1；工單 19 §2.2 把「原文」換成「來源文字」）。
 *
 * @param {string} sourceText 偏移的基準字串——`paper` 來源是 `papers.full_text`，
 *        `message` 來源是 `plainText(那則 assistant 回覆的 content)`。**呼叫端決定**，
 *        這顆函式不碰 DB。
 * @param {any} raw 前端送來的 quote
 * @returns {{ok: true, quote: object} | {ok: false, error: string}}
 */
export function validateQuote(sourceText, raw) {
  const quote = parseQuote(raw);
  if (!quote) return { ok: false, error: '引用格式不正確' };

  const source = typeof sourceText === 'string' ? sourceText : '';
  const { text, start, end } = quote;
  const isMessage = quoteSource(quote) === 'message';

  if (!text.trim()) return { ok: false, error: '引用內容為空' };
  if (start < 0 || end <= start) return { ok: false, error: '引用範圍不合法' };
  if (end - start > QUOTE_MAX_CHARS) {
    return { ok: false, error: `引用最多 ${QUOTE_MAX_CHARS} 字，這次選了 ${end - start} 字` };
  }
  if (end > source.length) {
    return { ok: false, error: isMessage ? '引用範圍超出回答長度' : '引用範圍超出原文長度' };
  }
  // 這一條才是真正的閘門：偏移算錯時 slice 出來的是別段，寧可 400 也不要悄悄問錯地方。
  if (source.slice(start, end) !== text) {
    return {
      ok: false,
      error: isMessage ? '選取內容與回答原文不一致' : '選取內容與原文不一致',
    };
  }

  const normalized = { text, start, end, page: quote.page ?? null };
  if (isMessage) {
    normalized.source = 'message';
    normalized.message_id = quote.message_id;
  }
  return { ok: true, quote: normalized };
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

/**
 * 「第幾輪」的唯一定義（工單 19 §2.3）：這則 assistant 訊息是**第幾則 assistant**，
 * 依 `seq` 排序數，1-based。user 訊息與找不到的 id 都回 null。
 *
 * 前後端共用這一顆（前端畫引用卡的「第 N 輪」、後端組 prompt 前綴），
 * 兩邊數出來的輪次才會是同一個數字。
 *
 * @param {Array<{id: string, role: string}>} messages 依 seq 排好的訊息
 */
export function assistantTurnOf(messages, messageId) {
  if (!Array.isArray(messages) || !messageId) return null;
  let n = 0;
  for (const m of messages) {
    if (m.role !== 'assistant') continue;
    n += 1;
    if (m.id === messageId) return n;
  }
  return null;
}

/** 一次算完整串的輪次（`id → 第 N 輪`），歷史回放時不必每則各掃一遍。 */
export function assistantTurnMap(messages) {
  const map = new Map();
  if (!Array.isArray(messages)) return map;
  let n = 0;
  for (const m of messages) {
    if (m.role !== 'assistant') continue;
    n += 1;
    map.set(m.id, n);
  }
  return map;
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
 * 送給模型的那一則 user 訊息（§3.2；工單 19 §2.3 加上第二型前綴）。
 *
 * **送出當輪與歷史回放共用這一顆**——輸出只依賴 (quote, message, fullText, turn)，
 * 四者都不會變，所以同一輪在第 N 次回放時逐字相同（§5.2）。
 *
 * @param {object|null} quote 已經過 validateQuote 的 quote
 * @param {string} message 她打的字（可能是空字串）
 * @param {string} fullText 用來算「約第幾段」（`message` 來源時用不到）
 * @param {{turn?: number|null}} [opts] `message` 來源時那則回答是第幾輪（算不出來就省略）
 */
export function renderQuotedMessage(quote, message, fullText, { turn = null } = {}) {
  // 沒有引用時原樣回傳（**不 trim**）——沒選段的那些輪，送出的字串要與工單 14 之前逐字相同。
  if (!quote) return message || '';
  const typed = (message || '').trim();

  if (quoteSource(quote) === 'message') {
    const header = Number.isInteger(turn) && turn > 0
      ? `【引用你先前的回答（第 ${turn} 輪）】`
      : '【引用你先前的回答】';
    return [
      header,
      blockquote(quote.text),
      '',
      typed || DEFAULT_REPLY_QUOTE_QUESTION,
      '',
      `（${QUOTE_REPLY_ANSWER_INSTRUCTION}）`,
    ].join('\n');
  }

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
export function buildQuoteContextBlock(sourceText, quote, {
  radius = QUOTE_CONTEXT_RADIUS,
  userQuestion = '',
  turn = null,
} = {}) {
  if (!quote) return '';
  const source = typeof sourceText === 'string' ? sourceText : '';
  if (!source) return '';

  if (quoteSource(quote) === 'message') {
    return buildReplyContextBlock(source, quote, { userQuestion, turn });
  }

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

/**
 * 引用 AI 回答時的變動區脈絡（工單 19 §2.3）。
 *
 * 跟 `paper` 那一支不同：論文原文是「一大片、只能給前後」，一則回答卻**整段就是脈絡**，
 * 所以 ≤2,000 字直接整段給；真的很長才退回選段前後各 800 字。再附上她當時問的那句
 * （≤300 字），模型才知道自己那段話是在回答什麼。
 *
 * @param {string} replyPlain 那則 assistant 回覆的純文字投影（偏移的基準）
 */
function buildReplyContextBlock(replyPlain, quote, { userQuestion = '', turn = null } = {}) {
  const turnLabel = Number.isInteger(turn) && turn > 0 ? `你第 ${turn} 輪的回答` : '你先前的回答';

  let body;
  if (replyPlain.length <= QUOTE_MESSAGE_CONTEXT_MAX) {
    body = replyPlain;
  } else {
    const from = Math.max(0, quote.start - QUOTE_MESSAGE_CONTEXT_RADIUS);
    const to = Math.min(replyPlain.length, quote.end + QUOTE_MESSAGE_CONTEXT_RADIUS);
    body = `${from > 0 ? '…' : ''}${replyPlain.slice(from, to)}${to < replyPlain.length ? '…' : ''}`;
  }

  const question = (userQuestion || '').trim();
  const parts = [
    `\n\n她這一輪引用的是${turnLabel}裡的一段（那則回答的第 ${formatQuoteRange(quote)} 字）。`
    + '以下是那則回答的原文，用來判斷你當時說了什麼、依據是什麼：',
    `【被引用回答的上下文】\n${body}`,
  ];
  if (question) {
    const trimmed = question.length > QUOTE_MESSAGE_QUESTION_MAX
      ? `${question.slice(0, QUOTE_MESSAGE_QUESTION_MAX)}…`
      : question;
    parts.push(`【那一輪她問的是】\n${trimmed}`);
  } else {
    parts.push('【那一輪她問的是】（那一輪她只選了一段、沒有另外打字）');
  }
  return parts.join('\n');
}

/** `[CHAT] start` 那行的 `quote=` 欄（§3.4；工單 19 §2.4 加上來源）。 */
export function quoteLogLabel(quote) {
  return quote ? `${quoteSource(quote)}:${quote.end - quote.start}字` : 'none';
}
