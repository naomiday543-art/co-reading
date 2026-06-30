import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import db from '../src/db.js';
import { nanoid } from 'nanoid';

let baseUrl;

describe('Chat Routes', () => {
  let server;

  before(async () => {
    // Start the server on a random port for tests
    const { default: app } = await import('../src/server.js');
    await new Promise((resolve) => {
      server = app.listen(0, () => {
        baseUrl = `http://127.0.0.1:${server.address().port}`;
        resolve();
      });
    });
  });

  after(() => {
    if (server) server.close();
  });

  describe('POST /chat/edit', () => {
    const paperId = `test_paper_${Date.now()}`;
    let userMsgId, aiMsgId;

    before(() => {
      db.prepare(`INSERT INTO papers (id, title, full_text, summary_bg, summary_methods, summary_results, summary_conclusions, summary_limitations)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
        paperId, 'Test Paper', 'Test full text.', 'bg', 'methods', 'results', 'conclusions', 'limitations'
      );
    });

    after(() => {
      db.prepare('DELETE FROM message_branches WHERE paper_id = ?').run(paperId);
      db.prepare('DELETE FROM messages WHERE paper_id = ?').run(paperId);
      db.prepare('DELETE FROM papers WHERE id = ?').run(paperId);
    });

    it('edits user message, saves branch, truncates tail', async () => {
      userMsgId = nanoid();
      aiMsgId = nanoid();
      db.prepare(
        'INSERT INTO messages (id, paper_id, role, content, created_at, seq) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(userMsgId, paperId, 'user', 'What is this paper about?', Date.now(), 1);
      db.prepare(
        'INSERT INTO messages (id, paper_id, role, content, created_at, seq) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(aiMsgId, paperId, 'assistant', 'This paper is about testing.', Date.now() + 1, 2);

      const res = await fetch(`${baseUrl}/api/papers/${paperId}/chat/edit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ msg_id: userMsgId, content: 'New question?' }),
      });
      const data = await res.json();

      assert.equal(res.status, 200);
      assert.equal(data.ok, true);

      const msg = db.prepare('SELECT * FROM messages WHERE id = ?').get(userMsgId);
      assert.equal(msg.content, 'New question?');
      assert.equal(msg.edited, 1);
      const branches = JSON.parse(msg.edit_branches || '[]');
      assert.equal(branches.length, 1);
      assert.equal(branches[0].original_content, 'What is this paper about?');
      assert.equal(branches[0].tail_count, 1);

      const tailCount = db.prepare(
        'SELECT COUNT(*) as cnt FROM messages WHERE paper_id = ? AND seq > ?'
      ).get(paperId, msg.seq);
      assert.equal(tailCount.cnt, 0);
    });

    it('rejects non-user message edit with 400', async () => {
      const pid = `test_paper_${Date.now() + 1}`;
      db.prepare(`INSERT INTO papers (id, title, full_text, summary_bg, summary_methods, summary_results, summary_conclusions, summary_limitations)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
        pid, 'P2', '', '', '', '', '', ''
      );
      const aId = nanoid();
      db.prepare(
        'INSERT INTO messages (id, paper_id, role, content, created_at, seq) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(aId, pid, 'assistant', 'reply', Date.now(), 1);

      const res = await fetch(`${baseUrl}/api/papers/${pid}/chat/edit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ msg_id: aId, content: 'edit attempt' }),
      });
      const data = await res.json();
      assert.equal(res.status, 400);
      assert.ok(data.error.includes('user'));

      db.prepare('DELETE FROM messages WHERE paper_id = ?').run(pid);
      db.prepare('DELETE FROM papers WHERE id = ?').run(pid);
    });
  });

  describe('POST /chat/branch/switch', () => {
    const paperId = `test_paper_switch_${Date.now()}`;
    let userMsgId, aiMsgId;

    before(() => {
      db.prepare(`INSERT INTO papers (id, title, full_text, summary_bg, summary_methods, summary_results, summary_conclusions, summary_limitations)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
        paperId, 'Switch Test', '', '', '', '', '', ''
      );
    });

    after(() => {
      db.prepare('DELETE FROM message_branches WHERE paper_id = ?').run(paperId);
      db.prepare('DELETE FROM messages WHERE paper_id = ?').run(paperId);
      db.prepare('DELETE FROM papers WHERE id = ?').run(paperId);
    });

    it('switches branch and saves current state', async () => {
      userMsgId = nanoid();
      aiMsgId = nanoid();
      db.prepare(
        'INSERT INTO messages (id, paper_id, role, content, created_at, seq) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(userMsgId, paperId, 'user', 'Original question', Date.now(), 1);
      db.prepare(
        'INSERT INTO messages (id, paper_id, role, content, created_at, seq) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(aiMsgId, paperId, 'assistant', 'Original answer', Date.now() + 1, 2);

      // Manually create a branch (simulating what /chat/edit does)
      const branchId = nanoid();
      const tailJson = JSON.stringify([
        { id: userMsgId, role: 'user', content: 'Original question', created_at: Date.now(), seq: 1 },
        { id: aiMsgId, role: 'assistant', content: 'Original answer', created_at: Date.now() + 1, seq: 2 },
      ]);
      db.prepare(
        'INSERT INTO message_branches (id, paper_id, fork_message_id, tail_json, created_at) VALUES (?, ?, ?, ?, ?)'
      ).run(branchId, paperId, userMsgId, tailJson, Date.now());

      // Edit the user message to change state
      db.prepare('UPDATE messages SET content = ?, edited = 1, edit_branches = ? WHERE id = ?').run(
        'Edited question',
        JSON.stringify([{ id: branchId, original_content: 'Original question', tail_count: 1, ts: Date.now() }]),
        userMsgId
      );
      db.prepare('DELETE FROM messages WHERE paper_id = ? AND seq > ?').run(paperId, 1);

      // Now switch to the branch
      const res = await fetch(`${baseUrl}/api/papers/${paperId}/chat/branch/switch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fork_id: userMsgId, branch_id: branchId }),
      });
      const data = await res.json();

      assert.equal(res.status, 200);
      assert.equal(data.ok, true);

      // Verify old content restored
      const restoredMsg = db.prepare('SELECT * FROM messages WHERE id = ?').get(userMsgId);
      assert.equal(restoredMsg.content, 'Original question');
      assert.equal(restoredMsg.edited, 0);

      // Verify AI message restored
      const restoredAI = db.prepare('SELECT * FROM messages WHERE id = ?').get(aiMsgId);
      assert.ok(restoredAI);
      assert.equal(restoredAI.content, 'Original answer');

      // Verify the edited state was saved as a new branch
      const newBranches = JSON.parse(restoredMsg.edit_branches || '[]');
      assert.ok(newBranches.length > 0, 'should have saved the previously-current state');
    });

    it('returns 404 for non-existent branch', async () => {
      const res = await fetch(`${baseUrl}/api/papers/${paperId}/chat/branch/switch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fork_id: 'nonexistent', branch_id: 'nonexistent-branch' }),
      });
      assert.equal(res.status, 404);
    });
  });

  describe('POST /chat?regenerate=true', () => {
    it('returns 400 when no AI messages exist', async () => {
      const pid = `test_paper_regen_${Date.now()}`;
      db.prepare(`INSERT INTO papers (id, title, full_text, summary_bg, summary_methods, summary_results, summary_conclusions, summary_limitations)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
        pid, 'Regen Test', '', '', '', '', '', ''
      );

      // Add only a user message (no AI)
      db.prepare(
        'INSERT INTO messages (id, paper_id, role, content, created_at, seq) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(nanoid(), pid, 'user', 'Hello', Date.now(), 1);

      const res = await fetch(`${baseUrl}/api/papers/${pid}/chat?regenerate=true`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = await res.json();

      assert.equal(res.status, 400);
      assert.ok(data.error);

      db.prepare('DELETE FROM messages WHERE paper_id = ?').run(pid);
      db.prepare('DELETE FROM papers WHERE id = ?').run(pid);
    });
  });
});

describe('switchVersion', () => {
  it('returns same array when no matching message', () => {
    const messages = [
      { id: 'a', role: 'user', content: 'hi', regen_versions: [] },
    ];
    const result = switchVersion(messages, 'nonexistent', 1);
    assert.deepStrictEqual(result, messages);
  });

  it('switches to next version within bounds', () => {
    const messages = [
      {
        id: 'v2',
        role: 'assistant',
        content: 'Version 2',
        regen_idx: 1,
        regen_versions: [
          { id: 'v1', content: 'Version 1', ts: 1000 },
          { id: 'v2', content: 'Version 2', ts: 2000 },
          { id: 'v3', content: 'Version 3', ts: 3000 },
        ],
      },
    ];
    const result = switchVersion(messages, 'v2', 1);
    assert.equal(result[0].regen_idx, 2);
    assert.equal(result[0].content, 'Version 3');
    assert.equal(result[0].id, 'v3');
  });

  it('switches to previous version', () => {
    const messages = [
      {
        id: 'v2',
        role: 'assistant',
        content: 'Version 2',
        regen_idx: 1,
        regen_versions: [
          { id: 'v1', content: 'Version 1', ts: 1000 },
          { id: 'v2', content: 'Version 2', ts: 2000 },
        ],
      },
    ];
    const result = switchVersion(messages, 'v2', -1);
    assert.equal(result[0].regen_idx, 0);
    assert.equal(result[0].content, 'Version 1');
    assert.equal(result[0].id, 'v1');
  });

  it('finds message by branch version id', () => {
    const messages = [
      {
        id: 'current_id',
        role: 'assistant',
        content: 'Current',
        regen_idx: 1,
        regen_versions: [
          { id: 'old_id', content: 'Old', ts: 1000 },
          { id: 'current_id', content: 'Current', ts: 2000 },
        ],
      },
    ];
    // Search by the old version id that's in branches
    const result = switchVersion(messages, 'old_id', 1);
    assert.equal(result[0].regen_idx, 1);
    assert.equal(result[0].content, 'Current');
  });

  it('clamps at boundaries — does not go below 0', () => {
    const messages = [
      {
        id: 'v1',
        role: 'assistant',
        content: 'Version 1',
        regen_idx: 0,
        regen_versions: [
          { id: 'v1', content: 'Version 1', ts: 1000 },
          { id: 'v2', content: 'Version 2', ts: 2000 },
        ],
      },
    ];
    const result = switchVersion(messages, 'v1', -1);
    assert.equal(result[0].regen_idx, 0);
    assert.equal(result[0].content, 'Version 1');
  });

  it('clamps at boundaries — does not exceed length', () => {
    const messages = [
      {
        id: 'v2',
        role: 'assistant',
        content: 'Version 2',
        regen_idx: 1,
        regen_versions: [
          { id: 'v1', content: 'Version 1', ts: 1000 },
          { id: 'v2', content: 'Version 2', ts: 2000 },
        ],
      },
    ];
    const result = switchVersion(messages, 'v2', 1);
    assert.equal(result[0].regen_idx, 1);
    assert.equal(result[0].content, 'Version 2');
  });
});

// Inline copy of switchVersion for unit testing without JSX import
function switchVersion(messages, messageId, direction) {
  return messages.map(m => {
    const isTarget = m.id === messageId ||
      (m.regen_versions && m.regen_versions.some(v => v.id === messageId));
    if (!isTarget) return m;

    const versions = m.regen_versions || [];
    if (versions.length < 2) return m;

    const newIdx = (m.regen_idx ?? 0) + direction;
    if (newIdx < 0 || newIdx >= versions.length) return m;

    return {
      ...m,
      regen_idx: newIdx,
      content: versions[newIdx].content,
      id: versions[newIdx].id,
      created_at: versions[newIdx].ts,
    };
  });
}
