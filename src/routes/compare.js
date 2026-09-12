// POST /api/compare —— 多篇摘要對比（工單 09 §3.1）。
//
// 掛點是 `/api`（server.js 的 `app.use('/api', compareRouter)`），**不是** `/api/papers`：
// papers.js／chat.js 同掛 `/api/papers` 且有 `/:id` 路由，掛進去會被 `/:id` 吃掉。
import { Router } from 'express';
import db from '../db.js';
import { log } from '../logger.js';
import { comparePapers, MIN_PAPERS, MAX_PAPERS } from '../compare.js';

const router = Router();

// 只撈對比要用的欄位——full_text 一個字都不進來（工單 §5 紅線）。
const SELECT_FOR_COMPARE = `SELECT id, title, authors, year, analyze_status,
    summary_bg, summary_methods, summary_results, summary_conclusions, summary_limitations
  FROM papers WHERE id = ?`;

router.post('/compare', async (req, res) => {
  const ids = req.body?.paper_ids;

  if (!Array.isArray(ids) || ids.length < MIN_PAPERS || ids.length > MAX_PAPERS) {
    return res.status(400).json({
      error: `要對比 ${MIN_PAPERS}–${MAX_PAPERS} 篇論文（收到 ${Array.isArray(ids) ? ids.length : 0} 篇）`,
    });
  }

  const stmt = db.prepare(SELECT_FOR_COMPARE);
  const papers = [];
  for (const id of ids) {
    const paper = stmt.get(id);
    if (!paper) return res.status(404).json({ error: `論文不存在: ${id}` });
    papers.push(paper);
  }

  // 沒通讀完就沒有五段摘要，對比無料可吃——明確告訴她是哪幾篇，前端才點得出來。
  const notAnalyzed = papers.filter(p => p.analyze_status !== 'done');
  if (notAnalyzed.length > 0) {
    return res.status(400).json({
      error: '有論文還沒通讀完，先通讀才能對比',
      not_analyzed: notAnalyzed.map(p => ({ id: p.id, title: p.title })),
    });
  }

  try {
    const { table, analysis, model, elapsed_ms } = await comparePapers(papers);

    log('INFO', `[COMPARE] ids=${ids.join(',')} elapsed=${elapsed_ms} model=${model}`);

    res.json({
      papers: papers.map(p => ({
        id: p.id,
        title: p.title,
        authors: p.authors,
        year: p.year,
      })),
      table,
      analysis,
      model,
      elapsed_ms,
    });
  } catch (err) {
    log('ERROR', `[COMPARE] ids=${ids.join(',')} 失敗: ${err.message}`);
    res.status(502).json({ error: err.message });
  }
});

export default router;
