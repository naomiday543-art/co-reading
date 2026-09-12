// 工單 07：方向區塊的兩個注入點。
// 矩陣 C1/C2（討論 system）、E1/E2（提取 system）。
//
// C1/E1 是零回歸線（工單 §5）：沒有任何方向時，兩個 system 必須與工單 07 之前**逐字相同**。
// C1 的期望值不是「照現在的代碼算一遍」，是開工前在 main @ 53988fa 上抓下來的快照
// （test/fixtures/chat-system-no-directions.json），這樣改 buildPaperBlock 也會被抓到。
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';

import db from '../src/db.js';
import { nanoid } from 'nanoid';
import { buildChatSystem } from '../src/ai.js';
import { EXTRACT_PROMPT, buildExtractSystem } from '../src/memory.js';
import { renderDirectionsBlock } from '../src/directions.js';

const snapshot = JSON.parse(
  readFileSync(new URL('./fixtures/chat-system-no-directions.json', import.meta.url), 'utf-8')
);

// 逐字對照快照就必須用快照那顆論文。
const snapshotPaper = {
  id: 'snap_paper_1',
  title: 'Cholesterol alters the protein corona',
  authors: 'Tang et al.',
  year: 2023,
  summary_bg: 'BG-X',
  summary_methods: 'M-X',
  summary_results: 'R-X',
  summary_conclusions: 'C-X',
  summary_limitations: 'L-X',
  full_text: 'FULLTEXT-SNAPSHOT-MARKER lorem ipsum',
};

const nodeIds = [];
const paperIds = [];

function addNode(name, { parentId = null, description = '', sortOrder = 0 } = {}) {
  const id = `inj_${nanoid(8)}`;
  db.prepare('INSERT INTO tree_nodes (id, parent_id, name, sort_order, description) VALUES (?, ?, ?, ?, ?)')
    .run(id, parentId, name, sortOrder, description);
  nodeIds.push(id);
  return id;
}

function addPaper(treeNodeId, id = `inj_paper_${nanoid(8)}`) {
  db.prepare(`INSERT INTO papers (id, title, full_text, tree_node_id, summary_bg, summary_methods, summary_results, summary_conclusions, summary_limitations)
    VALUES (?, ?, ?, ?, '', '', '', '', '')`).run(id, 'Injection paper', 'text', treeNodeId);
  paperIds.push(id);
  return id;
}

function clearAll() {
  for (const id of paperIds.splice(0)) db.prepare('DELETE FROM papers WHERE id = ?').run(id);
  for (const id of nodeIds.splice(0).reverse()) db.prepare('DELETE FROM tree_nodes WHERE id = ?').run(id);
}

describe('C1 沒有方向時，討論 system 與 main 逐字相同', () => {
  before(clearAll);
  after(clearAll);

  it('沒有任何方向：anthropic 兩個 block 與快照一致', () => {
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tree_nodes').get().n, 0);
    const sys = buildChatSystem(snapshotPaper, { constitution: 'CONST-SNAPSHOT', format: 'anthropic' });
    assert.deepEqual(sys, snapshot.anthropic);
  });

  it('沒有任何方向：openai 單一字串與快照一致', () => {
    const sys = buildChatSystem(snapshotPaper, { constitution: 'CONST-SNAPSHOT', format: 'openai' });
    assert.equal(sys, snapshot.openai);
  });

  it('零回歸的條件是「方向庫為空」，不是「論文沒歸類」——有方向就會注入', () => {
    // 論文不存在 ⇒ directionOfPaper 回 null，但方向庫非空仍注入（尚未歸入）。
    addNode('nano plastics', { description: 'D', sortOrder: 1 });
    const sys = buildChatSystem(snapshotPaper, { constitution: 'CONST-SNAPSHOT', format: 'openai' });
    assert.notEqual(sys, snapshot.openai);
    assert.ok(sys.includes('【她的研究方向】'));
    clearAll();
  });

  it('方向存在但區塊被呼叫端明確傳空字串時也不加一個換行', () => {
    addNode('nano plastics', { description: 'D', sortOrder: 1 });
    const sys = buildChatSystem(snapshotPaper, {
      constitution: 'CONST-SNAPSHOT',
      format: 'openai',
      directionsBlock: '',
    });
    assert.equal(sys, snapshot.openai);
    clearAll();
  });
});

describe('C2 有方向時，區塊接在 paperBlock 之後、同一個 cache block', () => {
  before(clearAll);
  after(clearAll);

  it('anthropic：仍是兩個 block，方向在第二塊的全文之後', () => {
    const nano = addNode('nano plastics', { description: '奈米塑膠在血液中的分佈', sortOrder: 1 });
    addNode('py-GCMS', { description: '熱裂解氣相層析質譜', sortOrder: 2 });
    const paperId = addPaper(nano);
    const paper = { ...snapshotPaper, id: paperId };

    const sys = buildChatSystem(paper, { constitution: 'CONST-SNAPSHOT', format: 'anthropic' });

    assert.equal(sys.length, 2, '不得為方向多開一個 cache block');
    assert.equal(sys[0].text, 'CONST-SNAPSHOT');
    assert.deepEqual(sys[0].cache_control, { type: 'ephemeral' });
    assert.deepEqual(sys[1].cache_control, { type: 'ephemeral' });

    const second = sys[1].text;
    assert.ok(second.includes('【她的研究方向】'), second);
    assert.ok(second.includes('這篇論文屬於：nano plastics — 奈米塑膠在血液中的分佈'), second);
    assert.ok(second.includes('她另外還有的方向：py-GCMS — 熱裂解氣相層析質譜'), second);

    // 順序：方向在全文之後；而且就是 paperBlock + '\n\n' + 區塊
    assert.ok(second.indexOf('FULLTEXT-SNAPSHOT-MARKER') < second.indexOf('【她的研究方向】'), second);
    assert.equal(second, `${snapshot.anthropic[1].text}\n\n${renderDirectionsBlock(paperId)}`);
    assert.ok(!sys[0].text.includes('【她的研究方向】'), '方向不得進憲章那塊');
  });

  it('openai：憲章、論文、方向依序在同一個字串裡', () => {
    clearAll();
    const nano = addNode('nano plastics', { description: '奈米塑膠', sortOrder: 1 });
    const paperId = addPaper(nano);
    const paper = { ...snapshotPaper, id: paperId };

    const sys = buildChatSystem(paper, { constitution: 'CONST-SNAPSHOT', format: 'openai' });
    assert.ok(sys.startsWith('CONST-SNAPSHOT\n\n以下是這篇論文的信息'), sys.slice(0, 80));
    assert.equal(sys, `${snapshot.openai}\n\n${renderDirectionsBlock(paperId)}`);
  });
});

describe('E1/E2 提取 system', () => {
  before(clearAll);
  after(clearAll);

  it('E1 沒有方向：逐字等於 EXTRACT_PROMPT', () => {
    const paperId = addPaper(null);
    assert.equal(buildExtractSystem(paperId), EXTRACT_PROMPT);
    // 快照：工單 07 不動提取 prompt 的語義，這三個類型名必須還在。
    assert.ok(EXTRACT_PROMPT.startsWith('你是一位科研記憶提取助手。'));
    assert.ok(EXTRACT_PROMPT.includes('**fact**'));
    assert.ok(EXTRACT_PROMPT.includes('**hypothesis**'));
    assert.ok(EXTRACT_PROMPT.includes('**progress**'));
    clearAll();
  });

  it('E2 有方向：以 EXTRACT_PROMPT 開頭、含方向區塊', () => {
    const nano = addNode('nano plastics', { description: '奈米塑膠在血液中的分佈', sortOrder: 1 });
    addNode('py-GCMS', { description: '熱裂解', sortOrder: 2 });
    const paperId = addPaper(nano);

    const system = buildExtractSystem(paperId);
    assert.ok(system.startsWith(EXTRACT_PROMPT), '方向必須接在後面，不得插進提取 prompt 中間');
    assert.equal(system, `${EXTRACT_PROMPT}\n\n${renderDirectionsBlock(paperId)}`);
    assert.ok(system.includes('【她的研究方向】'));
    assert.ok(system.includes('這篇論文屬於：nano plastics — 奈米塑膠在血液中的分佈'));
    clearAll();
  });

  it('E2 論文未歸類但有方向：仍注入，且開頭不變', () => {
    addNode('nano plastics', { description: '奈米塑膠', sortOrder: 1 });
    const paperId = addPaper(null);

    const system = buildExtractSystem(paperId);
    assert.ok(system.startsWith(EXTRACT_PROMPT));
    assert.ok(system.includes('這篇論文尚未歸入任何方向'));
    clearAll();
  });
});

// 實彈：假 anthropic 上游 + 真正的 POST /api/papers/:id/chat，抓上游收到的 body.system。
// 釘的是「方向真的上了飛機」，以及 log 裡看得到 [DIRECTIONS] 一行。
describe('live: 討論路由把方向送到上游，並寫下 [DIRECTIONS] log', () => {
  let server, baseUrl, upstream, upstreamUrl, logLines;
  const captured = [];
  const paperId = `inj_live_${nanoid(6)}`;
  const originalLog = console.log;

  before(async () => {
    const { setSetting } = await import('../src/db.js');

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

    const nano = addNode('nano plastics', { description: '奈米塑膠在血液中的分佈', sortOrder: 1 });
    addNode('py-GCMS', { description: '熱裂解', sortOrder: 2 });
    addPaper(nano, paperId);

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
    console.log = originalLog;
    db.prepare('DELETE FROM messages WHERE paper_id = ?').run(paperId);
    clearAll();
    if (server) server.close();
    if (upstream) upstream.close();
  });

  it('上游的 system 第二塊含方向區塊；log 有 [DIRECTIONS] paper=… direction=… total=…', async () => {
    logLines = [];
    console.log = (...args) => { logLines.push(args.join(' ')); originalLog(...args); };

    const res = await fetch(`${baseUrl}/api/papers/${paperId}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '作者為什麼選血清？' }),
    });
    assert.equal(res.status, 200);
    await res.text();

    console.log = originalLog;

    assert.equal(captured.length, 1);
    const system = captured[0].system;
    assert.ok(Array.isArray(system), JSON.stringify(system).slice(0, 200));
    assert.ok(system[1].text.includes('【她的研究方向】'), system[1].text.slice(-400));
    assert.ok(system[1].text.includes('這篇論文屬於：nano plastics — 奈米塑膠在血液中的分佈'));
    assert.ok(system[1].text.includes('她另外還有的方向：py-GCMS — 熱裂解'));
    // 方向不得另開 cache block：憲章一塊 + 論文（含方向）一塊。
    assert.equal(system.filter(b => b.cache_control).length, 2);

    const line = logLines.find(l => l.includes('[DIRECTIONS]'));
    assert.ok(line, logLines.slice(-10).join('\n'));
    assert.ok(line.includes(`paper=${paperId}`), line);
    assert.ok(line.includes('direction=nano plastics'), line);
    assert.ok(line.includes('total=2'), line);
  });
});
