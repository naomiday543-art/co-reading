// 工單 13 §5 的釘子：上限、參考文獻區塊、頁級抽字品質、text_meta、ctx_overflow。
//
// 全部 mock 上游——**絕不打真上游**（工單 13 §4 紅線）。
// 參考文獻與頁級品質的 fixture 都是照她八篇的真實形狀捏的（版式在註解裡寫明是哪一篇），
// 真 DB 的對照結果在 docs/work/report-13-fulltext-limit-quality-20260914.md。
import { test, describe, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { nanoid } from 'nanoid';

process.env.CO_READING_DB_PATH = `/tmp/co-reading-fulltext-quality-${process.pid}.sqlite`;

import db from '../src/db.js';
import {
  locateReferencesBlock, buildTextMeta, describePages, describePageQuality,
  parseTextMeta, MIN_CITATION_DENSITY, TEXT_META_VERSION,
} from '../src/pdf.js';
import {
  resolvePaperFulltextLimit, resolveCutReferences, clipFullText,
  stripReferences, prepareFullTextForModel, buildPaperBlock, buildQualityNote,
  analyzeErrorKind, isRetryableAnalyzeError, describeAnalyzeError, describeChatError,
  analyzePaper,
} from '../src/ai.js';
import { describeTextQuality, renderPageList, renderPageReasons } from '../frontend/src/textQuality.js';

const realFetch = global.fetch;
const envBackup = {};

function setEnv(key, value) {
  if (!(key in envBackup)) envBackup[key] = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

afterEach(() => {
  for (const [key, value] of Object.entries(envBackup)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    delete envBackup[key];
  }
  global.fetch = realFetch;
});

// ── §5.1 上限 ───────────────────────────────────────────────────────────

describe('§5.1 PAPER_FULLTEXT_LIMIT_CHARS', () => {
  test('預設 250,000（工單 13 §3.1 拍板值）', () => {
    setEnv('PAPER_FULLTEXT_LIMIT_CHARS', undefined);
    assert.equal(resolvePaperFulltextLimit(), 250_000);
  });

  test('空／非數字／0 一律退回預設，不是 0 也不是 NaN', () => {
    for (const raw of ['', '   ', 'abc', '0', '-5']) {
      setEnv('PAPER_FULLTEXT_LIMIT_CHARS', raw);
      assert.equal(resolvePaperFulltextLimit(), 250_000, `${JSON.stringify(raw)} 應該退回預設`);
    }
  });

  test('超大／超小 clamp 到 [20,000, 2,000,000]', () => {
    setEnv('PAPER_FULLTEXT_LIMIT_CHARS', '1e9');
    assert.equal(resolvePaperFulltextLimit(), 2_000_000);
    setEnv('PAPER_FULLTEXT_LIMIT_CHARS', '100');
    assert.equal(resolvePaperFulltextLimit(), 20_000);
  });

  test('合法值照用（她把窗口小的線調低時就是走這條）', () => {
    setEnv('PAPER_FULLTEXT_LIMIT_CHARS', '120000');
    assert.equal(resolvePaperFulltextLimit(), 120_000);
  });

  test('249,999 字不截、250,001 字截且帶標記', () => {
    setEnv('PAPER_FULLTEXT_LIMIT_CHARS', undefined);
    const under = clipFullText('字'.repeat(249_999));
    assert.equal(under.length, 249_999);
    assert.ok(!under.includes('[全文已截斷]'));

    const over = clipFullText('字'.repeat(250_001));
    assert.ok(over.endsWith('\n[全文已截斷]'));
    assert.equal(over.length, 250_000 + '\n[全文已截斷]'.length);

    // 邊界：剛好等於上限不算截斷（與 GET /api/papers/:id 的 > 一致）
    assert.equal(clipFullText('字'.repeat(250_000)).length, 250_000);
  });
});

// ── §5.2 參考文獻區塊 ───────────────────────────────────────────────────

/** 造 n 條長得像參考文獻的條目（年份、et al.、doi 都有）。 */
function fakeReferences(n, startIndex = 1) {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const k = startIndex + i;
    out.push(`${k}. Author A${k}, Author B${k} et al. A study of things ${k}. `
      + `Journal of Things ${k}, 100-110 (20${String(10 + (k % 15)).padStart(2, '0')}). doi:10.1000/j.things.${k}`);
  }
  return out.join('\n');
}

/**
 * 造一段**乾淨的正文**：至少 chars 字，一個引用特徵都沒有
 *（沒有年份＋標點、沒有 et al.、沒有 doi 這三個字母、沒有網址、沒有編號條目）。
 * 位置門檻是「標題落在全文 ≥50%」，所以正文長度必須壓得過參考文獻——
 * 這也是真實論文的比例（她八篇的參考文獻佔 1%–42%）。
 */
function fakeBody(chars, tag = 'BODY') {
  const out = [];
  let total = 0;
  for (let i = 0; total < chars; i += 1) {
    const line = `${tag}-${i} 這一段是正文，講的是實驗設計與觀察到的現象。`
      + `我們把樣本分成兩組，分別在不同條件下培養，然後比較它們的差異與可能的機制解釋。`;
    out.push(line);
    total += line.length + 1;
  }
  return out.join('\n');
}

/** 正文 ＋ 參考文獻（＋可選的尾段），保證標題落在 ≥55% 的位置。 */
function paperWith(refs, tail = '', { heading = 'References' } = {}) {
  const bodyChars = Math.max(2000, Math.round((refs.length + tail.length) * 1.4));
  return `${fakeBody(bodyChars)}\n${heading}\n${refs}\n${tail}`;
}

describe('§5.2 locateReferencesBlock', () => {
  test('(a) 標準期刊版式：References 在後段、一路到文末 → 切到文末', () => {
    const text = paperWith(fakeReferences(40));
    const r = locateReferencesBlock(text);
    assert.equal(r.cut, true);
    assert.equal(r.reason, 'ok');
    assert.equal(text.slice(r.start, r.start + 'References'.length), 'References');
    assert.equal(r.end, text.length);
  });

  test('(b) Cell Press 版式：REFERENCES 後面還有 STAR★METHODS → 方法保留', () => {
    const methods = `STAR★METHODS\n${fakeBody(2200, 'METHOD')}`;
    const text = paperWith(fakeReferences(60), `${methods}\n`, { heading: 'REFERENCES' });
    const r = locateReferencesBlock(text);

    assert.equal(r.cut, true);
    assert.equal(text.slice(r.end).trimStart().startsWith('STAR★METHODS'), true,
      '區塊終點應該落在 STAR★METHODS 之前');

    const { text: sent } = prepareFullTextForModel(text, null);
    assert.ok(sent.includes('STAR★METHODS'), '方法段不能被切掉');
    assert.ok(sent.includes('METHOD-0'), '方法段正文不能被切掉');
    assert.ok(!sent.includes('40. Author A40'), '參考文獻條目應該不見了');
    assert.ok(/\[參考文獻 [\d,]+ 字已略去\]/.test(sent));
  });

  test('(c) 正文中段就有一行 References、真標題在後面 → 取後面那個', () => {
    const refs = fakeReferences(40);
    const head = `${fakeBody(6000)}\nReferences\n${fakeBody(6000, 'STILL-BODY')}`;
    const text = `${head}\nReferences\n${refs}\n`;
    const r = locateReferencesBlock(text);

    assert.equal(r.cut, true);
    assert.ok(r.start > head.indexOf('\nReferences\n'), '不能取到正文裡那個');
    const { text: sent } = prepareFullTextForModel(text, null);
    assert.ok(sent.includes('STILL-BODY-0'), '兩個標題之間的正文必須留著');
  });

  test('(d) 有標題但區塊沒有引用特徵 → 不切，reason=low_density', () => {
    const text = `${fakeBody(9000)}\nReferences\n${fakeBody(1500, 'NOT-REFS')}\n`;
    const r = locateReferencesBlock(text);
    assert.equal(r.cut, false);
    assert.equal(r.reason, 'low_density');
    assert.ok(r.density < MIN_CITATION_DENSITY);

    const { text: sent, refsCut } = prepareFullTextForModel(text, null);
    assert.equal(refsCut, false);
    assert.equal(sent, text, '不切就是逐字原樣');
  });

  test('50% 位置門檻：標題在前段一律不取（她 jGPpnD 那篇 40.6% 的形狀）', () => {
    const text = `${fakeBody(1500)}\nReferences\n${fakeReferences(5)}\n${fakeBody(12000)}`;
    assert.equal(locateReferencesBlock(text).cut, false);
    assert.equal(locateReferencesBlock(text).reason, 'no_heading');
  });

  test('尾端密度回退：References 與下一個標題之間夾著圖注，圖注要留著', () => {
    // 她的 Immunity 那篇就是這個形狀：REFERENCES … 參考文獻 … 圖注 … KEY RESOURCES TABLE
    const legends = fakeBody(4000, 'FIGURE-LEGEND');
    const text = paperWith(fakeReferences(60), `${legends}\nKEY RESOURCES TABLE\nReagent\tSource\n`,
      { heading: 'REFERENCES' });
    const r = locateReferencesBlock(text);

    assert.equal(r.cut, true);
    assert.ok(r.end < text.indexOf('KEY RESOURCES TABLE'), '不能一路切到 KEY RESOURCES TABLE');
    const { text: sent } = prepareFullTextForModel(text, null);
    assert.ok(sent.includes('FIGURE-LEGEND-0'), '圖注必須留著');
    assert.ok(sent.includes('KEY RESOURCES TABLE'));
    assert.ok(!sent.includes('60. Author A60'), '參考文獻還是要切掉');
  });

  test('中文標題也認得（參考文獻／参考文献）', () => {
    for (const heading of ['參考文獻', '参考文献']) {
      const text = paperWith(fakeReferences(40), '', { heading });
      assert.equal(locateReferencesBlock(text).cut, true, heading);
    }
  });

  test('空全文不炸', () => {
    const r = locateReferencesBlock('');
    assert.equal(r.cut, false);
    assert.equal(r.reason, 'empty');
  });
});

// ── 工單 16：門檻 35% ＋ 多區塊 ─────────────────────────────────────────

/**
 * Nature 版式（她那篇 Cholesterol 的真實形狀）：
 * 正文 → References(≈40%) → Methods → References(≈70%, 只有幾條) → Acknowledgements → 尾段。
 * 兩個文獻表都要切，Methods 一個字都不能少。
 */
function natureFixture() {
  const refs1 = fakeReferences(40);
  const refs2 = fakeReferences(5, 41);
  const body = fakeBody(12000);
  const methods = fakeBody(9000 - refs1.length, 'METHOD');
  const tail = fakeBody(8400, 'ACK');
  return `${body}\nReferences\n${refs1}\nMethods\n${methods}\nReferences\n${refs2}\nAcknowledgements\n${tail}`;
}

describe('工單 16 §3.1 門檻 35%：[35%, 50%) 的候選要多過兩道閂', () => {
  test('§5.1 Nature 版式：40% 主文獻表＋70% 補充文獻表兩塊都切，Methods 留著', () => {
    const text = natureFixture();
    const r = locateReferencesBlock(text);

    assert.equal(r.cut, true);
    assert.equal(r.reason, 'ok');
    assert.equal(r.blocks.length, 2, '兩個文獻表都要進 blocks[]');

    const ratio = r.blocks[0].start / text.length;
    assert.ok(ratio >= 0.35 && ratio < 0.5, `第一塊要落在 [35%, 50%)，實際 ${(ratio * 100).toFixed(1)}%`);
    assert.ok(r.blocks[1].start / text.length >= 0.5);
    assert.ok(r.blocks[0].start < r.blocks[1].start, 'blocks 依 start 排序');
    assert.ok(r.blocks[0].end <= r.blocks[1].start, 'blocks 不重疊');

    // 第一塊的終點必須正好是 Methods 標題（不是文末、不是尾端回退出來的點）
    assert.equal(text.slice(r.blocks[0].end).startsWith('Methods\n'), true);
    assert.equal(text.slice(r.blocks[1].end).startsWith('Acknowledgements\n'), true);

    assert.equal(r.chars_total, r.blocks[0].chars + r.blocks[1].chars);
    // start/end/chars ＝最大那一塊（向後相容 UI 與工單 13 的既有測試）
    assert.equal(r.start, r.blocks[0].start);
    assert.equal(r.end, r.blocks[0].end);
    assert.equal(r.chars, r.blocks[0].chars);
    assert.ok(r.chars < r.chars_total, '最大那塊不等於全部，chars_total 才是合計');
  });

  test('§5.1 兩塊各放一行標記，Methods 與尾段一個字都不能少', () => {
    const text = natureFixture();
    const r = locateReferencesBlock(text);
    const { text: sent, refsCut, refsChars, refsBlocks } = prepareFullTextForModel(text, null);

    assert.equal(refsCut, true);
    assert.equal(refsBlocks, 2);
    assert.equal(refsChars, r.chars_total);

    const markers = sent.match(/\[參考文獻 [\d,]+ 字已略去\]/g) || [];
    assert.equal(markers.length, 2, '每個區塊各一行標記');
    assert.equal(markers[0], `[參考文獻 ${r.blocks[0].chars.toLocaleString('en-US')} 字已略去]`);
    assert.equal(markers[1], `[參考文獻 ${r.blocks[1].chars.toLocaleString('en-US')} 字已略去]`);

    assert.ok(sent.includes('METHOD-0'), 'Methods 正文不能被切掉');
    assert.ok(sent.includes('ACK-0'), '尾段不能被切掉');
    assert.ok(sent.includes('BODY-0'), '正文不能被挖掉');
    assert.ok(!sent.includes('1. Author A1,'), '主文獻表要不見');
    assert.ok(!sent.includes('41. Author A41,'), '補充文獻表要不見');
    assert.equal(sent.length, text.length - r.chars_total + markers.join('').length + 2);
  });

  test('§5.2 37% 的候選一路到文末（沒有終點標題）→ 不切', () => {
    const text = `${fakeBody(7000)}\nReferences\n${fakeReferences(92)}`;
    const r = locateReferencesBlock(text);
    const ratio = text.indexOf('\nReferences\n') / text.length;
    assert.ok(ratio >= 0.35 && ratio < 0.5, `fixture 要落在 [35%, 50%)，實際 ${(ratio * 100).toFixed(1)}%`);

    assert.equal(r.cut, false);
    assert.equal(r.reason, 'early_open_end');
    assert.deepEqual(r.blocks, []);
    assert.equal(r.chars_total, 0);
    assert.equal(prepareFullTextForModel(text, null).text, text, '不切就是逐字原樣');
  });

  test('§5.2 同一塊文獻表，補上終點標題就切得掉（證明擋的是終點不明，不是位置）', () => {
    const text = `${fakeBody(7000)}\nReferences\n${fakeReferences(92)}\nAcknowledgements\n${fakeBody(300, 'ACK')}`;
    const r = locateReferencesBlock(text);
    assert.equal(r.cut, true);
    assert.equal(r.blocks.length, 1);
    assert.equal(text.slice(r.end).startsWith('Acknowledgements\n'), true);
  });

  test('§5.3 37% 的候選終點是標題、但區塊只有 900 字 → 不切', () => {
    const text = `${fakeBody(7000)}\nReferences\n${fakeReferences(7)}\nMethods\n${fakeBody(11000, 'METHOD')}`;
    const r = locateReferencesBlock(text);
    const ratio = text.indexOf('\nReferences\n') / text.length;
    assert.ok(ratio >= 0.35 && ratio < 0.5, `fixture 要落在 [35%, 50%)，實際 ${(ratio * 100).toFixed(1)}%`);

    assert.ok(r.chars < 2000 && r.chars > 500, `區塊要在 2,000 字門檻之下，實際 ${r.chars}`);
    assert.equal(r.cut, false);
    assert.equal(r.reason, 'early_too_short');
    assert.ok(prepareFullTextForModel(text, null).text.includes('1. Author A1,'), '不切＝文獻條目還在');
  });

  test('§5.4 正文句子裡的 references（非獨立行）不是候選，真標題在後面才算', () => {
    const sentence = '我們在 41% 的位置提到 see the references cited above for details，這是一句正文。';
    const text = `${fakeBody(6000)}\n${sentence}\n${fakeBody(6000, 'MID')}\nReferences\n${fakeReferences(40)}\nAcknowledgements\n${fakeBody(400, 'ACK')}`;
    const r = locateReferencesBlock(text);

    assert.equal(r.cut, true);
    assert.equal(r.blocks.length, 1, '正文那句不該變成第二塊');
    assert.ok(r.start > text.indexOf(sentence), '取的是後面那個真標題');
    const { text: sent } = prepareFullTextForModel(text, null);
    assert.ok(sent.includes(sentence), '正文那句要留著');
    assert.ok(sent.includes('MID-0'), '兩者之間的正文要留著');
  });

  test('[35%, 50%) 的密度門檻沒有被放寬（終點是標題、夠長，但整塊太稀）', () => {
    // 尾端是真文獻（所以尾端回退不會動終點，兩道閂都過），但整塊被正文稀釋到 6/1000 以下。
    const block = `${fakeBody(6000, 'NOT-REFS')}\n${fakeReferences(6)}`;
    const text = `${fakeBody(9000)}\nReferences\n${block}\nMethods\n${fakeBody(6000, 'METHOD')}`;
    const r = locateReferencesBlock(text);
    const ratio = text.indexOf('\nReferences\n') / text.length;
    assert.ok(ratio >= 0.35 && ratio < 0.5, `fixture 要落在 [35%, 50%)，實際 ${(ratio * 100).toFixed(1)}%`);

    assert.equal(text.slice(r.end).startsWith('Methods\n'), true, '終點是標題、沒被尾端回退動過');
    assert.ok(r.chars >= 2000, '長度也夠');
    assert.equal(r.cut, false, '就差密度這一關');
    assert.equal(r.reason, 'low_density');
    assert.ok(r.density < MIN_CITATION_DENSITY);
  });

  test('兩道閂的順序：終點不明時先報 early_open_end（稀疏區塊會被尾端回退先動到）', () => {
    const text = `${fakeBody(7000)}\nReferences\n${fakeBody(3000, 'NOT-REFS')}\nMethods\n${fakeBody(8000, 'METHOD')}`;
    const r = locateReferencesBlock(text);
    assert.equal(r.cut, false, '不管理由是哪一個，正文都不准被挖掉');
    assert.equal(r.reason, 'early_open_end');
    assert.ok(prepareFullTextForModel(text, null).text.includes('NOT-REFS-0'));
  });

  test('候選重疊時保留較早開始的那一塊（工單 16 §3.2）', () => {
    const text = `${fakeBody(9000)}\nReferences\n${fakeReferences(30)}\nReferences\n${fakeReferences(30, 31)}\nAcknowledgements\n${fakeBody(400, 'ACK')}`;
    const r = locateReferencesBlock(text);

    assert.equal(r.cut, true);
    assert.equal(r.blocks.length, 1, '後面那塊被前面那塊包住，只留一塊');
    assert.equal(r.start, text.indexOf('\nReferences\n') + 1);
    const { text: sent } = prepareFullTextForModel(text, null);
    assert.equal((sent.match(/\[參考文獻 [\d,]+ 字已略去\]/g) || []).length, 1);
    assert.ok(!sent.includes('31. Author A31,'), '兩張表都要切掉');
  });

  test('≥50% 的候選行為不變：尾端密度回退照舊保住圖注（她那篇 Immunity）', () => {
    const legends = fakeBody(4000, 'FIGURE-LEGEND');
    const text = paperWith(fakeReferences(60), `${legends}\nKEY RESOURCES TABLE\nReagent\tSource\n`,
      { heading: 'REFERENCES' });
    const r = locateReferencesBlock(text);

    assert.equal(r.cut, true);
    assert.equal(r.blocks.length, 1);
    assert.ok(r.blocks[0].start / text.length >= 0.5, '這顆釘的是 ≥50% 那條路徑');
    assert.ok(r.end < text.indexOf('KEY RESOURCES TABLE'), '尾端回退還在');
    const { text: sent } = prepareFullTextForModel(text, null);
    assert.ok(sent.includes('FIGURE-LEGEND-0'), '圖注必須留著');
  });
});

describe('工單 16 §3.2 text_meta 的形狀與向後相容', () => {
  test('buildTextMeta 多了 blocks[] 與 chars_total，version=2', () => {
    const text = natureFixture();
    const meta = buildTextMeta(text, []);

    assert.equal(meta.version, TEXT_META_VERSION);
    assert.equal(TEXT_META_VERSION, 2);
    assert.equal(meta.references.blocks.length, 2);
    assert.equal(meta.references.chars_total, meta.references.blocks.reduce((n, b) => n + b.chars, 0));
    assert.equal(meta.references.chars, meta.references.blocks[0].chars, 'chars ＝最大那一塊');
    for (const b of meta.references.blocks) {
      assert.equal(text.slice(b.start, b.start + b.heading.length), b.heading);
      assert.equal(b.reason, 'ok');
      assert.equal(typeof b.density, 'number');
    }
  });

  test('存下來的 blocks 直接拿來用（不必每輪重算），切出來跟現算的一樣', () => {
    const text = natureFixture();
    const meta = buildTextMeta(text, []);
    const fromMeta = stripReferences(text, JSON.stringify(meta));
    const fresh = stripReferences(text, null);
    assert.equal(fromMeta.text, fresh.text);
    assert.equal(fromMeta.blocks, 2);
    assert.equal(fromMeta.chars, meta.references.chars_total);
  });

  test('工單 16 之前存的 v1 單塊 meta（沒有 blocks）照舊能用', () => {
    const text = paperWith(fakeReferences(40));
    const fresh = locateReferencesBlock(text);
    const v1 = {
      version: 1,
      references: {
        cut: true, start: fresh.start, end: fresh.end, chars: fresh.chars,
        reason: 'ok', heading: fresh.heading, density: fresh.density,
      },
      pages: [], bad_pages: [],
    };
    const out = stripReferences(text, JSON.stringify(v1));
    assert.equal(out.cut, true);
    assert.equal(out.blocks, 1);
    assert.equal(out.chars, fresh.chars);
  });

  test('存下來的 blocks 有一塊對不上標題 → 整份當場重算，不照著錯位置亂切', () => {
    const text = natureFixture();
    const meta = buildTextMeta(text, []);
    meta.references.blocks[1] = { ...meta.references.blocks[1], start: 10, end: 400 };
    const out = stripReferences(text, JSON.stringify(meta));

    assert.equal(out.blocks, 2);
    assert.equal(out.chars, locateReferencesBlock(text).chars_total, '應該用重算的結果');
    assert.ok(out.text.includes('BODY-0'), '正文開頭不能被挖掉');
  });
});

describe('§5.2 stripReferences：只動送出去的那份', () => {
  const text = paperWith(fakeReferences(40));

  test('原文物件一個字不改，回傳的是新字串', () => {
    const original = `${text}`;
    const out = stripReferences(text, null);
    assert.equal(out.cut, true);
    assert.notEqual(out.text, text);
    assert.equal(text, original, 'papers.full_text 的那份必須逐字不變');
  });

  test('切掉處放一行「[參考文獻 N 字已略去]」，N 是真的字數', () => {
    const block = locateReferencesBlock(text);
    const out = stripReferences(text, null);
    assert.ok(out.text.includes(`[參考文獻 ${block.chars.toLocaleString('en-US')} 字已略去]`));
    assert.equal(out.chars, block.chars);
    assert.equal(out.text.length, text.length - block.chars
      + `[參考文獻 ${block.chars.toLocaleString('en-US')} 字已略去]\n`.length);
  });

  test('CUT_REFERENCES=false 整個關掉（回滾旋鈕）', () => {
    setEnv('CUT_REFERENCES', 'false');
    assert.equal(resolveCutReferences(), false);
    const out = stripReferences(text, null);
    assert.equal(out.cut, false);
    assert.equal(out.reason, 'disabled');
    assert.equal(out.text, text);
  });

  test('用存下來的 text_meta 偏移（不必每輪重算）', () => {
    const meta = buildTextMeta(text);
    const out = stripReferences(text, JSON.stringify(meta));
    assert.equal(out.cut, true);
    assert.equal(out.chars, meta.references.chars);
  });

  test('存下來的偏移對不上標題 → 當場重算，不照著錯位置亂切', () => {
    const stale = {
      version: 1,
      references: { cut: true, start: 12, end: 400, chars: 388, reason: 'ok', heading: 'References', density: 20 },
      pages: [], bad_pages: [],
    };
    const out = stripReferences(text, JSON.stringify(stale));
    const fresh = locateReferencesBlock(text);
    assert.equal(out.cut, true);
    assert.equal(out.chars, fresh.chars, '應該用重算的結果，不是那個錯偏移');
    assert.ok(out.text.includes('BODY-0'), '正文開頭不能被挖掉');
  });

  test('先切參考文獻、再套上限——順序反了就白切', () => {
    setEnv('PAPER_FULLTEXT_LIMIT_CHARS', '20000');
    const big = paperWith(fakeReferences(400));
    const prepared = prepareFullTextForModel(big, null);
    assert.equal(prepared.refsCut, true);
    assert.ok(prepared.text.length <= 20_000 + '\n[全文已截斷]'.length);
  });
});

// ── §5.3 頁級抽字品質 ───────────────────────────────────────────────────

/** 一頁「正常」的抽字結果。 */
function okPage(n, chars = 1800) {
  const line = '這一行是正常抽出來的內文，長度與字元分佈都很普通。';
  const lines = Math.max(1, Math.round(chars / line.length));
  return { n, text: Array.from({ length: lines }, () => line).join('\n'), items: 120, rotatedItems: 2, rotate: 0 };
}

describe('§5.3 describePageQuality', () => {
  test('橫向表格：多數 text item 被旋轉 → quality=rotated', () => {
    const page = { ...okPage(3), items: 80, rotatedItems: 60 };
    const q = describePageQuality(page, 3);
    assert.equal(q.rotated_hint, true);
    assert.equal(q.quality, 'rotated');
    assert.ok(q.reasons.includes('rotated'));
  });

  test('側邊浮水印不算旋轉（她那篇 Immunity 每頁 4/119 個 item 是轉的）', () => {
    const q = describePageQuality({ ...okPage(5), items: 119, rotatedItems: 4 }, 5);
    assert.equal(q.rotated_hint, false);
    assert.equal(q.quality, 'ok');
  });

  test('整頁 /Rotate 90 也算（item transform 反而是正的那種）', () => {
    const q = describePageQuality({ ...okPage(6), rotate: 90, rotatedItems: 0 }, 6);
    assert.equal(q.rotated_hint, true);
  });

  test('單字元行過半 → quality=poor（fragmented）', () => {
    const text = Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? 'A' : '這是一行比較正常的內文字句')).join('\n');
    const q = describePageQuality({ n: 7, text, items: 200, rotatedItems: 0, rotate: 0 }, 7);
    assert.ok(q.single_char_line_ratio > 0.4);
    assert.equal(q.quality, 'poor');
    assert.ok(q.reasons.includes('fragmented'));
  });

  test('非末頁 <200 字 → poor（too_short）；末頁不算', () => {
    const thin = { n: 12, text: '只有這幾個字', items: 6, rotatedItems: 0, rotate: 0 };
    assert.equal(describePageQuality(thin, 12, false).quality, 'poor');
    assert.equal(describePageQuality(thin, 12, true).quality, 'ok', '末頁常常只有版權宣告');
  });

  test('亂碼（非文字符號 >30%）→ poor（garbled）', () => {
    const q = describePageQuality({ n: 9, text: '��'.repeat(80), items: 40, rotatedItems: 0, rotate: 0 }, 9);
    assert.ok(q.nonword_ratio > 0.3);
    assert.equal(q.quality, 'poor');
    assert.ok(q.reasons.includes('garbled'));
  });

  test('describePages 把 bad_pages 挑出來，頁碼是 1-based', () => {
    const pages = [okPage(1), { ...okPage(2), items: 80, rotatedItems: 70 }, okPage(3),
      { n: 4, text: '短', items: 2, rotatedItems: 0, rotate: 0 }, okPage(5)];
    const meta = buildTextMeta('全文很短但這裡不測參考文獻', describePages(pages));
    assert.deepEqual(meta.bad_pages, [2, 4]);
    assert.equal(meta.pages[1].quality, 'rotated');
    assert.equal(meta.pages[3].quality, 'poor');
    assert.equal(meta.pages.length, 5);
  });
});

describe('§5.3 給模型的品質提示', () => {
  const paper = {
    id: 'q1', title: 'T', authors: 'A', year: 2024,
    summary_bg: 'bg', summary_methods: 'm', summary_results: 'r',
    summary_conclusions: 'c', summary_limitations: 'l',
    full_text: '全文很短，沒有參考文獻標題。',
  };

  test('沒有壞頁時提示完全不出現，穩定前綴逐字等於工單 13 之前', () => {
    const clean = buildTextMeta(paper.full_text, describePages([okPage(1), okPage(2)]));
    assert.deepEqual(clean.bad_pages, []);
    assert.equal(buildQualityNote(JSON.stringify(clean)), '');

    const expected = `以下是這篇論文的信息：
標題：T
作者：A
年份：2024

AI 摘要：
- 背景：bg
- 方法：m
- 結果：r
- 結論：c
- 局限：l

以下是論文全文（供你參考回答問題，不需要重複全文內容）：
全文很短，沒有參考文獻標題。`;
    assert.equal(buildPaperBlock(paper), expected, '沒壞頁＝一個字都不該多');
    assert.equal(buildPaperBlock({ ...paper, text_meta: JSON.stringify(clean) }), expected);
  });

  test('有壞頁時一句話說清楚哪幾頁、要模型明說讀不到', () => {
    const meta = {
      version: 1,
      references: { cut: false, start: -1, end: -1, chars: 0, reason: 'no_heading', heading: '', density: 0 },
      pages: [
        { n: 3, quality: 'rotated', reasons: ['rotated'], chars: 900, lines: 40 },
        { n: 7, quality: 'rotated', reasons: ['rotated'], chars: 800, lines: 30 },
        { n: 12, quality: 'poor', reasons: ['too_short'], chars: 120, lines: 3 },
      ],
      bad_pages: [3, 7, 12],
    };
    const note = buildQualityNote(JSON.stringify(meta));
    assert.equal(note,
      '抽字品質提示：第 3、7 頁文字疑似旋轉（可能是橫向表格）、第 12 頁抽字不完整。'
      + '這些頁的內容你可能讀不到或讀到亂碼；涉及時明說「這部分我從抽取文字裡讀不到」，不要推測。');

    const block = buildPaperBlock({ ...paper, text_meta: JSON.stringify(meta) });
    assert.ok(block.includes(note));
    assert.ok(block.indexOf(note) > block.indexOf('以下是論文全文'), '提示接在全文之後、方向區塊之前');
  });

  test('壞頁很多時收尾成「等 N 頁」，不要吐一整串頁碼', () => {
    const pages = Array.from({ length: 20 }, (_, i) => ({ n: i + 1, quality: 'poor', reasons: ['too_short'] }));
    const note = buildQualityNote({ version: 1, pages, bad_pages: pages.map(p => p.n) });
    assert.ok(note.includes('等 20 頁'));
  });

  test('text_meta 壞掉／沒有 → 空字串（不是 undefined、不是爆炸）', () => {
    assert.equal(buildQualityNote(''), '');
    assert.equal(buildQualityNote(null), '');
    assert.equal(buildQualityNote('{not json'), '');
    assert.equal(parseTextMeta('{not json'), null);
  });
});

describe('§5.3 前端那一行', () => {
  test('沒壞頁 → null（畫面上什麼都不出現）', () => {
    assert.equal(describeTextQuality(null), null);
    assert.equal(describeTextQuality({ pages: [{ n: 1, quality: 'ok' }] }), null);
  });

  test('有壞頁 → 一行人話＋明細', () => {
    const q = describeTextQuality({
      pages: [
        { n: 1, quality: 'ok' },
        { n: 27, quality: 'poor', reasons: ['too_short'] },
        { n: 28, quality: 'rotated', reasons: ['rotated'] },
      ],
    });
    assert.equal(q.line, '第 28 頁文字疑似旋轉（可能是橫向表格）、第 27 頁抽字不完整');
    assert.equal(q.badPages.length, 2);
    assert.equal(q.pageCount, 3);
    assert.equal(renderPageReasons(['too_short']), '這頁幾乎沒抽到字');
    assert.equal(renderPageList([3, 7]), '第 3、7 頁');
  });
});

// ── §5.4 text_meta migration 與路由 ─────────────────────────────────────

describe('§5.4 papers.text_meta migration', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'co-reading-textmeta-'));
  after(() => rmSync(tmpDir, { recursive: true, force: true }));

  test('既有庫（沒有 text_meta 欄）跑兩次遷移都不炸，資料原封不動', async () => {
    const dbFile = join(tmpDir, 'legacy.db');
    const legacy = new Database(dbFile);
    legacy.exec(`
      CREATE TABLE papers (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '',
        authors TEXT NOT NULL DEFAULT '',
        year INTEGER,
        doi TEXT,
        pdf_filename TEXT,
        full_text TEXT NOT NULL DEFAULT '',
        summary_bg TEXT NOT NULL DEFAULT '',
        summary_methods TEXT NOT NULL DEFAULT '',
        summary_results TEXT NOT NULL DEFAULT '',
        summary_conclusions TEXT NOT NULL DEFAULT '',
        summary_limitations TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'unread',
        notes TEXT NOT NULL DEFAULT '',
        tree_node_id TEXT,
        analyze_status TEXT NOT NULL DEFAULT 'pending',
        analyze_error TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO papers (id, full_text) VALUES ('old1', '舊論文的全文');
    `);
    legacy.close();

    const before = process.env.CO_READING_DB_PATH;
    try {
      process.env.CO_READING_DB_PATH = dbFile;
      const first = (await import(`../src/db.js?textmeta=1`)).default;
      const cols = () => first.prepare('PRAGMA table_info(papers)').all().filter(c => c.name === 'text_meta');
      assert.equal(cols().length, 1, '第一次遷移補上 text_meta');
      assert.equal(first.prepare("SELECT text_meta FROM papers WHERE id = 'old1'").get().text_meta, '');
      assert.equal(first.prepare("SELECT full_text FROM papers WHERE id = 'old1'").get().full_text, '舊論文的全文');
      first.close();

      // 第二次＝再啟動一次同一個庫
      const second = (await import(`../src/db.js?textmeta=2`)).default;
      assert.equal(second.prepare('PRAGMA table_info(papers)').all().filter(c => c.name === 'text_meta').length, 1);
      assert.equal(second.prepare("SELECT full_text FROM papers WHERE id = 'old1'").get().full_text, '舊論文的全文');
      second.close();
    } finally {
      process.env.CO_READING_DB_PATH = before;
    }
  });
});

describe('§5.4 GET /api/papers/:id 的 lazy 補算與 rebuild 端點', () => {
  let server, baseUrl;
  const paperId = `tm_${nanoid(6)}`;
  const fullText = paperWith(fakeReferences(40));

  before(async () => {
    db.prepare(`INSERT INTO papers (id, title, authors, year, full_text, summary_bg, summary_methods,
      summary_results, summary_conclusions, summary_limitations)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      paperId, 'TextMeta Paper', 'A', 2024, fullText, 'bg', 'm', 'r', 'c', 'l'
    );
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
    db.prepare('DELETE FROM papers WHERE id = ?').run(paperId);
    if (server) server.close();
  });

  test('第一次打開就把 text_meta 算好回寫（既有論文的補算路徑）', async () => {
    assert.equal(db.prepare('SELECT text_meta FROM papers WHERE id = ?').get(paperId).text_meta, '');

    const res = await fetch(`${baseUrl}/api/papers/${paperId}`);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.text_meta.references.cut, true);
    assert.equal(body.text_meta.version, TEXT_META_VERSION);
    assert.equal(body.full_text_limit, resolvePaperFulltextLimit());

    const stored = parseTextMeta(db.prepare('SELECT text_meta FROM papers WHERE id = ?').get(paperId).text_meta);
    assert.equal(stored.references.chars, body.text_meta.references.chars, '算完要回寫，不是每次重算');
    assert.equal(db.prepare('SELECT full_text FROM papers WHERE id = ?').get(paperId).full_text, fullText,
      'full_text 原文不准動');
  });

  test('POST /:id/text-meta/rebuild 重算（PDF 不在也照樣把參考文獻那半算完）', async () => {
    const res = await fetch(`${baseUrl}/api/papers/${paperId}/text-meta/rebuild`, { method: 'POST' });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.text_meta.references.cut, true);
    assert.deepEqual(body.text_meta.bad_pages, []);
  });

  test('rebuild 不存在的論文 → 404', async () => {
    const res = await fetch(`${baseUrl}/api/papers/nope_${nanoid(4)}/text-meta/rebuild`, { method: 'POST' });
    assert.equal(res.status, 404);
  });
});

// ── 工單 16 §3.3 版本升級自動重算 ───────────────────────────────────────

describe('工單 16 §5.6 舊論文靠版本號在下次打開時自動重算', () => {
  let server, baseUrl;
  const ids = [];
  // Nature 版式：v1 的規則只切得到後面那塊小的，v2 兩塊都切。
  const fullText = natureFixture();

  function insert(suffix, textMeta) {
    const id = `tmv_${suffix}_${nanoid(4)}`;
    ids.push(id);
    db.prepare(`INSERT INTO papers (id, title, authors, year, full_text, text_meta, summary_bg,
      summary_methods, summary_results, summary_conclusions, summary_limitations)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, 'Nature Layout', 'A', 2024, fullText, JSON.stringify(textMeta), 'bg', 'm', 'r', 'c', 'l'
    );
    return id;
  }

  /** 工單 13 時代存下來的樣子：單塊、只切到 70% 那張小表、有頁級品質。 */
  const legacyPages = [
    { n: 1, chars: 1800, lines: 40, quality: 'ok', reasons: [] },
    { n: 2, chars: 90, lines: 3, quality: 'poor', reasons: ['too_short'] },
  ];
  const legacyMeta = {
    version: 1,
    references: {
      cut: true, start: fullText.lastIndexOf('\nReferences\n') + 1, end: fullText.indexOf('\nAcknowledgements\n') + 1,
      chars: 0, reason: 'ok', heading: 'References', density: 15,
    },
    pages: legacyPages,
    bad_pages: [2],
  };
  legacyMeta.references.chars = legacyMeta.references.end - legacyMeta.references.start;

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
    for (const id of ids) db.prepare('DELETE FROM papers WHERE id = ?').run(id);
    if (server) server.close();
  });

  test('version=1 的舊列被打開時重算成 2，頁級品質沿用舊值（不重解析 PDF）', async () => {
    const id = insert('v1', legacyMeta);
    const body = await (await fetch(`${baseUrl}/api/papers/${id}`)).json();

    assert.equal(body.text_meta.version, TEXT_META_VERSION);
    assert.equal(body.text_meta.references.blocks.length, 2, '兩塊都切到了（v1 只切得到一塊）');
    assert.ok(body.text_meta.references.chars_total > legacyMeta.references.chars,
      '切到的字數要比 v1 多');
    assert.deepEqual(body.text_meta.pages, legacyPages, '頁級品質沿用舊值');
    assert.deepEqual(body.text_meta.bad_pages, [2]);

    const stored = parseTextMeta(db.prepare('SELECT text_meta FROM papers WHERE id = ?').get(id).text_meta);
    assert.equal(stored.version, TEXT_META_VERSION, '重算要回寫，不是每次現算');
    assert.deepEqual(stored.references.blocks, body.text_meta.references.blocks);
    assert.equal(db.prepare('SELECT full_text FROM papers WHERE id = ?').get(id).full_text, fullText,
      '升級路徑一樣不准動 full_text');
  });

  test('version=2 的列不重算（照抄回去，連刻意寫歪的欄位都不動）', async () => {
    const pinned = {
      version: TEXT_META_VERSION,
      references: { cut: false, blocks: [], chars_total: 0, start: -1, end: -1, chars: 0, reason: 'low_density', heading: '', density: 1.5 },
      pages: [], bad_pages: [],
    };
    const id = insert('v2', pinned);
    const body = await (await fetch(`${baseUrl}/api/papers/${id}`)).json();

    assert.deepEqual(body.text_meta, pinned, '版本夠新就不該被碰');
    assert.equal(parseTextMeta(db.prepare('SELECT text_meta FROM papers WHERE id = ?').get(id).text_meta).references.reason,
      'low_density');
  });

  test('沒有 version 欄位的舊列也會被重算（工單 13 之前的殘留）', async () => {
    const id = insert('nov', { references: { cut: false, start: -1, end: -1, chars: 0, reason: 'no_heading', heading: '', density: 0 } });
    const body = await (await fetch(`${baseUrl}/api/papers/${id}`)).json();

    assert.equal(body.text_meta.version, TEXT_META_VERSION);
    assert.equal(body.text_meta.references.cut, true);
    assert.deepEqual(body.text_meta.pages, [], '沒有舊的頁級品質就留空');
  });
});

// ── §5.5 ctx_overflow ───────────────────────────────────────────────────

function jsonErrorResponse(status, text) {
  return {
    ok: false,
    status,
    text: async () => text,
  };
}

describe('§5.5 上游說「太長了」', () => {
  test('4xx ＋ context length → kind=ctx_overflow，且不重試', () => {
    const err = new Error('API error 400: {"error":{"message":"This model\'s maximum context length is 128000 tokens"}}');
    assert.equal(analyzeErrorKind(err), 'ctx_overflow');
    assert.equal(isRetryableAnalyzeError(err), false);
  });

  test('訊息說得出該調哪顆旋鈕（通讀／討論各自的動詞）', () => {
    const err = new Error('API error 413: request too long');
    err.sentChars = 385_000;
    const analyze = describeAnalyzeError(err);
    assert.ok(analyze.includes('PAPER_FULLTEXT_LIMIT_CHARS'), analyze);
    assert.ok(analyze.includes('385,000 字'), analyze);
    assert.ok(analyze.includes('100,000 token'), '3.85 字/token 的換算');
    assert.ok(analyze.endsWith('再重新通讀'));
    assert.ok(describeChatError(err).endsWith('再重新提問'));
  });

  test('拿不到 sentChars 時不瞎編數字', () => {
    const message = describeAnalyzeError(new Error('API error 400: maximum context length exceeded'));
    assert.ok(message.includes('PAPER_FULLTEXT_LIMIT_CHARS'));
    assert.ok(!message.includes('送出約'));
  });

  test('沒踩到那些字的 4xx 照舊是 http4xx（設定錯還是要說設定錯）', () => {
    const err = new Error('API error 401: invalid api key');
    assert.equal(analyzeErrorKind(err), 'http401');
    assert.ok(describeAnalyzeError(err).includes('請檢查通讀模型設定'));
  });

  test('實彈（mock 上游）：analyzePaper 撞 400 只打一發，訊息帶旋鈕與字數', async () => {
    setEnv('ANALYZE_BASE_URL', 'https://example.invalid/v1');
    setEnv('ANALYZE_API_KEY', 'k');
    setEnv('ANALYZE_MODEL', 'fake-model');
    setEnv('ANALYZE_FORMAT', 'openai');
    setEnv('ANALYZE_VISION_CAPABLE', 'false');

    let calls = 0;
    global.fetch = async () => {
      calls += 1;
      return jsonErrorResponse(400, '{"error":{"message":"maximum context length is 65536 tokens"}}');
    };

    await assert.rejects(
      () => analyzePaper('全文'.repeat(1000), { paperId: 'ctx1', retries: 2 }),
      (err) => {
        assert.ok(err.message.includes('論文太長'), err.message);
        assert.ok(err.message.includes('PAPER_FULLTEXT_LIMIT_CHARS'), err.message);
        assert.ok(err.message.includes('送出約'), err.message);
        assert.ok(!err.message.includes('已自動重試'), '這一類不該重試');
        return true;
      },
    );
    assert.equal(calls, 1, '重打一定再錯一次，不要多燒一次');
  });
});
