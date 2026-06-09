import { Router } from 'express';
import { nanoid } from 'nanoid';
import db from '../db.js';
import { chatAboutPaper } from '../ai.js';
import { log } from '../logger.js';

const router = Router();

// POST /api/papers/:id/chat (SSE streaming)
router.post('/:id/chat', async (req, res) => {
  const paperId = req.params.id;
  const { message } = req.body;

  if (!message || !message.trim()) {
    return res.status(400).json({ error: '消息不能為空' });
  }

  const paper = db.prepare('SELECT * FROM papers WHERE id = ?').get(paperId);
  if (!paper) return res.status(404).json({ error: '論文不存在' });

  // Save user message
  const userMsgId = nanoid();
  db.prepare('INSERT INTO messages (id, paper_id, role, content) VALUES (?, ?, ?, ?)')
    .run(userMsgId, paperId, 'user', message.trim());
  log('INFO', `討論消息: ${paperId}, user (${message.length} 字)`);

  // Get history (last 50)
  const history = db.prepare(
    'SELECT role, content FROM messages WHERE paper_id = ? ORDER BY created_at ASC LIMIT 50'
  ).all(paperId);

  // Set up SSE
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  let fullContent = '';

  try {
    await chatAboutPaper(paper, history.slice(0, -1), message.trim(), (chunk) => {
      fullContent += chunk;
      res.write(`data: ${JSON.stringify({ type: 'delta', content: chunk })}\n\n`);
    });

    // Save assistant message
    const assistantMsgId = nanoid();
    db.prepare('INSERT INTO messages (id, paper_id, role, content) VALUES (?, ?, ?, ?)')
      .run(assistantMsgId, paperId, 'assistant', fullContent);
    log('INFO', `討論回覆: ${paperId}, assistant (${fullContent.length} 字)`);

    res.write(`data: ${JSON.stringify({ type: 'done', message_id: assistantMsgId })}\n\n`);
  } catch (err) {
    log('ERROR', `討論回覆失敗: ${paperId} — ${err.message}`);
    res.write(`data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`);
  }

  res.end();
});

// GET /api/papers/:id/chat
router.get('/:id/chat', (req, res) => {
  const messages = db.prepare(
    'SELECT id, role, content, created_at FROM messages WHERE paper_id = ? ORDER BY created_at ASC'
  ).all(req.params.id);
  res.json(messages);
});

export default router;
