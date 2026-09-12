import { Router } from 'express';
import { nanoid } from 'nanoid';
import db from '../db.js';
import { DESCRIPTION_MAX } from '../directions.js';

const router = Router();

// 方向描述（工單 07 §3.1）：字串、trim、上限 2000 字；型別或長度不合直接 400，
// 不替她截斷（注入 prompt 的字是原樣的，截斷會讓她以為存進去了）。
function normalizeDescription(raw) {
  if (typeof raw !== 'string') return { error: '描述必須是字串' };
  const text = raw.trim();
  if (text.length > DESCRIPTION_MAX) return { error: `描述最長 ${DESCRIPTION_MAX} 字` };
  return { text };
}

// GET /api/tree - returns nested tree with paper counts
router.get('/tree', (_req, res) => {
  const nodes = db.prepare('SELECT * FROM tree_nodes ORDER BY sort_order, name').all();

  // Count papers per node
  const countStmt = db.prepare('SELECT COUNT(*) as count FROM papers WHERE tree_node_id = ?');

  function buildTree(parentId) {
    const children = nodes.filter(n => n.parent_id === parentId);
    return children.map(n => {
      const { count } = countStmt.get(n.id);
      return {
        ...n,
        description: n.description || '',
        paper_count: count,
        children: buildTree(n.id),
      };
    });
  }

  const tree = buildTree(null);
  res.json(tree);
});

// POST /api/tree
router.post('/tree', (req, res) => {
  const { name, parent_id, description } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: '名稱不能為空' });
  }

  let desc = '';
  if (description !== undefined) {
    const normalized = normalizeDescription(description);
    if (normalized.error) return res.status(400).json({ error: normalized.error });
    desc = normalized.text;
  }

  const id = nanoid();
  const maxOrder = db.prepare(
    'SELECT MAX(sort_order) as max FROM tree_nodes WHERE parent_id IS ?'
  ).get(parent_id || null);

  db.prepare('INSERT INTO tree_nodes (id, parent_id, name, sort_order, description) VALUES (?, ?, ?, ?, ?)')
    .run(id, parent_id || null, name.trim(), (maxOrder?.max || 0) + 1, desc);

  res.json({ id, name: name.trim(), parent_id: parent_id || null, description: desc });
});

// PATCH /api/tree/:id
router.patch('/tree/:id', (req, res) => {
  const node = db.prepare('SELECT * FROM tree_nodes WHERE id = ?').get(req.params.id);
  if (!node) return res.status(404).json({ error: '節點不存在' });

  const { name, parent_id, sort_order, description } = req.body;
  if (description !== undefined) {
    const normalized = normalizeDescription(description);
    if (normalized.error) return res.status(400).json({ error: normalized.error });
    db.prepare('UPDATE tree_nodes SET description = ? WHERE id = ?').run(normalized.text, req.params.id);
  }
  if (name !== undefined) {
    db.prepare('UPDATE tree_nodes SET name = ? WHERE id = ?').run(name.trim(), req.params.id);
  }
  if (parent_id !== undefined) {
    db.prepare('UPDATE tree_nodes SET parent_id = ? WHERE id = ?').run(parent_id || null, req.params.id);
  }
  if (sort_order !== undefined) {
    db.prepare('UPDATE tree_nodes SET sort_order = ? WHERE id = ?').run(sort_order, req.params.id);
  }

  const updated = db.prepare('SELECT * FROM tree_nodes WHERE id = ?').get(req.params.id);
  res.json(updated);
});

// DELETE /api/tree/:id
router.delete('/tree/:id', (req, res) => {
  const node = db.prepare('SELECT * FROM tree_nodes WHERE id = ?').get(req.params.id);
  if (!node) return res.status(404).json({ error: '節點不存在' });

  // Move children to parent
  db.prepare('UPDATE tree_nodes SET parent_id = ? WHERE parent_id = ?')
    .run(node.parent_id || null, req.params.id);

  // Clear paper assignments
  db.prepare('UPDATE papers SET tree_node_id = NULL WHERE tree_node_id = ?').run(req.params.id);

  // Delete the node
  db.prepare('DELETE FROM tree_nodes WHERE id = ?').run(req.params.id);

  res.json({ ok: true });
});

export default router;
