// 工單 14 §5：選一段文字問它——偏移驗證、prompt 組法、歷史回放逐字穩定、前端偏移映射。
//
// 上游一律是本機假 server（工單 14 §4 紅線：絕不打真上游）。
// 分三層：
//   ① 純函式（`src/quote.js`）：驗證閘門、渲染規則、位置脈絡。
//   ② 路由層（真 express + 真 SSE + 假上游）：400 的三種形狀、DB 只存她打的字、
//      送模型的 messages 長什麼樣、穩定前綴逐字不變、歷史回放與送出當輪逐字相同。
//   ③ 前端純函式（`frontend/src/lib/fulltext-offsets.js`）：假 DOM 上的選取 → 偏移。
import { test, describe, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { nanoid } from 'nanoid';

import db, { setSetting } from '../src/db.js';
import { getRecentLogs } from '../src/logger.js';
import {
  QUOTE_MAX_CHARS,
  QUOTE_CONTEXT_RADIUS,
  DEFAULT_QUOTE_QUESTION,
  QUOTE_ANSWER_INSTRUCTION,
  parseQuote,
  validateQuote,
  paragraphIndexAt,
  renderQuotedMessage,
  buildQuoteContextBlock,
  quoteLogLabel,
} from '../src/quote.js';
import {
  OFFSET_ATTR,
  MIN_SELECTION_CHARS,
  buildParagraphs,
  resolveEndpointOffset,
  resolveSelectionQuote,
  formatRange,
  quotePreview,
  paragraphIndexOfOffset,
} from '../frontend/src/lib/fulltext-offsets.js';

// ── fixture 原文：三段，段間是空行（跟真的抽字結果同一個形狀）──────────────
const PARA_1 = '奈米塑膠進入血液之後，最先接觸到的並不是細胞，而是血漿蛋白。';
const PARA_2 = '本研究以膽固醇含量為變因，量測蛋白冠在不同脂質環境下的組成差異，結果顯示膽固醇會顯著改變吸附層的厚度。';
const PARA_3 = '這個發現意味著，過去以純脂質體推得的分佈模型，可能低估了體內的清除速率。';
const FULL_TEXT = `${PARA_1}\n\n${PARA_2}\n\n${PARA_3}`;

const P2_START = PARA_1.length + 2;
const P2_END = P2_START + PARA_2.length;

function makePaper(prefix = 'quote', fullText = FULL_TEXT) {
  const id = `${prefix}_${nanoid(6)}`;
  db.prepare(`INSERT INTO papers (id, title, authors, year, full_text, summary_bg, summary_methods, summary_results, summary_conclusions, summary_limitations)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id, '蛋白冠與膽固醇', 'Tang', 2023, fullText, 'bg', 'm', 'r', 'c', 'l'
  );
  return db.prepare('SELECT * FROM papers WHERE id = ?').get(id);
}

function dropPaper(id) {
  db.prepare('DELETE FROM messages WHERE paper_id = ?').run(id);
  db.prepare('DELETE FROM papers WHERE id = ?').run(id);
}

// ── ① 純函式 ─────────────────────────────────────────────────────────────
describe('quote 驗證閘門（工單 14 §3.1）', () => {
  const good = { text: PARA_2, start: P2_START, end: P2_END };

  test('偏移對得上原文 → 過，並正規化出 page:null', () => {
    const v = validateQuote(FULL_TEXT, good);
    assert.equal(v.ok, true);
    assert.deepEqual(v.quote, { ...good, page: null });
  });

  test('slice(start,end) !== text → 400 的那句「選取內容與原文不一致」', () => {
    const v = validateQuote(FULL_TEXT, { ...good, start: good.start + 1 });
    assert.equal(v.ok, false);
    assert.equal(v.error, '選取內容與原文不一致');
  });

  test('超過 4000 字 → 擋下，訊息帶實際字數', () => {
    const long = 'x'.repeat(QUOTE_MAX_CHARS + 10);
    const v = validateQuote(long, { text: long, start: 0, end: long.length });
    assert.equal(v.ok, false);
    assert.match(v.error, new RegExp(`${QUOTE_MAX_CHARS} 字`));
    assert.match(v.error, new RegExp(`${QUOTE_MAX_CHARS + 10} 字`));
  });

  test('start >= end、負數、超出長度、空白選取都擋', () => {
    assert.equal(validateQuote(FULL_TEXT, { text: '', start: 3, end: 3 }).ok, false);
    assert.equal(validateQuote(FULL_TEXT, { text: 'ab', start: -1, end: 1 }).ok, false);
    assert.equal(validateQuote(FULL_TEXT, { text: 'ab', start: 5, end: 2 }).ok, false);
    assert.equal(
      validateQuote(FULL_TEXT, { text: 'ab', start: FULL_TEXT.length - 1, end: FULL_TEXT.length + 5 }).ok,
      false
    );
    assert.equal(validateQuote(FULL_TEXT, { text: '  ', start: 0, end: 2 }).ok, false);
  });

  test('壞掉的 JSON／缺欄位一律當作沒有引用，不拋', () => {
    assert.equal(parseQuote('{壞掉'), null);
    assert.equal(parseQuote(''), null);
    assert.equal(parseQuote(null), null);
    assert.equal(parseQuote({ text: 'a', start: 0 }), null);
    assert.equal(parseQuote({ text: 'a', start: 0.5, end: 3 }), null);
    assert.equal(validateQuote(FULL_TEXT, 'null').ok, false);
  });
});

describe('送給模型的那一則 user 訊息（§3.2）', () => {
  const quote = { text: PARA_2, start: P2_START, end: P2_END };

  test('引用＋問題＋答題指令，段號是第 2 段', () => {
    const rendered = renderQuotedMessage(quote, '這裡的厚度是怎麼量的？', FULL_TEXT);
    assert.match(rendered, /^【引用原文（全文第 \d+–\d+ 字，約第 2 段）】\n/);
    assert.ok(rendered.includes(`> ${PARA_2}`), '引用要排成 markdown 引言');
    assert.ok(rendered.includes('這裡的厚度是怎麼量的？'));
    assert.ok(rendered.includes(QUOTE_ANSWER_INSTRUCTION), '答題指令走 user 訊息，不改憲章');
  });

  test('§5.4 只選段沒打字 → 用預設問題', () => {
    const rendered = renderQuotedMessage(quote, '', FULL_TEXT);
    assert.ok(rendered.includes(DEFAULT_QUOTE_QUESTION));
  });

  test('多行選段每一行都帶 `> `', () => {
    const multi = 'A\nB';
    const text = `${multi}`;
    const rendered = renderQuotedMessage({ text, start: 0, end: 3 }, '問', text);
    assert.ok(rendered.includes('> A\n> B'));
  });

  test('沒有引用時逐字回傳原訊息（零回歸）', () => {
    assert.equal(renderQuotedMessage(null, '就是一句話  ', FULL_TEXT), '就是一句話  ');
  });

  test('同一顆函式重跑多次逐字相同（cache 前綴穩定的前提）', () => {
    const a = renderQuotedMessage(quote, '問題', FULL_TEXT);
    const b = renderQuotedMessage({ ...quote }, '問題', FULL_TEXT);
    assert.equal(a, b);
  });
});

describe('位置脈絡（§3.2 變動區）', () => {
  test('前後各取 ≤600 字，標「選段前文」「選段後文」', () => {
    const long = 'A'.repeat(1000) + PARA_2 + 'B'.repeat(1000);
    const quote = { text: PARA_2, start: 1000, end: 1000 + PARA_2.length };
    const block = buildQuoteContextBlock(long, quote);

    assert.ok(block.includes('【選段前文】'));
    assert.ok(block.includes('【選段後文】'));
    const before = block.split('【選段前文】')[1].split('【選段後文】')[0];
    const after = block.split('【選段後文】')[1];
    assert.ok(before.replace(/[\n…]/g, '').length <= QUOTE_CONTEXT_RADIUS, '前文不超過 600 字');
    assert.ok(after.replace(/[\n…]/g, '').length <= QUOTE_CONTEXT_RADIUS, '後文不超過 600 字');
    assert.ok(before.includes('…'), '被截掉的那頭要有刪節號');
  });

  test('選段在開頭／結尾時明說「沒有內容」，不留空殼', () => {
    const head = buildQuoteContextBlock(FULL_TEXT, { text: PARA_1, start: 0, end: PARA_1.length });
    assert.ok(head.includes('前面沒有內容'));
    const tailStart = FULL_TEXT.length - PARA_3.length;
    const tail = buildQuoteContextBlock(FULL_TEXT, {
      text: PARA_3, start: tailStart, end: FULL_TEXT.length,
    });
    assert.ok(tail.includes('後面沒有內容'));
  });

  test('沒有 quote → 空字串（呼叫端直接串接）', () => {
    assert.equal(buildQuoteContextBlock(FULL_TEXT, null), '');
    assert.equal(quoteLogLabel(null), 'none');
    assert.equal(quoteLogLabel({ start: 10, end: 30 }), '20字');
  });
});

describe('段號：後端 paragraphIndexAt 與前端 buildParagraphs 同一口徑', () => {
  test('三段各自的段號是 1/2/3', () => {
    assert.equal(paragraphIndexAt(FULL_TEXT, 0), 1);
    assert.equal(paragraphIndexAt(FULL_TEXT, P2_START), 2);
    assert.equal(paragraphIndexAt(FULL_TEXT, FULL_TEXT.length - 1), 3);
  });

  test('前端切出來的每一段起點，後端都算得出同一個段號', () => {
    const paras = buildParagraphs(FULL_TEXT);
    assert.equal(paras.length, 3);
    paras.forEach((p, i) => {
      assert.equal(paragraphIndexAt(FULL_TEXT, p.start), i + 1);
      assert.equal(FULL_TEXT.slice(p.start, p.end), p.text, '段落文字必須是原文切片');
    });
  });
});

// ── ② 路由層：真 express + 真 SSE + 本機假上游 ─────────────────────────────
describe('討論路由：帶選段送出（§5.1–§5.3、§5.6）', () => {
  let server, baseUrl, upstream;
  const requests = [];          // 每發上游請求的 body

  before(async () => {
    upstream = createServer((req, res) => {
      let body = '';
      req.on('data', c => (body += c));
      req.on('end', () => {
        requests.push(JSON.parse(body));
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: {"choices":[{"delta":{"content":"好"}}]}\n\n');
        res.write('data: [DONE]\n\n');
        res.end();
      });
    });
    await new Promise(r => upstream.listen(0, '127.0.0.1', r));

    setSetting('ai_base_url', `http://127.0.0.1:${upstream.address().port}/v1`);
    setSetting('ai_format', 'openai');
    setSetting('ai_model', 'fake');
    setSetting('ai_api_key', 'fake');

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
    if (server) server.close();
    if (upstream) upstream.close();
  });

  afterEach(() => { requests.length = 0; });

  async function send(paperId, body) {
    const res = await fetch(`${baseUrl}/api/papers/${paperId}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.ok) await res.text();          // 把 SSE 收完，確保 assistant 已寫進 DB
    return res;
  }

  test('§5.1 帶合法 quote → 200、DB quote 欄有值、content 只有她打的字', async () => {
    const paper = makePaper('ok');
    try {
      const res = await send(paper.id, {
        message: '這個厚度差異有統計意義嗎？',
        quote: { text: PARA_2, start: P2_START, end: P2_END },
      });
      assert.equal(res.status, 200);

      const rows = db.prepare(
        'SELECT role, content, quote FROM messages WHERE paper_id = ? ORDER BY seq'
      ).all(paper.id);
      assert.equal(rows.length, 2);
      assert.equal(rows[0].content, '這個厚度差異有統計意義嗎？', '紅線：content 只存她打的字');
      const saved = JSON.parse(rows[0].quote);
      assert.deepEqual(saved, { text: PARA_2, start: P2_START, end: P2_END, page: null });

      const sent = requests.at(-1);
      const lastUser = sent.messages.at(-1);
      assert.equal(lastUser.role, 'user');
      assert.ok(lastUser.content.startsWith('【引用原文'), '送模型的最後一則 user 要帶引用');
      assert.ok(lastUser.content.includes(PARA_2));
      assert.ok(lastUser.content.includes('這個厚度差異有統計意義嗎？'));

      const system = sent.messages[0].content;
      assert.ok(system.includes('【選段前文】'), '位置脈絡在變動區（system 尾端）');
      assert.ok(system.includes('【選段後文】'));
    } finally {
      dropPaper(paper.id);
    }
  });

  test('§5.3 穩定前綴逐字不變：帶 quote 的 system 是「不帶 quote 的 system ＋ 脈絡」', async () => {
    const paper = makePaper('prefix');
    try {
      await send(paper.id, { message: '先問一句' });
      const plainSystem = requests.at(-1).messages[0].content;

      const paper2 = makePaper('prefix2');
      await send(paper2.id, {
        message: '再問一句',
        quote: { text: PARA_2, start: P2_START, end: P2_END },
      });
      const quotedSystem = requests.at(-1).messages[0].content;

      // 兩篇論文不同，所以比的是「同一篇的 system 前綴」——改用同一篇再送一次不帶 quote
      await send(paper2.id, { message: '第三句' });
      const plainSystem2 = requests.at(-1).messages[0].content;

      assert.ok(
        quotedSystem.startsWith(plainSystem2),
        '帶 quote 只能在變動區尾巴加東西，憲章＋論文區塊必須逐字不變'
      );
      const extra = quotedSystem.slice(plainSystem2.length);
      assert.ok(extra.includes('【選段前文】'));
      assert.ok(!plainSystem.includes('【選段前文】'), '不帶 quote 時完全沒有這一段');

      dropPaper(paper2.id);
    } finally {
      dropPaper(paper.id);
    }
  });

  test('§5.1 slice !== text → 400「選取內容與原文不一致」，一列都不寫、上游一發都不打', async () => {
    const paper = makePaper('mismatch');
    try {
      const res = await send(paper.id, {
        message: '問題',
        quote: { text: PARA_2, start: P2_START + 3, end: P2_END },
      });
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.equal(body.error, '選取內容與原文不一致');
      assert.equal(requests.length, 0, '驗不過就不該打上游');
      const count = db.prepare('SELECT COUNT(*) n FROM messages WHERE paper_id = ?').get(paper.id).n;
      assert.equal(count, 0);
    } finally {
      dropPaper(paper.id);
    }
  });

  test('§5.1 超過 4000 字 → 400', async () => {
    const long = '長'.repeat(5000);
    const paper = makePaper('toolong', long);
    try {
      const res = await send(paper.id, {
        message: '問題',
        quote: { text: long.slice(0, 4001), start: 0, end: 4001 },
      });
      assert.equal(res.status, 400);
      assert.match((await res.json()).error, /4000 字/);
      assert.equal(requests.length, 0);
    } finally {
      dropPaper(paper.id);
    }
  });

  test('§5.4 只選段、沒打字 → 200，送模型的是預設問題，DB content 是空字串', async () => {
    const paper = makePaper('noq');
    try {
      const res = await send(paper.id, {
        message: '',
        quote: { text: PARA_3, start: FULL_TEXT.length - PARA_3.length, end: FULL_TEXT.length },
      });
      assert.equal(res.status, 200);
      assert.ok(requests.at(-1).messages.at(-1).content.includes(DEFAULT_QUOTE_QUESTION));
      const row = db.prepare(
        'SELECT content, quote FROM messages WHERE paper_id = ? AND role = ? ORDER BY seq'
      ).get(paper.id, 'user');
      assert.equal(row.content, '');
      assert.ok(row.quote.includes('start'));
    } finally {
      dropPaper(paper.id);
    }
  });

  test('沒選段也沒打字 → 還是 400「消息不能為空」（原行為不變）', async () => {
    const paper = makePaper('empty');
    try {
      const res = await send(paper.id, { message: '   ' });
      assert.equal(res.status, 400);
      assert.equal((await res.json()).error, '消息不能為空');
    } finally {
      dropPaper(paper.id);
    }
  });

  test('§5.2 歷史回放：第二輪送出時，第一輪的 user 與當時逐字相同', async () => {
    const paper = makePaper('replay');
    try {
      await send(paper.id, {
        message: '第一輪的問題',
        quote: { text: PARA_2, start: P2_START, end: P2_END },
      });
      const firstTurnUser = requests.at(-1).messages.at(-1).content;

      await send(paper.id, { message: '第二輪的問題' });
      const secondTurn = requests.at(-1).messages;

      // [system, user(第一輪), assistant, user(第二輪)]
      assert.equal(secondTurn.length, 4);
      assert.equal(secondTurn[1].role, 'user');
      assert.equal(
        secondTurn[1].content, firstTurnUser,
        '歷史回放與送出當輪必須逐字相同，否則 cache 前綴每輪都冷'
      );
      assert.equal(secondTurn[3].content, '第二輪的問題');
    } finally {
      dropPaper(paper.id);
    }
  });

  test('§5.2 重新生成／繼續 也走同一條渲染規則，並沿用最後一則 user 的選段脈絡', async () => {
    const paper = makePaper('regen');
    try {
      await send(paper.id, {
        message: '原問題',
        quote: { text: PARA_2, start: P2_START, end: P2_END },
      });
      const firstTurnUser = requests.at(-1).messages.at(-1).content;

      const res = await fetch(`${baseUrl}/api/papers/${paper.id}/chat?regenerate=true`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      await res.text();

      const regen = requests.at(-1).messages;
      assert.equal(regen.at(-1).content, firstTurnUser, '重新生成時歷史裡的引用要在');
      assert.ok(regen[0].content.includes('【選段前文】'), '位置脈絡也要跟著回來');
    } finally {
      dropPaper(paper.id);
    }
  });

  test('§5.6 `[CHAT] start` 帶 quote=；不帶選段時是 quote=none', async () => {
    const paper = makePaper('log');
    try {
      await send(paper.id, {
        message: '問題',
        quote: { text: PARA_2, start: P2_START, end: P2_END },
      });
      const withQuote = getRecentLogs(50).find(l => l.includes('[CHAT] start') && l.includes(paper.id));
      assert.ok(withQuote, '找得到這一輪的 [CHAT] start');
      assert.match(withQuote, new RegExp(`quote=${PARA_2.length}字`));

      await send(paper.id, { message: '再問' });
      const withoutQuote = getRecentLogs(50).find(l => l.includes('[CHAT] start') && l.includes(paper.id));
      assert.match(withoutQuote, /quote=none/);
    } finally {
      dropPaper(paper.id);
    }
  });

  test('GET /chat 回得出 quote（氣泡上的引用塊靠它畫）', async () => {
    const paper = makePaper('get');
    try {
      await send(paper.id, {
        message: '問題',
        quote: { text: PARA_2, start: P2_START, end: P2_END },
      });
      const msgs = await fetch(`${baseUrl}/api/papers/${paper.id}/chat`).then(r => r.json());
      assert.equal(msgs[0].role, 'user');
      assert.deepEqual(msgs[0].quote, { text: PARA_2, start: P2_START, end: P2_END, page: null });
      assert.equal(msgs[1].quote, null, 'assistant 沒有引用');
    } finally {
      dropPaper(paper.id);
    }
  });

  test('編輯 user 訊息 → 引用留著（分支往返不弄丟）', async () => {
    const paper = makePaper('edit');
    try {
      await send(paper.id, {
        message: '原問題',
        quote: { text: PARA_2, start: P2_START, end: P2_END },
      });
      const msgs = await fetch(`${baseUrl}/api/papers/${paper.id}/chat`).then(r => r.json());
      const userMsg = msgs.find(m => m.role === 'user');

      await fetch(`${baseUrl}/api/papers/${paper.id}/chat/edit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ msg_id: userMsg.id, content: '改過的問題' }),
      }).then(r => r.json());

      const after = await fetch(`${baseUrl}/api/papers/${paper.id}/chat`).then(r => r.json());
      assert.equal(after[0].content, '改過的問題');
      assert.deepEqual(after[0].quote, { text: PARA_2, start: P2_START, end: P2_END, page: null });
    } finally {
      dropPaper(paper.id);
    }
  });
});

// ── ③ 前端：選取 → 偏移（§5.5）────────────────────────────────────────────
//
// 假 DOM：只實作映射函式真的會碰的那幾個欄位（nodeType/nodeValue/childNodes/
// parentNode/getAttribute）。真瀏覽器的 Selection 給的就是 (node, offset) 四元組。
function textNode(value) {
  return { nodeType: 3, nodeValue: value, childNodes: [], parentNode: null };
}

function element(attrs, children) {
  const el = {
    nodeType: 1,
    attrs,
    childNodes: children,
    parentNode: null,
    getAttribute: (name) => (name in attrs ? attrs[name] : null),
  };
  for (const c of children) c.parentNode = el;
  return el;
}

/** 把 buildParagraphs 的結果搭成 `<div><p data-cr-offset=…>文字</p>…</div>`。 */
function renderFakeDom(fullText, { wrapEvery = 0 } = {}) {
  const paragraphs = buildParagraphs(fullText);
  const nodes = [];
  const ps = paragraphs.map((p, i) => {
    let children;
    if (wrapEvery && i === wrapEvery - 1) {
      // 段落裡再包一層（模擬未來加 <mark>／<span> 的情況）：映射必須照樣對
      const head = textNode(p.text.slice(0, 3));
      const inner = element({}, [textNode(p.text.slice(3))]);
      children = [head, inner];
    } else {
      children = [textNode(p.text)];
    }
    const el = element({ [OFFSET_ATTR]: String(p.start) }, children);
    nodes.push({ el, para: p });
    return el;
  });
  const root = element({}, ps);
  return { root, nodes, paragraphs };
}

describe('前端偏移映射（§5.5）', () => {
  test('段落切分：文字是原文切片、空白段跳過但偏移不錯位', () => {
    const withBlank = `${PARA_1}\n\n   \n\n${PARA_2}`;
    const paras = buildParagraphs(withBlank);
    assert.equal(paras.length, 2);
    assert.equal(paras[1].text, PARA_2);
    assert.equal(withBlank.slice(paras[1].start, paras[1].end), PARA_2);
  });

  test('段內選取 → 偏移正確', () => {
    const { nodes } = renderFakeDom(FULL_TEXT);
    const second = nodes[1];
    const t = second.el.childNodes[0];

    const quote = resolveSelectionQuote(
      { anchorNode: t, anchorOffset: 0, focusNode: t, focusOffset: PARA_2.length },
      FULL_TEXT
    );
    assert.deepEqual(quote, { text: PARA_2, start: P2_START, end: P2_END });
    assert.equal(FULL_TEXT.slice(quote.start, quote.end), quote.text, '後端那道閘門要過得去');
  });

  test('跨段落選取 → 引用文字帶回段間的換行（不是 selection.toString()）', () => {
    const { nodes } = renderFakeDom(FULL_TEXT);
    const first = nodes[0].el.childNodes[0];
    const third = nodes[2].el.childNodes[0];

    const quote = resolveSelectionQuote(
      { anchorNode: first, anchorOffset: 5, focusNode: third, focusOffset: 4 },
      FULL_TEXT
    );
    assert.equal(quote.start, 5);
    assert.equal(quote.end, FULL_TEXT.length - PARA_3.length + 4);
    assert.equal(quote.text, FULL_TEXT.slice(quote.start, quote.end));
    assert.ok(quote.text.includes('\n\n'), '跨段落時段間換行必須在，否則後端 slice 比不過');
  });

  test('反向選取（由後往前拖）→ start/end 自動排好', () => {
    const { nodes } = renderFakeDom(FULL_TEXT);
    const t = nodes[1].el.childNodes[0];
    const quote = resolveSelectionQuote(
      { anchorNode: t, anchorOffset: 20, focusNode: t, focusOffset: 2 },
      FULL_TEXT
    );
    assert.equal(quote.start, P2_START + 2);
    assert.equal(quote.end, P2_START + 20);
  });

  test('段落裡有內層元素時，段內位移照樣算得對', () => {
    const { nodes } = renderFakeDom(FULL_TEXT, { wrapEvery: 2 });
    const inner = nodes[1].el.childNodes[1].childNodes[0];   // <p>頭三字<span>其餘</span></p>
    const quote = resolveSelectionQuote(
      { anchorNode: inner, anchorOffset: 0, focusNode: inner, focusOffset: 10 },
      FULL_TEXT
    );
    assert.equal(quote.start, P2_START + 3, '內層節點前面那三個字要算進去');
    assert.equal(quote.text, FULL_TEXT.slice(P2_START + 3, P2_START + 13));
  });

  test('元素端點（Range 的 node=元素、offset=子節點索引）也解得出來', () => {
    const { nodes } = renderFakeDom(FULL_TEXT, { wrapEvery: 2 });
    const p = nodes[1].el;
    assert.equal(resolveEndpointOffset(p, 0), P2_START);
    assert.equal(resolveEndpointOffset(p, 1), P2_START + 3);
    assert.equal(resolveEndpointOffset(p, 2), P2_END);
  });

  test('選太短、選到錨點外面 → null（不彈「問這段」）', () => {
    const { nodes } = renderFakeDom(FULL_TEXT);
    const t = nodes[0].el.childNodes[0];
    assert.equal(
      resolveSelectionQuote({ anchorNode: t, anchorOffset: 0, focusNode: t, focusOffset: 3 }, FULL_TEXT),
      null,
      `少於 ${MIN_SELECTION_CHARS} 字不算`
    );
    const orphan = textNode('頁面上別的地方的字');
    assert.equal(
      resolveSelectionQuote({ anchorNode: orphan, anchorOffset: 0, focusNode: orphan, focusOffset: 5 }, FULL_TEXT),
      null
    );
    assert.equal(resolveEndpointOffset(null, 0), null);
  });

  test('4000 字上限前端先擋一次（後端仍是唯一閘門）', () => {
    const long = '長'.repeat(5000);
    const { nodes } = renderFakeDom(long);
    const t = nodes[0].el.childNodes[0];
    assert.equal(
      resolveSelectionQuote({ anchorNode: t, anchorOffset: 0, focusNode: t, focusOffset: 4001 }, long),
      null
    );
    assert.ok(
      resolveSelectionQuote({ anchorNode: t, anchorOffset: 0, focusNode: t, focusOffset: 4000 }, long)
    );
  });

  test('引用卡文案：範圍口徑與後端一致、預覽壓成一行', () => {
    assert.equal(formatRange({ start: 0, end: 12 }), '第 1–12 字');
    assert.equal(quotePreview('  A\n\nB  '), 'A B');
    assert.equal(quotePreview('x'.repeat(200)).length, 121);
    const paras = buildParagraphs(FULL_TEXT);
    assert.equal(paragraphIndexOfOffset(paras, P2_START), 1);
    assert.equal(paragraphIndexOfOffset(paras, FULL_TEXT.length - 1), 2);
    assert.equal(paragraphIndexOfOffset([], 3), -1);
  });
});
