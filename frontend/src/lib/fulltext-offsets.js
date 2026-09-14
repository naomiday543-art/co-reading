/**
 * 閱讀模式的「選取 → `full_text` 字元偏移」映射（工單 14 §3.3）。
 *
 * 為什麼需要一層映射：文字版閱讀是把 `paper.full_text` 依 `\n{2,}` 切成段、每段一個
 * `<p>`。段與段之間的分隔字元（那幾個換行）**沒有任何 DOM 節點**，所以
 * 「這個 <p> 裡的第 N 個字」不等於「全文的第 N 個字」——必須把每段的起始偏移
 * 釘在 DOM 上（`data-cr-offset`），再用「段起點 ＋ 段內位移」把兩邊接起來。
 *
 * 三條規矩：
 * 1. 段落切分**不清洗文字**：`text === fullText.slice(start, end)` 永遠成立，
 *    後端 `slice(start,end) === text` 那道閘門才過得去。
 * 2. 送出的引用文字一律是 `fullText.slice(start,end)`，**不是** `selection.toString()`
 *    ——跨段落時瀏覽器給的字串少了段間的換行，直接送會被後端 400。
 * 3. 這裡只碰 `nodeType/nodeValue/childNodes/parentNode/getAttribute`，不碰
 *    `document`／`TreeWalker`／`window`，所以 node:test 裡用一顆假 DOM 就能釘死。
 */

const TEXT_NODE = 3;
const ELEMENT_NODE = 1;

/** 段落錨點的屬性名：值是這一段在 `full_text` 裡的起始偏移。 */
export const OFFSET_ATTR = 'data-cr-offset';

/** 少於這個字數不彈「問這段」（§3.3）——手滑點一下不該跳出按鈕。 */
export const MIN_SELECTION_CHARS = 8;

/**
 * `full_text` → 可渲染的段落（每段帶原字串裡的 [start, end)）。
 *
 * 空白段（只有換行／空格）跳過不渲染，但**偏移照樣往前走**，所以被跳過的字不會
 * 讓後面每一段偏移錯位。
 *
 * @param {string} fullText
 * @returns {Array<{start: number, end: number, text: string}>}
 */
export function buildParagraphs(fullText) {
  if (typeof fullText !== 'string' || !fullText) return [];
  const out = [];
  const re = /\n{2,}/g;
  let pos = 0;
  let m;
  const push = (start, end) => {
    const text = fullText.slice(start, end);
    if (!text.trim()) return;
    out.push({ start, end, text });
  };
  while ((m = re.exec(fullText)) !== null) {
    push(pos, m.index);
    pos = m.index + m[0].length;
  }
  push(pos, fullText.length);
  return out;
}

/** 往上找最近一個帶 `data-cr-offset` 的祖先（含自己），回傳 [元素, 段起始偏移]。 */
function closestAnchor(node) {
  let cur = node;
  while (cur) {
    if (cur.nodeType === ELEMENT_NODE && typeof cur.getAttribute === 'function') {
      const raw = cur.getAttribute(OFFSET_ATTR);
      if (raw !== null && raw !== undefined && raw !== '') {
        const start = Number(raw);
        if (Number.isInteger(start) && start >= 0) return [cur, start];
      }
    }
    cur = cur.parentNode;
  }
  return [null, null];
}

/**
 * 段內位移：`root` 底下依序數文字節點，數到 (node, offset) 為止有幾個字。
 * `node` 是元素時，`offset` 是子節點索引（Range 的語意），數前 offset 個子節點的文字。
 *
 * @returns {number|null} 找不到那個節點（不在 root 底下）時回 null
 */
function localOffset(root, node, offset) {
  let count = 0;
  let found = false;

  const walk = (current) => {
    if (found) return;
    if (current === node) {
      if (current.nodeType === TEXT_NODE) {
        count += Math.max(0, Math.min(offset, (current.nodeValue || '').length));
        found = true;
        return;
      }
      // 元素：offset 是「第幾個子節點之前」
      const kids = current.childNodes || [];
      for (let i = 0; i < Math.min(offset, kids.length); i += 1) walk2(kids[i]);
      found = true;
      return;
    }
    if (current.nodeType === TEXT_NODE) {
      count += (current.nodeValue || '').length;
      return;
    }
    const kids = current.childNodes || [];
    for (let i = 0; i < kids.length && !found; i += 1) walk(kids[i]);
  };

  // 整棵子樹的字數（給「元素 + 子節點索引」那一支用，不再比對 node）
  const walk2 = (current) => {
    if (current.nodeType === TEXT_NODE) {
      count += (current.nodeValue || '').length;
      return;
    }
    const kids = current.childNodes || [];
    for (let i = 0; i < kids.length; i += 1) walk2(kids[i]);
  };

  walk(root);
  return found ? count : null;
}

/**
 * 一個選取端點 (node, offset) → `full_text` 的絕對偏移。
 * @returns {number|null} 端點不在任何段落錨點裡（例如她選到頁面別處）時回 null
 */
export function resolveEndpointOffset(node, offset) {
  if (!node) return null;
  const [anchor, paragraphStart] = closestAnchor(node);
  if (!anchor) return null;
  const local = localOffset(anchor, node, offset);
  if (local === null) return null;
  return paragraphStart + local;
}

/**
 * 一次選取 → `{ text, start, end }`（可直接送後端），不合格回 null。
 *
 * 傳進來的是 `window.getSelection()` 的四個欄位（或測試裡的假物件），
 * 不是 Selection 物件本身——這樣這顆函式在 node 裡也跑得動。
 *
 * @param {{anchorNode: any, anchorOffset: number, focusNode: any, focusOffset: number}} sel
 * @param {string} fullText
 * @param {{minChars?: number, maxChars?: number}} [opts]
 */
export function resolveSelectionQuote(sel, fullText, { minChars = MIN_SELECTION_CHARS, maxChars = 4000 } = {}) {
  if (!sel || typeof fullText !== 'string') return null;
  const a = resolveEndpointOffset(sel.anchorNode, sel.anchorOffset);
  const b = resolveEndpointOffset(sel.focusNode, sel.focusOffset);
  if (a === null || b === null) return null;

  const start = Math.min(a, b);
  const end = Math.max(a, b);
  if (end <= start) return null;
  if (start < 0 || end > fullText.length) return null;

  // 引用文字一律從原文切（見檔頭規矩 2）：跨段落時 selection.toString() 會少掉段間換行。
  const text = fullText.slice(start, end);
  if (text.trim().length < minChars) return null;
  if (end - start > maxChars) return null;

  return { text, start, end };
}

/** 引用卡上那句「第 S–E 字」——與後端 `formatQuoteRange` 同一個口徑（1-based 閉區間）。 */
export function formatRange(quote) {
  if (!quote) return '';
  return `第 ${quote.start + 1}–${quote.end} 字`;
}

/** 引用卡／氣泡上的縮寫（§3.3：前 120 字）。 */
export function quotePreview(text, limit = 120) {
  const s = (text || '').replace(/\s+/g, ' ').trim();
  return s.length > limit ? `${s.slice(0, limit)}…` : s;
}

/** 這個偏移落在哪一段（回傳 `buildParagraphs` 的索引，找不到回 -1）——跳回原文用。 */
export function paragraphIndexOfOffset(paragraphs, offset) {
  if (!Array.isArray(paragraphs) || paragraphs.length === 0) return -1;
  for (let i = 0; i < paragraphs.length; i += 1) {
    if (offset < paragraphs[i].end) return i;
  }
  return paragraphs.length - 1;
}
