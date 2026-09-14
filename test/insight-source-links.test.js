// 工單 18 §4：洞察來源浮現卡（A）＋洞察之間的自動聯想（B）。
//
// 上游一律是本機假 server（§3 紅線：絕不打真上游；B2 的「為什麼相關」只 mock）。
// 分三層，跟工單 14 的測試同一個骨架：
//   ① 純函式（`src/insightSource.js`／`src/insightLinks.js`）：探針、切詞、門檻 clamp、分數。
//   ② 路由層（真 express、真 SQLite）：欄位驗證、`GET /:id` 的一問一答、backfill、
//      relink-all 冪等、`link_count` 一趟 SQL、DELETE 的 CASCADE。
//   ③ 前端純函式（`frontend/src/lib/insight-source.js`）：來源三態、分數三檔、歷史堆疊。
import { test, describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { nanoid } from 'nanoid';

import db, { setSetting } from '../src/db.js';
import {
  BACKFILL_PROBE_CHARS,
  stripContextRoleTag,
  backfillProbe,
  resolveSourceMessageId,
  loadSourceConversation,
  backfillInsightSources,
} from '../src/insightSource.js';
import {
  LINK_MIN_SCORE_DEFAULT,
  LINK_MAX_DEFAULT,
  LINK_REASON_BATCH_MAX,
  resolveLinkMinScore,
  resolveLinkMax,
  resolveLinkReasonEnabled,
  normalizeLinkPair,
  buildLinkTerms,
  buildLinkMatch,
  scoreCandidates,
  computeInsightLinks,
  relinkAll,
  listInsightLinks,
  sanitizeReason,
  maybeGenerateReasons,
} from '../src/insightLinks.js';
import {
  describeSourceBlock,
  excerpt,
  scoreLabel,
  pushHistory,
  popHistory,
  previousUserMessage,
  HISTORY_MAX,
} from '../frontend/src/lib/insight-source.js';

// ── fixture helpers ────────────────────────────────────────────────────
const PAPER_TITLE = '膽固醇如何重塑奈米顆粒的蛋白冠';

function makePaper(prefix = 'wo18') {
  const id = `${prefix}_${nanoid(6)}`;
  db.prepare(`INSERT INTO papers (id, title, authors, year, full_text, summary_bg, summary_methods, summary_results, summary_conclusions, summary_limitations)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id, PAPER_TITLE, 'Tang', 2023, '全文', 'bg', 'm', 'r', 'c', 'l'
  );
  return id;
}

function addMessage(paperId, role, content, seq) {
  const id = nanoid();
  db.prepare(
    'INSERT INTO messages (id, paper_id, role, content, created_at, seq) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, paperId, role, content, Date.now() + seq, seq);
  return id;
}

function addInsight({ paperId = null, title, content, context = '', messageId = '' }) {
  const id = nanoid();
  db.prepare(`INSERT INTO insights (id, dimension, title, content, source_paper_id, source_context, source_message_id, tags_json)
    VALUES (?, '概念', ?, ?, ?, ?, ?, '[]')`).run(id, title, content, paperId, context, messageId);
  return id;
}

function dropPaper(paperId) {
  db.prepare('DELETE FROM insights WHERE source_paper_id = ?').run(paperId);
  db.prepare('DELETE FROM messages WHERE paper_id = ?').run(paperId);
  db.prepare('DELETE FROM papers WHERE id = ?').run(paperId);
}

// ── ① 純函式：來源欄位 ─────────────────────────────────────────────────
describe('工單 18 A1 — source_context 探針（純函式）', () => {
  it('剝掉提取線加的角色標記（不剝就永遠比不中訊息原文）', () => {
    assert.equal(stripContextRoleTag('[assistant] 載脂蛋白主要負責運輸'), '載脂蛋白主要負責運輸');
    assert.equal(stripContextRoleTag('[user] 為什麼'), '為什麼');
    assert.equal(stripContextRoleTag('沒有標記的原文'), '沒有標記的原文');
  });

  it('探針只取第一段的前 60 字', () => {
    const long = `[assistant] ${'膽'.repeat(200)}\n[user] 第二段`;
    const probe = backfillProbe(long);
    assert.equal(probe.length, BACKFILL_PROBE_CHARS);
    assert.ok(!probe.includes('第二段'));
  });

  it('空值回空字串（呼叫端據此跳過，不會拿空探針去撈全庫）', () => {
    assert.equal(backfillProbe(''), '');
    assert.equal(backfillProbe(null), '');
  });
});

describe('工單 18 A1 — resolveSourceMessageId（驗證但不 400）', () => {
  let paperId;
  let otherPaperId;
  let msgId;

  before(() => {
    paperId = makePaper();
    otherPaperId = makePaper();
    msgId = addMessage(paperId, 'assistant', '這一則屬於第一篇', 1);
  });
  after(() => { dropPaper(paperId); dropPaper(otherPaperId); });

  it('存在且同篇 → 原樣回傳', () => {
    assert.equal(resolveSourceMessageId(msgId, paperId), msgId);
  });

  it('訊息不存在 → 空字串', () => {
    assert.equal(resolveSourceMessageId('no-such-message', paperId), '');
  });

  it('訊息屬於別篇 → 空字串（跳回去會跳到不相干的對話）', () => {
    assert.equal(resolveSourceMessageId(msgId, otherPaperId), '');
  });

  it('沒給／空白／非字串 → 空字串', () => {
    assert.equal(resolveSourceMessageId(undefined, paperId), '');
    assert.equal(resolveSourceMessageId('   ', paperId), '');
    assert.equal(resolveSourceMessageId(123, paperId), '');
  });
});

describe('工單 18 A2 — loadSourceConversation（一問一答）', () => {
  let paperId;
  let q1;
  let a1;
  let q2;
  let a2;

  before(() => {
    paperId = makePaper();
    q1 = addMessage(paperId, 'user', '載脂蛋白和補體蛋白差在哪？', 1);
    a1 = addMessage(paperId, 'assistant', '一個負責運輸遞送，一個是先天免疫。', 2);
    q2 = addMessage(paperId, 'user', '那膽固醇為什麼會改變它們？', 3);
    a2 = addMessage(paperId, 'assistant', '因為膽固醇改變了脂質環境。', 4);
  });
  after(() => dropPaper(paperId));

  it('回那一則 assistant ＋ 它前面最近的一則 user', () => {
    const out = loadSourceConversation({ source_message_id: a2 });
    assert.equal(out.source_message.id, a2);
    assert.equal(out.source_message.content, '因為膽固醇改變了脂質環境。');
    assert.equal(out.source_question.id, q2);
  });

  it('第一輪也抓得到它自己的提問', () => {
    const out = loadSourceConversation({ source_message_id: a1 });
    assert.equal(out.source_question.id, q1);
  });

  it('沒有 source_message_id → 兩者都 null（前端退回 source_context）', () => {
    const out = loadSourceConversation({ source_message_id: '' });
    assert.equal(out.source_message, null);
    assert.equal(out.source_question, null);
  });

  it('訊息被截掉（編輯／重生）→ 兩者都 null，不拋', () => {
    const out = loadSourceConversation({ source_message_id: 'gone' });
    assert.equal(out.source_message, null);
    assert.equal(out.source_question, null);
  });
});

// ── ① 純函式：聯想參數與切詞 ──────────────────────────────────────────
describe('工單 18 B1 — 參數 clamp 與切詞', () => {
  it('門檻預設 0.35，超界 clamp 進 [0.05, 0.95]', () => {
    assert.equal(resolveLinkMinScore({}), LINK_MIN_SCORE_DEFAULT);
    assert.equal(resolveLinkMinScore({ INSIGHT_LINK_MIN_SCORE: '0.6' }), 0.6);
    assert.equal(resolveLinkMinScore({ INSIGHT_LINK_MIN_SCORE: '0' }), 0.05);
    assert.equal(resolveLinkMinScore({ INSIGHT_LINK_MIN_SCORE: '5' }), 0.95);
    assert.equal(resolveLinkMinScore({ INSIGHT_LINK_MIN_SCORE: '亂寫' }), LINK_MIN_SCORE_DEFAULT);
  });

  it('每條上限預設 5，非法值退回預設、上界 50', () => {
    assert.equal(resolveLinkMax({}), LINK_MAX_DEFAULT);
    assert.equal(resolveLinkMax({ INSIGHT_LINK_MAX: '3' }), 3);
    assert.equal(resolveLinkMax({ INSIGHT_LINK_MAX: '0' }), LINK_MAX_DEFAULT);
    assert.equal(resolveLinkMax({ INSIGHT_LINK_MAX: '999' }), 50);
  });

  it('「為什麼相關」預設關——沒設、空字串、false 全部是關', () => {
    assert.equal(resolveLinkReasonEnabled({}), false);
    assert.equal(resolveLinkReasonEnabled({ INSIGHT_LINK_REASON: '' }), false);
    assert.equal(resolveLinkReasonEnabled({ INSIGHT_LINK_REASON: 'false' }), false);
    assert.equal(resolveLinkReasonEnabled({ INSIGHT_LINK_REASON: 'true' }), true);
    assert.equal(resolveLinkReasonEnabled({ INSIGHT_LINK_REASON: '1' }), true);
  });

  it('a<b 正規化；同一條回 null', () => {
    assert.deepEqual(normalizeLinkPair('b', 'a'), { a: 'a', b: 'b' });
    assert.deepEqual(normalizeLinkPair('a', 'b'), { a: 'a', b: 'b' });
    assert.equal(normalizeLinkPair('a', 'a'), null);
    assert.equal(normalizeLinkPair('a', ''), null);
  });

  it('切詞：重疊窗、去重、不做去標點正規化（PY-GCMS 要留著那一槓）', () => {
    const terms = buildLinkTerms('PY-GCMS 的方法');
    assert.ok(terms.some(t => t.includes('-')), 'trigram 是逐字比對，標點不能先吃掉');
    assert.equal(new Set(terms).size, terms.length, '去重');
  });

  it('切詞：字數上限吃得住，短到不足一窗的至少留一個 trigram', () => {
    const terms = buildLinkTerms('膽'.repeat(1000));
    assert.ok(terms.length <= 80);
    assert.deepEqual(buildLinkTerms('可靠性'), ['可靠性']);
    assert.deepEqual(buildLinkTerms('短'), []);
  });

  it('MATCH 只查 title／content 兩欄（source_context 是整段對話，會把同一次對話誤判成同一個想法）', () => {
    const match = buildLinkMatch(['膽固醇會改']);
    assert.ok(match.startsWith('{title content} :'));
    assert.ok(!match.includes('source_context'));
    assert.equal(buildLinkMatch([]), '');
  });

  it('雙引號會被逸出，不讓查詢語法炸掉', () => {
    assert.equal(buildLinkMatch(['a"b']), '{title content} : ("a""b")');
  });
});

// ── ② 聯想：真 SQLite 上的行為 ────────────────────────────────────────
describe('工單 18 B1 — 連線計算（真 FTS5）', () => {
  let paperId;
  let ids;

  // 兩對明顯相似（A1/A2 與 B1/B2）＋ 一條完全不相干（C）
  const FIXTURES = {
    a1: '載脂蛋白負責運輸脂類，促進肝細胞攝取奈米顆粒；補體蛋白是先天免疫系統成分，負責調理。',
    a2: '載脂蛋白負責運輸脂類，促進肝細胞攝取奈米顆粒；補體蛋白是先天免疫系統的成分，負責調理作用。',
    b1: '高膽固醇環境下，蛋白冠中載脂蛋白富集、補體蛋白減少，免疫激活路徑從補體依賴轉向受體依賴。',
    b2: '高膽固醇環境下，蛋白冠中載脂蛋白富集、補體蛋白減少，免疫激活路徑由補體依賴轉向受體依賴。',
    c: '本研究用同步輻射粉末繞射量測鈣鈦礦薄膜在退火過程中的晶格常數變化。',
  };

  before(() => {
    paperId = makePaper();
    ids = {};
    for (const [key, content] of Object.entries(FIXTURES)) {
      // 標題照提取線的規矩取前 80 字——FTS 兩欄都吃得到，跟她真資料同一個形狀
      ids[key] = addInsight({ paperId, title: content.slice(0, 80), content });
    }
    relinkAll();
  });
  after(() => {
    dropPaper(paperId);
    db.prepare('DELETE FROM insight_links').run();
  });

  function pairsFor(paper) {
    const own = new Set(db.prepare('SELECT id FROM insights WHERE source_paper_id = ?').all(paper).map(r => r.id));
    return db.prepare('SELECT a, b, score FROM insight_links').all()
      .filter(r => own.has(r.a) && own.has(r.b));
  }

  it('恰好兩對被連上，孤立的那條一條都沒有', () => {
    const rows = pairsFor(paperId);
    assert.equal(rows.length, 2, `期待兩對，實得 ${JSON.stringify(rows)}`);
    const key = (id) => Object.keys(ids).find(k => ids[k] === id);
    const got = rows.map(r => [key(r.a), key(r.b)].sort().join('↔')).sort();
    assert.deepEqual(got, ['a1↔a2', 'b1↔b2']);
    assert.equal(listInsightLinks(ids.c).length, 0, '不相干的那條沒有連線');
  });

  it('分數在 0–1，而且近重複遠高於門檻', () => {
    for (const row of pairsFor(paperId)) {
      assert.ok(row.score > LINK_MIN_SCORE_DEFAULT && row.score <= 1, `score=${row.score}`);
    }
  });

  it('門檻拉到 0.95 → 一條連線都不留（門檻真的在作用）', () => {
    relinkAll({ minScore: 0.95 });
    assert.equal(pairsFor(paperId).length, 0);
    relinkAll();
    assert.equal(pairsFor(paperId).length, 2);
  });

  it('每條上限 max=1 時不會超發', () => {
    relinkAll({ minScore: 0.05, max: 1 });
    for (const id of Object.values(ids)) {
      assert.ok(listInsightLinks(id).length <= 2, '無向表下一條最多被 max 條各連一次');
    }
    relinkAll();
  });

  it('relink-all 冪等：跑兩次結果逐列相同', () => {
    const snapshot = () => db.prepare('SELECT a, b, score FROM insight_links ORDER BY a, b').all();
    const first = snapshot();
    relinkAll();
    assert.deepEqual(snapshot(), first);
  });

  it('scoreCandidates 不寫庫', () => {
    const before = db.prepare('SELECT COUNT(*) AS n FROM insight_links').get().n;
    scoreCandidates(db.prepare('SELECT id, title, content FROM insights WHERE id = ?').get(ids.a1));
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM insight_links').get().n, before);
  });

  it('DELETE 一條洞察 → 它的連線跟著消失（外鍵 CASCADE）', () => {
    const victim = addInsight({ paperId, title: FIXTURES.a1.slice(0, 80), content: FIXTURES.a1 });
    computeInsightLinks(victim);
    assert.ok(listInsightLinks(victim).length > 0, '先確定它真的有連線');

    db.prepare('DELETE FROM insights WHERE id = ?').run(victim);
    const left = db.prepare('SELECT COUNT(*) AS n FROM insight_links WHERE a = ? OR b = ?')
      .get(victim, victim).n;
    assert.equal(left, 0);
    relinkAll();
  });
});

// ── ② 路由層 ──────────────────────────────────────────────────────────
describe('工單 18 — 路由層（真 express）', () => {
  let server;
  let baseUrl;
  let paperId;
  let otherPaperId;
  let questionId;
  let answerId;

  before(async () => {
    const { startServer } = await import('../src/server.js');
    await new Promise((resolve) => {
      server = startServer(0, '127.0.0.1');
      server.once('listening', () => {
        baseUrl = `http://127.0.0.1:${server.address().port}`;
        resolve();
      });
    });
    paperId = makePaper();
    otherPaperId = makePaper();
    questionId = addMessage(paperId, 'user', '為什麼高膽固醇會讓載脂蛋白富集？', 1);
    answerId = addMessage(paperId, 'assistant', '因為膽固醇改變了顆粒表面的脂質環境，載脂蛋白親和力上升。', 2);
  });

  after(() => {
    if (server) server.close();
    dropPaper(paperId);
    dropPaper(otherPaperId);
    db.prepare('DELETE FROM insight_links').run();
  });

  const post = (path, body) => fetch(`${baseUrl}/api${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  it('POST 帶合法 source_message_id → 存得進去', async () => {
    const res = await post('/insights', {
      dimension: '概念', title: '膽固醇改變脂質環境', content: '膽固醇改變脂質環境，載脂蛋白親和力上升。',
      source_paper_id: paperId, source_message_id: answerId,
    });
    const data = await res.json();
    assert.equal(res.status, 200);
    assert.equal(data.source_message_id, answerId);
  });

  it('POST 帶不存在的 id → 洞察仍然存得成，欄位留空（不 400）', async () => {
    const res = await post('/insights', {
      title: '不存在的來源', content: '這條洞察的來源訊息 id 是亂寫的。',
      source_paper_id: paperId, source_message_id: 'totally-bogus',
    });
    const data = await res.json();
    assert.equal(res.status, 200);
    assert.equal(data.source_message_id, '');
  });

  it('POST 帶別篇的訊息 id → 一樣留空', async () => {
    const res = await post('/insights', {
      title: '跨篇來源', content: '來源訊息屬於另外一篇論文。',
      source_paper_id: otherPaperId, source_message_id: answerId,
    });
    assert.equal((await res.json()).source_message_id, '');
  });

  it('GET /:id 回 source_message ＋ source_question（前端不用打第二趟）', async () => {
    const created = await (await post('/insights', {
      title: '有來源的洞察', content: '這條有來源訊息。',
      source_paper_id: paperId, source_message_id: answerId,
    })).json();

    const detail = await (await fetch(`${baseUrl}/api/insights/${created.id}`)).json();
    assert.equal(detail.source_message.id, answerId);
    assert.equal(detail.source_question.id, questionId);
    assert.ok(detail.source_message.content.includes('脂質環境'));
    assert.equal(typeof detail.link_count, 'number');
  });

  it('GET /:id 沒來源時 source_message／source_question 都是 null', async () => {
    const created = await (await post('/insights', {
      title: '沒來源的洞察', content: '這條是她手打的，沒有來源訊息。', source_paper_id: paperId,
    })).json();
    const detail = await (await fetch(`${baseUrl}/api/insights/${created.id}`)).json();
    assert.equal(detail.source_message, null);
    assert.equal(detail.source_question, null);
  });

  it('PATCH 可以改 source_message_id，亂值一樣被擋成空', async () => {
    const created = await (await post('/insights', {
      title: '待改來源', content: '先不帶來源，等下用 PATCH 補。', source_paper_id: paperId,
    })).json();

    const patch = (body) => fetch(`${baseUrl}/api/insights/${created.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });

    assert.equal((await (await patch({ source_message_id: answerId })).json()).source_message_id, answerId);
    assert.equal((await (await patch({ source_message_id: 'nope' })).json()).source_message_id, '');
  });

  it('列表帶 link_count，而且是一趟 SQL（不是每條洞察打一次）', async () => {
    // 先造一對連得上的
    await post('/insights', {
      title: '載脂蛋白運輸', content: '載脂蛋白負責運輸脂類，促進肝細胞攝取奈米顆粒。', source_paper_id: paperId,
    });
    await post('/insights', {
      title: '載脂蛋白運輸二', content: '載脂蛋白負責運輸脂類，促進奈米顆粒被肝細胞攝取。', source_paper_id: paperId,
    });

    const realPrepare = db.prepare.bind(db);
    const seen = [];
    db.prepare = (sql) => { seen.push(sql); return realPrepare(sql); };
    let list;
    try {
      list = await (await fetch(`${baseUrl}/api/insights?source_paper_id=${paperId}`)).json();
    } finally {
      db.prepare = realPrepare;
    }

    const insightQueries = seen.filter(sql => /FROM insights\b/i.test(sql));
    assert.equal(insightQueries.length, 1, `列表只該打一趟，實得 ${insightQueries.length}`);
    assert.ok(insightQueries[0].includes('LEFT JOIN'), '用 LEFT JOIN 算 link_count');
    assert.ok(list.length >= 2);
    assert.ok(list.every(i => typeof i.link_count === 'number'));
    assert.ok(list.some(i => i.link_count > 0), '那一對應該互相連上');
    assert.ok(list.every(i => 'source_paper_title' in i));
  });

  it('GET /:id/links 回相關洞察（帶維度、標題、來源論文、分數）', async () => {
    const list = await (await fetch(`${baseUrl}/api/insights?source_paper_id=${paperId}`)).json();
    const withLinks = list.find(i => i.link_count > 0);
    assert.ok(withLinks, '前一個案例應該已經造出一對');

    const links = await (await fetch(`${baseUrl}/api/insights/${withLinks.id}/links`)).json();
    assert.ok(links.length > 0);
    assert.ok(links[0].insight.id && links[0].insight.dimension && links[0].insight.title);
    assert.equal(links[0].insight.source_paper_title, PAPER_TITLE);
    assert.ok(links[0].score > 0 && links[0].score <= 1);
    assert.equal(typeof links[0].reason, 'string');
  });

  it('GET /:id/links 對不存在的洞察回 404', async () => {
    const res = await fetch(`${baseUrl}/api/insights/nope/links`);
    assert.equal(res.status, 404);
  });

  it('POST /insights/relink-all 回總數與連線數，且冪等', async () => {
    const first = await (await post('/insights/relink-all', {})).json();
    assert.equal(first.ok, true);
    assert.ok(first.total >= 2);
    const second = await (await post('/insights/relink-all', {})).json();
    assert.equal(second.links, first.links);
    assert.equal(second.total, first.total);
  });
});

// ── ② backfill ────────────────────────────────────────────────────────
describe('工單 18 A1 — 存量洞察回填（只在唯一命中時寫）', () => {
  let paperId;
  let uniqueMsg;
  let unique;
  let ambiguous;
  let missed;
  let alreadyHas;

  const UNIQUE_TEXT = '載脂蛋白在高膽固醇環境下於顆粒表面富集，這是本文最核心的觀察之一。';
  const DUP_TEXT = '這一段在對話裡出現了兩次，完全一樣，所以分不出來是哪一則。';

  before(() => {
    paperId = makePaper();
    addMessage(paperId, 'user', '問題一', 1);
    uniqueMsg = addMessage(paperId, 'assistant', UNIQUE_TEXT, 2);
    addMessage(paperId, 'assistant', DUP_TEXT, 3);
    addMessage(paperId, 'assistant', DUP_TEXT, 4);

    unique = addInsight({ paperId, title: '唯一命中', content: '唯一命中的洞察', context: `[assistant] ${UNIQUE_TEXT}` });
    ambiguous = addInsight({ paperId, title: '兩則命中', content: '兩則命中的洞察', context: `[assistant] ${DUP_TEXT}` });
    missed = addInsight({ paperId, title: '無命中', content: '無命中的洞察', context: '[assistant] 這段話對話裡根本沒有出現過，所以撈不到任何訊息。' });
    alreadyHas = addInsight({ paperId, title: '已有來源', content: '已經有來源的洞察', context: `[assistant] ${UNIQUE_TEXT}`, messageId: uniqueMsg });
  });
  after(() => dropPaper(paperId));

  const sourceOf = (id) => db.prepare('SELECT source_message_id FROM insights WHERE id = ?').get(id).source_message_id;

  it('唯一命中 → 寫回；兩則命中 → 不寫；無命中 → 不寫', () => {
    const out = backfillInsightSources();
    assert.ok(out.scanned >= 3);
    assert.equal(sourceOf(unique), uniqueMsg);
    assert.equal(sourceOf(ambiguous), '');
    assert.equal(sourceOf(missed), '');
  });

  it('已經有來源的不在候選集裡，不會被重算覆蓋', () => {
    assert.equal(sourceOf(alreadyHas), uniqueMsg);
  });

  it('冪等：再跑一次結果相同，且候選數變少（寫過的退場）', () => {
    const again = backfillInsightSources();
    assert.equal(sourceOf(unique), uniqueMsg);
    assert.equal(sourceOf(ambiguous), '');
    assert.equal(again.filled, 0, '第二輪沒有新的可填');
  });
});

// ── ② B2：為什麼相關（預設關；開啟時只打假上游）───────────────────────
describe('工單 18 B2 — 為什麼相關（mock 上游，絕不打真的）', () => {
  let upstream;
  let upstreamUrl;
  let calls;
  let mode;
  let paperId;
  let ids;

  before(async () => {
    upstream = createServer((req, res) => {
      calls++;
      if (mode === 'fail') {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('boom');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '「都在講載脂蛋白富集」' } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });
    await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
    upstreamUrl = `http://127.0.0.1:${upstream.address().port}/v1`;

    paperId = makePaper();
    ids = {
      a: addInsight({ paperId, title: '載脂蛋白運輸一', content: '載脂蛋白負責運輸脂類，促進肝細胞攝取奈米顆粒，補體蛋白則負責調理。' }),
      b: addInsight({ paperId, title: '載脂蛋白運輸二', content: '載脂蛋白負責運輸脂類，促進奈米顆粒被肝細胞攝取，補體蛋白負責免疫調理。' }),
    };
  });

  after(() => {
    if (upstream) upstream.close();
    dropPaper(paperId);
    db.prepare('DELETE FROM insight_links').run();
  });

  beforeEach(() => { calls = 0; mode = 'ok'; });

  const config = () => ({ key: 'fake', baseUrl: upstreamUrl, model: 'fake', format: 'openai' });

  it('關閉（預設）→ 一次 fetch 都不打', async () => {
    const { reasonTask } = computeInsightLinks(ids.a);
    const out = await reasonTask;
    assert.equal(out.skipped, true);
    assert.equal(out.asked, 0);
    assert.equal(calls, 0, '預設關就是零 token');
  });

  it('開啟 → 問的對數 = 新連線數，reason 寫得進去', async () => {
    const { links, reasonTask } = computeInsightLinks(ids.a, {
      reasonEnabled: true, reasonConfig: config(),
    });
    assert.ok(links.length > 0, '這兩條該連上');
    const out = await reasonTask;
    assert.equal(out.asked, links.length);
    assert.ok(out.asked <= LINK_REASON_BATCH_MAX);
    assert.equal(out.written, links.length);
    assert.equal(calls, links.length);

    const stored = listInsightLinks(ids.a);
    assert.equal(stored[0].reason, '都在講載脂蛋白富集');
  });

  it('上游失敗 → 留空、不重試（一對只打一次）', async () => {
    db.prepare('UPDATE insight_links SET reason = %s' .replace('%s', "''")).run();
    mode = 'fail';
    const out = await maybeGenerateReasons(
      [{ a: ids.a < ids.b ? ids.a : ids.b, b: ids.a < ids.b ? ids.b : ids.a }],
      { reasonEnabled: true, config: config() },
    );
    assert.equal(out.asked, 1);
    assert.equal(out.written, 0);
    assert.equal(calls, 1, '失敗不重試');
    assert.equal(listInsightLinks(ids.a)[0].reason, '');
  });

  it('一批最多 20 對（§2 B2）', async () => {
    const many = Array.from({ length: 50 }, () => ({ a: ids.a, b: ids.b }));
    const out = await maybeGenerateReasons(many, { reasonEnabled: true, config: config() });
    assert.equal(out.asked, LINK_REASON_BATCH_MAX);
    assert.ok(calls <= LINK_REASON_BATCH_MAX);
  });

  it('relink-all 重建後 reason 貼得回同一對（不白白丟掉已經花過的 token）', async () => {
    mode = 'ok';
    await maybeGenerateReasons(
      [{ a: ids.a < ids.b ? ids.a : ids.b, b: ids.a < ids.b ? ids.b : ids.a }],
      { reasonEnabled: true, config: config() },
    );
    assert.equal(listInsightLinks(ids.a)[0].reason, '都在講載脂蛋白富集');
    relinkAll();
    assert.equal(listInsightLinks(ids.a)[0].reason, '都在講載脂蛋白富集');
  });

  it('沒有 API key 又不是本機上游 → 直接跳過，不打', async () => {
    const out = await maybeGenerateReasons([{ a: ids.a, b: ids.b }], {
      reasonEnabled: true,
      config: { key: '', baseUrl: 'https://api.example.com/v1', model: 'x', format: 'openai' },
    });
    assert.equal(out.skipped, true);
    assert.equal(calls, 0);
  });

  it('reason 清洗：剝引號與「原因：」，壓到 40 字', () => {
    assert.equal(sanitizeReason('「都在講載脂蛋白」'), '都在講載脂蛋白');
    assert.equal(sanitizeReason('原因：兩者同一個機制'), '兩者同一個機制');
    assert.equal(sanitizeReason(`${'字'.repeat(90)}`).length, 40);
    assert.equal(sanitizeReason(''), '');
  });
});

// ── ③ 前端純函式 ─────────────────────────────────────────────────────
describe('工單 18 — 浮現卡的純函式（前端）', () => {
  it('來源區塊三態：有一問一答 / 只有 context / 都沒有', () => {
    const full = describeSourceBlock({
      source_message: { id: 'm1', content: '回覆內容' },
      source_question: { id: 'q1', content: '提問內容' },
      source_context: '舊的 context',
    });
    assert.equal(full.kind, 'conversation');
    assert.equal(full.answer.content, '回覆內容');
    assert.equal(full.question.content, '提問內容');

    const ctxOnly = describeSourceBlock({ source_message: null, source_context: '[assistant] 舊的 context' });
    assert.equal(ctxOnly.kind, 'context');
    assert.equal(ctxOnly.context, '[assistant] 舊的 context');

    assert.equal(describeSourceBlock({}).kind, 'none');
    assert.equal(describeSourceBlock(null).kind, 'none');
  });

  it('有訊息殼但內容是空白 → 退回 context／none（不畫一塊空白卡）', () => {
    assert.equal(describeSourceBlock({ source_message: { id: 'm', content: '   ' } }).kind, 'none');
    assert.equal(
      describeSourceBlock({ source_message: { id: 'm', content: '' }, source_context: 'x' }).kind,
      'context',
    );
  });

  it('摘錄 300 字才需要展開', () => {
    assert.deepEqual(excerpt('短短一句'), { text: '短短一句', truncated: false });
    const long = excerpt('字'.repeat(400));
    assert.equal(long.truncated, true);
    assert.equal(long.text.length, 301);   // 300 ＋ 省略號
  });

  it('分數三檔：很像／有關／略有關', () => {
    assert.equal(scoreLabel(0.9), '很像');
    assert.equal(scoreLabel(0.58), '很像');
    assert.equal(scoreLabel(0.5), '有關');
    assert.equal(scoreLabel(0.42), '有關');
    assert.equal(scoreLabel(0.36), '略有關');
    assert.equal(scoreLabel(undefined), '略有關');
  });

  it('歷史堆疊：上限 10，從最舊的那端丟；同一張不重複推', () => {
    let stack = [];
    for (let i = 0; i < 15; i++) stack = pushHistory(stack, `i${i}`);
    assert.equal(stack.length, HISTORY_MAX);
    assert.equal(stack[0], 'i5');
    assert.equal(stack[HISTORY_MAX - 1], 'i14');

    assert.deepEqual(pushHistory(['a'], 'a'), ['a']);
    assert.deepEqual(pushHistory(['a'], ''), ['a']);
  });

  it('「←」回上一張；空堆疊回 null', () => {
    assert.deepEqual(popHistory(['a', 'b']), { stack: ['a'], id: 'b' });
    assert.deepEqual(popHistory([]), { stack: [], id: null });
  });

  it('存為洞察：往前找最近的一則 user，不是 idx-1', () => {
    const msgs = [
      { id: 'u1', role: 'user' },
      { id: 'a1', role: 'assistant' },
      { id: 'a2', role: 'assistant' },
    ];
    assert.equal(previousUserMessage(msgs, 2).id, 'u1');
    assert.equal(previousUserMessage(msgs, 1).id, 'u1');
    assert.equal(previousUserMessage(msgs, 0), null);
    assert.equal(previousUserMessage(null, 3), null);
  });
});
