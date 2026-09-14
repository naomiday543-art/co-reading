import { Router } from 'express';
import { nanoid } from 'nanoid';
import db from '../db.js';
import { log } from '../logger.js';
import { findRelatedInsights } from '../search.js';
import { resolveSourceMessageId, loadSourceConversation, backfillInsightSources } from '../insightSource.js';

const router = Router();

const DIMENSIONS = ['概念', '延伸', '你的研究', '闪回', '共振', '悬题'];

// GET /api/insights
router.get('/insights', (req, res) => {
  const { dimension, source_paper_id } = req.query;

  let query = 'SELECT * FROM insights WHERE 1=1';
  const params = [];

  if (dimension) {
    query += ' AND dimension = ?';
    params.push(dimension);
  }
  if (source_paper_id) {
    query += ' AND source_paper_id = ?';
    params.push(source_paper_id);
  }

  query += ' ORDER BY updated_at DESC';

  const insights = db.prepare(query).all(...params);

  // Attach source paper title for display
  const paperStmt = db.prepare('SELECT id, title FROM papers WHERE id = ?');
  const result = insights.map(ins => {
    const paper = paperStmt.get(ins.source_paper_id);
    return {
      ...ins,
      tags_json: JSON.parse(ins.tags_json || '[]'),
      source_paper_title: paper?.title || null,
    };
  });

  res.json(result);
});

// GET /api/insights/related?paper_id=...
router.get('/insights/related', (req, res) => {
  const { paper_id } = req.query;
  if (!paper_id) return res.status(400).json({ error: 'paper_id is required' });

  const paper = db.prepare('SELECT * FROM papers WHERE id = ?').get(paper_id);
  if (!paper) return res.status(404).json({ error: '論文不存在' });

  const ownInsights = db.prepare(
    'SELECT * FROM insights WHERE source_paper_id = ? ORDER BY updated_at DESC LIMIT 5'
  ).all(paper_id);

  // Use FTS5 trigram search for related insights
  const related = findRelatedInsights(paper_id, 5);

  const combined = [...ownInsights, ...related].slice(0, 10);

  const paperStmt = db.prepare('SELECT id, title FROM papers WHERE id = ?');
  const result = combined.map(ins => ({
    ...ins,
    tags_json: JSON.parse(ins.tags_json || '[]'),
    source_paper_title: paperStmt.get(ins.source_paper_id)?.title || null,
    score: ins.score,
  }));

  res.json(result);
});

// POST /api/insights/backfill-sources —— 存量洞察補來源訊息（工單 18 §2 A1，冪等）
router.post('/insights/backfill-sources', (req, res) => {
  res.json(backfillInsightSources());
});

// GET /api/insights/:id
router.get('/insights/:id', (req, res) => {
  const insight = db.prepare('SELECT * FROM insights WHERE id = ?').get(req.params.id);
  if (!insight) return res.status(404).json({ error: '洞察不存在' });

  const paper = db.prepare('SELECT id, title FROM papers WHERE id = ?').get(insight.source_paper_id);

  // 工單 18 §2 A2：浮現卡中段要的「那一問一答」一次拿齊，前端不用再打第二趟。
  const { source_message, source_question } = loadSourceConversation(insight);

  res.json({
    ...insight,
    tags_json: JSON.parse(insight.tags_json || '[]'),
    source_message_id: insight.source_message_id || '',
    source_paper_title: paper?.title || null,
    source_message,
    source_question,
  });
});

// POST /api/insights
router.post('/insights', (req, res) => {
  const { dimension, title, content, source_paper_id, source_context, source_message_id, tags } = req.body;

  if (!title || !title.trim()) {
    return res.status(400).json({ error: '標題不能為空' });
  }
  if (!content || !content.trim()) {
    return res.status(400).json({ error: '內容不能為空' });
  }

  const id = nanoid();
  const dim = DIMENSIONS.includes(dimension) ? dimension : '延伸';
  const tagsJson = JSON.stringify(Array.isArray(tags) ? tags : []);
  // 驗不過就存空——洞察本身永遠存得成（工單 18 §2 A1：不 400）。
  const sourceMessageId = resolveSourceMessageId(source_message_id, source_paper_id || null);

  db.prepare(`INSERT INTO insights (id, dimension, title, content, source_paper_id, source_context, source_message_id, tags_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id, dim, title.trim(), content.trim(),
    source_paper_id || null, source_context || '', sourceMessageId, tagsJson
  );

  log('INFO', `洞察已創建: ${id} [${dim}] ${title.trim().slice(0, 40)}`);

  const insight = db.prepare('SELECT * FROM insights WHERE id = ?').get(id);
  res.json({
    ...insight,
    tags_json: JSON.parse(insight.tags_json || '[]'),
    source_message_id: insight.source_message_id || '',
  });
});

// PATCH /api/insights/:id
router.patch('/insights/:id', (req, res) => {
  const insight = db.prepare('SELECT * FROM insights WHERE id = ?').get(req.params.id);
  if (!insight) return res.status(404).json({ error: '洞察不存在' });

  const { dimension, title, content, source_paper_id, source_context, source_message_id, tags } = req.body;

  if (dimension !== undefined && !DIMENSIONS.includes(dimension)) {
    return res.status(400).json({ error: `無效的維度: ${dimension}` });
  }

  const updates = [];
  const params = [];

  if (dimension !== undefined) { updates.push('dimension = ?'); params.push(dimension); }
  if (title !== undefined) { updates.push('title = ?'); params.push(title.trim()); }
  if (content !== undefined) { updates.push('content = ?'); params.push(content.trim()); }
  if (source_paper_id !== undefined) { updates.push('source_paper_id = ?'); params.push(source_paper_id || null); }
  if (source_context !== undefined) { updates.push('source_context = ?'); params.push(source_context); }
  if (source_message_id !== undefined) {
    const paperId = source_paper_id !== undefined
      ? (source_paper_id || null)
      : insight.source_paper_id;
    updates.push('source_message_id = ?');
    params.push(resolveSourceMessageId(source_message_id, paperId));
  }
  if (tags !== undefined) { updates.push('tags_json = ?'); params.push(JSON.stringify(tags)); }

  if (updates.length > 0) {
    updates.push("updated_at = strftime('%s','now') * 1000");
    params.push(req.params.id);
    db.prepare(`UPDATE insights SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  }

  const updated = db.prepare('SELECT * FROM insights WHERE id = ?').get(req.params.id);
  res.json({
    ...updated,
    tags_json: JSON.parse(updated.tags_json || '[]'),
    source_message_id: updated.source_message_id || '',
  });
});

// DELETE /api/insights/:id
router.delete('/insights/:id', (req, res) => {
  const insight = db.prepare('SELECT * FROM insights WHERE id = ?').get(req.params.id);
  if (!insight) return res.status(404).json({ error: '洞察不存在' });

  db.prepare('DELETE FROM insights WHERE id = ?').run(req.params.id);
  log('INFO', `洞察已刪除: ${req.params.id}`);
  res.json({ ok: true });
});

export { DIMENSIONS };
export default router;
