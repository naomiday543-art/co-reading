import { readFileSync } from 'fs';
import pdfParse from 'pdf-parse';

export async function extractPDF(filepath) {
  const buf = readFileSync(filepath);
  const data = await pdfParse(buf);

  const text = data.text || '';

  // Check for scanned PDF (little to no extractable text)
  const clean = text.replace(/\s/g, '');
  if (clean.length < 50) {
    const err = new Error('此 PDF 可能是掃描版，無法自動提取文本');
    err.code = 'SCANNED_PDF';
    throw err;
  }

  return text;
}
