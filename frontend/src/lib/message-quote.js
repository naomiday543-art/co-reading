/**
 * 「選 AI 回覆的一段來追問」的純函式層（工單 19 §2.2／§2.4）。
 *
 * 跟閱讀模式那條線（`fulltext-offsets.js`）的差別只有一個：論文原文是我們自己
 * 排出來的段落，每段都釘得住 `data-cr-offset`；AI 氣泡是 `ReactMarkdown` 渲染的，
 * DOM 長什麼樣不由我們決定，**釘不了偏移**。所以這裡改用「字串比對」：
 * 拿 `selection.toString()` 去 `plainText(content)` 裡找，**唯一命中才算數**——
 * 命中兩次以上就請她多選幾個字（工單 §2.2 二選一，選這個，附錄有記）。
 *
 * 兩條規矩：
 * 1. 送出的引用文字一律是 `plain.slice(start,end)`，**不是** `selection.toString()`
 *    ——後端驗的是投影上的 `slice(start,end) === text`（同 `fulltext-offsets.js` 規矩 2）。
 * 2. 這個檔不碰 `window`／`document`，只碰節點的 `nodeType/getAttribute/parentNode`，
 *    所以 node:test 裡用一顆假 DOM 就能釘死。
 */
import { plainText } from './markdown-plain.js';
import { assistantTurnOf, formatQuoteRange } from '../../../src/quote.js';

export { plainText, assistantTurnOf };

const ELEMENT_NODE = 1;

/** AI 氣泡外面那層容器的屬性名：值是那則訊息的 id。 */
export const MSG_ID_ATTR = 'data-cr-msg-id';

/** 少於這個字數不彈「問這段」（與閱讀模式同一個門檻）。 */
export const MIN_MESSAGE_SELECTION_CHARS = 8;

/** 多次命中時給她的那句（§2.2）。 */
export const AMBIGUOUS_HINT = '這段字在這則回覆裡出現不只一次，多選幾個字再試';
/** 對不上投影時給她的那句（例如選取跨了表格／程式碼圍欄的邊界）。 */
export const NOT_FOUND_HINT = '這段選取對不上回覆的原文，換個選法（避開表格邊界）再試';
/** 選太少。 */
export const TOO_SHORT_HINT = `選 ${MIN_MESSAGE_SELECTION_CHARS} 字以上才能問這段`;

/** 往上找最近一個帶 `data-cr-msg-id` 的祖先（含自己），回傳那則訊息的 id。 */
export function closestMessageId(node) {
  let cur = node;
  while (cur) {
    if (cur.nodeType === ELEMENT_NODE && typeof cur.getAttribute === 'function') {
      const id = cur.getAttribute(MSG_ID_ATTR);
      if (id) return id;
    }
    cur = cur.parentNode;
  }
  return null;
}

/** 這個理由該對她說哪一句。 */
export function selectionHint(reason) {
  if (reason === 'ambiguous') return AMBIGUOUS_HINT;
  if (reason === 'tooShort') return TOO_SHORT_HINT;
  return NOT_FOUND_HINT;
}

/** 空白一律壓成一格，同時記住每個字回到原字串的 [start, end)。 */
function normalizeWithMap(s) {
  const chars = [];
  const starts = [];
  const ends = [];
  let i = 0;
  while (i < s.length) {
    if (/\s/.test(s[i])) {
      let j = i;
      while (j < s.length && /\s/.test(s[j])) j += 1;
      chars.push(' ');
      starts.push(i);
      ends.push(j);
      i = j;
    } else {
      chars.push(s[i]);
      starts.push(i);
      ends.push(i + 1);
      i += 1;
    }
  }
  return { norm: chars.join(''), starts, ends };
}

/** 前三個命中就夠判斷唯一性了，整篇掃完沒有意義。 */
function firstFewIndexes(hay, needle, limit = 3) {
  const out = [];
  let i = hay.indexOf(needle);
  while (i !== -1 && out.length < limit) {
    out.push(i);
    i = hay.indexOf(needle, i + 1);
  }
  return out;
}

/**
 * 在純文字投影裡定位一段選取（§2.2）。
 *
 * 先照原樣找；找不到才退一步用「空白壓成一格」的版本再找一次——瀏覽器把
 * markdown 的軟換行渲染成空白、表格儲存格之間塞 tab，`selection.toString()`
 * 的空白跟投影天生就會差一點，但**字**是一樣的。
 *
 * @returns {{ok: true, start: number, end: number, text: string}
 *          | {ok: false, reason: 'empty'|'tooShort'|'ambiguous'|'notFound'}}
 */
export function locateInPlain(plain, selected, { minChars = MIN_MESSAGE_SELECTION_CHARS } = {}) {
  if (typeof plain !== 'string' || !plain) return { ok: false, reason: 'empty' };
  const needle = (typeof selected === 'string' ? selected : '').replace(/^\s+|\s+$/g, '');
  if (!needle) return { ok: false, reason: 'empty' };
  if (needle.replace(/\s+/g, '').length < minChars) return { ok: false, reason: 'tooShort' };

  const exact = firstFewIndexes(plain, needle);
  if (exact.length === 1) {
    const start = exact[0];
    const end = start + needle.length;
    return { ok: true, start, end, text: plain.slice(start, end) };
  }
  if (exact.length > 1) return { ok: false, reason: 'ambiguous' };

  const hay = normalizeWithMap(plain);
  const nee = normalizeWithMap(needle);
  const hits = firstFewIndexes(hay.norm, nee.norm);
  if (hits.length === 0) return { ok: false, reason: 'notFound' };
  if (hits.length > 1) return { ok: false, reason: 'ambiguous' };

  const start = hay.starts[hits[0]];
  const end = hay.ends[hits[0] + nee.norm.length - 1];
  return { ok: true, start, end, text: plain.slice(start, end) };
}

/**
 * 一次氣泡選取 → 可以直接送後端的 quote（§2.1 的第二型）。
 *
 * `turn` 只給畫面用（引用卡上的「第 N 輪」）；後端的 `parseQuote` 會把它丟掉，
 * 輪次一律由後端自己從 seq 反推，兩邊不會各算各的。
 *
 * @returns {{ok: true, quote: object} | {ok: false, reason: string}}
 */
export function resolveMessageSelectionQuote({ selectedText, messageId, content, turn = null }) {
  if (!messageId) return { ok: false, reason: 'empty' };
  const hit = locateInPlain(plainText(content), selectedText);
  if (!hit.ok) return hit;
  return {
    ok: true,
    quote: {
      source: 'message',
      message_id: messageId,
      text: hit.text,
      start: hit.start,
      end: hit.end,
      turn,
    },
  };
}

/** 引用卡／氣泡引用塊上那一行小字（§2.4）：兩種來源兩種文案。 */
export function quoteCardLabel(quote, turn = null) {
  if (!quote) return '';
  if (quote.source === 'message') {
    const n = Number.isInteger(turn) && turn > 0 ? turn : quote.turn;
    return Number.isInteger(n) && n > 0 ? `引用 AI 回答 · 第 ${n} 輪` : '引用 AI 回答';
  }
  return `引用原文 · 第 ${formatQuoteRange(quote)} 字`;
}

/** 引用塊上那顆連結的字：論文回原文，回答回那則訊息（§2.4）。 */
export function quoteJumpLabel(quote) {
  return quote?.source === 'message' ? '跳回那則回答' : '跳回原文';
}
