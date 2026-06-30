import { Router } from 'express';
import { nanoid } from 'nanoid';
import db from '../db.js';
import { chatAboutPaper } from '../ai.js';
import { log } from '../logger.js';

const router = Router();

function nextSeq(paperId) {
  const row = db.prepare(
    'SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM messages WHERE paper_id = ?'
  ).get(paperId);
  return row.n;
}

function getHistory(paperId) {
  return db.prepare(
    'SELECT role, content FROM messages WHERE paper_id = ? ORDER BY seq ASC'
  ).all(paperId);
}

// POST /api/papers/:id/chat (SSE streaming)
// ?regenerate=true — regenerate last AI answer
// ?continue=true  — generate AI answer from current history (no new user message)
router.post('/:id/chat', async (req, res) => {
  const paperId = req.params.id;
  const regenerate = req.query.regenerate === 'true';
  const continueChat = req.query.continue === 'true';
  const { message } = req.body;

  if (!regenerate && !continueChat && (!message || !message.trim())) {
    return res.status(400).json({ error: '消息不能為空' });
  }

  const paper = db.prepare('SELECT * FROM papers WHERE id = ?').get(paperId);
  if (!paper) return res.status(404).json({ error: '論文不存在' });

  // ── Regenerate mode ──
  if (regenerate) {
    const allMsgs = db.prepare(
      'SELECT * FROM messages WHERE paper_id = ? ORDER BY seq ASC'
    ).all(paperId);

    const lastAI = [...allMsgs].reverse().find(m => m.role === 'assistant');
    if (!lastAI) {
      return res.status(400).json({ error: '沒有可重新生成的 AI 回覆' });
    }
    // Guard against orphan tail (e.g. interrupted continue/edit left a trailing user message)
    if (allMsgs.length > 0 && allMsgs[allMsgs.length - 1].id !== lastAI.id) {
      return res.status(400).json({ error: '最後一條不是 AI 回覆，請改用「繼續」生成新回覆' });
    }

    // Save current content as first version if no versions exist yet
    let versions = [];
    try { versions = JSON.parse(lastAI.regen_versions || '[]'); } catch {}
    if (versions.length === 0) {
      versions.push({ id: lastAI.id, content: lastAI.content, ts: lastAI.created_at });
    }

    // History = everything BEFORE the last AI message
    const history = allMsgs.filter(m => m.seq < lastAI.seq).map(m => ({ role: m.role, content: m.content }));

    // Set up SSE
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    let fullContent = '';

    try {
      await chatAboutPaper(paper, history, null, (chunk) => {
        fullContent += chunk;
        res.write(`data: ${JSON.stringify({ type: 'delta', content: chunk })}\n\n`);
      });

      const newVersionId = nanoid();
      versions.push({ id: newVersionId, content: fullContent, ts: Date.now() });

      db.prepare(
        'UPDATE messages SET content = ?, regen_versions = ?, regen_idx = ? WHERE id = ?'
      ).run(fullContent, JSON.stringify(versions), versions.length - 1, lastAI.id);
      log('INFO', `重新生成: ${paperId}, 版本 ${versions.length}/${versions.length}`);

      res.write(`data: ${JSON.stringify({ type: 'done', message_id: newVersionId })}\n\n`);
    } catch (err) {
      log('ERROR', `重新生成失敗: ${paperId} — ${err.message}`);
      res.write(`data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`);
    }

    res.end();
    return;
  }

  // ── Continue mode ──
  if (continueChat) {
    const history = getHistory(paperId);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    let fullContent = '';

    try {
      await chatAboutPaper(paper, history, null, (chunk) => {
        fullContent += chunk;
        res.write(`data: ${JSON.stringify({ type: 'delta', content: chunk })}\n\n`);
      });

      const assistantMsgId = nanoid();
      const seq = nextSeq(paperId);
      db.prepare(
        'INSERT INTO messages (id, paper_id, role, content, created_at, seq) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(assistantMsgId, paperId, 'assistant', fullContent, Date.now(), seq);
      log('INFO', `繼續回覆: ${paperId}, assistant (${fullContent.length} 字)`);

      res.write(`data: ${JSON.stringify({ type: 'done', message_id: assistantMsgId })}\n\n`);
    } catch (err) {
      log('ERROR', `繼續回覆失敗: ${paperId} — ${err.message}`);
      res.write(`data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`);
    }

    res.end();
    return;
  }

  // ── Default: normal send ──
  // Save user message
  const userMsgId = nanoid();
  const userSeq = nextSeq(paperId);
  db.prepare(
    'INSERT INTO messages (id, paper_id, role, content, created_at, seq) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(userMsgId, paperId, 'user', message.trim(), Date.now(), userSeq);
  log('INFO', `討論消息: ${paperId}, user (${message.length} 字)`);

  // Get history (without the just-saved user message, to avoid duplicates in the prompt)
  const history = db.prepare(
    'SELECT role, content FROM messages WHERE paper_id = ? ORDER BY seq ASC'
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
    const assistantSeq = nextSeq(paperId);
    db.prepare(
      'INSERT INTO messages (id, paper_id, role, content, created_at, seq) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(assistantMsgId, paperId, 'assistant', fullContent, Date.now(), assistantSeq);
    log('INFO', `討論回覆: ${paperId}, assistant (${fullContent.length} 字)`);

    res.write(`data: ${JSON.stringify({ type: 'done', message_id: assistantMsgId })}\n\n`);
  } catch (err) {
    log('ERROR', `討論回覆失敗: ${paperId} — ${err.message}`);
    res.write(`data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`);
  }

  res.end();
});

// POST /api/papers/:id/chat/edit
router.post('/:id/chat/edit', (req, res) => {
  const paperId = req.params.id;
  const { msg_id, content } = req.body;

  if (!msg_id || !content || !content.trim()) {
    return res.status(400).json({ error: 'msg_id 和 content 為必填' });
  }

  const msg = db.prepare('SELECT * FROM messages WHERE id = ? AND paper_id = ?').get(msg_id, paperId);
  if (!msg) return res.status(404).json({ error: '消息不存在' });
  if (msg.role !== 'user') return res.status(400).json({ error: '只能編輯 user 消息' });

  const allMsgs = db.prepare(
    'SELECT * FROM messages WHERE paper_id = ? ORDER BY seq ASC'
  ).all(paperId);

  const idx = allMsgs.findIndex(m => m.id === msg_id);
  const tail = allMsgs.slice(idx);

  // Save tail to message_branches
  const branchId = nanoid();
  const tailJson = JSON.stringify(tail.map(m => ({
    id: m.id,
    role: m.role,
    content: m.content,
    created_at: m.created_at,
    seq: m.seq,
    regen_versions: m.regen_versions ? JSON.parse(m.regen_versions) : null,
    regen_idx: m.regen_idx,
    edited: m.edited,
    edit_branches: m.edit_branches ? JSON.parse(m.edit_branches) : null,
  })));

  if (tailJson.length > 1_000_000) {
    log('WARN', `tail_json 體積過大: ${paperId} — ${(tailJson.length / 1024 / 1024).toFixed(1)}MB`);
  }

  const transaction = db.transaction(() => {
    db.prepare(
      'INSERT INTO message_branches (id, paper_id, fork_message_id, tail_json, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(branchId, paperId, msg_id, tailJson, Date.now());

    // Update edit_branches on the message
    let editBranches = [];
    try { editBranches = JSON.parse(msg.edit_branches || '[]'); } catch {}
    editBranches.push({
      id: branchId,
      original_content: msg.content,
      tail_count: tail.length - 1,
      ts: Date.now(),
    });

    db.prepare(
      'UPDATE messages SET content = ?, edited = 1, edit_branches = ? WHERE id = ?'
    ).run(content.trim(), JSON.stringify(editBranches), msg_id);

    // Delete all messages after this one (by seq)
    db.prepare(
      'DELETE FROM messages WHERE paper_id = ? AND seq > ?'
    ).run(paperId, msg.seq);
  });

  transaction();
  log('INFO', `編輯消息: ${paperId}, ${msg_id} → 分支 ${branchId}`);
  res.json({ ok: true });
});

// POST /api/papers/:id/chat/branch/switch
router.post('/:id/chat/branch/switch', (req, res) => {
  const paperId = req.params.id;
  const { fork_id, branch_id } = req.body;

  if (!fork_id || !branch_id) {
    return res.status(400).json({ error: 'fork_id 和 branch_id 為必填' });
  }

  const branchRow = db.prepare('SELECT * FROM message_branches WHERE id = ?').get(branch_id);
  if (!branchRow) return res.status(404).json({ error: '分支不存在' });

  let tailJson;
  try { tailJson = JSON.parse(branchRow.tail_json); } catch {
    return res.status(500).json({ error: '分支數據損壞' });
  }

  if (branchRow.fork_message_id !== fork_id) {
    return res.status(400).json({ error: 'branch_id 不匹配 fork_id' });
  }

  const forkMsg = db.prepare('SELECT * FROM messages WHERE id = ? AND paper_id = ?').get(fork_id, paperId);
  if (!forkMsg) return res.status(404).json({ error: 'fork 消息不存在' });

  const transaction = db.transaction(() => {
    // 1. Save current tail as a new branch
    const allMsgs = db.prepare(
      'SELECT * FROM messages WHERE paper_id = ? ORDER BY seq ASC'
    ).all(paperId);

    const forkIdx = allMsgs.findIndex(m => m.id === fork_id);
    const currentTail = allMsgs.slice(forkIdx);

    const savedId = nanoid();
    const currentTailJson = JSON.stringify(currentTail.map(m => ({
      id: m.id,
      role: m.role,
      content: m.content,
      created_at: m.created_at,
      seq: m.seq,
      regen_versions: m.regen_versions ? JSON.parse(m.regen_versions) : null,
      regen_idx: m.regen_idx,
      edited: m.edited,
      edit_branches: m.edit_branches ? JSON.parse(m.edit_branches) : null,
    })));

    db.prepare(
      'INSERT INTO message_branches (id, paper_id, fork_message_id, tail_json, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(savedId, paperId, fork_id, currentTailJson, Date.now());

    // 2. Delete messages from fork point onward
    db.prepare('DELETE FROM messages WHERE paper_id = ? AND seq >= ?').run(paperId, forkMsg.seq);

    // 3. Insert tail messages from the branch
    const insertStmt = db.prepare(
      'INSERT INTO messages (id, paper_id, role, content, created_at, seq, regen_versions, regen_idx, edited, edit_branches) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    );

    for (const m of tailJson) {
      insertStmt.run(
        m.id,
        paperId,
        m.role,
        m.content,
        m.created_at,
        m.seq,
        m.regen_versions ? JSON.stringify(m.regen_versions) : null,
        m.regen_idx ?? null,
        m.edited ?? 0,
        m.edit_branches ? JSON.stringify(m.edit_branches) : null
      );
    }

    // 4. Update edit_branches on fork message (after insert to avoid overwrite)
    let editBranches = [];
    try { editBranches = JSON.parse(forkMsg.edit_branches || '[]'); } catch {}
    editBranches = editBranches.filter(b => b.id !== branch_id);
    editBranches.push({
      id: savedId,
      original_content: currentTail[0]?.content?.slice(0, 80) || '',
      tail_count: currentTail.length - 1,
      ts: Date.now(),
    });

    db.prepare('UPDATE messages SET edit_branches = ? WHERE id = ?').run(
      JSON.stringify(editBranches), fork_id
    );

    // 5. Delete the consumed branch row
    db.prepare('DELETE FROM message_branches WHERE id = ?').run(branch_id);
  });

  transaction();
  log('INFO', `分支切換: ${paperId}, ${fork_id} → ${branch_id}`);
  res.json({ ok: true });
});

// GET /api/papers/:id/chat
router.get('/:id/chat', (req, res) => {
  const messages = db.prepare(
    'SELECT id, role, content, created_at, seq, regen_versions, regen_idx, edited, edit_branches FROM messages WHERE paper_id = ? ORDER BY seq ASC'
  ).all(req.params.id);

  const result = messages.map(m => ({
    id: m.id,
    role: m.role,
    content: m.content,
    created_at: m.created_at,
    seq: m.seq,
    regen_versions: m.regen_versions ? JSON.parse(m.regen_versions) : [],
    regen_idx: m.regen_idx ?? 0,
    edited: m.edited ?? 0,
    edit_branches: m.edit_branches ? JSON.parse(m.edit_branches) : [],
  }));

  res.json(result);
});

export default router;
