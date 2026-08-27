import { readFileSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import pdfParse from 'pdf-parse';

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

export async function renderVisualPages(filepath, { maxPages = 8, dpi = 120 } = {}) {
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
