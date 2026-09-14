// 抽字品質提示的純函式（工單 13 §3.3）。
//
// 後端 `GET /api/papers/:id` 回的 `text_meta.pages[]` → 畫面上那一行人話。
// 放在自己的檔案裡而不是 store.js：這只是格式化，沒有狀態；也避開跟工單 14
// 在 store.js 上的改動打架。

const QUALITY_LABEL = {
  rotated: '文字疑似旋轉（可能是橫向表格）',
  poor: '抽字不完整',
};

const REASON_LABEL = {
  rotated: '文字被旋轉 90°',
  too_short: '這頁幾乎沒抽到字',
  fragmented: '大量單字元斷行',
  garbled: '非文字符號過多',
};

/** [3,7,12] → '第 3、7、12 頁'；超過 max 就收尾成「… 等 N 頁」。 */
export function renderPageList(pages, max = 12) {
  if (!pages || pages.length === 0) return '';
  const head = pages.slice(0, max).join('、');
  return pages.length > max ? `第 ${head}… 等 ${pages.length} 頁` : `第 ${head} 頁`;
}

/** 一頁的 reasons → 人話，給 <details> 裡的明細用。 */
export function renderPageReasons(reasons = []) {
  return reasons.map(r => REASON_LABEL[r] || r).join('、');
}

/**
 * text_meta → 摘要頁上那一行。沒有壞頁（或還沒算過 text_meta）時回 null，
 * 畫面上就什麼都不出現——沒問題的時候不要製造焦慮（憲章第 6 條）。
 *
 * @param {object|null} textMeta
 * @returns {{line: string, badPages: Array, pageCount: number}|null}
 */
export function describeTextQuality(textMeta) {
  const pages = Array.isArray(textMeta?.pages) ? textMeta.pages : [];
  const badPages = pages.filter(p => p && p.quality && p.quality !== 'ok');
  if (badPages.length === 0) return null;

  const parts = [];
  for (const quality of ['rotated', 'poor']) {
    const numbers = badPages.filter(p => p.quality === quality).map(p => p.n);
    if (numbers.length > 0) parts.push(`${renderPageList(numbers)}${QUALITY_LABEL[quality]}`);
  }
  return { line: parts.join('、'), badPages, pageCount: pages.length };
}
