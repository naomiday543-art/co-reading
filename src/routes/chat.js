import { Router } from 'express';
import { nanoid } from 'nanoid';
import db from '../db.js';
import { chatAboutPaper, ChatAbortedError } from '../ai.js';
import { parseQuote, validateQuote, renderQuotedMessage } from '../quote.js';
import { log } from '../logger.js';

const router = Router();

/** `thinking` 事件的節流間隔。推理鏈是逐 chunk 來的，不節流會變成每秒幾十發 SSE。 */
const THINKING_THROTTLE_MS = 500;

function sse(res, payload) {
  if (res.writableEnded || res.destroyed) return;
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function openStream(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
}

/**
 * 跑一輪討論並把事件推到 SSE 上。三個入口（正常送出／重新生成／繼續）共用。
 *
 * 這裡新增三件事（工單 12 §3.3／§3.4）：
 * 1. `thinking`／`thinking_done`：**只送字數與秒數，不送思考內容**（§4 紅線）。
 *    節流 500ms，正文第一個 delta 到時補一發 thinking_done 讓等待提示消失。
 * 2. 她按「停止」或關掉頁面 ⇒ `req.on('close')` ⇒ AbortController ⇒ 上游那條連線也收掉，
 *    不再替一個沒人看的答案付錢。取消不是故障：不寫 DB、不印紅框。
 * 3. 失敗時 `error` 事件帶 `partial`（已吐正文長度）與 `hint`，前端據此保住半截。
 *
 * @returns {{ok: boolean, content: string, aborted: boolean}}
 */
async function runChatStream(res, { paper, history, userMessage, hint, quote = null, label = '討論回覆' }) {
  const controller = new AbortController();
  // 掛 `res` 不是 `req`：Express 讀完 body 之後 `req` 立刻就 'close' 了（Node ≥16 的
  // IncomingMessage 語意），掛在那邊會在打上游之前就自己把自己 abort 掉。
  // `res` 的 'close' 才是「這條連線沒了」——正常結束時我們在 finally 先把它摘掉。
  const onClose = () => controller.abort();
  res.on('close', onClose);

  const startedAt = Date.now();
  let fullContent = '';
  let reasoningChars = 0;
  let lastThinkingAt = 0;
  let thinkingDone = false;

  try {
    await chatAboutPaper(paper, history, userMessage, (chunk) => {
      if (!thinkingDone) {
        thinkingDone = true;
        sse(res, {
          type: 'thinking_done',
          chars: reasoningChars,
          seconds: Number(((Date.now() - startedAt) / 1000).toFixed(1)),
        });
      }
      fullContent += chunk;
      sse(res, { type: 'delta', content: chunk });
    }, {
      signal: controller.signal,
      // 工單 14 §3.2：選段的位置脈絡由 `chatAboutPaper` 接在變動區（insightText 之後）。
      quote,
      onReasoning: (text) => {
        reasoningChars += text.length;
        const now = Date.now();
        if (now - lastThinkingAt < THINKING_THROTTLE_MS) return;
        lastThinkingAt = now;
        sse(res, { type: 'thinking', chars: reasoningChars });
      },
    });

    return { ok: true, content: fullContent, aborted: false };
  } catch (err) {
    if (err instanceof ChatAbortedError || controller.signal.aborted) {
      log('INFO', `討論中止: ${paper.id} — 已生成 ${fullContent.length} 字，未保存`);
      return { ok: false, content: fullContent, aborted: true };
    }
    log('ERROR', `${label}失敗: ${paper.id} — ${err.message}`);
    sse(res, {
      type: 'error',
      message: err.message,
      partial: fullContent.length,
      ...(hint ? { hint } : {}),
    });
    return { ok: false, content: fullContent, aborted: false };
  } finally {
    res.off('close', onClose);
  }
}

function nextSeq(paperId) {
  const row = db.prepare(
    'SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM messages WHERE paper_id = ?'
  ).get(paperId);
  return row.n;
}

/**
 * 給模型的歷史（工單 14 §3.1）。
 *
 * 三個入口（送出／重新生成／繼續）都走這一顆，**不要各自 SELECT**：有 quote 的 user
 * 訊息要在這裡渲染成單一字串，而且用的是跟送出當輪同一顆 `renderQuotedMessage`
 * ⇒ 同一輪不管回放幾次都逐字相同，cache 前綴才穩（§5.2 的釘子）。
 * DB 的 `content` 依舊只有她打的字。
 *
 * `lastQuote` 是歷史裡最後一則 user 訊息的引用：重新生成／繼續沒有新的 userMessage，
 * 位置脈絡要從這裡拿，否則同一個問題重答一次就少了上下文。
 *
 * @returns {{history: Array<{role: string, content: string}>, lastQuote: object|null}}
 */
function loadHistory(paper, { beforeSeq = null } = {}) {
  const rows = beforeSeq === null
    ? db.prepare(
      'SELECT role, content, quote FROM messages WHERE paper_id = ? ORDER BY seq ASC'
    ).all(paper.id)
    : db.prepare(
      'SELECT role, content, quote FROM messages WHERE paper_id = ? AND seq < ? ORDER BY seq ASC'
    ).all(paper.id, beforeSeq);

  let lastQuote = null;
  const history = rows.map(m => {
    if (m.role !== 'user') return { role: m.role, content: m.content };
    const quote = parseQuote(m.quote);
    // 最後一則 user 沒引用就是沒有，不沿用更早那次的。`question` 只是傳給 ai.js 當洞察
    // 搜尋的關鍵字（不進 DB 的 quote JSON、不影響驗證）。
    lastQuote = quote ? { ...quote, question: m.content } : null;
    return { role: m.role, content: renderQuotedMessage(quote, m.content, paper.full_text) };
  });

  return { history, lastQuote };
}

// POST /api/papers/:id/chat (SSE streaming)
// ?regenerate=true — regenerate last AI answer
// ?continue=true  — generate AI answer from current history (no new user message)
router.post('/:id/chat', async (req, res) => {
  const paperId = req.params.id;
  const regenerate = req.query.regenerate === 'true';
  const continueChat = req.query.continue === 'true';
  const { message, quote: rawQuote } = req.body;

  const paper = db.prepare('SELECT * FROM papers WHERE id = ?').get(paperId);
  if (!paper) return res.status(404).json({ error: '論文不存在' });

  // 工單 14 §3.1：只選了一段、沒打字也算數（用預設問題）——所以「空」的判斷要在驗過
  // quote 之後。驗不過一律 400，不寫 DB、不打上游。
  let quote = null;
  if (!regenerate && !continueChat && rawQuote !== undefined && rawQuote !== null && rawQuote !== '') {
    const verdict = validateQuote(paper.full_text, rawQuote);
    if (!verdict.ok) return res.status(400).json({ error: verdict.error });
    quote = verdict.quote;
  }

  if (!regenerate && !continueChat && !quote && (!message || !message.trim())) {
    return res.status(400).json({ error: '消息不能為空' });
  }

  // ── Regenerate mode ──
  if (regenerate) {
    const allMsgs = db.prepare(
      'SELECT * FROM messages WHERE paper_id = ? ORDER BY seq ASC'
    ).all(paperId);

    const lastAI = [...allMsgs].reverse().find(m => m.role === 'assistant');
    if (!lastAI) {
      return res.status(400).json({ error: '沒有可重新生成的 AI 回覆' });
    }
    const lastMsg = allMsgs[allMsgs.length - 1];
    if (lastMsg.id !== lastAI.id) {
      // 孤兒 user 尾巴（上一輪串流失敗／被中止，問題寫進去了但回答沒有）。
      // 工單 12 §3.2 二選一，選「放寬」：這時候她要的就是「把這個問題回答掉」，
      // 也就是「繼續」。再叫她自己看懂一句 400 去換一顆按鈕是多一步。
      // 完全沒有 AI 回覆過的那種（上面那個 400）維持原樣——那不是孤兒尾巴，是還沒開始。
      if (lastMsg.role === 'user') {
        return runContinue(res, { paper, paperId });
      }
      return res.status(400).json({ error: '最後一條不是 AI 回覆，請改用「繼續」生成新回覆' });
    }

    // Save current content as first version if no versions exist yet
    let versions = [];
    try { versions = JSON.parse(lastAI.regen_versions || '[]'); } catch {}
    if (versions.length === 0) {
      versions.push({ id: lastAI.id, content: lastAI.content, ts: lastAI.created_at });
    }

    // History = everything BEFORE the last AI message
    const { history, lastQuote } = loadHistory(paper, { beforeSeq: lastAI.seq });

    // Set up SSE
    openStream(res);

    const outcome = await runChatStream(res, {
      paper, history, userMessage: null, quote: lastQuote, label: '重新生成',
    });

    if (outcome.ok) {
      const newVersionId = nanoid();
      versions.push({ id: newVersionId, content: outcome.content, ts: Date.now() });

      db.prepare(
        'UPDATE messages SET content = ?, regen_versions = ?, regen_idx = ? WHERE id = ?'
      ).run(outcome.content, JSON.stringify(versions), versions.length - 1, lastAI.id);
      log('INFO', `重新生成: ${paperId}, 版本 ${versions.length}/${versions.length}`);

      sse(res, { type: 'done', message_id: newVersionId });
    }

    res.end();
    return;
  }

  // ── Continue mode ──
  if (continueChat) {
    return runContinue(res, { paper, paperId });
  }

  // ── Default: normal send ──
  // Save user message
  const typed = (message || '').trim();
  const userMsgId = nanoid();
  const userSeq = nextSeq(paperId);
  db.prepare(
    'INSERT INTO messages (id, paper_id, role, content, created_at, seq, quote) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(userMsgId, paperId, 'user', typed, Date.now(), userSeq, quote ? JSON.stringify(quote) : '');
  log('INFO', `討論消息: ${paperId}, user (${typed.length} 字`
    + `${quote ? `, 引用 ${quote.end - quote.start} 字` : ''})`);

  // Get history (without the just-saved user message, to avoid duplicates in the prompt)
  const { history } = loadHistory(paper, { beforeSeq: userSeq });

  // Set up SSE
  openStream(res);

  // user 訊息在開串流之前就已經寫進 DB 了（上面幾行）。失敗時 assistant 不寫 ⇒ 留下
  // 一條孤兒 user 尾巴，所以 error 事件要告訴她怎麼救回來。
  const outcome = await runChatStream(res, {
    paper,
    history,
    // 送模型的是「引用＋問題」渲染後的整串；DB 裡那一列仍然只有 `typed`（§4 紅線）。
    userMessage: renderQuotedMessage(quote, typed, paper.full_text),
    quote: quote ? { ...quote, question: typed } : null,
    hint: '你的問題已保存——按「重新生成」或「繼續」都能讓 AI 接著回答',
  });

  if (outcome.ok) {
    // Save assistant message
    const assistantMsgId = nanoid();
    const assistantSeq = nextSeq(paperId);
    db.prepare(
      'INSERT INTO messages (id, paper_id, role, content, created_at, seq) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(assistantMsgId, paperId, 'assistant', outcome.content, Date.now(), assistantSeq);
    log('INFO', `討論回覆: ${paperId}, assistant (${outcome.content.length} 字)`);

    sse(res, { type: 'done', message_id: assistantMsgId });
  }

  res.end();
});

/**
 * 「繼續」：不寫 user 訊息，直接就現有歷史生成一條新的 assistant。
 * 編輯訊息後自動觸發，也是孤兒 user 尾巴的救援路徑（見上面 regenerate 的放寬）。
 */
async function runContinue(res, { paper, paperId }) {
  const { history, lastQuote } = loadHistory(paper);

  openStream(res);

  const outcome = await runChatStream(res, {
    paper, history, userMessage: null, quote: lastQuote, label: '繼續回覆',
  });

  if (outcome.ok) {
    const assistantMsgId = nanoid();
    const seq = nextSeq(paperId);
    db.prepare(
      'INSERT INTO messages (id, paper_id, role, content, created_at, seq) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(assistantMsgId, paperId, 'assistant', outcome.content, Date.now(), seq);
    log('INFO', `繼續回覆: ${paperId}, assistant (${outcome.content.length} 字)`);

    sse(res, { type: 'done', message_id: assistantMsgId });
  }

  res.end();
}

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
    quote: m.quote || '',                    // 工單 14：分支往返不能把引用弄丟
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
      quote: m.quote || '',
    })));

    db.prepare(
      'INSERT INTO message_branches (id, paper_id, fork_message_id, tail_json, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(savedId, paperId, fork_id, currentTailJson, Date.now());

    // 2. Delete messages from fork point onward
    db.prepare('DELETE FROM messages WHERE paper_id = ? AND seq >= ?').run(paperId, forkMsg.seq);

    // 3. Insert tail messages from the branch
    const insertStmt = db.prepare(
      'INSERT INTO messages (id, paper_id, role, content, created_at, seq, regen_versions, regen_idx, edited, edit_branches, quote) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
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
        m.edit_branches ? JSON.stringify(m.edit_branches) : null,
        // 舊分支（工單 14 之前存的）沒有這個欄位 ⇒ ''，不是 undefined（better-sqlite3 會炸）
        m.quote || ''
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
    'SELECT id, role, content, created_at, seq, regen_versions, regen_idx, edited, edit_branches, quote FROM messages WHERE paper_id = ? ORDER BY seq ASC'
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
    // 工單 14：氣泡上的引用塊要靠它畫；壞掉的 JSON 一律當作沒有引用（parseQuote 不拋）
    quote: parseQuote(m.quote),
  }));

  res.json(result);
});

export default router;
