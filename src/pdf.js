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
