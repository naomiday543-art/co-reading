import { readFileSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import pdfParse from 'pdf-parse';
import { log } from './logger.js';

const execFileAsync = promisify(execFile);

function pageTextRenderer(pageTexts) {
  return async (pageData) => {
    const textContent = await pageData.getTextContent({
      normalizeWhitespace: false,
      disableCombineTextItems: false,
    });
    let lastY;
    let text = '';
    for (const item of textContent.items) {
      text += lastY === undefined || lastY === item.transform[5] ? item.str : `\n${item.str}`;
      lastY = item.transform[5];
    }
    pageTexts.push(text);
    return text;
  };
}

// ── 參考文獻區塊（工單 13 §3.2）──────────────────────────────────────────
//
// 為什麼是「切區塊」不是「切尾巴」：她的 Cell Press 那篇（Immunity）REFERENCES 在 60%，
// 後面還有 Highlights、圖注與 KEY RESOURCES TABLE；切到文末會把方法與圖注一起砍掉。
// 為什麼要 ≥50% 的位置門檻：正文裡「see References」「references therein」也會獨立成行
//（她 jGPpnD 那篇 40.6% 就有一個真的 References 標題，但那是 Nature 版式的正文引文表，
// 後面還有 Methods）。取最後一個 ≥50% 的候選是最保守的選法。

/** 獨立成行的「參考文獻」標題。 */
const REFERENCES_HEADING = /^(references?|bibliography|literature cited|参考文献|參考文獻|reference list)\s*[:：]?\s*$/i;

/**
 * 區塊終點：下一個「像章節標題」的獨立行。
 *
 * 必須**整行**就是那個標題（後面最多跟冒號／句點）——鬆一點就會被
 * 「methods and applications. J. Photochem. Photobiol. B 98, 77–86」這種
 * 參考文獻條目本身當成標題，區塊在第三條就被截斷（她 lkd5HG 那篇實際長這樣）。
 * 認不出終點時退到文末，再由密度回退（trimReferencesTail）把非文獻的尾巴還回去。
 */
const NEXT_SECTION_HEADING = /^(star\W*methods|methods|materials and methods|supplement(ary|al)( information| materials)?|appendix|acknowledg(e)?ments?|author contributions|key resources table|支持信息|致谢|附录)\s*[:：.]?\s*$/i;

/** 「這一段長得像參考文獻」的特徵：年份、et al.、DOI、URL、編號條目。 */
const CITATION_PATTERNS = [
  /\(?(19|20)\d{2}\)?[a-z]?[.;,]/g,
  /et al\./g,
  /doi/gi,
  /https?:\/\//g,
  /^\d+\.\s+[A-Z][a-z]+,/gm,
];

/** 每千字至少要有這麼多個引用特徵，才承認那是參考文獻區塊。 */
export const MIN_CITATION_DENSITY = 6;

/** 候選標題至少要落在全文這個比例之後。 */
const MIN_HEADING_RATIO = 0.5;

/** 尾端回退的視窗大小（字元）。 */
const TAIL_WINDOW = 1000;

/** 回退後最多再往前補幾行（把被格線切斷的那條文獻補完）。 */
const TAIL_EXTEND_MAX_LINES = 20;

/** 一段文字裡的引用特徵個數。 */
export function countCitationFeatures(text) {
  let n = 0;
  for (const pattern of CITATION_PATTERNS) {
    pattern.lastIndex = 0;
    n += (text.match(pattern) || []).length;
  }
  return n;
}

function citationDensity(text) {
  if (!text) return 0;
  return (countCitationFeatures(text) * 1000) / text.length;
}

/**
 * 把區塊尾端「明顯不是參考文獻」的部分還回去。
 *
 * 她的 Immunity 那篇就是這個形狀：REFERENCES(88,072) … 參考文獻 … Highlights(117,419)
 * … 18k 字圖注 … KEY RESOURCES TABLE(135,181)。照「切到下一個章節標題」會連圖注一起吃掉。
 * 從尾巴往回一格一格看，密度低於門檻一半的視窗一律退回。只會讓區塊變小，不會變大。
 */
function trimReferencesTail(text, start, end) {
  const floor = MIN_CITATION_DENSITY / 2;
  let cursor = end;
  while (cursor - start > TAIL_WINDOW) {
    const windowStart = cursor - TAIL_WINDOW;
    if (citationDensity(text.slice(windowStart, cursor)) >= floor) break;
    cursor = windowStart;
  }
  if (cursor >= end) return end;

  // 回退是以 1000 字為格的，格線會落在某條文獻中間。往後補到「這一行不再像文獻」為止，
  // 免得原文裡留下半條參考文獻。只往前補，永遠不超過原本的終點。
  let line = text.indexOf('\n', cursor);
  if (line === -1 || line >= end) return Math.min(cursor, end);
  let out = line + 1;
  for (let i = 0; i < TAIL_EXTEND_MAX_LINES && out < end; i += 1) {
    const nl = text.indexOf('\n', out);
    const stop = nl === -1 || nl >= end ? end : nl + 1;
    const chunk = text.slice(out, stop);
    // 還像文獻的兩種樣子：本身帶引用特徵，或是上一條的續行（懸掛縮排 ⇒ 小寫開頭）。
    const continuation = /^[a-z]/.test(chunk.trim()) && chunk.length < 120;
    if (countCitationFeatures(chunk) === 0 && !continuation) break;
    out = stop;
  }
  return out;
}

/**
 * 找出全文裡的參考文獻區塊。**只回位置，不動原文**——切除只發生在送模型的那份文字上
 *（`papers.full_text` 是閱讀模式與選段偏移的事實源，工單 13／14 共同紅線）。
 *
 * @param {string} fullText
 * @returns {{cut: boolean, start: number, end: number, chars: number,
 *            reason: 'ok'|'no_heading'|'low_density'|'empty', heading: string, density: number}}
 */
export function locateReferencesBlock(fullText) {
  const text = `${fullText ?? ''}`;
  const miss = reason => ({ cut: false, start: -1, end: -1, chars: 0, reason, heading: '', density: 0 });
  if (text.length === 0) return miss('empty');

  const lines = text.split('\n');
  let offset = 0;
  let heading = null;
  const sectionStarts = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (line) {
      if (REFERENCES_HEADING.test(line) && offset / text.length >= MIN_HEADING_RATIO) {
        heading = { offset, line, lineEnd: offset + raw.length + 1 };
      }
      if (NEXT_SECTION_HEADING.test(line)) sectionStarts.push(offset);
    }
    offset += raw.length + 1;
  }
  if (!heading) return miss('no_heading');

  const nextSection = sectionStarts.find(start => start >= heading.lineEnd);
  const rawEnd = nextSection === undefined ? text.length : nextSection;
  const end = trimReferencesTail(text, heading.offset, rawEnd);
  const block = text.slice(heading.offset, end);
  const density = citationDensity(block);

  if (density < MIN_CITATION_DENSITY) {
    return { cut: false, start: heading.offset, end, chars: block.length, reason: 'low_density', heading: heading.line, density };
  }
  return { cut: true, start: heading.offset, end, chars: block.length, reason: 'ok', heading: heading.line, density };
}

// ── text_meta（工單 13 §3.2／§3.3）───────────────────────────────────────
//
// 存進 `papers.text_meta` 的那顆 JSON：參考文獻區塊的位置 ＋ 每頁抽字品質。
// 它是**推導出來的資料**，隨時可以砍掉重算（POST /api/papers/:id/text-meta/rebuild），
// 不是事實源——事實源永遠是 `papers.full_text` 與 PDF 本身。

export const TEXT_META_VERSION = 1;

/**
 * @param {string} fullText
 * @param {Array} [pageMeta] 頁級品質（`describePages()` 的輸出）；沒有就只做參考文獻那半
 */
export function buildTextMeta(fullText, pageMeta = []) {
  const refs = locateReferencesBlock(fullText);
  return {
    version: TEXT_META_VERSION,
    references: {
      cut: refs.cut,
      start: refs.start,
      end: refs.end,
      chars: refs.chars,
      reason: refs.reason,
      heading: refs.heading,
      density: Number(refs.density.toFixed(2)),
    },
    pages: pageMeta,
    bad_pages: pageMeta.filter(p => p.quality !== 'ok').map(p => p.n),
  };
}

/** DB 欄位（TEXT）→ 物件；空／壞掉一律回 null，呼叫端自己決定要不要重算。 */
export function parseTextMeta(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export function selectVisualPageNumbers(pageTexts, maxPages = 8) {
  const captionPattern = /(?:^|\n)\s*(?:fig(?:ure)?\.?|table|chart|圖|表)\s*[\dIVX一二三四五六七八九十]+/gim;
  const scored = pageTexts.map((text, index) => ({
    page: index + 1,
    score: (String(text || '').match(captionPattern) || []).length,
  }));
  const hits = scored
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || a.page - b.page)
    .slice(0, maxPages)
    .map(item => item.page)
    .sort((a, b) => a - b);

  if (hits.length > 0) return hits;
  if (pageTexts.length === 0) return [];

  // Caption extraction can fail on scanned/vector-heavy PDFs. In that case,
  // sample the paper instead of silently disabling vision.
  const count = Math.min(maxPages, pageTexts.length);
  const sampled = new Set();
  for (let i = 0; i < count; i += 1) {
    sampled.add(1 + Math.round((i * (pageTexts.length - 1)) / Math.max(1, count - 1)));
  }
  return [...sampled].sort((a, b) => a - b);
}

export async function inspectPDF(filepath) {
  const buf = readFileSync(filepath);
  const pageTexts = [];
  const data = await pdfParse(buf, { pagerender: pageTextRenderer(pageTexts) });
  return {
    text: data.text || '',
    pageTexts,
    pageCount: data.numpages || pageTexts.length,
  };
}

export async function extractPDF(filepath) {
  const { text } = await inspectPDF(filepath);

  // Check for scanned PDF (little to no extractable text)
  const clean = text.replace(/\s/g, '');
  if (clean.length < 50) {
    const err = new Error('此 PDF 可能是掃描版，無法自動提取文本');
    err.code = 'SCANNED_PDF';
    throw err;
  }

  return text;
}

// pdftoppm（poppler）在不在這台機器上。null = 還沒探測過。
// 這台 Mac 沒裝 poppler，而 opencode_go preset 的 vision_mode 預設是 'on'，
// 結果每上傳一篇論文都要：把整份 PDF 用 pdf-parse 重新解析一次（實測 371ms）
// → spawn pdftoppm → ENOENT（1ms）→ 降級。全程約 400ms 純白跑，而且每篇重來。
// 探測一次就記住，之後連那 371ms 的重新解析都不用付。
let pdftoppmAvailable = null;

/** 測試用：清掉探測結果。 */
export function resetPdftoppmProbe() {
  pdftoppmAvailable = null;
}

/**
 * 這台機器有沒有 pdftoppm。整個進程只探測一次，「沒有」也只抱怨一次。
 * @returns {Promise<boolean>}
 */
export async function hasPdftoppm() {
  if (pdftoppmAvailable !== null) return pdftoppmAvailable;
  const binary = process.env.PDFTOPPM_PATH || 'pdftoppm';
  try {
    await execFileAsync(binary, ['-v'], { timeout: 10_000 });
    pdftoppmAvailable = true;
  } catch (err) {
    // 只有「找不到執行檔」才算沒裝。`pdftoppm -v` 在部分 poppler 版本用非零退出碼
    // 把版本印在 stderr，那不是缺檔，別把它誤判成沒裝。
    const missing = err?.code === 'ENOENT' || /ENOENT/.test(err?.message || '');
    pdftoppmAvailable = !missing;
    if (missing) {
      log('WARN', '找不到 pdftoppm（poppler 未安裝），視覺通讀本進程內一律跳過；'
        + '裝 poppler 或設 PDFTOPPM_PATH 才會啟用');
    }
  }
  return pdftoppmAvailable;
}

export async function renderVisualPages(filepath, { maxPages = 8, dpi = 120 } = {}) {
  // 先問有沒有工具，再決定要不要付「整份 PDF 重新解析」的代價。順序反了就是每篇白跑 400ms。
  if (!(await hasPdftoppm())) {
    const err = new Error('找不到 pdftoppm（poppler 未安裝），無法把論文頁面轉成圖');
    err.code = 'PDFTOPPM_MISSING';
    throw err;
  }

  const { pageTexts } = await inspectPDF(filepath);
  const pageNumbers = selectVisualPageNumbers(pageTexts, maxPages);
  if (pageNumbers.length === 0) return [];

  const workDir = mkdtempSync(join(tmpdir(), 'co-reading-figures-'));
  const binary = process.env.PDFTOPPM_PATH || 'pdftoppm';
  const images = [];
  try {
    for (const page of pageNumbers) {
      const prefix = join(workDir, `page-${page}`);
      await execFileAsync(binary, [
        '-f', String(page), '-l', String(page), '-singlefile',
        '-png', '-r', String(dpi), filepath, prefix,
      ], { timeout: 60_000, maxBuffer: 2 * 1024 * 1024 });
      const data = readFileSync(`${prefix}.png`).toString('base64');
      images.push({ type: 'image', mediaType: 'image/png', data, page });
    }
    return images;
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}
