// 測試用的最小含字 PDF 產生器（工單 24 §五）。
//
// 為什麼手寫而不是裝套件：工單 §四 紅線 5「不裝新套件」。這支只用字串拼一份
// 單頁、Type1 Helvetica、未壓縮內容流的 PDF，`pdf-parse` 抽得到字。
//
// 🔴 `padTo` 不是裝飾，是**必要**的（2026-09-21 查了一輪才定位）：
// pdf-parse 綁的 pdf.js v1.10.100 在 `XRef.fetchUncompressed()` 裡走
// `this.stream.makeSubStream(offset + start)`，而 `makeSubStream` 拿的是
// `this.bytes.buffer`——Node 的 `readFileSync` 對**小於 4KB** 的檔案回的是
// **共用 pool** 上的 Buffer（`byteOffset !== 0`），於是 xref 的絕對偏移就落在
// pool 裡別人的位元組上，報 `bad XRef entry`。把檔案墊到 8KB 以上，
// `readFileSync` 會獨立配置（`byteOffset === 0`），偏移才對得上。
// 墊的是一行 PDF 註解（`%` 開頭），對解析沒有任何語義影響。
// 真實的 SI PDF 沒有一份小於 4KB，所以這是測試夾具的問題，不是產品的坑。

/** PDF 字串字面量裡 `\`、`(`、`)` 要跳脫。 */
function escapePdfText(s) {
  return `${s}`.replace(/([\\()])/g, '\\$1');
}

/**
 * 產生一份單頁 PDF。
 *
 * @param {string[]} lines 頁面上的文字行；**傳 `[]` 就是「掃描版」**
 *        （抽不到字，`extractPDFDetailed` 會丟 `SCANNED_PDF`）
 * @param {{padTo?: number}} [opts] `padTo` 最小位元組數，預設 8192（見上面那段）
 * @returns {Buffer}
 */
export function makeTextPdf(lines = [], { padTo = 8192 } = {}) {
  const content = ['BT', '/F1 12 Tf', '36 756 Td', '14 TL']
    .concat((lines || []).map(l => `(${escapePdfText(l)}) Tj T*`))
    .concat(['ET'])
    .join('\n');

  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R'
      + ' /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];

  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((body, i) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });

  // xref 每一列固定 20 bytes：`nnnnnnnnnn ggggg n \n`。
  const xrefAt = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;

  let buf = Buffer.from(pdf, 'latin1');
  if (buf.length < padTo) {
    const filler = `\n%${'p'.repeat(Math.max(0, padTo - buf.length - 2))}\n`;
    buf = Buffer.concat([buf, Buffer.from(filler, 'latin1')]);
  }
  return buf;
}

/** 掃描版（一個字都抽不到）。 */
export function makeScannedPdf(opts) {
  return makeTextPdf([], opts);
}

/** 上傳用的 `File`（Node 20+ 的全域 File／FormData）。 */
export function pdfFile(name, lines, opts) {
  return new File([makeTextPdf(lines, opts)], name, { type: 'application/pdf' });
}
