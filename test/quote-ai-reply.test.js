// 工單 19 §4：引用 AI 的原話來提問——markdown 純文字投影、message 來源的驗證閘門、
// prompt 的兩型前綴、歷史回放逐字穩定、前端氣泡選取的唯一命中規則。
//
// 上游一律是本機假 server（§3 紅線：絕不打真上游）。分三層，跟工單 14 那份同一個骨架：
//   ① 純函式（`src/markdownPlain.js`／`src/quote.js`）：投影、驗證、渲染、脈絡、輪次。
//   ② 路由層（真 express + 真 SSE + 假上游）：400 的四種形狀、DB 存什麼、
//      送模型的 messages 長什麼樣、穩定前綴逐字不變、歷史回放與送出當輪逐字相同。
//   ③ 前端純函式（`frontend/src/lib/message-quote.js`）：假 DOM 上的氣泡選取 → 偏移。
//
// fixture 裡的三段真回覆是從她自己的 DB 唯讀副本取的（各 300 字以內，§3 紅線）。
import { test, describe, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { nanoid } from 'nanoid';

import db, { setSetting } from '../src/db.js';
import { getRecentLogs } from '../src/logger.js';
import { plainText } from '../src/markdownPlain.js';
import {
  QUOTE_REPLY_ANSWER_INSTRUCTION,
  DEFAULT_REPLY_QUOTE_QUESTION,
  QUOTE_MESSAGE_CONTEXT_MAX,
  QUOTE_MESSAGE_QUESTION_MAX,
  parseQuote,
  validateQuote,
  quoteSource,
  renderQuotedMessage,
  buildQuoteContextBlock,
  quoteLogLabel,
  assistantTurnOf,
  assistantTurnMap,
} from '../src/quote.js';
import {
  MSG_ID_ATTR,
  MIN_MESSAGE_SELECTION_CHARS,
  AMBIGUOUS_HINT,
  closestMessageId,
  locateInPlain,
  resolveMessageSelectionQuote,
  selectionHint,
  quoteCardLabel,
  quoteJumpLabel,
  plainText as frontendPlainText,
} from '../frontend/src/lib/message-quote.js';

// ── 她 DB 裡真回覆的片段（唯讀副本取樣，各 <300 字）──────────────────────
// A：標題帶粗體、`*   ` 清單、分隔線。B：`### ` 標題＋行內粗體。C：gfm 表格。
const REAL_A = [
  '好的，这是一个非常棒的练习。如果由我来向一个科研团队汇报这篇论文，我会采用一个“**故事线**”清晰、逻辑递进的汇报结构。',
  '',
  '---',
  '',
  '### **汇报题目：胆固醇通过重塑蛋白冠，决定纳米颗粒的体内命运**',
  '',
  '#### **第一部分：引言与科学问题（2-3分钟）**',
  '',
  '*   **背景介绍：**',
  '    *   **纳米颗粒的“身份ID”——蛋白冠**：当纳米颗粒进入血液，蛋白质会迅速吸附其表面。',
].join('\n');

const REAL_B = [
  '您这个问题问得非常精准，直指这项研究中最微妙的一个矛盾点。',
  '',
  '### 核心逻辑：补体蛋白减少 ≠ 炎症反应减弱',
  '',
  '作者的核心观点是：**蛋白冠的组成变化，改变了激活免疫反应的“路径”，而不是简单地“增强”或“减弱”免疫反应。**',
  '',
  '具体来说，可以分为两步：',
  '',
  '**第一步：补体蛋白减少，意味着“经典补体激活通路”这条路被削弱了。**',
].join('\n');

const REAL_C = [
  '**【逻辑推进】** 作者从“已知”推向“未知”：',
  '',
  '| 已知事实 | 未知问题 | 作者的切入点 |',
  '|:---|:---|:---|',
  '| 蛋白冠决定纳米颗粒的体内命运 | 代谢物是否能调控蛋白冠？ | 选择胆固醇作为模型代谢物 |',
  '| 不同患者的血清会导致不同蛋白冠 | 关键驱动因素是什么？ | 胆固醇是疾病相关代谢物的典型代表 |',
].join('\n');

// ── ① 純函式：markdown → 純文字投影（§4.1）────────────────────────────────
describe('plainText：markdown 純文字投影（工單 19 §2.2）', () => {
  test('標題／強調／清單／行內碼／連結的標記都脫掉，內容留著', () => {
    assert.equal(plainText('## 標題'), '標題');
    assert.equal(plainText('###### 六級也算'), '六級也算');
    assert.equal(plainText('**粗**與*斜*與***都粗斜***'), '粗與斜與都粗斜');
    assert.equal(plainText('- 清單一'), '清單一');
    assert.equal(plainText('1. 第一項'), '第一項');
    assert.equal(plainText('1) 也是第一項'), '也是第一項');
    assert.equal(plainText('用 `code_here()` 呼叫'), '用 code_here() 呼叫');
    assert.equal(plainText('看 [這篇論文](https://example.com/a) 的結論'), '看 這篇論文 的結論');
    assert.equal(plainText('![圖一](img.png) 說明'), '圖一 說明');
    assert.equal(plainText('~~刪掉這句~~留著'), '刪掉這句留著');
    assert.equal(plainText('> 引言一句'), '引言一句');
  });

  test('snake_case 的底線不會被當成強調咬掉', () => {
    assert.equal(plainText('變數 full_text 與 message_id 照原樣'), '變數 full_text 與 message_id 照原樣');
    assert.equal(plainText('_真的強調_ 要脫'), '真的強調 要脫');
  });

  test('換行與縮排保留（偏移才穩），空行不被吃掉', () => {
    const md = '第一段\n\n第二段\n    縮排這行';
    assert.equal(plainText(md), '第一段\n\n第二段\n    縮排這行');
  });

  test('清單保留縮排 ⇒ 層級看得出來，只脫掉標記', () => {
    assert.equal(plainText('*   甲\n    *   乙'), '甲\n    乙');
  });

  test('圍欄整行消失、裡面的程式碼一個字不動', () => {
    const md = '說明：\n```js\nconst a = **1**;\n```\n結束';
    assert.equal(plainText(md), '說明：\nconst a = **1**;\n結束');
  });

  test('分隔線與表格分隔列整行消失；表格列的管線換成空白', () => {
    // `---` 那一行整行消失（連同它的換行），前後的空行照舊留著
    assert.equal(plainText('上\n\n---\n\n下'), '上\n\n\n下');
    assert.equal(plainText('| a | b |\n|:---|---:|\n| 1 | 2 |'), 'a  b\n1  2');
  });

  test('冪等：投影一次與投影兩次逐字相同（§4.1）', () => {
    for (const md of [REAL_A, REAL_B, REAL_C, '## a\n- **b**\n> c\n`d`']) {
      assert.equal(plainText(plainText(md)), plainText(md), '投影必須冪等');
    }
  });

  test('她三則真回覆的投影不含 `**`／`##`／行首 `- `（§4.1）', () => {
    for (const md of [REAL_A, REAL_B, REAL_C]) {
      const out = plainText(md);
      assert.ok(!out.includes('**'), '粗體標記要脫乾淨');
      assert.ok(!out.includes('##'), '標題井號要脫乾淨');
      assert.ok(!/^[ \t]*[-*+][ \t]+/m.test(out), '行首清單標記要脫乾淨');
      assert.ok(!/^\s*\|/m.test(out), '表格管線不留在行首');
    }
    assert.ok(plainText(REAL_A).includes('汇报题目：胆固醇通过重塑蛋白冠，决定纳米颗粒的体内命运'));
    assert.ok(plainText(REAL_C).includes('蛋白冠决定纳米颗粒的体内命运  代谢物是否能调控蛋白冠？'));
  });

  test('不是字串 → 空字串（呼叫端不必先判斷）', () => {
    assert.equal(plainText(null), '');
    assert.equal(plainText(undefined), '');
    assert.equal(plainText(12), '');
  });

  test('前後端是同一顆函式，不是兩份複製品（§2.2）', () => {
    assert.equal(frontendPlainText, plainText, 'frontend/src/lib/markdown-plain.js 必須 re-export 同一份');
  });
});

// ── ① 純函式：quote 的第二種來源 ─────────────────────────────────────────
describe('parseQuote／validateQuote：message 來源（§2.1／§2.2）', () => {
  const PLAIN = plainText(REAL_B);
  const PICK = '蛋白冠的组成变化，改变了激活免疫反应的“路径”';
  const START = PLAIN.indexOf(PICK);
  const good = { source: 'message', message_id: 'm1', text: PICK, start: START, end: START + PICK.length };

  test('source 缺省＝paper，而且正規化後**不帶** source 鍵（工單 14 的形狀逐字不變）', () => {
    const q = parseQuote({ text: 'abc', start: 0, end: 3 });
    assert.deepEqual(q, { text: 'abc', start: 0, end: 3, page: null });
    assert.equal(quoteSource(q), 'paper');
    assert.equal(quoteSource(parseQuote({ text: 'abc', start: 0, end: 3, source: 'paper' })), 'paper');
  });

  test('source=message 正規化出 source／message_id', () => {
    const q = parseQuote(good);
    assert.equal(q.source, 'message');
    assert.equal(q.message_id, 'm1');
    assert.equal(quoteSource(q), 'message');
  });

  test('source=message 少了 message_id → 解不出來（當成沒有引用）', () => {
    assert.equal(parseQuote({ ...good, message_id: undefined }), null);
    assert.equal(parseQuote({ ...good, message_id: '   ' }), null);
  });

  test('偏移對得上投影 → 過；差一個字 → 400「選取內容與回答原文不一致」', () => {
    const ok = validateQuote(PLAIN, good);
    assert.equal(ok.ok, true);
    assert.deepEqual(ok.quote, { text: PICK, start: START, end: START + PICK.length, page: null, source: 'message', message_id: 'm1' });

    const bad = validateQuote(PLAIN, { ...good, start: START + 1 });
    assert.equal(bad.ok, false);
    assert.equal(bad.error, '選取內容與回答原文不一致');
  });

  test('拿原始 markdown 當基準會驗不過（＝投影真的是唯一基準）', () => {
    const v = validateQuote(REAL_B, good);
    assert.equal(v.ok, false, '偏移是對投影算的，對 markdown 原字串必定對不上');
  });

  test('超出回答長度 → 那一句話跟 paper 來源分得開', () => {
    const v = validateQuote(PLAIN, { ...good, start: PLAIN.length - 2, end: PLAIN.length + 50, text: 'xx' });
    assert.equal(v.ok, false);
    assert.equal(v.error, '引用範圍超出回答長度');
  });
});

describe('renderQuotedMessage／buildQuoteContextBlock：message 來源（§2.3）', () => {
  const quote = { source: 'message', message_id: 'm1', text: '補體蛋白減少 ≠ 炎症反應減弱', start: 3, end: 17, page: null };

  test('前綴是「【引用你先前的回答（第 N 輪）】」，指令句換成認錯那一句', () => {
    const out = renderQuotedMessage(quote, '那免疫反應到底是強還是弱？', '（用不到的 full_text）', { turn: 3 });
    assert.ok(out.startsWith('【引用你先前的回答（第 3 輪）】\n'), out.slice(0, 40));
    assert.ok(out.includes('> 補體蛋白減少 ≠ 炎症反應減弱'));
    assert.ok(out.includes('那免疫反應到底是強還是弱？'));
    assert.ok(out.endsWith(`（${QUOTE_REPLY_ANSWER_INSTRUCTION}）`));
    assert.ok(!out.includes('【引用原文'), 'paper 那一型的前綴不能混進來');
  });

  test('算不出輪次時退成不帶輪次的前綴（不是印 null）', () => {
    const out = renderQuotedMessage(quote, '追問', '', { turn: null });
    assert.ok(out.startsWith('【引用你先前的回答】\n'));
  });

  test('只選段、沒打字 → 用 message 那一型的預設問題', () => {
    const out = renderQuotedMessage(quote, '', '', { turn: 1 });
    assert.ok(out.includes(DEFAULT_REPLY_QUOTE_QUESTION));
  });

  test('脈絡：短回答整段給，標題是「【被引用回答的上下文】」，附上她當時問的那句', () => {
    const plain = plainText(REAL_B);
    const block = buildQuoteContextBlock(plain, { ...quote, start: 0, end: 10, text: plain.slice(0, 10) }, {
      userQuestion: '補體減少不是應該發炎變輕嗎？',
      turn: 2,
    });
    assert.ok(block.startsWith('\n\n'), '只進變動區，開頭是兩個換行接在 insightText 後面');
    assert.ok(block.includes('【被引用回答的上下文】'));
    assert.ok(block.includes('核心逻辑：补体蛋白减少'), '短回答整段進去');
    assert.ok(block.includes('【那一輪她問的是】'));
    assert.ok(block.includes('補體減少不是應該發炎變輕嗎？'));
    assert.ok(!block.includes('【選段前文】'), 'paper 那一型的脈絡不能混進來');
  });

  test('脈絡：超過 2,000 字改取選段前後各 800 字，兩端補刪節號', () => {
    const long = '甲'.repeat(6000);
    const block = buildQuoteContextBlock(long, { ...quote, start: 3000, end: 3010, text: '甲'.repeat(10) }, { turn: 1 });
    const body = block.split('【被引用回答的上下文】\n')[1].split('\n【那一輪她問的是】')[0];
    assert.ok(body.startsWith('…') && body.endsWith('…'));
    assert.ok(body.length < QUOTE_MESSAGE_CONTEXT_MAX, `取到 ${body.length} 字，應該遠小於整段`);
    assert.equal(body.length, 1 + 800 + 10 + 800 + 1);
  });

  test('脈絡：她當時的問題超過 300 字會截斷', () => {
    const block = buildQuoteContextBlock('短回答', { ...quote, start: 0, end: 3, text: '短回答' }, {
      userQuestion: '問'.repeat(500),
    });
    assert.ok(block.includes(`${'問'.repeat(QUOTE_MESSAGE_QUESTION_MAX)}…`));
    assert.ok(!block.includes('問'.repeat(QUOTE_MESSAGE_QUESTION_MAX + 1)));
  });

  test('那一輪她沒打字時也要有一句，不是空著', () => {
    const block = buildQuoteContextBlock('短回答', { ...quote, start: 0, end: 3, text: '短回答' }, {});
    assert.ok(block.includes('（那一輪她只選了一段、沒有另外打字）'));
  });

  test('[CHAT] start 的 quote= 欄帶來源（§2.4）', () => {
    assert.equal(quoteLogLabel(null), 'none');
    assert.equal(quoteLogLabel({ start: 0, end: 12 }), 'paper:12字');
    assert.equal(quoteLogLabel({ source: 'message', start: 0, end: 12 }), 'message:12字');
  });
});

describe('輪次：assistantTurnOf／assistantTurnMap（§2.3）', () => {
  const msgs = [
    { id: 'u1', role: 'user' },
    { id: 'a1', role: 'assistant' },
    { id: 'u2', role: 'user' },
    { id: 'a2', role: 'assistant' },
    { id: 'u3', role: 'user' },
    { id: 'a3', role: 'assistant' },
  ];

  test('只數 assistant，1-based', () => {
    assert.equal(assistantTurnOf(msgs, 'a1'), 1);
    assert.equal(assistantTurnOf(msgs, 'a3'), 3);
  });

  test('user 的 id 與不存在的 id → null（呼叫端退成不帶輪次）', () => {
    assert.equal(assistantTurnOf(msgs, 'u2'), null);
    assert.equal(assistantTurnOf(msgs, 'nope'), null);
    assert.equal(assistantTurnOf(msgs, null), null);
  });

  test('assistantTurnMap 與逐個算同一個答案', () => {
    const map = assistantTurnMap(msgs);
    for (const m of msgs.filter(x => x.role === 'assistant')) {
      assert.equal(map.get(m.id), assistantTurnOf(msgs, m.id));
    }
    assert.equal(map.size, 3);
  });
});

// ── ② 路由層 ─────────────────────────────────────────────────────────────
describe('討論路由：引用 AI 先前的回覆（§4.2–§4.5、§4.7）', () => {
  let server, baseUrl, upstream;
  const requests = [];
  const REPLY = REAL_B;                       // 假上游回這一串（＝之後被引用的那則回答）
  const REPLY_PLAIN = plainText(REPLY);
  const PICK = '蛋白冠的组成变化，改变了激活免疫反应的“路径”';
  const PICK_START = REPLY_PLAIN.indexOf(PICK);

  function makePaper(prefix) {
    const id = `${prefix}_${nanoid(6)}`;
    db.prepare(`INSERT INTO papers (id, title, authors, year, full_text, summary_bg, summary_methods, summary_results, summary_conclusions, summary_limitations)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, '蛋白冠與膽固醇', 'Tang', 2023, '奈米塑膠進入血液之後，最先接觸到的是血漿蛋白。\n\n第二段講膽固醇。', 'bg', 'm', 'r', 'c', 'l'
    );
    return db.prepare('SELECT * FROM papers WHERE id = ?').get(id);
  }

  function dropPaper(id) {
    db.prepare('DELETE FROM messages WHERE paper_id = ?').run(id);
    db.prepare('DELETE FROM papers WHERE id = ?').run(id);
  }

  before(async () => {
    upstream = createServer((req, res) => {
      let body = '';
      req.on('data', c => (body += c));
      req.on('end', () => {
        requests.push(JSON.parse(body));
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: REPLY } }] })}\n\n`);
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
    if (res.ok) await res.text();
    return res;
  }

  /** 先問一句、拿到一則 assistant 回覆（＝之後要引用的那則），回傳它的 id。 */
  async function seedReply(paperId, question = '補體減少不是應該發炎變輕嗎？') {
    await send(paperId, { message: question });
    const msgs = await fetch(`${baseUrl}/api/papers/${paperId}/chat`).then(r => r.json());
    return msgs.filter(m => m.role === 'assistant').at(-1).id;
  }

  function messageQuote(messageId) {
    return {
      source: 'message',
      message_id: messageId,
      text: PICK,
      start: PICK_START,
      end: PICK_START + PICK.length,
    };
  }

  test('§4.2 帶 message 來源＋正確偏移 → 200；DB quote 含 source／message_id，content 只有她打的字', async () => {
    const paper = makePaper('msgok');
    try {
      const replyId = await seedReply(paper.id);
      requests.length = 0;

      const res = await send(paper.id, {
        message: '你這句「路徑改變」具體是指哪一條路徑？',
        quote: messageQuote(replyId),
      });
      assert.equal(res.status, 200);

      const rows = db.prepare(
        'SELECT role, content, quote FROM messages WHERE paper_id = ? ORDER BY seq'
      ).all(paper.id);
      const lastUser = rows.filter(r => r.role === 'user').at(-1);
      assert.equal(lastUser.content, '你這句「路徑改變」具體是指哪一條路徑？', '紅線：content 只存她打的字');
      const saved = JSON.parse(lastUser.quote);
      assert.deepEqual(saved, {
        text: PICK, start: PICK_START, end: PICK_START + PICK.length, page: null,
        source: 'message', message_id: replyId,
      });

      const sent = requests.at(-1).messages.at(-1);
      assert.equal(sent.role, 'user');
      assert.ok(sent.content.startsWith('【引用你先前的回答（第 1 輪）】'), sent.content.slice(0, 40));
      assert.ok(sent.content.includes(PICK));
      assert.ok(sent.content.includes('你這句「路徑改變」具體是指哪一條路徑？'));
      assert.ok(sent.content.includes(QUOTE_REPLY_ANSWER_INSTRUCTION));
    } finally {
      dropPaper(paper.id);
    }
  });

  test('§4.3 穩定前綴逐字不變；變動區有【被引用回答的上下文】與她當時的問題', async () => {
    const paper = makePaper('msgprefix');
    try {
      const replyId = await seedReply(paper.id, '補體減少不是應該發炎變輕嗎？');
      requests.length = 0;

      await send(paper.id, { message: '不帶引用的一句' });
      const plainSystem = requests.at(-1).messages[0].content;

      await send(paper.id, { message: '帶引用的一句', quote: messageQuote(replyId) });
      const quotedSystem = requests.at(-1).messages[0].content;

      assert.ok(
        quotedSystem.startsWith(plainSystem),
        '帶 quote 只能在變動區尾巴加東西，憲章＋論文區塊必須逐字不變'
      );
      const extra = quotedSystem.slice(plainSystem.length);
      assert.ok(extra.includes('【被引用回答的上下文】'));
      assert.ok(extra.includes('补体蛋白减少'), '那則回答的內容要進脈絡');
      assert.ok(extra.includes('【那一輪她問的是】\n補體減少不是應該發炎變輕嗎？'));
      assert.ok(!extra.includes('【選段前文】'), 'paper 那一型的脈絡不該出現');
      assert.ok(!plainSystem.includes('【被引用回答的上下文】'));
    } finally {
      dropPaper(paper.id);
    }
  });

  test('§4.3 脈絡吃的是投影不是 markdown（`**`／`##` 不進 prompt）', async () => {
    const paper = makePaper('msgplain');
    try {
      const replyId = await seedReply(paper.id);
      requests.length = 0;
      await send(paper.id, { message: '追問', quote: messageQuote(replyId) });

      const system = requests.at(-1).messages[0].content;
      const block = system.slice(system.indexOf('【被引用回答的上下文】'));
      assert.ok(!block.includes('**'), '送進模型的脈絡是純文字投影');
      assert.ok(!block.includes('###'));
    } finally {
      dropPaper(paper.id);
    }
  });

  test('§4.2 偏移錯 → 400「選取內容與回答原文不一致」，一列都不寫、上游零發', async () => {
    const paper = makePaper('msgbad');
    try {
      const replyId = await seedReply(paper.id);
      const before = db.prepare('SELECT COUNT(*) n FROM messages WHERE paper_id = ?').get(paper.id).n;
      requests.length = 0;

      const q = messageQuote(replyId);
      const res = await send(paper.id, { message: '追問', quote: { ...q, start: q.start + 2 } });
      assert.equal(res.status, 400);
      assert.equal((await res.json()).error, '選取內容與回答原文不一致');
      assert.equal(requests.length, 0, '驗不過就不該打上游');
      assert.equal(db.prepare('SELECT COUNT(*) n FROM messages WHERE paper_id = ?').get(paper.id).n, before);
    } finally {
      dropPaper(paper.id);
    }
  });

  test('§4.2 拿原始 markdown 的偏移送進來也是 400（投影是唯一基準）', async () => {
    const paper = makePaper('msgraw');
    try {
      const replyId = await seedReply(paper.id);
      requests.length = 0;
      const rawStart = REPLY.indexOf(PICK);
      const res = await send(paper.id, {
        message: '追問',
        quote: { source: 'message', message_id: replyId, text: PICK, start: rawStart, end: rawStart + PICK.length },
      });
      assert.equal(res.status, 400);
      assert.equal(requests.length, 0);
    } finally {
      dropPaper(paper.id);
    }
  });

  test('§4.2 message_id 不屬於這篇論文 → 400；引用的是她自己的訊息 → 400', async () => {
    const paperA = makePaper('msgA');
    const paperB = makePaper('msgB');
    try {
      const replyId = await seedReply(paperA.id);
      requests.length = 0;

      const cross = await send(paperB.id, { message: '追問', quote: messageQuote(replyId) });
      assert.equal(cross.status, 400);
      assert.equal((await cross.json()).error, '找不到被引用的回覆');

      const userMsg = db.prepare(
        'SELECT id FROM messages WHERE paper_id = ? AND role = ? ORDER BY seq LIMIT 1'
      ).get(paperA.id, 'user');
      const wrongRole = await send(paperA.id, { message: '追問', quote: messageQuote(userMsg.id) });
      assert.equal(wrongRole.status, 400);
      assert.equal((await wrongRole.json()).error, '只能引用 AI 的回覆');

      const noSuch = await send(paperA.id, { message: '追問', quote: messageQuote('doesnotexist') });
      assert.equal(noSuch.status, 400);

      assert.equal(requests.length, 0, '四個 400 沒有一發打到上游');
    } finally {
      dropPaper(paperA.id);
      dropPaper(paperB.id);
    }
  });

  test('§4.2 只引用、一個字都沒打 → 200，送的是 message 型的預設問題', async () => {
    const paper = makePaper('msgnoq');
    try {
      const replyId = await seedReply(paper.id);
      requests.length = 0;
      const res = await send(paper.id, { message: '', quote: messageQuote(replyId) });
      assert.equal(res.status, 200);
      assert.ok(requests.at(-1).messages.at(-1).content.includes(DEFAULT_REPLY_QUOTE_QUESTION));
    } finally {
      dropPaper(paper.id);
    }
  });

  test('§4.4 歷史回放：下一輪送出時，引用那一則 user 與當時逐字相同', async () => {
    const paper = makePaper('msgreplay');
    try {
      const replyId = await seedReply(paper.id);
      requests.length = 0;

      await send(paper.id, { message: '第一次追問', quote: messageQuote(replyId) });
      const asSent = requests.at(-1).messages.at(-1).content;

      await send(paper.id, { message: '再問一句' });
      const replayed = requests.at(-1).messages.find(m => m.content === asSent);
      assert.ok(replayed, '歷史回放與送出當輪必須逐字相同，否則 cache 前綴每輪都冷');
      assert.ok(asSent.startsWith('【引用你先前的回答（第 1 輪）】'));
    } finally {
      dropPaper(paper.id);
    }
  });

  test('§4.4 重新生成沿用最後一則 user 的引用脈絡（輪次與上下文都要回來）', async () => {
    const paper = makePaper('msgregen');
    try {
      const replyId = await seedReply(paper.id);
      requests.length = 0;
      await send(paper.id, { message: '追問一次', quote: messageQuote(replyId) });
      const asSent = requests.at(-1).messages.at(-1).content;

      const res = await fetch(`${baseUrl}/api/papers/${paper.id}/chat?regenerate=true`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      await res.text();

      const regen = requests.at(-1).messages;
      assert.equal(regen.at(-1).content, asSent);
      assert.ok(regen[0].content.includes('【被引用回答的上下文】'), '脈絡也要跟著回來');
    } finally {
      dropPaper(paper.id);
    }
  });

  test('§4.7 `[CHAT] start` 帶 quote=message:', async () => {
    const paper = makePaper('msglog');
    try {
      const replyId = await seedReply(paper.id);
      requests.length = 0;
      await send(paper.id, { message: '追問', quote: messageQuote(replyId) });
      const line = getRecentLogs(50).find(l => l.includes('[CHAT] start') && l.includes(paper.id));
      assert.ok(line, '找得到這一輪的 [CHAT] start');
      assert.match(line, new RegExp(`quote=message:${PICK.length}字`));
    } finally {
      dropPaper(paper.id);
    }
  });

  test('GET /chat 回得出 source／message_id（氣泡的引用塊靠它畫）', async () => {
    const paper = makePaper('msgget');
    try {
      const replyId = await seedReply(paper.id);
      await send(paper.id, { message: '追問', quote: messageQuote(replyId) });
      const msgs = await fetch(`${baseUrl}/api/papers/${paper.id}/chat`).then(r => r.json());
      const quoted = msgs.filter(m => m.role === 'user').at(-1);
      assert.equal(quoted.quote.source, 'message');
      assert.equal(quoted.quote.message_id, replyId);
      // 前端畫「第 N 輪」用的是同一顆輪次函式
      assert.equal(assistantTurnOf(msgs, replyId), 1);
    } finally {
      dropPaper(paper.id);
    }
  });

  test('§4.5 paper 來源在同一條路徑上完全沒變（引用論文原文照舊 200）', async () => {
    const paper = makePaper('msgpaper');
    try {
      const head = paper.full_text.slice(0, 20);
      requests.length = 0;
      const res = await send(paper.id, { message: '這段在說什麼', quote: { text: head, start: 0, end: 20 } });
      assert.equal(res.status, 200);
      const sent = requests.at(-1).messages.at(-1).content;
      assert.ok(sent.startsWith('【引用原文（全文第 1–20 字，約第 1 段）】'));
      const row = db.prepare(
        'SELECT quote FROM messages WHERE paper_id = ? AND role = ? ORDER BY seq LIMIT 1'
      ).get(paper.id, 'user');
      assert.deepEqual(JSON.parse(row.quote), { text: head, start: 0, end: 20, page: null },
        'paper 來源存進 DB 的 JSON 形狀必須與工單 14 逐字相同');
    } finally {
      dropPaper(paper.id);
    }
  });
});

// ── ③ 前端：氣泡選取 → 偏移（§4.6）───────────────────────────────────────
//
// 假 DOM：只實作 `closestMessageId` 真的會碰的那幾個欄位。`selection.toString()`
// 在真瀏覽器裡就是一段字串，所以定位那一層直接餵字串測。
function element(attrs, children = []) {
  const el = {
    nodeType: 1,
    childNodes: children,
    parentNode: null,
    getAttribute: (name) => (name in attrs ? attrs[name] : null),
  };
  for (const c of children) c.parentNode = el;
  return el;
}

function textNode(value) {
  return { nodeType: 3, nodeValue: value, childNodes: [], parentNode: null };
}

describe('前端氣泡選取（§2.2／§4.6）', () => {
  const PLAIN = plainText(REAL_B);

  test('closestMessageId：往上找得到 data-cr-msg-id，找不到回 null', () => {
    const leaf = textNode('某一句');
    const strong = element({}, [leaf]);
    const bubble = element({ [MSG_ID_ATTR]: 'a42' }, [strong]);
    element({}, [bubble]);                    // 再包一層外殼（沒有屬性）
    assert.equal(closestMessageId(leaf), 'a42');
    assert.equal(closestMessageId(bubble), 'a42');
    assert.equal(closestMessageId(textNode('孤兒節點')), null);
    assert.equal(closestMessageId(null), null);
  });

  test('唯一命中 → 偏移正確，而且 text 是投影切片（不是 selection.toString()）', () => {
    const picked = '补体蛋白减少 ≠ 炎症反应减弱';
    const hit = locateInPlain(PLAIN, picked);
    assert.equal(hit.ok, true);
    assert.equal(PLAIN.slice(hit.start, hit.end), hit.text);
    assert.equal(hit.text, picked);
  });

  test('多次命中 → 拒絕，提示她多選幾個字（§2.2 二選一的那一條）', () => {
    const plain = '重複的一段話在這裡。中間夾別的。重複的一段話在這裡。';
    const hit = locateInPlain(plain, '重複的一段話在這裡');
    assert.equal(hit.ok, false);
    assert.equal(hit.reason, 'ambiguous');
    assert.equal(selectionHint(hit.reason), AMBIGUOUS_HINT);
    assert.match(AMBIGUOUS_HINT, /多選幾個字/);
  });

  test(`少於 ${MIN_MESSAGE_SELECTION_CHARS} 字 → 不彈（手滑點一下不該跳按鈕）`, () => {
    assert.equal(locateInPlain(PLAIN, '补体').reason, 'tooShort');
    assert.equal(locateInPlain(PLAIN, '   ').reason, 'empty');
  });

  test('選取的空白與投影不一樣（DOM 把軟換行渲染成空白）也接得回去', () => {
    const plain = '第一行結尾\n第二行開頭繼續講';
    const hit = locateInPlain(plain, '第一行結尾 第二行開頭繼續講');
    assert.equal(hit.ok, true);
    assert.equal(hit.start, 0);
    assert.equal(hit.end, plain.length);
    assert.equal(hit.text, plain, 'text 一律是投影切片，後端 slice===text 才過得去');
  });

  test('對不上投影 → notFound，不是硬送一個錯偏移', () => {
    const hit = locateInPlain(PLAIN, '這串字根本不在這則回覆裡面');
    assert.equal(hit.ok, false);
    assert.equal(hit.reason, 'notFound');
  });

  test('resolveMessageSelectionQuote：吃 markdown 原字串、吐可以直接送後端的 quote', () => {
    const picked = '补体蛋白减少 ≠ 炎症反应减弱';
    const v = resolveMessageSelectionQuote({
      selectedText: picked, messageId: 'a7', content: REAL_B, turn: 2,
    });
    assert.equal(v.ok, true);
    assert.equal(v.quote.source, 'message');
    assert.equal(v.quote.message_id, 'a7');
    assert.equal(v.quote.turn, 2);
    // 後端拿同一份投影驗這顆 quote 要過
    const verdict = validateQuote(plainText(REAL_B), v.quote);
    assert.equal(verdict.ok, true, '前端算的偏移必須過得了後端那道閘門');
    assert.equal(verdict.quote.message_id, 'a7');
    assert.equal(verdict.quote.turn, undefined, 'turn 只給畫面用，不進 DB');
  });

  test('沒有 messageId → 不成立（§2.5：不做引用她自己的訊息）', () => {
    assert.equal(resolveMessageSelectionQuote({ selectedText: '一二三四五六七八', messageId: null, content: REAL_B }).ok, false);
  });

  test('引用卡文案分兩型（§2.4）', () => {
    assert.equal(quoteCardLabel({ text: 'x', start: 10, end: 30 }), '引用原文 · 第 11–30 字');
    assert.equal(quoteCardLabel({ source: 'message', text: 'x', start: 0, end: 5, turn: 3 }), '引用 AI 回答 · 第 3 輪');
    assert.equal(quoteCardLabel({ source: 'message', text: 'x', start: 0, end: 5 }, 2), '引用 AI 回答 · 第 2 輪');
    assert.equal(quoteCardLabel({ source: 'message', text: 'x', start: 0, end: 5 }), '引用 AI 回答');
    assert.equal(quoteJumpLabel({ text: 'x', start: 0, end: 5 }), '跳回原文');
    assert.equal(quoteJumpLabel({ source: 'message', text: 'x', start: 0, end: 5 }), '跳回那則回答');
  });
});
