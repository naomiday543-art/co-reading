import { Router } from 'express';
import multer from 'multer';
import { nanoid } from 'nanoid';
import { join } from 'path';
import { unlinkSync, existsSync } from 'fs';
import db from '../db.js';
import { extractPDF } from '../pdf.js';
import { analyzePaper } from '../ai.js';
import { log } from '../logger.js';
import { extractInsights } from '../memory.js';
import { requestRefine, fetchCarryover, fetchClaimProvenance, getCachedCarryover, sessionKeyFor, isCarryoverInjected, setCarryoverInjected } from '../carryover.js';
import { dataPaths } from '../paths.js';

const router = Router();

const storage = multer.diskStorage({
  destination: dataPaths.pdfDir,
  filename: (_req, file, cb) => {
    const id = nanoid();
    const ext = file.originalname.split('.').pop() || 'pdf';
    cb(null, `${id}.${ext}`);
  },
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

// POST /api/papers/upload
router.post('/upload', upload.array('files'), async (req, res) => {
  try {
    const files = req.files || (req.file ? [req.file] : []);
    const treeNodeId = req.body.tree_node_id || null;
    const results = [];

    for (const file of files) {
      const id = nanoid();
      const pdfPath = file.path;
      let fullText = '';

      try {
        fullText = await extractPDF(pdfPath);
      } catch (err) {
        if (err.code === 'SCANNED_PDF') {
          fullText = '';
        } else {
          throw err;
        }
      }

      db.prepare(`INSERT INTO papers (id, pdf_filename, full_text, tree_node_id, status, analyze_status)
        VALUES (?, ?, ?, ?, 'unread', 'pending')`).run(id, file.filename, fullText, treeNodeId);

      log('INFO', `PDF 上傳成功: ${id} (${file.originalname}, ${(file.size / 1024 / 1024).toFixed(1)}MB)`);

      results.push({ id, title: file.originalname, status: 'unread', analyze_status: 'pending', scanned: !fullText });

      // If scanned PDF, mark as error immediately
      if (!fullText) {
        db.prepare(`UPDATE papers SET analyze_status = 'error', analyze_error = ? WHERE id = ?`)
          .run('此 PDF 可能是掃描版，無法自動提取文本', id);
        results[results.length - 1].analyze_status = 'error';
      } else {
        // Trigger async analyze
        triggerAnalyze(id);
      }
    }

    res.json(results.length === 1 ? results[0] : results);
  } catch (err) {
    log('ERROR', `PDF 上傳失敗: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

/**
 * 啟動時把「上次進程死掉時還在通讀」的論文從 analyzing 收掉。
 *
 * triggerAnalyze 是 fire-and-forget 的 in-process promise：進程一死（`node --watch`
 * 因為存檔而重啟、手動 Ctrl-C、crash），那條 promise 跟著消失，catch 不會跑，
 * 於是連一行失敗日誌都沒有，而 analyze_status 永遠停在 'analyzing'，前端就一直轉圈。
 * 2026-09-09 14:25 的兩篇就是這樣：14:26:24 服務重啟，它們掛了四分半沒有任何音訊，
 * 她等不到只好刪掉。沒有人對帳的狀態＝永遠轉圈。
 * @returns {number} 被收掉的篇數
 */
export function reconcileStuckAnalyses() {
  const info = db.prepare(
    `UPDATE papers SET analyze_status = 'error', analyze_error = ?
     WHERE analyze_status = 'analyzing'`
  ).run('上次通讀被服務重啟打斷，請重新通讀');
  if (info.changes > 0) {
    log('WARN', `啟動對帳：${info.changes} 篇論文上次通讀被重啟打斷，已標記為失敗`);
  }
  return info.changes;
}

async function triggerAnalyze(paperId) {
  try {
    db.prepare(`UPDATE papers SET analyze_status = 'analyzing' WHERE id = ?`).run(paperId);
    log('INFO', `開始 AI 通讀: ${paperId}`);

    const startTime = Date.now();
    const paper = db.prepare('SELECT full_text, pdf_filename FROM papers WHERE id = ?').get(paperId);
    if (!paper || !paper.full_text) {
      throw new Error('論文沒有全文');
    }

    const pdfPath = paper.pdf_filename
      ? join(dataPaths.pdfDir, paper.pdf_filename)
      : null;
    const summary = await analyzePaper(paper.full_text, {
      pdfPath: pdfPath && existsSync(pdfPath) ? pdfPath : undefined,
    });

    db.prepare(`UPDATE papers SET
      title = CASE WHEN title = '' OR title IS NULL THEN ? ELSE title END,
      authors = CASE WHEN authors = '' OR authors IS NULL THEN ? ELSE authors END,
      year = CASE WHEN year IS NULL THEN ? ELSE year END,
      summary_bg = ?, summary_methods = ?, summary_results = ?,
      summary_conclusions = ?, summary_limitations = ?,
      analyze_status = 'done', analyze_error = '',
      updated_at = strftime('%s','now') * 1000
      WHERE id = ?`).run(
      summary.title, summary.authors, summary.year,
      summary.summary_bg, summary.summary_methods, summary.summary_results,
      summary.summary_conclusions, summary.summary_limitations,
      paperId
    );

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
    log('INFO', `AI 通讀完成: ${paperId} (用時 ${elapsed}s)`);
  } catch (err) {
    log('ERROR', `AI 通讀失敗: ${paperId} — ${err.message}`);
    db.prepare(`UPDATE papers SET analyze_status = 'error', analyze_error = ? WHERE id = ?`)
      .run(err.message, paperId);
  }
}

// GET /api/papers
router.get('/', (req, res) => {
  const { status, tag, tree_node_id, q, sort } = req.query;

  let query = `
    SELECT DISTINCT p.* FROM papers p
    LEFT JOIN paper_tags pt ON p.id = pt.paper_id
    WHERE 1=1
  `;
  const params = [];

  if (status) {
    query += ' AND p.status = ?';
    params.push(status);
  }
  if (tag) {
    query += ' AND pt.tag_id = ?';
    params.push(tag);
  }
  if (tree_node_id) {
    if (tree_node_id === '__none') {
      query += ' AND p.tree_node_id IS NULL';
    } else {
      query += ' AND p.tree_node_id = ?';
      params.push(tree_node_id);
    }
  }
  if (q) {
    query += ' AND (p.title LIKE ? OR p.authors LIKE ? OR p.full_text LIKE ?)';
    const like = `%${q}%`;
    params.push(like, like, like);
  }

  if (sort === 'title') {
    query += ' ORDER BY p.title ASC';
  } else if (sort === 'created') {
    query += ' ORDER BY p.created_at DESC';
  } else {
    query += ' ORDER BY p.updated_at DESC';
  }

  const papers = db.prepare(query).all(...params);

  // Attach tags to each paper
  const tagStmt = db.prepare(`
    SELECT t.id, t.name, t.color FROM tags t
    JOIN paper_tags pt ON t.id = pt.tag_id
    WHERE pt.paper_id = ?
  `);

  const result = papers.map(p => ({
    ...p,
    tags: tagStmt.all(p.id),
  }));

  res.json(result);
});

// GET /api/papers/:id
router.get('/:id', (req, res) => {
  const paper = db.prepare('SELECT * FROM papers WHERE id = ?').get(req.params.id);
  if (!paper) return res.status(404).json({ error: '論文不存在' });

  const tags = db.prepare(`
    SELECT t.id, t.name, t.color FROM tags t
    JOIN paper_tags pt ON t.id = pt.tag_id
    WHERE pt.paper_id = ?
  `).all(paper.id);

  let treeNode = null;
  if (paper.tree_node_id) {
    treeNode = db.prepare('SELECT id, name FROM tree_nodes WHERE id = ?').get(paper.tree_node_id);
  }

  res.json({ ...paper, tags, tree_node: treeNode });
});

// PATCH /api/papers/:id
router.patch('/:id', (req, res) => {
  const paper = db.prepare('SELECT * FROM papers WHERE id = ?').get(req.params.id);
  if (!paper) return res.status(404).json({ error: '論文不存在' });

  const allowed = ['title', 'authors', 'year', 'doi', 'status', 'notes', 'tree_node_id'];
  const updates = [];
  const params = [];

  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      updates.push(`${key} = ?`);
      params.push(req.body[key]);
    }
  }

  if (updates.length > 0) {
    updates.push("updated_at = strftime('%s','now') * 1000");
    params.push(req.params.id);
    db.prepare(`UPDATE papers SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  }

  const updated = db.prepare('SELECT * FROM papers WHERE id = ?').get(req.params.id);
  res.json(updated);
});

// DELETE /api/papers/:id
router.delete('/:id', (req, res) => {
  const paper = db.prepare('SELECT * FROM papers WHERE id = ?').get(req.params.id);
  if (!paper) return res.status(404).json({ error: '論文不存在' });

  // Delete PDF file
  if (paper.pdf_filename) {
    const pdfPath = join(dataPaths.pdfDir, paper.pdf_filename);
    try {
      if (existsSync(pdfPath)) unlinkSync(pdfPath);
    } catch {}
  }

  db.prepare('DELETE FROM papers WHERE id = ?').run(req.params.id);
  log('INFO', `論文已刪除: ${req.params.id}`);
  res.json({ ok: true });
});

// GET /api/papers/:id/pdf  — serve the original PDF file
router.get('/:id/pdf', (req, res) => {
  const paper = db.prepare('SELECT pdf_filename FROM papers WHERE id = ?').get(req.params.id);
  if (!paper?.pdf_filename) return res.status(404).json({ error: 'PDF not found' });

  const pdfPath = join(dataPaths.pdfDir, paper.pdf_filename);
  if (!existsSync(pdfPath)) return res.status(404).json({ error: 'PDF file not found on disk' });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'inline');
  import('fs').then(({ createReadStream }) => createReadStream(pdfPath).pipe(res));
});

// POST /api/papers/:id/analyze
router.post('/:id/analyze', (req, res) => {
  const paper = db.prepare('SELECT * FROM papers WHERE id = ?').get(req.params.id);
  if (!paper) return res.status(404).json({ error: '論文不存在' });
  if (!paper.full_text) {
    return res.status(400).json({ error: '此論文沒有提取到文本，無法通讀' });
  }

  triggerAnalyze(paper.id);
  res.json({ ok: true, analyze_status: 'analyzing' });
});

// POST /api/papers/:id/extract-insights
router.post('/:id/extract-insights', async (req, res) => {
  try {
    const paper = db.prepare('SELECT * FROM papers WHERE id = ?').get(req.params.id);
    if (!paper) return res.status(404).json({ error: '論文不存在' });

    const result = await extractInsights(paper.id);
    res.json({ ok: true, ...result });
  } catch (err) {
    log('ERROR', `記憶提取失敗: ${req.params.id} — ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ── Research carryover（工單 §5.3，契約 §九）─────────────────────

// POST /api/papers/:id/refine —— 手動觸發精煉（拍板 #3：不定時自動）
router.post('/:id/refine', async (req, res) => {
  const paper = db.prepare('SELECT id FROM papers WHERE id = ?').get(req.params.id);
  if (!paper) return res.status(404).json({ error: '論文不存在' });
  const msgCount = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE paper_id = ?').get(paper.id).n;
  if (msgCount < 2) return res.status(400).json({ error: '對話不足 2 條，無法精煉' });

  const sinceSeq = req.body?.since_seq !== undefined ? req.body.since_seq : undefined;
  const result = await requestRefine(paper.id, { sinceSeq });
  if (!result.ok) return res.status(502).json({ error: `精煉失敗：${result.reason}` });
  res.json({
    ok: true,
    run_id: result.run_id,
    version: result.version,
    idempotent: result.idempotent,
    stats: result.stats,
    carryover: result.carryover,
  });
});

// GET /api/papers/:id/carryover —— 讀最新 carryover（快取優先，可 ?refresh=1 回源）
router.get('/:id/carryover', async (req, res) => {
  const paper = db.prepare('SELECT id FROM papers WHERE id = ?').get(req.params.id);
  if (!paper) return res.status(404).json({ error: '論文不存在' });
  const sessionKey = sessionKeyFor(paper.id);

  if (req.query.refresh === '1') {
    await fetchCarryover(sessionKey);
  }
  const cached = getCachedCarryover(sessionKey);
  if (!cached) return res.status(404).json({ error: '尚無 carryover（先按「精煉本次共讀」）' });
  res.json({
    ok: true,
    session_key: sessionKey,
    version: cached.version,
    fetched_at: cached.fetchedAt,
    injected: isCarryoverInjected(paper.id),
    carryover: cached.payload,
  });
});

// POST /api/papers/:id/carryover/inject —— 「帶上」開關（拍板 #1：手動注入）
router.post('/:id/carryover/inject', (req, res) => {
  const paper = db.prepare('SELECT id FROM papers WHERE id = ?').get(req.params.id);
  if (!paper) return res.status(404).json({ error: '論文不存在' });
  const enabled = Boolean(req.body?.enabled);
  setCarryoverInjected(paper.id, enabled);
  res.json({ ok: true, paper_id: paper.id, injected: enabled });
});

// GET /api/papers/:id/claims/:claimId/provenance —— 溯源代理（前端不直連 gateway）
router.get('/:id/claims/:claimId/provenance', async (req, res) => {
  const paper = db.prepare('SELECT id FROM papers WHERE id = ?').get(req.params.id);
  if (!paper) return res.status(404).json({ error: '論文不存在' });
  const result = await fetchClaimProvenance(req.params.claimId);
  if (!result.ok) return res.status(502).json({ error: `溯源失敗：${result.reason}` });
  res.json(result.provenance);
});

export default router;
