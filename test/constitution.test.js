import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';

import db, { setSetting } from '../src/db.js';
import { nanoid } from 'nanoid';
import {
  loadConstitution,
  builtinConstitutionPath,
  FALLBACK_CONSTITUTION,
} from '../src/constitution.js';
import { buildChatSystem, buildPaperBlock } from '../src/ai.js';

const paper = {
  id: 'p1',
  title: 'Cholesterol alters the protein corona',
  authors: 'Tang et al.',
  year: 2023,
  summary_bg: 'bg', summary_methods: 'm', summary_results: 'r',
  summary_conclusions: 'c', summary_limitations: 'l',
  full_text: 'FULLTEXT-MARKER lorem ipsum',
};

describe('loadConstitution', () => {
  it('builtin file exists, loads, and starts with the identity heading', () => {
    assert.ok(existsSync(builtinConstitutionPath), builtinConstitutionPath);
    const { text, source } = loadConstitution({ dataDir: mkdtempSync(join(tmpdir(), 'cr-const-')) });
    assert.equal(source, 'builtin');
    assert.ok(text.startsWith('# 你是誰'));
    assert.ok(text.includes('# 邊界'));
  });

  it('<dataDir>/CONSTITUTION.md overrides the builtin', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cr-const-'));
    writeFileSync(join(dir, 'CONSTITUTION.md'), '# 你是誰\n\n你是測試導師。\n');
    const { text, source } = loadConstitution({ dataDir: dir });
    assert.equal(source, 'user');
    assert.equal(text, '# 你是誰\n\n你是測試導師。');
  });

  it('an empty user file is ignored, not treated as a blank constitution', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cr-const-'));
    writeFileSync(join(dir, 'CONSTITUTION.md'), '   \n');
    const { source } = loadConstitution({ dataDir: dir });
    assert.equal(source, 'builtin');
  });

  it('falls back to the hard-coded identity when the builtin is unreadable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cr-const-'));
    const { text, source } = loadConstitution({ dataDir: dir, builtinPath: join(dir, 'nope.md') });
    assert.equal(source, 'fallback');
    assert.equal(text, FALLBACK_CONSTITUTION);
  });

  // K1（工單 07 §3.3）：第 7 條「不當辯護人」在內建憲章裡，而且 loadConstitution 讀得到。
  // 她問「作者為什麼選血清」時，導師的任務不該被定義成「去找作者的理由」。
  it('K1 內建憲章含第 7 條：不當辯護人、分兩層、印象要標明', () => {
    const { text, source } = loadConstitution({ dataDir: mkdtempSync(join(tmpdir(), 'cr-const-')) });
    assert.equal(source, 'builtin');

    assert.ok(text.includes('7. **你不是這篇論文的辯護人。**'), '第 7 條不在內建憲章裡');
    assert.ok(text.includes('先判斷她的質疑成不成立，再說作者的理由'));
    assert.ok(text.includes('**批判要有據**'));
    assert.ok(text.includes('只從她的洞察區塊與研究方向區塊引用'));
    assert.ok(text.includes('這是我的印象，可能過時'));
    assert.ok(text.includes('先「論文說的」（準確轉述、引出處），後「我的評估」（明確標記）'));
    assert.ok(text.includes('純理解型的問題'), '純理解題不加評估段的例外要留著');

    // 身份段要認得方向區塊（§3.3）
    assert.ok(text.includes('洞察、研究方向、上一段研究續窗'));

    // 1–6 條措辭不得被動（紅線）
    assert.ok(text.includes('1. **記性比人好，但永遠可以被拒絕。**'));
    assert.ok(text.includes('2. **保留矛盾，而不是消除矛盾。**'));
    assert.ok(text.includes('3. **事實靠查，不靠編。**'));
    assert.ok(text.includes('4. **引用要具體。**'));
    assert.ok(text.includes('5. **講清楚，不講深奧。**'));
    assert.ok(text.includes('6. **不評分、不催促、不製造焦慮。**'));
    assert.ok(!text.includes('8. **'), '本工單只加第 7 條');
  });
});

describe('buildChatSystem', () => {
  it('anthropic: constitution block first, paper block second, both cached', () => {
    const sys = buildChatSystem(paper, { constitution: 'CONST', format: 'anthropic' });
    assert.equal(sys.length, 2);
    assert.equal(sys[0].text, 'CONST');
    assert.deepEqual(sys[0].cache_control, { type: 'ephemeral' });
    assert.deepEqual(sys[1].cache_control, { type: 'ephemeral' });
    assert.ok(sys[1].text.includes('標題：Cholesterol alters the protein corona'));
    assert.ok(sys[1].text.includes('FULLTEXT-MARKER'));
    assert.ok(!sys[1].text.includes('CONST'));
  });

  it('openai: single string, constitution before the paper', () => {
    const sys = buildChatSystem(paper, { constitution: 'CONST', format: 'openai' });
    assert.equal(typeof sys, 'string');
    assert.ok(sys.startsWith('CONST\n\n以下是這篇論文的信息'));
    assert.ok(sys.includes('FULLTEXT-MARKER'));
  });

  it('paper block keeps the 100k truncation marker', () => {
    const big = { ...paper, full_text: 'x'.repeat(100001) };
    const block = buildPaperBlock(big);
    assert.ok(block.endsWith('[全文已截斷]'));
  });
});

// 實彈：假 anthropic 上游，走真正的 POST /api/papers/:id/chat，抓上游收到的 body.system。
describe('live: chat route sends [constitution, paper, insights] to the upstream', () => {
  let server, baseUrl, upstream, upstreamUrl;
  const captured = [];
  const paperId = `const_paper_${nanoid(6)}`;
  const userDataDir = process.env.CO_READING_DATA_DIR;

  before(async () => {
    upstream = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        captured.push(JSON.parse(body));
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}\n\n');
        res.write('data: [DONE]\n\n');
        res.end();
      });
    });
    await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
    upstreamUrl = `http://127.0.0.1:${upstream.address().port}/v1`;

    setSetting('ai_base_url', upstreamUrl);
    setSetting('ai_format', 'anthropic');
    setSetting('ai_model', 'fake');
    setSetting('ai_api_key', 'fake');

    db.prepare(`INSERT INTO papers (id, title, authors, year, full_text, summary_bg, summary_methods, summary_results, summary_conclusions, summary_limitations)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      paperId, 'Live Paper', 'A, B', 2024, 'LIVE-FULLTEXT', 'bg', 'm', 'r', 'c', 'l'
    );
    db.prepare(`INSERT INTO insights (id, source_paper_id, dimension, title, content, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(nanoid(), paperId, '概念', 'INSIGHT-TITLE', 'insight body', Date.now(), Date.now());

    // 使用者覆蓋版憲章
    writeFileSync(join(userDataDir, 'CONSTITUTION.md'), '# 你是誰\n\nUSER-CONSTITUTION-MARKER\n');

    const { startServer } = await import('../src/server.js');
    await new Promise((resolve) => {
      server = startServer(0, '127.0.0.1');
      server.once('listening', () => {
        baseUrl = `http://127.0.0.1:${server.address().port}`;
        resolve();
      });
    });
  });

  after(() => {
    try { rmSync(join(userDataDir, 'CONSTITUTION.md'), { force: true }); } catch {}
    db.prepare('DELETE FROM insights WHERE source_paper_id = ?').run(paperId);
    db.prepare('DELETE FROM messages WHERE paper_id = ?').run(paperId);
    db.prepare('DELETE FROM papers WHERE id = ?').run(paperId);
    if (server) server.close();
    if (upstream) upstream.close();
  });

  it('upstream receives constitution block first, paper block second, insights third', async () => {
    const res = await fetch(`${baseUrl}/api/papers/${paperId}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'what is this paper about' }),
    });
    assert.equal(res.status, 200);
    await res.text(); // drain the SSE

    assert.equal(captured.length, 1);
    const sys = captured[0].system;
    assert.ok(Array.isArray(sys), 'system should be an array of blocks for anthropic');
    assert.equal(sys.length, 3);
    assert.ok(sys[0].text.includes('USER-CONSTITUTION-MARKER'), 'user override should win');
    assert.deepEqual(sys[0].cache_control, { type: 'ephemeral' });
    assert.ok(sys[1].text.includes('LIVE-FULLTEXT'));
    assert.deepEqual(sys[1].cache_control, { type: 'ephemeral' });
    assert.ok(sys[2].text.includes('INSIGHT-TITLE'));
    assert.equal(sys[2].cache_control, undefined, 'variable region must not be cached');
  });
});
