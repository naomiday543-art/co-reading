import { Router } from 'express';
import { nanoid } from 'nanoid';
import db from '../db.js';

const router = Router();

// GET /api/tags
router.get('/tags', (_req, res) => {
  const tags = db.prepare('SELECT * FROM tags ORDER BY name').all();
  res.json(tags);
});

// POST /api/tags
router.post('/tags', (req, res) => {
  const { name, color } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: '標籤名稱不能為空' });
  }

  const existing = db.prepare('SELECT * FROM tags WHERE name = ?').get(name.trim());
  if (existing) return res.json(existing);

  const id = nanoid();
  db.prepare('INSERT INTO tags (id, name, color) VALUES (?, ?, ?)')
    .run(id, name.trim(), color || '#6366f1');

  res.json({ id, name: name.trim(), color: color || '#6366f1' });
});

// DELETE /api/tags/:id
router.delete('/tags/:id', (req, res) => {
  const tag = db.prepare('SELECT * FROM tags WHERE id = ?').get(req.params.id);
  if (!tag) return res.status(404).json({ error: '標籤不存在' });
  db.prepare('DELETE FROM tags WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// POST /api/papers/:id/tags
router.post('/papers/:id/tags', (req, res) => {
  const { tag_id } = req.body;
  const paper = db.prepare('SELECT * FROM papers WHERE id = ?').get(req.params.id);
  if (!paper) return res.status(404).json({ error: '論文不存在' });
  if (!tag_id) return res.status(400).json({ error: 'tag_id 不能為空' });

  try {
    db.prepare('INSERT OR IGNORE INTO paper_tags (paper_id, tag_id) VALUES (?, ?)')
      .run(req.params.id, tag_id);
  } catch {}

  res.json({ ok: true });
});

// DELETE /api/papers/:paperId/tags/:tagId
router.delete('/papers/:paperId/tags/:tagId', (req, res) => {
  db.prepare('DELETE FROM paper_tags WHERE paper_id = ? AND tag_id = ?')
    .run(req.params.paperId, req.params.tagId);
  res.json({ ok: true });
});

export default router;
