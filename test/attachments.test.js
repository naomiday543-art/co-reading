// 工單 24 §五：補充文件（SI）子路由的實打測試。
//
// 走真伺服器（port 0）＋真 multer ＋真 `extractPDFDetailed`，資料落在
// `test/setup-data-dir.js` 給的 temp dataDir——**絕不碰 data/**（她的真庫與真 PDF）。
// 測試 PDF 是手寫的（`test/fixtures/make-pdf.js`），沒有裝任何新套件。
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { nanoid } from 'nanoid';

import db from '../src/db.js';
import { dataPaths } from '../src/paths.js';
import { makeTextPdf, makeScannedPdf } from './fixtures/make-pdf.js';

const SI_LINES = [
  'Supplementary Table S1 nanoplastic recovery in serum matrix',
  'Polyethylene recovery was 87.4 percent at 10 micrograms per litre',
  'The limit of detection for PVC was 0.31 micrograms per litre',
];

let server;
let baseUrl;
const paperIds = [];

function addPaper(id = `att_${nanoid(8)}`) {
  db.prepare(`INSERT INTO papers (id, title, full_text, summary_bg, summary_methods,
    summary_results, summary_conclusions, summary_limitations)
    VALUES (?, ?, ?, '', '', '', '', '')`).run(id, '宿主論文', '正文原文');
  paperIds.push(id);
  return id;
}

function form(files) {
  const fd = new FormData();
  for (const [name, buf, type] of files) {
    fd.append('files', new File([buf], name, { type: type ?? 'application/pdf' }));
  }
  return fd;
}

function upload(paperId, files) {
  return fetch(`${baseUrl}/api/papers/${paperId}/attachments`, { method: 'POST', body: form(files) });
}

/**
 * 回應主體只讀得了一次——`assert.equal(res.status, 200, await res.text())` 那種寫法
 * 就算斷言過了也會把 body 吃掉（訊息參數是先求值的），後面 `res.json()` 必炸
 * 「Body has already been read」。統一從這裡讀，順便讓失敗訊息帶上後端的錯誤。
 */
async function readJson(res, expected = 200) {
  const text = await res.text();
  assert.equal(res.status, expected, `HTTP ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

async function uploadOne(paperId, name = 'SI-1.pdf', lines = SI_LINES) {
  const body = await readJson(await upload(paperId, [[name, makeTextPdf(lines)]]));
  return body.attachments[body.attachments.length - 1];
}

/** `data/pdfs/` 裡屬於這一篇的 SI 磁碟檔（檔名存在 DB 裡，所以直接查庫比對）。 */
function siFilesOnDisk() {
  return readdirSync(dataPaths.pdfDir).filter(f => f.startsWith('si-'));
}

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
  for (const id of paperIds.splice(0)) db.prepare('DELETE FROM papers WHERE id = ?').run(id);
  if (server) server.close();
});

describe('上傳與列表', () => {
  it('上傳一份 → 入庫、列表帶 chars／has_text，且**不含 extracted_text**', async () => {
    const paperId = addPaper();
    const body = await readJson(await upload(paperId, [['SI-1.pdf', makeTextPdf(SI_LINES)]]));

    assert.equal(body.attachments.length, 1);
    assert.deepEqual(body.failed, []);
    const a = body.attachments[0];

    assert.equal(a.paper_id, paperId);
    assert.equal(a.kind, 'si');
    assert.equal(a.label, 'SI-1', '預設名字＝原始檔名去掉 .pdf');
    assert.equal(a.original_name, 'SI-1.pdf');
    assert.equal(a.ai_visible, 1);
    assert.ok(a.has_text);
    assert.ok(a.chars > 100, `chars=${a.chars}`);
    assert.equal(a.ai_chars_sent, a.chars, '預設上限 10 萬字，這份整份都送得出去');
    assert.equal(a.truncated, false);
    assert.equal(a.dropped, false);
    assert.equal(a.extracted_text, undefined, '列表不得背全文');
    assert.equal(a.filename, undefined, '磁碟檔名不外流');

    // DB 裡真的抽到了字
    const row = db.prepare('SELECT extracted_text, filename FROM paper_attachments WHERE id = ?').get(a.id);
    assert.ok(row.extracted_text.includes('87.4'));
    assert.ok(row.extracted_text.includes('0.31'));
    assert.match(row.filename, /^si-[\w-]+\.pdf$/, '磁碟檔名是 si-<nanoid>.pdf，原始檔名不進路徑');
    assert.ok(existsSync(join(dataPaths.pdfDir, row.filename)));

    // GET 列表拿到同一份
    const list = await readJson(await fetch(`${baseUrl}/api/papers/${paperId}/attachments`));
    assert.equal(list.attachments.length, 1);
    assert.equal(list.attachments[0].id, a.id);
    assert.equal(list.si_limit, 100_000);
    assert.equal(list.si_chars_sent, a.chars);
  });

  it('一次多檔：依序排 sort_order', async () => {
    const paperId = addPaper();
    const { attachments } = await readJson(await upload(paperId, [
      ['第一份 SI.pdf', makeTextPdf(SI_LINES)],
      ['SI-2.pdf', makeTextPdf(['Supplementary Figure S2 caption with enough text to extract cleanly'])],
    ]));
    assert.equal(attachments.length, 2);
    assert.equal(attachments[0].label, '第一份 SI');
    assert.equal(attachments[1].label, 'SI-2');
    assert.deepEqual(attachments.map(a => a.sort_order), [0, 1]);
  });

  it('掃描版（抽不到字）照樣入庫，chars=0、has_text=false', async () => {
    const paperId = addPaper();
    const { attachments, failed } = await readJson(await upload(paperId, [['掃描的 SI.pdf', makeScannedPdf()]]));
    assert.deepEqual(failed, []);
    assert.equal(attachments.length, 1);
    assert.equal(attachments[0].chars, 0);
    assert.equal(attachments[0].has_text, false);
    assert.equal(attachments[0].ai_chars_sent, 0);
    // PDF 還在（她照樣看得到），只是 AI 讀不到字
    const row = db.prepare('SELECT filename FROM paper_attachments WHERE id = ?').get(attachments[0].id);
    assert.ok(existsSync(join(dataPaths.pdfDir, row.filename)));
  });

  it('論文不存在 → 404，而且一個檔都不會落盤', async () => {
    const before = siFilesOnDisk().length;
    const res = await upload('no-such-paper', [['SI.pdf', makeTextPdf(SI_LINES)]]);
    assert.equal(res.status, 404);
    assert.equal(siFilesOnDisk().length, before);
  });

  it('沒帶檔案 → 400', async () => {
    const paperId = addPaper();
    const res = await fetch(`${baseUrl}/api/papers/${paperId}/attachments`, {
      method: 'POST', body: new FormData(),
    });
    assert.match((await readJson(res, 400)).error, /沒有收到檔案/);
  });
});

describe('只收 PDF', () => {
  it('非 PDF → 400，**而且暫存檔不殘留**（multer 會把前面那份寫進磁碟）', async () => {
    const paperId = addPaper();
    const before = siFilesOnDisk().length;

    const res = await upload(paperId, [
      ['好的 SI.pdf', makeTextPdf(SI_LINES)],
      ['資料表.xlsx', Buffer.from('not a pdf at all'), 'application/vnd.ms-excel'],
    ]);
    assert.match((await readJson(res, 400)).error, /目前只支援 PDF 的補充文件/);

    assert.equal(siFilesOnDisk().length, before, '被拒絕那批的落盤檔要清乾淨，不能留孤兒檔');
    assert.equal(
      db.prepare('SELECT COUNT(*) AS n FROM paper_attachments WHERE paper_id = ?').get(paperId).n, 0
    );
  });

  it('副檔名是 .pdf 但 mimetype 不對 → 一樣 400', async () => {
    const paperId = addPaper();
    const res = await upload(paperId, [['偽裝.pdf', makeTextPdf(SI_LINES), 'text/plain']]);
    assert.match((await readJson(res, 400)).error, /目前只支援 PDF/);
  });
});

describe('每篇 10 份上限', () => {
  it('第 11 份 → 400，且多出來的檔案清掉、前 10 份完好', async () => {
    const paperId = addPaper();
    for (let i = 1; i <= 10; i++) {
      await readJson(await upload(paperId, [[`SI-${i}.pdf`, makeTextPdf([`Supplementary section ${i} with enough characters to extract`])]]));
    }
    const before = siFilesOnDisk().length;

    const res = await upload(paperId, [['SI-11.pdf', makeTextPdf(SI_LINES)]]);
    assert.match((await readJson(res, 400)).error, /最多 10 份/);

    assert.equal(siFilesOnDisk().length, before, '超出上限那份的落盤檔要清掉');
    assert.equal(
      db.prepare('SELECT COUNT(*) AS n FROM paper_attachments WHERE paper_id = ?').get(paperId).n, 10
    );
  });
});

describe('取檔與取文字', () => {
  it('GET /:aid/file：Content-Type 對，中文原名走 filename*=UTF-8 而不是裸進 header', async () => {
    const paperId = addPaper();
    const a = await uploadOne(paperId, '補充材料（第一版）.pdf');

    const res = await fetch(`${baseUrl}/api/papers/${paperId}/attachments/${a.id}/file`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/pdf');

    const cd = res.headers.get('content-disposition');
    assert.ok(cd.startsWith("inline; filename*=UTF-8''"), cd);
    // 整個 header 必須是 ASCII——中文一個字都不能裸著出現
    assert.ok(/^[\x20-\x7e]*$/.test(cd), `header 不是純 ASCII: ${cd}`);
    assert.ok(!cd.includes('補充'), cd);
    // 解得回原名
    const encoded = cd.slice("inline; filename*=UTF-8''".length);
    assert.equal(decodeURIComponent(encoded), '補充材料（第一版）.pdf');

    const body = Buffer.from(await res.arrayBuffer());
    assert.equal(body.subarray(0, 5).toString('latin1'), '%PDF-');
  });

  it('GET /:aid/text：拿得到抽出來的字', async () => {
    const paperId = addPaper();
    const a = await uploadOne(paperId);
    const { text } = await readJson(await fetch(`${baseUrl}/api/papers/${paperId}/attachments/${a.id}/text`));
    assert.ok(text.includes('87.4'));
    assert.equal(text.length, a.chars);
  });
});

describe('PATCH：只准改 label／ai_visible／sort_order', () => {
  it('改名（trim、≤120 字）', async () => {
    const paperId = addPaper();
    const a = await uploadOne(paperId);

    const res = await fetch(`${baseUrl}/api/papers/${paperId}/attachments/${a.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: '  方法細節  ' }),
    });
    const { attachments } = await readJson(res);
    assert.equal(attachments[0].label, '方法細節');

    // 超長 → 切到 120
    await fetch(`${baseUrl}/api/papers/${paperId}/attachments/${a.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'あ'.repeat(200) }),
    });
    const row = db.prepare('SELECT label FROM paper_attachments WHERE id = ?').get(a.id);
    assert.equal(row.label.length, 120);
  });

  it('空名字 → 400', async () => {
    const paperId = addPaper();
    const a = await uploadOne(paperId);
    const res = await fetch(`${baseUrl}/api/papers/${paperId}/attachments/${a.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: '   ' }),
    });
    assert.equal(res.status, 400);
  });

  it('ai_visible=0 → 入庫為 0，且 ai_chars_sent 歸零', async () => {
    const paperId = addPaper();
    const a = await uploadOne(paperId);
    const res = await fetch(`${baseUrl}/api/papers/${paperId}/attachments/${a.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ai_visible: false }),
    });
    const { attachments, si_chars_sent } = await readJson(res);
    assert.equal(attachments[0].ai_visible, 0);
    assert.equal(attachments[0].ai_chars_sent, 0);
    assert.equal(si_chars_sent, 0);
    // chars 本身不變（字還在，只是 AI 不讀）
    assert.equal(attachments[0].chars, a.chars);
  });

  it('不准改的欄位（extracted_text／filename／paper_id）一個字都不動', async () => {
    const paperId = addPaper();
    const a = await uploadOne(paperId);
    const before = db.prepare('SELECT * FROM paper_attachments WHERE id = ?').get(a.id);

    await fetch(`${baseUrl}/api/papers/${paperId}/attachments/${a.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        extracted_text: '駭進來的字', filename: '../../etc/passwd',
        paper_id: 'somewhere-else', kind: 'evil',
      }),
    });

    const after = db.prepare('SELECT * FROM paper_attachments WHERE id = ?').get(a.id);
    assert.equal(after.extracted_text, before.extracted_text);
    assert.equal(after.filename, before.filename);
    assert.equal(after.paper_id, before.paper_id);
    assert.equal(after.kind, 'si');
  });
});

describe('DELETE', () => {
  it('刪一份 → 磁碟檔消失、列消失', async () => {
    const paperId = addPaper();
    const a = await uploadOne(paperId);
    const { filename } = db.prepare('SELECT filename FROM paper_attachments WHERE id = ?').get(a.id);
    const p = join(dataPaths.pdfDir, filename);
    assert.ok(existsSync(p));

    const res = await fetch(`${baseUrl}/api/papers/${paperId}/attachments/${a.id}`, { method: 'DELETE' });
    assert.deepEqual((await readJson(res)).attachments, []);
    assert.ok(!existsSync(p), '磁碟檔要跟著消失');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM paper_attachments WHERE id = ?').get(a.id).n, 0);
  });

  it('刪論文 → 該篇所有 SI 的磁碟檔全消失（FK CASCADE 帶不走檔案）', async () => {
    const paperId = addPaper();
    await uploadOne(paperId, 'SI-A.pdf');
    await uploadOne(paperId, 'SI-B.pdf');
    const paths = db.prepare('SELECT filename FROM paper_attachments WHERE paper_id = ?').all(paperId)
      .map(r => join(dataPaths.pdfDir, r.filename));
    assert.equal(paths.length, 2);
    for (const p of paths) assert.ok(existsSync(p));

    const res = await fetch(`${baseUrl}/api/papers/${paperId}`, { method: 'DELETE' });
    assert.equal(res.status, 200);

    for (const p of paths) assert.ok(!existsSync(p), `孤兒檔還在: ${p}`);
    assert.equal(
      db.prepare('SELECT COUNT(*) AS n FROM paper_attachments WHERE paper_id = ?').get(paperId).n, 0,
      'FK CASCADE 應該把列帶走'
    );
    paperIds.splice(paperIds.indexOf(paperId), 1);
  });
});

describe('別篇論文的 aid 進來一律 404', () => {
  it('GET file／GET text／PATCH／DELETE 四個口都擋', async () => {
    const mine = addPaper();
    const other = addPaper();
    const a = await uploadOne(other, '別人的 SI.pdf');

    const paths = [
      ['GET', `/api/papers/${mine}/attachments/${a.id}/file`],
      ['GET', `/api/papers/${mine}/attachments/${a.id}/text`],
      ['PATCH', `/api/papers/${mine}/attachments/${a.id}`],
      ['DELETE', `/api/papers/${mine}/attachments/${a.id}`],
    ];
    for (const [method, path] of paths) {
      const res = await fetch(`${baseUrl}${path}`, {
        method,
        ...(method === 'PATCH'
          ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label: 'x' }) }
          : {}),
      });
      assert.equal(res.status, 404, `${method} ${path} 應該 404，實際 ${res.status}`);
    }

    // 那份 SI 毫髮無傷
    assert.equal(
      db.prepare('SELECT COUNT(*) AS n FROM paper_attachments WHERE id = ?').get(a.id).n, 1
    );
  });

  it('不存在的 aid → 404', async () => {
    const paperId = addPaper();
    const res = await fetch(`${baseUrl}/api/papers/${paperId}/attachments/nope/text`);
    assert.equal(res.status, 404);
  });
});

describe('紅線：SI 不碰論文本體', () => {
  it('上傳 SI 之後 full_text／text_meta／analyze_status 一個字都沒變', async () => {
    const paperId = addPaper();
    const before = db.prepare('SELECT full_text, text_meta, analyze_status, updated_at FROM papers WHERE id = ?').get(paperId);

    await uploadOne(paperId);
    await uploadOne(paperId, 'SI-2.pdf', ['Another supplementary block with plenty of characters here']);

    const after = db.prepare('SELECT full_text, text_meta, analyze_status, updated_at FROM papers WHERE id = ?').get(paperId);
    assert.deepEqual(after, before, 'SI 不得觸發通讀、不得改 papers 任何欄位');
  });
});
