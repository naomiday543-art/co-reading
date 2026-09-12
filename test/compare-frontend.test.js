// 工單 09 §3.3：對比的前端狀態（勾選上限、不持久化、結果 key）。
//
// frontend/src/store.js 是純 JS（zustand），node 直接 import 得動——勾選邏輯與
// 洞察 body 的組法都是純函式，不必開瀏覽器就能釘住。版面與互動另有實彈驗收。
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { nanoid } from 'nanoid';

import db from '../src/db.js';
import {
  useStore,
  COMPARE_MIN,
  COMPARE_MAX,
  compareKey,
  buildCompareInsight,
} from '../frontend/src/store.js';

const reset = () => useStore.setState({ compareSelection: [], compareResult: null });

describe('compareSelection 勾選態', () => {
  beforeEach(reset);

  it('上下限就是後端的 2–4', () => {
    assert.equal(COMPARE_MIN, 2);
    assert.equal(COMPARE_MAX, 4);
  });

  it('toggle 加入、再 toggle 移除，順序照勾選順序', () => {
    const { toggleCompare } = useStore.getState();
    toggleCompare('p1');
    toggleCompare('p2');
    assert.deepEqual(useStore.getState().compareSelection, ['p1', 'p2']);

    toggleCompare('p1');
    assert.deepEqual(useStore.getState().compareSelection, ['p2']);
  });

  it('滿 4 篇後第 5 個不加（既有 4 篇原封不動）', () => {
    const { toggleCompare } = useStore.getState();
    for (const id of ['p1', 'p2', 'p3', 'p4', 'p5']) toggleCompare(id);

    assert.deepEqual(useStore.getState().compareSelection, ['p1', 'p2', 'p3', 'p4']);
  });

  it('滿了還是能取消已勾的（不是整條鎖死）', () => {
    const { toggleCompare } = useStore.getState();
    for (const id of ['p1', 'p2', 'p3', 'p4']) toggleCompare(id);
    toggleCompare('p2');

    assert.deepEqual(useStore.getState().compareSelection, ['p1', 'p3', 'p4']);
  });

  it('clearCompare 清空', () => {
    const { toggleCompare, clearCompare } = useStore.getState();
    toggleCompare('p1');
    toggleCompare('p2');
    clearCompare();
    assert.deepEqual(useStore.getState().compareSelection, []);
  });

  it('不持久化：store 沒碰 localStorage，初始值是空陣列', () => {
    // 勾選是一次動作不是偏好——這裡釘住「沒有 compare 的 storage key」。
    const src = readStoreSource();
    assert.ok(
      !/compare[^\n]*localStorage|localStorage[^\n]*compare/i.test(src),
      'compareSelection 不該寫進 localStorage',
    );
  });
});

describe('compareKey', () => {
  it('排序後 join：勾選順序不同但同一組＝同一個 key', () => {
    assert.equal(compareKey(['b', 'a']), compareKey(['a', 'b']));
    assert.equal(compareKey(['a', 'b']), 'a,b');
  });

  it('不同組就是不同 key（換了選擇要重打）', () => {
    assert.notEqual(compareKey(['a', 'b']), compareKey(['a', 'c']));
  });

  it('不改動傳進來的陣列', () => {
    const ids = ['b', 'a'];
    compareKey(ids);
    assert.deepEqual(ids, ['b', 'a']);
  });
});

function readStoreSource() {
  return readFileSync(new URL('../frontend/src/store.js', import.meta.url), 'utf8');
}

// ── I：存成「共振」洞察（工單 09 §3.2）──────────────────────────────

const SAMPLE = {
  papers: [
    { id: 'pa', title: '膽固醇改變蛋白冠', authors: 'Tang', year: 2023 },
    { id: 'pb', title: 'Nanoplastic shape', authors: 'Lee', year: 2024 },
  ],
  table: {
    背景: { pa: 'A 背景', pb: 'B 背景' },
    方法: { pa: 'DLS', pb: '摘要未提及' },
    結果: { pa: 'A 結果', pb: 'B 結果' },
    結論: { pa: 'A 結論', pb: 'B 結論' },
    局限: { pa: 'A 局限', pb: 'B 局限' },
  },
  analysis: {
    same: ['兩篇都量粒徑'],
    differ: ['一篇 120 nm、一篇 50 nm'],
    conflict: ['蛋白冠厚度結論相反'],
    for_her: '對你的題目要先固定粒徑。',
  },
};

describe('buildCompareInsight', () => {
  it('dimension 是共振；tags 含 compare 與每一篇', () => {
    const body = buildCompareInsight(SAMPLE);
    assert.equal(body.dimension, '共振');
    assert.deepEqual(body.tags, ['compare', 'paper:pa', 'paper:pb']);
    assert.equal(body.source_paper_id, 'pa', 'source_paper_id 是第一篇');
  });

  it('title 是「對比：《A》×《B》」，各截 30 字', () => {
    const body = buildCompareInsight(SAMPLE);
    assert.equal(body.title, '對比：《膽固醇改變蛋白冠》 × 《Nanoplastic shape》');

    const longTitle = '超'.repeat(50);
    const long = buildCompareInsight({
      ...SAMPLE,
      papers: [{ id: 'pa', title: longTitle }, { id: 'pb', title: 'B' }],
    });
    assert.ok(long.title.includes(`${'超'.repeat(30)}…`), long.title);
    assert.ok(!long.title.includes('超'.repeat(31)), '標題沒截到 30 字');
  });

  it('content 逐行前綴 相同／相異／打架，最後接 for_her', () => {
    const lines = buildCompareInsight(SAMPLE).content.split('\n');
    assert.deepEqual(lines, [
      '相同：兩篇都量粒徑',
      '相異：一篇 120 nm、一篇 50 nm',
      '打架：蛋白冠厚度結論相反',
      '對你的題目要先固定粒徑。',
    ]);
  });

  it('無 for_her（沒有方向）就不接那一行', () => {
    const body = buildCompareInsight({
      ...SAMPLE,
      analysis: { ...SAMPLE.analysis, for_her: '' },
    });
    assert.equal(body.content.split('\n').length, 3);
    assert.ok(!body.content.includes('對你的題目'));
  });

  it('source_context 是對比表壓成純文字：每維度一段、每篇一行', () => {
    const ctx = buildCompareInsight(SAMPLE).source_context;
    assert.ok(ctx.includes('【方法】'));
    assert.ok(ctx.includes('膽固醇改變蛋白冠：DLS'));
    assert.ok(ctx.includes('Nanoplastic shape：摘要未提及'));
    assert.equal(ctx.split('\n\n').length, 5, '五個維度五段');
  });

  it('三段分析全空時 content 退回對比表（不送空 content 去撞 400）', () => {
    const body = buildCompareInsight({
      ...SAMPLE,
      analysis: { same: [], differ: [], conflict: [], for_her: '' },
    });
    assert.ok(body.content.trim().length > 0);
    assert.ok(body.content.includes('【背景】'));
  });
});

describe('I1 組好的 body 真的存得進 POST /api/insights', () => {
  let server;
  let baseUrl;
  const paperIds = [];

  const addPaper = (id, title) => {
    db.prepare('INSERT INTO papers (id, title, analyze_status) VALUES (?, ?, ?)')
      .run(id, title, 'done');
    paperIds.push(id);
  };

  before(async () => {
    addPaper('pa', '膽固醇改變蛋白冠');
    addPaper('pb', 'Nanoplastic shape');
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
    for (const id of paperIds.splice(0)) {
      db.prepare('DELETE FROM insights WHERE source_paper_id = ?').run(id);
      db.prepare('DELETE FROM papers WHERE id = ?').run(id);
    }
    if (server) server.close();
  });

  it('落庫後 dimension=共振、tags_json 含每一篇、source_paper_id 是第一篇', async () => {
    const res = await fetch(`${baseUrl}/api/insights`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildCompareInsight(SAMPLE)),
    });
    assert.equal(res.status, 200);
    const created = await res.json();

    assert.equal(created.dimension, '共振', '維度沒被 insights 路由退成「延伸」');
    assert.deepEqual(created.tags_json, ['compare', 'paper:pa', 'paper:pb']);
    assert.equal(created.source_paper_id, 'pa');
    assert.match(created.title, /^對比：/);
    assert.match(created.content, /相同：/);

    // 真的在 DB 裡，不是只回了一個物件。
    const row = db.prepare('SELECT dimension, tags_json FROM insights WHERE id = ?').get(created.id);
    assert.equal(row.dimension, '共振');
    assert.deepEqual(JSON.parse(row.tags_json), ['compare', 'paper:pa', 'paper:pb']);

    const listed = await fetch(`${baseUrl}/api/insights?dimension=${encodeURIComponent('共振')}`);
    const rows = await listed.json();
    assert.ok(rows.some(r => r.id === created.id), '洞察頁撈得到（dimension=共振）');
  });
});
