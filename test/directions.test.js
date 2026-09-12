// 工單 07：研究方向 × 知識樹合流。
// 矩陣 M1–M3（migration）、T1/T2（/api/tree 的 description）、D1–D4（注入區塊）。
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';

import db from '../src/db.js';
import { nanoid } from 'nanoid';
import {
  listDirections,
  directionOfPaper,
  renderDirectionsBlock,
  buildDirectionsContext,
  DESCRIPTION_MAX,
} from '../src/directions.js';

const dbModuleUrl = new URL('../src/db.js', import.meta.url).href;

// 在一個乾淨的子進程裡載入 src/db.js ⇒ 等於「跑一次 migration」。
// 子進程才能對任意 DB 檔案跑，本進程的 db.js 早就綁在測試 DB 上了。
function runMigrations(dataDir, dbPath) {
  return spawnSync(
    process.execPath,
    ['--input-type=module', '-e', `await import(${JSON.stringify(dbModuleUrl)})`],
    {
      encoding: 'utf-8',
      env: { ...process.env, CO_READING_DATA_DIR: dataDir, CO_READING_DB_PATH: dbPath },
    }
  );
}

function columnsOf(dbPath, table) {
  const handle = new Database(dbPath, { readonly: true });
  try {
    return handle.prepare(`PRAGMA table_info(${table})`).all();
  } finally {
    handle.close();
  }
}

describe('tree_nodes.description migration（M1–M3）', () => {
  const dirs = [];

  function freshDir() {
    const dir = mkdtempSync(join(tmpdir(), 'cr-migrate-'));
    dirs.push(dir);
    return dir;
  }

  after(() => {
    for (const dir of dirs) {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  });

  it('M1 空 DB：建出 description 欄，預設空字串', () => {
    const dir = freshDir();
    const dbPath = join(dir, 'fresh.db');

    const run = runMigrations(dir, dbPath);
    assert.equal(run.status, 0, run.stderr);

    const description = columnsOf(dbPath, 'tree_nodes').find(c => c.name === 'description');
    assert.ok(description, 'tree_nodes 應該有 description 欄');
    assert.equal(description.notnull, 1);

    const handle = new Database(dbPath);
    try {
      handle.prepare('INSERT INTO tree_nodes (id, name) VALUES (?, ?)').run('n1', 'nano plastics');
      const row = handle.prepare('SELECT description FROM tree_nodes WHERE id = ?').get('n1');
      assert.equal(row.description, '');
    } finally {
      handle.close();
    }
  });

  it('M2 跑兩次不拋錯（idempotent）', () => {
    const dir = freshDir();
    const dbPath = join(dir, 'twice.db');

    const first = runMigrations(dir, dbPath);
    assert.equal(first.status, 0, first.stderr);
    const second = runMigrations(dir, dbPath);
    assert.equal(second.status, 0, second.stderr);

    const description = columnsOf(dbPath, 'tree_nodes').filter(c => c.name === 'description');
    assert.equal(description.length, 1);
  });

  it('M3 既有資料：舊 schema 先建節點，migrate 後資料還在、描述為空', () => {
    const dir = freshDir();
    const dbPath = join(dir, 'legacy.db');

    // 工單 07 之前的 tree_nodes schema，逐字照 db.js（沒有 description）。
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE tree_nodes (
        id          TEXT PRIMARY KEY,
        parent_id   TEXT REFERENCES tree_nodes(id) ON DELETE CASCADE,
        name        TEXT NOT NULL,
        sort_order  INTEGER NOT NULL DEFAULT 0,
        created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
      );
    `);
    legacy.prepare('INSERT INTO tree_nodes (id, parent_id, name, sort_order) VALUES (?, ?, ?, ?)')
      .run('legacy_nano', null, 'nano plastics', 1);
    legacy.prepare('INSERT INTO tree_nodes (id, parent_id, name, sort_order) VALUES (?, ?, ?, ?)')
      .run('legacy_gcms', null, 'py-GCMS', 2);
    legacy.prepare('INSERT INTO tree_nodes (id, parent_id, name, sort_order) VALUES (?, ?, ?, ?)')
      .run('legacy_child', 'legacy_nano', '血清蛋白冠', 1);
    legacy.close();

    const run = runMigrations(dir, dbPath);
    assert.equal(run.status, 0, run.stderr);

    const handle = new Database(dbPath, { readonly: true });
    try {
      const rows = handle.prepare('SELECT id, parent_id, name, sort_order, description FROM tree_nodes ORDER BY id').all();
      assert.deepEqual(rows.map(r => r.id), ['legacy_child', 'legacy_gcms', 'legacy_nano']);
      assert.deepEqual(rows.map(r => r.name), ['血清蛋白冠', 'py-GCMS', 'nano plastics']);
      assert.equal(rows.find(r => r.id === 'legacy_child').parent_id, 'legacy_nano');
      assert.equal(rows.find(r => r.id === 'legacy_gcms').sort_order, 2);
      for (const row of rows) assert.equal(row.description, '');
    } finally {
      handle.close();
    }
  });
});

describe('/api/tree description（T1/T2）', () => {
  let server, baseUrl;
  const created = [];

  before(async () => {
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
    for (const id of created) {
      db.prepare('DELETE FROM tree_nodes WHERE id = ?').run(id);
    }
    if (server) server.close();
  });

  async function createNode(body) {
    const res = await fetch(`${baseUrl}/api/tree`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (data.id) created.push(data.id);
    return { res, data };
  }

  it('T1 PATCH description round-trip（trim）', async () => {
    const { data: node } = await createNode({ name: 'T1 方向' });

    const res = await fetch(`${baseUrl}/api/tree/${node.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: '  奈米塑膠在血液中的分佈  ' }),
    });
    assert.equal(res.status, 200);
    const updated = await res.json();
    assert.equal(updated.description, '奈米塑膠在血液中的分佈');

    const row = db.prepare('SELECT description FROM tree_nodes WHERE id = ?').get(node.id);
    assert.equal(row.description, '奈米塑膠在血液中的分佈');
  });

  it('T1 PATCH >2000 字 → 400，且不寫進去', async () => {
    const { data: node } = await createNode({ name: 'T1 太長', description: '原本的描述' });

    const res = await fetch(`${baseUrl}/api/tree/${node.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: 'x'.repeat(DESCRIPTION_MAX + 1) }),
    });
    assert.equal(res.status, 400);

    const row = db.prepare('SELECT description FROM tree_nodes WHERE id = ?').get(node.id);
    assert.equal(row.description, '原本的描述');
  });

  it('T1 剛好 2000 字可以存', async () => {
    const { data: node } = await createNode({ name: 'T1 剛好' });
    const res = await fetch(`${baseUrl}/api/tree/${node.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: 'y'.repeat(DESCRIPTION_MAX) }),
    });
    assert.equal(res.status, 200);
    const row = db.prepare('SELECT description FROM tree_nodes WHERE id = ?').get(node.id);
    assert.equal(row.description.length, DESCRIPTION_MAX);
  });

  it('T1 非字串 → 400', async () => {
    const { data: node } = await createNode({ name: 'T1 型別' });

    for (const bad of [42, { a: 1 }, ['x'], null]) {
      const res = await fetch(`${baseUrl}/api/tree/${node.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: bad }),
      });
      assert.equal(res.status, 400, `description=${JSON.stringify(bad)} 應該 400`);
    }
  });

  it('T1 name／parent_id／sort_order 的既有行為不變', async () => {
    const { data: node } = await createNode({ name: 'T1 改名前', description: '描述留著' });

    const res = await fetch(`${baseUrl}/api/tree/${node.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: ' T1 改名後 ', sort_order: 7 }),
    });
    assert.equal(res.status, 200);
    const updated = await res.json();
    assert.equal(updated.name, 'T1 改名後');
    assert.equal(updated.sort_order, 7);
    assert.equal(updated.description, '描述留著');
  });

  it('T1 POST 帶 description；超長 → 400 且沒建出節點', async () => {
    const { res, data } = await createNode({ name: 'T1 建立帶描述', description: '  py-GCMS 熱裂解  ' });
    assert.equal(res.status, 200);
    assert.equal(data.description, 'py-GCMS 熱裂解');

    const before = db.prepare('SELECT COUNT(*) AS n FROM tree_nodes').get().n;
    const tooLong = await fetch(`${baseUrl}/api/tree`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'T1 不該存在', description: 'z'.repeat(DESCRIPTION_MAX + 1) }),
    });
    assert.equal(tooLong.status, 400);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tree_nodes').get().n, before);
  });

  it('T2 GET /tree 每個節點都帶 description（含子節點）', async () => {
    const { data: parent } = await createNode({ name: 'T2 頂層', description: '頂層描述' });
    const { data: child } = await createNode({ name: 'T2 子題', parent_id: parent.id });

    const tree = await fetch(`${baseUrl}/api/tree`).then(r => r.json());

    const flat = [];
    (function walk(nodes) {
      for (const n of nodes) {
        flat.push(n);
        walk(n.children || []);
      }
    })(tree);

    for (const node of flat) {
      assert.equal(typeof node.description, 'string', `${node.name} 少了 description`);
    }
    assert.equal(flat.find(n => n.id === parent.id).description, '頂層描述');
    assert.equal(flat.find(n => n.id === child.id).description, '');
  });
});

describe('方向注入區塊（D1–D4）', () => {
  const nodeIds = [];
  const paperIds = [];

  function addNode(name, { parentId = null, description = '', sortOrder = 0 } = {}) {
    const id = `dir_${nanoid(8)}`;
    db.prepare('INSERT INTO tree_nodes (id, parent_id, name, sort_order, description) VALUES (?, ?, ?, ?, ?)')
      .run(id, parentId, name, sortOrder, description);
    nodeIds.push(id);
    return id;
  }

  function addPaper(treeNodeId) {
    const id = `dir_paper_${nanoid(8)}`;
    db.prepare(`INSERT INTO papers (id, title, full_text, tree_node_id, summary_bg, summary_methods, summary_results, summary_conclusions, summary_limitations)
      VALUES (?, ?, ?, ?, '', '', '', '', '')`).run(id, 'D paper', 'text', treeNodeId);
    paperIds.push(id);
    return id;
  }

  function clearAll() {
    for (const id of paperIds.splice(0)) db.prepare('DELETE FROM papers WHERE id = ?').run(id);
    // 子節點先刪，免得 FK 擋住
    for (const id of nodeIds.splice(0).reverse()) db.prepare('DELETE FROM tree_nodes WHERE id = ?').run(id);
  }

  after(clearAll);

  it('D2 沒有任何方向 → 空字串，不是空白也不是換行', () => {
    clearAll();
    const paperId = addPaper(null);
    assert.equal(renderDirectionsBlock(paperId), '');
    assert.equal(buildDirectionsContext(paperId).total, 0);
    assert.equal(buildDirectionsContext(paperId).directionName, null);
  });

  it('D1 掛在子節點的論文回頂層祖先', () => {
    clearAll();
    const top = addNode('nano plastics', { description: '奈米塑膠在血液中的分佈', sortOrder: 1 });
    const mid = addNode('蛋白冠', { parentId: top, sortOrder: 1 });
    const leaf = addNode('膽固醇', { parentId: mid, sortOrder: 1 });
    const paperId = addPaper(leaf);

    const direction = directionOfPaper(paperId);
    assert.equal(direction.id, top);
    assert.equal(direction.name, 'nano plastics');
    assert.equal(direction.description, '奈米塑膠在血液中的分佈');
  });

  it('D1 論文沒掛節點 / 論文不存在 → null', () => {
    clearAll();
    addNode('nano plastics', { sortOrder: 1 });
    assert.equal(directionOfPaper(addPaper(null)), null);
    assert.equal(directionOfPaper('no_such_paper'), null);
  });

  it('D3 有方向、論文掛其一：含「屬於」與「另外還有」', () => {
    clearAll();
    const nano = addNode('nano plastics', { description: '奈米塑膠在血液中的分佈', sortOrder: 1 });
    addNode('py-GCMS', { description: '熱裂解氣相層析質譜定量', sortOrder: 2 });
    const paperId = addPaper(nano);

    const block = renderDirectionsBlock(paperId);
    assert.ok(block.startsWith('【她的研究方向】\n'), block);
    assert.ok(block.includes('這篇論文屬於：nano plastics — 奈米塑膠在血液中的分佈'), block);
    assert.ok(block.includes('她另外還有的方向：py-GCMS — 熱裂解氣相層析質譜定量'), block);
    assert.ok(block.includes('判斷「延伸」「你的研究」時以這裡為準'), block);
    assert.ok(block.includes('從這篇跳到她另一個方向的是「延伸」。'), block);
    assert.ok(!block.includes('尚未歸入'), block);

    const ctx = buildDirectionsContext(paperId);
    assert.equal(ctx.directionName, 'nano plastics');
    assert.equal(ctx.total, 2);
  });

  it('D3 掛在子節點也算掛在該方向', () => {
    clearAll();
    const nano = addNode('nano plastics', { description: '奈米塑膠', sortOrder: 1 });
    const child = addNode('蛋白冠', { parentId: nano, description: '子題描述不印', sortOrder: 1 });
    addNode('py-GCMS', { description: '熱裂解', sortOrder: 2 });
    const paperId = addPaper(child);

    const block = renderDirectionsBlock(paperId);
    assert.ok(block.includes('這篇論文屬於：nano plastics — 奈米塑膠'), block);
    assert.ok(!block.includes('子題描述不印'), block);
  });

  it('D3 描述為空的方向只印名字', () => {
    clearAll();
    const nano = addNode('nano plastics', { sortOrder: 1 });
    addNode('py-GCMS', { sortOrder: 2 });
    const paperId = addPaper(nano);

    const block = renderDirectionsBlock(paperId);
    assert.ok(block.includes('這篇論文屬於：nano plastics\n'), block);
    assert.ok(block.includes('她另外還有的方向：py-GCMS\n'), block);
    assert.ok(!block.includes('—'), block);
  });

  it('D3 只有一個方向時不印「另外還有」', () => {
    clearAll();
    const nano = addNode('nano plastics', { description: '只有這一個', sortOrder: 1 });
    const paperId = addPaper(nano);

    const block = renderDirectionsBlock(paperId);
    assert.ok(block.includes('這篇論文屬於：nano plastics — 只有這一個'), block);
    assert.ok(!block.includes('另外還有'), block);
  });

  it('D3 三個以上的其他方向逐行列出', () => {
    clearAll();
    const nano = addNode('nano plastics', { description: 'A', sortOrder: 1 });
    addNode('py-GCMS', { description: 'B', sortOrder: 2 });
    addNode('microplastics', { description: 'C', sortOrder: 3 });
    const paperId = addPaper(nano);

    const block = renderDirectionsBlock(paperId);
    assert.ok(block.includes('她另外還有的方向：\n- py-GCMS — B\n- microplastics — C'), block);
  });

  it('D4 有方向、論文未掛：含「尚未歸入」且仍列出全部', () => {
    clearAll();
    addNode('nano plastics', { description: '奈米塑膠', sortOrder: 1 });
    addNode('py-GCMS', { description: '熱裂解', sortOrder: 2 });
    const paperId = addPaper(null);

    const block = renderDirectionsBlock(paperId);
    assert.ok(block.includes('這篇論文尚未歸入任何方向'), block);
    assert.ok(block.includes('- nano plastics — 奈米塑膠'), block);
    assert.ok(block.includes('- py-GCMS — 熱裂解'), block);
    assert.ok(!block.includes('這篇論文屬於'), block);
    assert.equal(buildDirectionsContext(paperId).directionName, null);
    assert.equal(buildDirectionsContext(paperId).total, 2);
  });

  it('listDirections 只回頂層、依 sort_order，paperCount 含子題', () => {
    clearAll();
    const gcms = addNode('py-GCMS', { description: '熱裂解', sortOrder: 2 });
    const nano = addNode('nano plastics', { description: '奈米塑膠', sortOrder: 1 });
    const child = addNode('蛋白冠', { parentId: nano, sortOrder: 1 });
    addPaper(nano);
    addPaper(child);
    addPaper(child);
    addPaper(gcms);

    const directions = listDirections();
    assert.deepEqual(directions.map(d => d.name), ['nano plastics', 'py-GCMS']);
    assert.deepEqual(directions.map(d => d.paperCount), [3, 1]);
    assert.deepEqual(directions.map(d => d.description), ['奈米塑膠', '熱裂解']);
    assert.ok(!directions.some(d => d.id === child), '子節點不是方向');
  });

  it('描述原樣注入：不 trim 掉內部換行、不改寫標點', () => {
    clearAll();
    const nano = addNode('nano plastics', { description: '第一行\n第二行：50 nm vs 120 nm？', sortOrder: 1 });
    const paperId = addPaper(nano);

    const block = renderDirectionsBlock(paperId);
    assert.ok(block.includes('這篇論文屬於：nano plastics — 第一行\n第二行：50 nm vs 120 nm？'), block);
  });
});
