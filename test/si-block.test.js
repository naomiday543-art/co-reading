// 工單 24 §D3／§五：補充文件（SI）區塊。
//
// 零回歸釘在**跟方向區塊同一份快照**（`test/fixtures/chat-system-no-directions.json`，
// 開工單 07 前在 main @ 53988fa 上抓下來的）：沒有任何可見 SI 時，`buildChatSystem`
// 的輸出必須與那份快照逐字相同——anthropic 陣列與 openai 字串兩種 format 都要。
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { nanoid } from 'nanoid';

import db from '../src/db.js';
import { buildChatSystem, renderSiBlock, buildSiContext, planSiBudget, resolvePaperSiLimit } from '../src/ai.js';

const snapshot = JSON.parse(
  readFileSync(new URL('./fixtures/chat-system-no-directions.json', import.meta.url), 'utf-8')
);

// 逐字對照快照就必須用快照那顆論文（與 directions-injection.test.js 同一顆）。
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

const paperIds = [];
let envBackup;

function addPaper(id = `si_paper_${nanoid(8)}`) {
  db.prepare(`INSERT INTO papers (id, title, full_text, summary_bg, summary_methods,
    summary_results, summary_conclusions, summary_limitations)
    VALUES (?, 'SI 宿主', '正文', '', '', '', '', '')`).run(id);
  paperIds.push(id);
  return id;
}

function addSi(paperId, { label, text = '', visible = 1, order = 0 } = {}) {
  const id = `si_${nanoid(8)}`;
  db.prepare(`INSERT INTO paper_attachments
    (id, paper_id, kind, label, original_name, filename, mime, size_bytes, extracted_text, ai_visible, sort_order)
    VALUES (?, ?, 'si', ?, ?, ?, 'application/pdf', 0, ?, ?, ?)`)
    .run(id, paperId, label, `${label}.pdf`, `si-${id}.pdf`, text, visible, order);
  return id;
}

function clearAll() {
  for (const id of paperIds.splice(0)) db.prepare('DELETE FROM papers WHERE id = ?').run(id);
  db.prepare('DELETE FROM tree_nodes').run();
}

before(() => { envBackup = process.env.PAPER_SI_LIMIT_CHARS; clearAll(); });
after(() => {
  if (envBackup === undefined) delete process.env.PAPER_SI_LIMIT_CHARS;
  else process.env.PAPER_SI_LIMIT_CHARS = envBackup;
  clearAll();
});
beforeEach(() => { delete process.env.PAPER_SI_LIMIT_CHARS; });

describe('零回歸：沒有可見 SI 時，討論 system 與快照逐字相同', () => {
  it('完全沒有 SI：anthropic 兩個 block 與快照一致', () => {
    clearAll();
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tree_nodes').get().n, 0);
    const sys = buildChatSystem(snapshotPaper, { constitution: 'CONST-SNAPSHOT', format: 'anthropic' });
    assert.deepEqual(sys, snapshot.anthropic);
  });

  it('完全沒有 SI：openai 單一字串與快照一致', () => {
    clearAll();
    const sys = buildChatSystem(snapshotPaper, { constitution: 'CONST-SNAPSHOT', format: 'openai' });
    assert.equal(sys, snapshot.openai);
  });

  it('有 SI 但全部 ai_visible=0：兩種 format 都與快照逐字相同', () => {
    clearAll();
    const paperId = addPaper(snapshotPaper.id);
    addSi(paperId, { label: '關掉的 SI', text: 'SECRET-SI-TEXT', visible: 0 });

    assert.equal(renderSiBlock(paperId), '');
    const paper = { ...snapshotPaper, id: paperId };
    assert.deepEqual(
      buildChatSystem(paper, { constitution: 'CONST-SNAPSHOT', format: 'anthropic' }),
      snapshot.anthropic
    );
    assert.equal(
      buildChatSystem(paper, { constitution: 'CONST-SNAPSHOT', format: 'openai' }),
      snapshot.openai
    );
    clearAll();
  });

  it('env PAPER_SI_LIMIT_CHARS=0：整個注入關掉，逐字回到快照', () => {
    clearAll();
    const paperId = addPaper(snapshotPaper.id);
    addSi(paperId, { label: '有字的 SI', text: 'SECRET-SI-TEXT' });
    const paper = { ...snapshotPaper, id: paperId };

    // 先確認沒關的時候真的會注入（不然這個測試等於什麼都沒測）
    assert.notEqual(buildChatSystem(paper, { constitution: 'CONST-SNAPSHOT', format: 'openai' }), snapshot.openai);

    process.env.PAPER_SI_LIMIT_CHARS = '0';
    assert.equal(renderSiBlock(paperId), '');
    assert.deepEqual(
      buildChatSystem(paper, { constitution: 'CONST-SNAPSHOT', format: 'anthropic' }),
      snapshot.anthropic
    );
    assert.equal(
      buildChatSystem(paper, { constitution: 'CONST-SNAPSHOT', format: 'openai' }),
      snapshot.openai
    );
    clearAll();
  });

  it('呼叫端明確傳空字串的 siBlock 也不加一個換行', () => {
    clearAll();
    const paperId = addPaper(snapshotPaper.id);
    addSi(paperId, { label: '有字的 SI', text: 'SECRET-SI-TEXT' });
    const sys = buildChatSystem({ ...snapshotPaper, id: paperId }, {
      constitution: 'CONST-SNAPSHOT', format: 'openai', siBlock: '',
    });
    assert.equal(sys, snapshot.openai);
    clearAll();
  });
});

describe('注入位置：論文區塊 → SI 區塊 → 方向區塊，同一個 cache block', () => {
  it('anthropic：仍是兩個 block，SI 在全文之後、方向之前', () => {
    clearAll();
    const nodeId = `si_node_${nanoid(6)}`;
    db.prepare('INSERT INTO tree_nodes (id, parent_id, name, sort_order, description) VALUES (?, NULL, ?, 1, ?)')
      .run(nodeId, 'nano plastics', '奈米塑膠在血液中的分佈');
    const paperId = addPaper();
    db.prepare('UPDATE papers SET tree_node_id = ? WHERE id = ?').run(nodeId, paperId);
    addSi(paperId, { label: '方法細節', text: 'SI-BODY-MARKER' });

    const paper = { ...snapshotPaper, id: paperId };
    const sys = buildChatSystem(paper, { constitution: 'CONST-SNAPSHOT', format: 'anthropic' });

    assert.equal(sys.length, 2, '不得為 SI 多開一個 cache block');
    assert.deepEqual(sys[0].cache_control, { type: 'ephemeral' });
    assert.deepEqual(sys[1].cache_control, { type: 'ephemeral' });
    assert.equal(sys[0].text, 'CONST-SNAPSHOT');
    assert.ok(!sys[0].text.includes('補充材料'), 'SI 不得進憲章那塊');

    const second = sys[1].text;
    const iFull = second.indexOf('FULLTEXT-SNAPSHOT-MARKER');
    const iSi = second.indexOf('以下是這篇論文的補充材料');
    const iDir = second.indexOf('【她的研究方向】');
    assert.ok(iFull >= 0 && iSi >= 0 && iDir >= 0, second.slice(-400));
    assert.ok(iFull < iSi, 'SI 要在全文之後');
    assert.ok(iSi < iDir, 'SI 要在方向之前');

    // 就是 paperBlock + '\n\n' + SI + '\n\n' + 方向
    assert.equal(second, `${snapshot.anthropic[1].text}\n\n${renderSiBlock(paperId)}`
      + `\n\n${second.slice(iDir)}`);
    clearAll();
  });

  it('openai：憲章、論文、SI 依序在同一個字串裡', () => {
    clearAll();
    const paperId = addPaper();
    addSi(paperId, { label: '方法細節', text: 'SI-BODY-MARKER' });
    const sys = buildChatSystem({ ...snapshotPaper, id: paperId }, {
      constitution: 'CONST-SNAPSHOT', format: 'openai',
    });
    assert.equal(sys, `${snapshot.openai}\n\n${renderSiBlock(paperId)}`);
    assert.ok(sys.includes('SI-BODY-MARKER'));
    clearAll();
  });
});

describe('區塊內容：四種情境', () => {
  it('一份完整的 SI：標題行 + 全文，表頭說「共 1 份」', () => {
    clearAll();
    const paperId = addPaper();
    addSi(paperId, { label: '方法細節', text: 'ABCDEFGHIJ' });

    const block = renderSiBlock(paperId);
    assert.equal(block,
      '以下是這篇論文的補充材料（Supplementary Information，共 1 份）。'
      + '回答用到時請說明出自哪一份 SI；沒列在這裡的補充材料你讀不到，不要推測。'
      + '\n\n【SI 1：方法細節】\nABCDEFGHIJ');
    clearAll();
  });

  it('掃描版：只有標題行＋「這份你讀不到」，不佔預算', () => {
    clearAll();
    const paperId = addPaper();
    addSi(paperId, { label: '掃描的附錄', text: '', order: 0 });
    addSi(paperId, { label: '有字的', text: 'XYZ', order: 1 });

    const ctx = buildSiContext(paperId);
    assert.ok(ctx.block.includes('【SI 1：掃描的附錄】（掃描版，抽不到文字——這份你讀不到）'), ctx.block);
    assert.ok(ctx.block.includes('【SI 2：有字的】\nXYZ'), ctx.block);
    assert.equal(ctx.count, 2, '掃描版也算在「共 N 份」裡');
    assert.equal(ctx.chars, 3, '掃描版不佔字數預算');
    clearAll();
  });

  it('合計預算截斷：第一份被截、第二份整份被擠掉只剩標題行', () => {
    clearAll();
    process.env.PAPER_SI_LIMIT_CHARS = '10';
    const paperId = addPaper();
    addSi(paperId, { label: '第一份', text: 'A'.repeat(25), order: 0 });
    addSi(paperId, { label: '第二份', text: 'B'.repeat(30), order: 1 });

    const ctx = buildSiContext(paperId);
    assert.ok(ctx.block.includes('【SI 1：第一份】（只給了前 10 字，全長 25 字）\n' + 'A'.repeat(10)), ctx.block);
    assert.ok(ctx.block.includes('【SI 2：第二份】（超出字數預算，這份沒給你）'), ctx.block);
    assert.ok(!ctx.block.includes('B'), '被擠掉的份一個字都不該出現');
    assert.equal(ctx.chars, 10);
    assert.equal(ctx.count, 2);
    clearAll();
  });

  it('大數字帶千分位（她要看得懂「AI 只讀了前幾字」）', () => {
    clearAll();
    process.env.PAPER_SI_LIMIT_CHARS = '1500';
    const paperId = addPaper();
    addSi(paperId, { label: '長附錄', text: 'C'.repeat(9000) });
    assert.ok(renderSiBlock(paperId).includes('（只給了前 1,500 字，全長 9,000 字）'), renderSiBlock(paperId));
    clearAll();
  });

  it('ai_visible=0 的那份不進區塊，也不佔編號', () => {
    clearAll();
    const paperId = addPaper();
    addSi(paperId, { label: '關掉的', text: 'HIDDEN-MARKER', visible: 0, order: 0 });
    addSi(paperId, { label: '開著的', text: 'SHOWN', visible: 1, order: 1 });

    const ctx = buildSiContext(paperId);
    assert.ok(!ctx.block.includes('HIDDEN-MARKER'));
    assert.ok(!ctx.block.includes('關掉的'));
    assert.ok(ctx.block.includes('共 1 份'));
    assert.ok(ctx.block.includes('【SI 1：開著的】\nSHOWN'), ctx.block);
    clearAll();
  });

  it('依 sort_order 排，不是依插入順序', () => {
    clearAll();
    const paperId = addPaper();
    addSi(paperId, { label: '後面的', text: 'LATER', order: 5 });
    addSi(paperId, { label: '前面的', text: 'EARLIER', order: 1 });
    const block = renderSiBlock(paperId);
    assert.ok(block.indexOf('【SI 1：前面的】') < block.indexOf('【SI 2：後面的】'), block);
    clearAll();
  });

  it('別篇論文的 SI 不會漏進來', () => {
    clearAll();
    const mine = addPaper();
    const other = addPaper();
    addSi(other, { label: '別人的', text: 'OTHER-PAPER-MARKER' });
    assert.equal(renderSiBlock(mine), '');
    clearAll();
  });
});

describe('resolvePaperSiLimit：env 旋鈕', () => {
  it('沒設 → 預設 100,000', () => {
    delete process.env.PAPER_SI_LIMIT_CHARS;
    assert.equal(resolvePaperSiLimit(), 100_000);
  });

  it('空字串／非數字 → 退回預設', () => {
    for (const v of ['', '   ', 'abc', 'NaN']) {
      process.env.PAPER_SI_LIMIT_CHARS = v;
      assert.equal(resolvePaperSiLimit(), 100_000, `v=${JSON.stringify(v)}`);
    }
  });

  it('0 是有意義的值（整個關掉），不得被當成非法值吃掉', () => {
    process.env.PAPER_SI_LIMIT_CHARS = '0';
    assert.equal(resolvePaperSiLimit(), 0);
  });

  it('負數 → 退回預設；超大 → clamp 到 1,000,000', () => {
    process.env.PAPER_SI_LIMIT_CHARS = '-5';
    assert.equal(resolvePaperSiLimit(), 100_000);
    process.env.PAPER_SI_LIMIT_CHARS = '99999999';
    assert.equal(resolvePaperSiLimit(), 1_000_000);
  });

  it('每次呼叫重讀 env（改了不必重新 import）', () => {
    process.env.PAPER_SI_LIMIT_CHARS = '777';
    assert.equal(resolvePaperSiLimit(), 777);
    process.env.PAPER_SI_LIMIT_CHARS = '888';
    assert.equal(resolvePaperSiLimit(), 888);
  });
});

describe('planSiBudget：唯一一顆預算函式（UI 與 prompt 共用）', () => {
  const a = (id, chars, ai_visible = 1) => ({ id, chars, ai_visible });

  it('全部塞得下 → 每份都是整份，truncated 全 false', () => {
    const { plan, visible, totalSent } = planSiBudget([a('x', 10), a('y', 20)], 100);
    assert.equal(visible, 2);
    assert.equal(totalSent, 30);
    assert.deepEqual(plan.get('x'), { sent: 10, truncated: false, dropped: false, scanned: false, hidden: false });
    assert.deepEqual(plan.get('y'), { sent: 20, truncated: false, dropped: false, scanned: false, hidden: false });
  });

  it('合計預算：前面吃掉、後面截斷、再後面整份被擠掉', () => {
    const { plan, totalSent } = planSiBudget([a('x', 10), a('y', 20), a('z', 5)], 15);
    assert.equal(plan.get('x').sent, 10);
    assert.equal(plan.get('y').sent, 5);
    assert.equal(plan.get('y').truncated, true);
    assert.equal(plan.get('z').dropped, true);
    assert.equal(plan.get('z').sent, 0);
    assert.equal(totalSent, 15);
  });

  it('ai_visible=0 → hidden、不佔預算、不算進 visible', () => {
    const { plan, visible, totalSent } = planSiBudget([a('h', 999, 0), a('x', 10)], 100);
    assert.equal(visible, 1);
    assert.equal(totalSent, 10);
    assert.equal(plan.get('h').hidden, true);
    assert.equal(plan.get('h').sent, 0);
  });

  it('chars=0（掃描版）→ scanned，不佔預算但算進 visible', () => {
    const { plan, visible, totalSent } = planSiBudget([a('s', 0), a('x', 10)], 100);
    assert.equal(visible, 2);
    assert.equal(totalSent, 10);
    assert.equal(plan.get('s').scanned, true);
  });

  it('limit=0 → 全部 dropped；空陣列／undefined 不炸', () => {
    const zero = planSiBudget([a('x', 10)], 0);
    assert.equal(zero.totalSent, 0);
    assert.equal(zero.plan.get('x').dropped, true);
    assert.equal(planSiBudget([], 100).totalSent, 0);
    assert.equal(planSiBudget(undefined, 100).visible, 0);
  });
});
