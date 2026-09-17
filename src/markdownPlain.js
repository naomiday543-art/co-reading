/**
 * Markdown → 純文字投影（工單 19 §2.2）。
 *
 * 為什麼要有這一層：AI 的回覆存在 `messages.content` 裡是 **markdown 原字串**，
 * 但畫面上是 `ReactMarkdown` 渲染後的樣子——`**粗體**` 在畫面上只有兩個字，
 * `## 標題` 前面那兩個井號根本不存在。她在氣泡上選的是「畫面上的字」，
 * 所以引用偏移**不能**以 DB 的原字串為準，必須以這份投影為準。
 *
 * 三條規矩：
 * 1. **前後端同一份**：`frontend/src/lib/markdown-plain.js` 直接 re-export 這個檔，
 *    不是複製。兩邊算出來的偏移永遠一致，後端 `slice(start,end) === text`
 *    那道閘門才不會變成隨機 400（§3 紅線）。
 * 2. **換行與空白保留**：行與行之間的結構不動（不 trim、不合併空行），
 *    只脫掉行首的標記與行內的強調符號。段落形狀留著，偏移才穩。
 * 3. **冪等**：`plainText(plainText(x)) === plainText(x)`（§4.1）。所以行首標記
 *    是「剝到不能再剝」的迴圈，不是剝一次。
 *
 * 不追求完整 markdown 規範——只處理 AI 回覆真的會用的那幾種（標題、強調、
 * 清單、引言、行內碼、圍欄、連結、表格、分隔線）。碰不到的一律原樣留著。
 */

/** 圍欄行（```／~~~，前面可以有縮排）。 */
const FENCE_RE = /^\s*(?:`{3,}|~{3,})/;

/** 分隔線：---／***／___（三個以上，中間可夾空白）。 */
const THEMATIC_BREAK_RE = /^\s*([-*_])[ \t]*(?:\1[ \t]*){2,}$/;

/** 表格的分隔列：|:---|---:|（只有管線、冒號、連字號、空白）。 */
const TABLE_DIVIDER_RE = /^\s*\|?[\s:|-]*-[\s:|-]*\|[\s:|-]*$/;

/** 行首的標題井號。 */
const HEADING_RE = /^([ \t]*)#{1,6}[ \t]+/;

/** 行首的引言符號（可以連著好幾層）。 */
const BLOCKQUOTE_RE = /^([ \t]*)>[ \t]?/;

/** 行首的清單標記：`- `／`* `／`+ `／`1. `／`1) `（縮排保留＝層級看得出來）。 */
const LIST_RE = /^([ \t]*)(?:[-*+]|\d{1,9}[.)])[ \t]+/;

/** 這一行看起來像表格列（頭尾有管線，或行內有管線且不是行內碼）。 */
function isTableRow(line) {
  const t = line.trim();
  return t.startsWith('|') && t.endsWith('|') && t.length > 2;
}

/**
 * 表格列 → 用兩個空白接起來的一行（畫面上的儲存格是分開的，管線不會出現）。
 * 儲存格內部的字不動，只脫掉管線與儲存格兩端的空白。
 */
function flattenTableRow(line) {
  const t = line.trim();
  return t
    .slice(1, -1)
    .split('|')
    .map(cell => cell.trim())
    .join('  ');
}

/** 行首標記剝到不能再剝（冪等的來源，見檔頭規矩 3）。 */
function stripLinePrefixes(line) {
  let out = line;
  for (let i = 0; i < 16; i += 1) {
    const before = out;
    out = out.replace(HEADING_RE, '$1');
    out = out.replace(BLOCKQUOTE_RE, '$1');
    out = out.replace(LIST_RE, '$1');
    if (out === before) break;
  }
  return out;
}

/** 行內標記：圖片／連結只留文字、行內碼脫掉反引號、強調與刪除線脫掉符號。 */
function stripInline(line) {
  let out = line;
  // 圖片要排在連結前面（`![alt](url)` 也符合連結的形狀）
  out = out.replace(/!\[([^\]]*)\]\([^)\s]*(?:\s+"[^"]*")?\)/g, '$1');
  out = out.replace(/\[([^\]]*)\]\([^)\s]*(?:\s+"[^"]*")?\)/g, '$1');
  // 行內碼：保留內容、脫掉反引號
  out = out.replace(/`+([^`]+?)`+/g, '$1');
  // 刪除線（gfm）
  out = out.replace(/~~(?=\S)([\s\S]*?\S)~~/g, '$1');
  // 強調：***／**／*，再來是 __／_（底線只在詞界脫，免得咬掉 snake_case）
  out = out.replace(/\*\*\*(?=\S)([^*]*?\S)\*\*\*/g, '$1');
  out = out.replace(/\*\*(?=\S)([^*]*?\S)\*\*/g, '$1');
  out = out.replace(/\*(?=\S)([^*]*?\S)\*/g, '$1');
  out = out.replace(/(^|[^A-Za-z0-9_])__(?=\S)([^_]*?\S)__(?![A-Za-z0-9_])/g, '$1$2');
  out = out.replace(/(^|[^A-Za-z0-9_])_(?=\S)([^_]*?\S)_(?![A-Za-z0-9_])/g, '$1$2');
  return out;
}

/**
 * markdown 字串 → 純文字投影。
 *
 * @param {string} md
 * @returns {string} 不是字串時回空字串（呼叫端不必先判斷）
 */
export function plainText(md) {
  if (typeof md !== 'string' || md === '') return '';

  const lines = md.split('\n');
  const out = [];
  let inFence = false;

  for (const line of lines) {
    if (FENCE_RE.test(line)) {
      // 圍欄那一行畫面上不存在 ⇒ 整行連同換行一起消失（裡面的程式碼照樣留著）
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }
    if (THEMATIC_BREAK_RE.test(line) || TABLE_DIVIDER_RE.test(line)) {
      // 分隔線與表格分隔列在畫面上是一條線／不存在，不是文字
      continue;
    }

    let next = stripLinePrefixes(line);
    if (isTableRow(next)) next = flattenTableRow(next);
    next = stripInline(next);
    out.push(next);
  }

  return out.join('\n');
}

export default plainText;
