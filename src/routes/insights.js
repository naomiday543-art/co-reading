import { Router } from 'express';
import { nanoid } from 'nanoid';
import db from '../db.js';
import { log } from '../logger.js';
import { findRelatedInsights } from '../search.js';
import { resolveSourceMessageId, loadSourceConversation, backfillInsightSources } from '../insightSource.js';
import { computeInsightLinks, relinkAll, listInsightLinks } from '../insightLinks.js';

const router = Router();

const DIMENSIONS = ['概念', '延伸', '你的研究', '闪回', '共振', '悬题'];

/**
 * 列表用的一趟 SQL（工單 18 §2 B3：`link_count` 要 LEFT JOIN 算，別 N+1）。
 * 順手把「來源論文標題」也 JOIN 進來——本來是每條洞察一次 `paperStmt.get`。
 * `insight_links` 是無向表，一條洞察的連線數＝它出現在 a 或 b 的次數。
 */
const LIST_SELECT = `
  SELECT i.*, p.title AS source_paper_title, COALESCE(lc.cnt, 0) AS link_count
  FROM insights i
  LEFT JOIN papers p ON p.id = i.source_paper_id
  LEFT JOIN (
    SELECT id, COUNT(*) AS cnt FROM (
      SELECT a AS id FROM insight_links
      UNION ALL
      SELECT b AS id FROM insight_links
    ) GROUP BY id
  ) lc ON lc.id = i.id
  WHERE 1=1
`;

function shape(row) {
  return {
    ...row,
    tags_json: JSON.parse(row.tags_json || '[]'),
    source_message_id: row.source_message_id || '',
    source_paper_title: row.source_paper_title || null,
  };
}

// GET /api/insights
router.get('/insights', (req, res) => {
  const { dimension, source_paper_id } = req.query;

  let query = LIST_SELECT;
  const params = [];

  if (dimension) {
    query += ' AND i.dimension = ?';
    params.push(dimension);
  }
  if (source_paper_id) {
    query += ' AND i.source_paper_id = ?';
    params.push(source_paper_id);
  }

  query += ' ORDER BY i.updated_at DESC';

  res.json(db.prepare(query).all(...params).map(shape));
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
  const countStmt = db.prepare('SELECT COUNT(*) AS n FROM insight_links WHERE a = ? OR b = ?');
  const result = combined.map(ins => ({
    ...ins,
    tags_json: JSON.parse(ins.tags_json || '[]'),
    source_message_id: ins.source_message_id || '',
    source_paper_title: paperStmt.get(ins.source_paper_id)?.title || null,
    link_count: countStmt.get(ins.id, ins.id).n,
    score: ins.score,
  }));

  res.json(result);
});

// POST /api/insights/backfill-sources —— 存量洞察補來源訊息（工單 18 §2 A1，冪等）
router.post('/insights/backfill-sources', (req, res) => {
  res.json(backfillInsightSources());
});

// POST /api/insights/relink-all —— 全量重算聯想（工單 18 §2 B1，冪等、零 token）
router.post('/insights/relink-all', (req, res) => {
  const { total, links } = relinkAll();
  res.json({ ok: true, total, links });
});

// GET /api/insights/:id/links —— 一條洞察的相關洞察（工單 18 §2 B3）
router.get('/insights/:id/links', (req, res) => {
  const insight = db.prepare('SELECT id FROM insights WHERE id = ?').get(req.params.id);
  if (!insight) return res.status(404).json({ error: '洞察不存在' });
  res.json(listInsightLinks(req.params.id));
});

// GET /api/insights/:id
router.get('/insights/:id', (req, res) => {
  const insight = db.prepare('SELECT * FROM insights WHERE id = ?').get(req.params.id);
  if (!insight) return res.status(404).json({ error: '洞察不存在' });

  const paper = db.prepare('SELECT id, title FROM papers WHERE id = ?').get(insight.source_paper_id);
  const linkCount = db.prepare('SELECT COUNT(*) AS n FROM insight_links WHERE a = ? OR b = ?')
    .get(insight.id, insight.id).n;

  // 工單 18 §2 A2：浮現卡中段要的「那一問一答」一次拿齊，前端不用再打第二趟。
  const { source_message, source_question } = loadSourceConversation(insight);

  res.json({
    ...insight,
    tags_json: JSON.parse(insight.tags_json || '[]'),
    source_message_id: insight.source_message_id || '',
    source_paper_title: paper?.title || null,
    link_count: linkCount,
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

  // 聯想（§2 B1）：零 token、同步一個 FTS 查詢；reason 那段不等（預設也不會跑）。
  computeInsightLinks(id);

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

  // 只有 title／content 真的變了才重算聯想——改維度或標籤不影響 FTS 相似度（§2 B1）。
  const textChanged = (title !== undefined && title.trim() !== insight.title)
    || (content !== undefined && content.trim() !== insight.content);
  if (textChanged) computeInsightLinks(req.params.id);

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

  // insight_links 的兩個外鍵都是 ON DELETE CASCADE ⇒ 連線自己跟著走（§2 B1）。
  db.prepare('DELETE FROM insights WHERE id = ?').run(req.params.id);
  log('INFO', `洞察已刪除: ${req.params.id}`);
  res.json({ ok: true });
});

export { DIMENSIONS };
export default router;
