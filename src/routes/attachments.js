// 補充文件／SI（工單 24 §D2）。掛在 `/api/papers/:id/attachments`。
//
// 邊界：這條線**只碰 `paper_attachments`**。不觸發通讀、不動 `papers` 的任何欄位、
// 不碰 `full_text`／`text_meta`／`messages.quote`。掛一份 SI 不該讓她重跑通讀。
//
// 所有 `:aid` 一律 `WHERE id = ? AND paper_id = ?` 查：拿別篇論文的 aid 進來要 404，
// 不能讓 URL 上的論文 id 變成裝飾品。
import { Router } from 'express';
import multer from 'multer';
import { nanoid } from 'nanoid';
import { join } from 'path';
import { unlinkSync, existsSync, createReadStream } from 'fs';
import db from '../db.js';
import { extractPDFDetailed } from '../pdf.js';
import { planSiBudget, resolvePaperSiLimit } from '../ai.js';
import { log } from '../logger.js';
import { dataPaths } from '../paths.js';

const router = Router({ mergeParams: true });

/** 每篇論文最多幾份 SI。純粹是防手滑，不是技術上限。 */
export const MAX_ATTACHMENTS_PER_PAPER = 10;
/** 她看到的名字上限（工單 §D2 PATCH）。 */
export const LABEL_MAX = 120;

const storage = multer.diskStorage({
  destination: dataPaths.pdfDir,
  // 磁碟檔名一律是 `si-<nanoid>.pdf`——**原始檔名絕不進路徑**（工單 §四 紅線 4）。
  // 中文／空白／`../` 都只會出現在 DB 與編碼過的 header 裡。
  filename: (_req, _file, cb) => cb(null, `si-${nanoid()}.pdf`),
});

function onlyPdf(_req, file, cb) {
  const name = `${file.originalname || ''}`.toLowerCase();
  const isPdf = name.endsWith('.pdf') && file.mimetype === 'application/pdf';
  if (!isPdf) {
    const err = new Error('目前只支援 PDF 的補充文件');
    err.code = 'ONLY_PDF';
    return cb(err);
  }
  cb(null, true);
}

const upload = multer({
  storage,
  fileFilter: onlyPdf,
  limits: { fileSize: 50 * 1024 * 1024 },
});

/**
 * 把 multer 給的 `originalname` 還原成 UTF-8。
 *
 * 🔴 multer 1.x 底下的 busboy 是**用 latin1 解 multipart 的檔名**的，所以
 * 「第一份 SI.pdf」到手會變成 `ç¬¬ä¸ä»½ SI.pdf`。不還原的話她的中文 SI 名字
 * 從入庫那一刻就是亂碼（2026-09-21 這支測試抓到的）。
 * 作法：把字串照 latin1 轉回原始位元組，再用 UTF-8 解一次；解出替換字元
 * （U+FFFD＝本來就不是 UTF-8）就退回原字串，不要弄得更糟。
 * 純 ASCII 的名字走這條路是原樣不動。
 */
function decodeOriginalName(name) {
  const raw = `${name || ''}`;
  if (!raw) return '';
  try {
    const decoded = Buffer.from(raw, 'latin1').toString('utf8');
    return decoded.includes('�') ? raw : decoded;
  } catch {
    return raw;
  }
}

function pdfPathOf(filename) {
  return join(dataPaths.pdfDir, filename);
}

/** 靜悄悄刪磁碟檔。檔案早就不在不是錯（她可能自己清過 pdfs/）。 */
function unlinkQuiet(filename) {
  if (!filename) return;
  try {
    const p = pdfPathOf(filename);
    if (existsSync(p)) unlinkSync(p);
  } catch {}
}

/**
 * 把 multer 已經落盤的暫存檔清掉。
 *
 * 為什麼需要：`fileFilter` 拒絕第二份時，第一份**早就寫進磁碟了**，multer 只是停止
 * 繼續收。400 直接回去的話那一份就成了永遠沒有人認領的孤兒檔。
 */
function cleanupUploads(files) {
  for (const f of files || []) {
    try {
      if (f?.path && existsSync(f.path)) unlinkSync(f.path);
    } catch {}
  }
}

// 論文不存在就別再往下走（也就不會為了一篇不存在的論文寫任何檔案）。
router.use((req, res, next) => {
  const paper = db.prepare('SELECT id FROM papers WHERE id = ?').get(req.params.id);
  if (!paper) return res.status(404).json({ error: '論文不存在' });
  next();
});

/**
 * 列表用的列（**不含 `extracted_text`**：列表不背全文，那是 `GET /:aid/text` 的事）。
 * `chars` 用 SQLite 的 `LENGTH()`——TEXT 欄位回的是字元數，跟 JS 的 `.length` 同一個單位。
 */
const LIST_SQL = `SELECT id, paper_id, kind, label, original_name, filename, mime, size_bytes,
    LENGTH(extracted_text) AS chars, ai_visible, sort_order, created_at
  FROM paper_attachments WHERE paper_id = ? ORDER BY sort_order, created_at, id`;

function listRows(paperId) {
  return db.prepare(LIST_SQL).all(paperId);
}

/**
 * 一列 → 回給前端的形狀。`ai_chars_sent`／`truncated` 走 `planSiBudget`，
 * 跟 `renderSiBlock` 真正送出去的是**同一顆預算函式**（工單 §D2）。
 */
function toApi(row, plan) {
  const p = plan?.get(row.id);
  return {
    id: row.id,
    paper_id: row.paper_id,
    kind: row.kind,
    label: row.label,
    original_name: row.original_name,
    mime: row.mime,
    size_bytes: row.size_bytes,
    chars: row.chars,
    has_text: row.chars > 0,
    ai_visible: row.ai_visible ? 1 : 0,
    sort_order: row.sort_order,
    created_at: row.created_at,
    ai_chars_sent: p ? p.sent : 0,
    truncated: p ? p.truncated : false,
    // 預算被前面幾份吃光 ⇒ 這份只剩標題行。UI 要說「超出預算，AI 沒讀到」。
    dropped: p ? p.dropped : false,
  };
}

function respondList(res, paperId) {
  const rows = listRows(paperId);
  const limit = resolvePaperSiLimit();
  const { plan, totalSent } = planSiBudget(rows, limit);
  res.json({
    attachments: rows.map(r => toApi(r, plan)),
    si_limit: limit,
    si_chars_sent: totalSent,
  });
}

// GET /api/papers/:id/attachments —— 列表
router.get('/', (req, res) => {
  respondList(res, req.params.id);
});

/**
 * multer 包一層，把它丟出來的錯翻成她看得懂的中文，**並且把已落盤的檔清掉**。
 * 不用 express 的錯誤中介層：那會讓「清檔」離開這個檔案，容易漏。
 */
function receiveFiles(req, res, next) {
  upload.array('files')(req, res, (err) => {
    if (!err) return next();
    cleanupUploads(req.files);
    if (err.code === 'ONLY_PDF') return res.status(400).json({ error: '目前只支援 PDF 的補充文件' });
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: '補充文件單檔不能超過 50MB' });
    return res.status(400).json({ error: err.message || '補充文件上傳失敗' });
  });
}

// POST /api/papers/:id/attachments —— 上傳（欄位名 `files`，可多檔）
router.post('/', receiveFiles, async (req, res) => {
  const paperId = req.params.id;
  const files = req.files || [];

  if (files.length === 0) {
    return res.status(400).json({ error: '沒有收到檔案' });
  }

  const existing = db.prepare('SELECT COUNT(*) AS n FROM paper_attachments WHERE paper_id = ?').get(paperId).n;
  if (existing + files.length > MAX_ATTACHMENTS_PER_PAPER) {
    // 超過上限：整批退回。落盤的檔一份都不能留。
    cleanupUploads(files);
    return res.status(400).json({
      error: `每篇論文最多 ${MAX_ATTACHMENTS_PER_PAPER} 份補充文件（目前已有 ${existing} 份）`,
    });
  }

  const maxOrder = db.prepare(
    'SELECT COALESCE(MAX(sort_order), -1) AS m FROM paper_attachments WHERE paper_id = ?'
  ).get(paperId).m;

  const created = [];
  const failed = [];
  let nextOrder = maxOrder + 1;

  for (const file of files) {
    const originalName = decodeOriginalName(file.originalname) || 'supplementary.pdf';
    let text = '';
    let scanned = false;

    try {
      ({ text } = await extractPDFDetailed(file.path));
    } catch (err) {
      if (err.code === 'SCANNED_PDF') {
        // 掃描版不算錯：PDF 照樣看得到，只是 AI 讀不到字（工單 §D2）。
        text = '';
        scanned = true;
      } else {
        // 這一份壞了：清掉它自己的檔就好，**別讓整批 500**，也別留孤兒檔。
        cleanupUploads([file]);
        failed.push({ name: originalName, error: err.message });
        log('WARN', `[SI] upload paper=${paperId} file=${originalName} 抽字失敗: ${err.message}`);
        continue;
      }
    }

    const id = nanoid();
    // 預設名字＝原始檔名去副檔名（她之後可以改）。
    const label = originalName.replace(/\.pdf$/i, '').slice(0, LABEL_MAX) || '補充文件';

    db.prepare(`INSERT INTO paper_attachments
      (id, paper_id, kind, label, original_name, filename, mime, size_bytes, extracted_text, ai_visible, sort_order)
      VALUES (?, ?, 'si', ?, ?, ?, ?, ?, ?, 1, ?)`)
      .run(id, paperId, label, originalName, file.filename, file.mimetype || 'application/pdf',
        file.size || 0, text, nextOrder);
    nextOrder += 1;

    log('INFO', `[SI] upload paper=${paperId} aid=${id} chars=${text.length} scanned=${scanned}`);
    created.push(id);
  }

  const rows = listRows(paperId);
  const limit = resolvePaperSiLimit();
  const { plan, totalSent } = planSiBudget(rows, limit);
  res.json({
    attachments: rows.map(r => toApi(r, plan)),
    created,
    failed,
    si_limit: limit,
    si_chars_sent: totalSent,
  });
});

/** `:aid` 一律連 `paper_id` 一起查（工單 §四 紅線 4）。 */
function findAttachment(req) {
  return db.prepare('SELECT * FROM paper_attachments WHERE id = ? AND paper_id = ?')
    .get(req.params.aid, req.params.id);
}

/**
 * RFC 5987 的 ext-value：只留 attr-char，其餘一律百分比編碼。
 *
 * **中文檔名絕不裸進 header**（家裡 7/8 踩過：非 ASCII 進 header 會被 Node 擋掉／
 * 送出亂碼）。`encodeURIComponent` 不編 `!'()*`，而 `'`／`(`／`)`／`*` 不在 attr-char
 * 裡，所以要自己補上。
 */
function encodeFilenameStar(name) {
  return encodeURIComponent(name).replace(/['()*!]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

// GET /api/papers/:id/attachments/:aid/file —— 串流原檔
router.get('/:aid/file', (req, res) => {
  const row = findAttachment(req);
  if (!row) return res.status(404).json({ error: '補充文件不存在' });

  const p = pdfPathOf(row.filename);
  if (!existsSync(p)) return res.status(404).json({ error: '補充文件的檔案已不在磁碟上' });

  res.setHeader('Content-Type', row.mime || 'application/pdf');
  res.setHeader(
    'Content-Disposition',
    `inline; filename*=UTF-8''${encodeFilenameStar(row.original_name || 'supplementary.pdf')}`
  );
  createReadStream(p).pipe(res);
});

// GET /api/papers/:id/attachments/:aid/text —— 文字版（列表不背全文，單獨拿）
router.get('/:aid/text', (req, res) => {
  const row = db.prepare('SELECT extracted_text FROM paper_attachments WHERE id = ? AND paper_id = ?')
    .get(req.params.aid, req.params.id);
  if (!row) return res.status(404).json({ error: '補充文件不存在' });
  res.json({ text: row.extracted_text });
});

// PATCH /api/papers/:id/attachments/:aid —— 只准改 label／ai_visible／sort_order
router.patch('/:aid', (req, res) => {
  const row = findAttachment(req);
  if (!row) return res.status(404).json({ error: '補充文件不存在' });

  const updates = [];
  const params = [];

  if (req.body?.label !== undefined) {
    const label = `${req.body.label}`.trim().slice(0, LABEL_MAX);
    if (!label) return res.status(400).json({ error: '名字不能是空的' });
    updates.push('label = ?');
    params.push(label);
  }
  if (req.body?.ai_visible !== undefined) {
    updates.push('ai_visible = ?');
    params.push(req.body.ai_visible ? 1 : 0);
  }
  if (req.body?.sort_order !== undefined) {
    const n = Number(req.body.sort_order);
    if (!Number.isFinite(n)) return res.status(400).json({ error: 'sort_order 必須是數字' });
    updates.push('sort_order = ?');
    params.push(Math.round(n));
  }

  if (updates.length > 0) {
    params.push(req.params.aid, req.params.id);
    db.prepare(`UPDATE paper_attachments SET ${updates.join(', ')} WHERE id = ? AND paper_id = ?`).run(...params);
  }

  respondList(res, req.params.id);
});

// DELETE /api/papers/:id/attachments/:aid —— 先刪磁碟檔再刪列
router.delete('/:aid', (req, res) => {
  const row = findAttachment(req);
  if (!row) return res.status(404).json({ error: '補充文件不存在' });

  unlinkQuiet(row.filename);
  db.prepare('DELETE FROM paper_attachments WHERE id = ? AND paper_id = ?')
    .run(req.params.aid, req.params.id);
  log('INFO', `[SI] delete paper=${req.params.id} aid=${req.params.aid}`);

  respondList(res, req.params.id);
});

/**
 * 刪論文之前把該篇所有 SI 的磁碟檔清掉。
 *
 * FK `ON DELETE CASCADE` 只帶得走 DB 的列，**帶不走磁碟檔**——不先清就會在
 * `data/pdfs/` 留下一堆永遠沒有人認領的 `si-*.pdf`（全倉沒有任何孤兒 PDF 清理邏輯）。
 * 給 `routes/papers.js` 的 `DELETE /:id` 用。
 * @returns {number} 清掉幾份
 */
export function unlinkAttachmentsOfPaper(paperId) {
  const rows = db.prepare('SELECT filename FROM paper_attachments WHERE paper_id = ?').all(paperId);
  for (const r of rows) unlinkQuiet(r.filename);
  if (rows.length > 0) log('INFO', `[SI] delete paper=${paperId} files=${rows.length}（隨論文刪除）`);
  return rows.length;
}

export default router;
