// 工單 08：提取線收口——傳輸層接回 ai.js（含 x-opencode-session 現役 bug 的回歸線）、
// 六維度直出、【已有洞察】區塊、落庫前去重。
//
// 紅線（工單 §5）：
//   H1  指向 opencode.ai 的 base URL 時提取請求**帶** x-opencode-session
//   H2  非 opencode base **不帶**
//   H3  body 是 stream:true
// 全部走 mock fetch（覆寫 globalThis.fetch），不打真上游、不碰她的 DB。
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { nanoid } from 'nanoid';

import db, { setSetting } from '../src/db.js';
import {
  extractInsights,
  buildExtractSystem,
  renderExistingInsightsBlock,
  EXTRACT_MAX_TOKENS,
  EXTRACT_PROMPT,
} from '../src/memory.js';

// ── mock 上游 ───────────────────────────────────────────────────────

/** 把 SSE 文字做成能餵給 collectStream 的假 Response（抄 test/ai-provider.test.js）。 */
function sseResponse(lines) {
  const encoder = new TextEncoder();
  return {
    ok: true,
    status: 200,
    body: {
      getReader() {
        let i = 0;
        return {
          read: async () => (i < lines.length
            ? { done: false, value: encoder.encode(lines[i++]) }
            : { done: true, value: undefined }),
        };
      },
    },
    text: async () => lines.join(''),
  };
}

const chunk = (obj) => `data: ${JSON.stringify(obj)}\n\n`;

/** OpenAI 形狀：一串 content 片段 + 一個收尾事件。 */
function openaiStream(parts, { finishReason = 'stop', reasoning = '' } = {}) {
  const lines = [];
  if (reasoning) lines.push(chunk({ choices: [{ delta: { reasoning_content: reasoning } }] }));
  for (const p of parts) lines.push(chunk({ choices: [{ delta: { content: p } }] }));
  lines.push(chunk({ choices: [{ delta: {}, finish_reason: finishReason }] }));
  lines.push('data: [DONE]\n\n');
  return sseResponse(lines);
}

const captured = [];
let nextResponse = null;
const realFetch = globalThis.fetch;

function installFetch() {
  globalThis.fetch = async (url, opts = {}) => {
    captured.push({
      url: String(url),
      headers: opts.headers || {},
      body: JSON.parse(opts.body || '{}'),
    });
    if (typeof nextResponse === 'function') return nextResponse();
    return nextResponse ?? openaiStream(['{"entries":[]}']);
  };
}

function restoreFetch() {
  globalThis.fetch = realFetch;
}

// ── 臨時資料 ────────────────────────────────────────────────────────

const paperIds = [];

function addPaper({ id = `ext_${nanoid(8)}`, title = 'Extract paper', treeNodeId = null } = {}) {
  db.prepare(`INSERT INTO papers (id, title, full_text, tree_node_id,
      summary_bg, summary_methods, summary_results, summary_conclusions, summary_limitations)
    VALUES (?, ?, 'FULLTEXT', ?, '', '', '', '', '')`).run(id, title, treeNodeId);
  paperIds.push(id);
  return id;
}

function addMessages(paperId, n = 2) {
  for (let i = 0; i < n; i++) {
    db.prepare('INSERT INTO messages (id, paper_id, role, content, seq) VALUES (?, ?, ?, ?, ?)')
      .run(nanoid(), paperId, i % 2 === 0 ? 'user' : 'assistant', `第 ${i} 句討論內容`, i);
  }
}

function clearAll() {
  for (const id of paperIds.splice(0)) {
    db.prepare('DELETE FROM insights WHERE source_paper_id = ?').run(id);
    db.prepare('DELETE FROM messages WHERE paper_id = ?').run(id);
    db.prepare('DELETE FROM papers WHERE id = ?').run(id);
  }
}

function useBase(baseUrl, format = 'openai') {
  setSetting('ai_base_url', baseUrl);
  setSetting('ai_format', format);
  setSetting('ai_model', 'fake-model');
  setSetting('ai_api_key', 'fake-key');
}

// ── H：傳輸層（現役 bug 的回歸線）────────────────────────────────────

describe('H 提取請求的傳輸層（接回 ai.js）', () => {
  before(installFetch);
  after(() => { restoreFetch(); clearAll(); });
  beforeEach(() => { captured.length = 0; nextResponse = null; });

  it('H1 base URL 指向 opencode.ai：帶 x-opencode-session（UUID 形狀）', async () => {
    useBase('https://opencode.ai/zen/v1');
    const paperId = addPaper();
    addMessages(paperId);

    await extractInsights(paperId);

    assert.equal(captured.length, 1);
    const session = captured[0].headers['x-opencode-session'];
    assert.ok(session, JSON.stringify(captured[0].headers));
    assert.match(session, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(captured[0].url, 'https://opencode.ai/zen/v1/chat/completions');
    clearAll();
  });

  it('H1b scope 固定 extract：同一個值不隨論文改變', async () => {
    useBase('https://opencode.ai/zen/v1');
    const a = addPaper();
    addMessages(a);
    const b = addPaper();
    addMessages(b);

    await extractInsights(a);
    await extractInsights(b);

    assert.equal(captured.length, 2);
    assert.equal(
      captured[0].headers['x-opencode-session'],
      captured[1].headers['x-opencode-session'],
      'scope 必須固定 extract，不按論文分桶',
    );
    clearAll();
  });

  it('H2 非 opencode base：不帶 x-opencode-session', async () => {
    useBase('https://api.openai.com/v1');
    const paperId = addPaper();
    addMessages(paperId);

    await extractInsights(paperId);

    assert.equal(captured.length, 1);
    assert.equal('x-opencode-session' in captured[0].headers, false, JSON.stringify(captured[0].headers));
    assert.equal(captured[0].headers.Authorization, 'Bearer fake-key');
    clearAll();
  });

  it('H3 body：stream:true、max_tokens=EXTRACT_MAX_TOKENS、temperature:0.1', async () => {
    useBase('https://api.openai.com/v1');
    const paperId = addPaper();
    addMessages(paperId);

    await extractInsights(paperId);

    const body = captured[0].body;
    assert.equal(body.stream, true);
    assert.equal(body.max_tokens, EXTRACT_MAX_TOKENS);
    assert.equal(EXTRACT_MAX_TOKENS, 4000, '預設預算 4000（給思考鏈留位）');
    assert.equal(body.temperature, 0.1);
    assert.equal(body.model, 'fake-model');
    clearAll();
  });

  it('H3b anthropic 形狀：system 抽成頂層欄位、stream:true 照樣帶', async () => {
    useBase('https://api.anthropic.com/v1', 'anthropic');
    const paperId = addPaper();
    addMessages(paperId);
    nextResponse = () => sseResponse([
      'data: {"type":"content_block_delta","delta":{"text":"{\\"entries\\":[]}"}}\n\n',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
      'data: [DONE]\n\n',
    ]);

    await extractInsights(paperId);

    const body = captured[0].body;
    assert.equal(captured[0].url, 'https://api.anthropic.com/v1/messages');
    assert.equal(body.stream, true);
    assert.ok(typeof body.system === 'string' && body.system.includes('科研記憶提取助手'));
    assert.equal(body.messages.length, 1);
    assert.equal(captured[0].headers['x-api-key'], 'fake-key');
    clearAll();
  });
});

// ── S：串流重組與空正文診斷 ─────────────────────────────────────────

describe('S 串流重組與空正文診斷', () => {
  before(installFetch);
  after(() => { restoreFetch(); clearAll(); });
  beforeEach(() => { captured.length = 0; nextResponse = null; useBase('https://api.openai.com/v1'); });

  it('S1 兩段 content 的串流 → 完整 JSON 被解析', async () => {
    const paperId = addPaper();
    addMessages(paperId);
    nextResponse = () => openaiStream([
      '{"entries":[{"type":"fact","dimension":"概念","content":"膽固醇改變蛋白冠的組成"',
      '}]}',
    ]);

    const result = await extractInsights(paperId);

    assert.equal(result.insights.length, 1);
    assert.equal(result.insights[0].content, '膽固醇改變蛋白冠的組成');
    clearAll();
  });

  it('S2 finish_reason=length、content 空 → 拋錯含「輸出預算用盡」', async () => {
    const paperId = addPaper();
    addMessages(paperId);
    nextResponse = () => openaiStream([], { finishReason: 'length', reasoning: '我先想想{也許是這樣}' });

    await assert.rejects(() => extractInsights(paperId), (err) => {
      assert.match(err.message, /輸出預算用盡（調高 EXTRACT_MAX_TOKENS）/);
      assert.match(err.message, /finish_reason=length/);
      return true;
    });
    clearAll();
  });

  it('S3 finish_reason=stop、content 空、reasoning 含 JSON → 從 reasoning 搶救', async () => {
    const paperId = addPaper();
    addMessages(paperId);
    nextResponse = () => openaiStream([], {
      finishReason: 'stop',
      reasoning: '想一下……{"entries":[{"type":"hypothesis","dimension":"悬题","content":"血清是否代表循環環境，待驗證"}]}',
    });

    const result = await extractInsights(paperId);

    assert.equal(result.insights.length, 1);
    assert.equal(result.insights[0].dimension, '悬题');
    clearAll();
  });

  it('S3b 截斷的 reasoning 不救（寧可報錯也不要半成品）', async () => {
    const paperId = addPaper();
    addMessages(paperId);
    nextResponse = () => openaiStream([], {
      finishReason: 'length',
      reasoning: '{"entries":[{"type":"fact","content":"寫壞一半的草稿"}]}',
    });

    await assert.rejects(() => extractInsights(paperId), /輸出預算用盡/);
    clearAll();
  });
});

// ── P：六維度直出與解析 ─────────────────────────────────────────────

describe('P 六維度直出', () => {
  before(installFetch);
  after(() => { restoreFetch(); clearAll(); });
  beforeEach(() => { captured.length = 0; nextResponse = null; useBase('https://api.openai.com/v1'); });

  it('P1 六種 dimension 各一條 → 各自照模型說的入庫', async () => {
    const paperId = addPaper();
    addMessages(paperId);
    const entries = [
      { type: 'fact', dimension: '概念', content: '膽固醇會改變奈米粒子表面蛋白冠的組成' },
      { type: 'hypothesis', dimension: '悬题', content: '靜態血清是否代表循環環境，尚未有人驗證' },
      { type: 'fact', dimension: '你的研究', content: '她的奈米塑膠方向可以直接沿用這套蛋白冠定量流程' },
      { type: 'fact', dimension: '延伸', content: '這套方法搬到 py-GCMS 那個方向可以拿來做前處理回收率' },
      { type: 'fact', dimension: '闪回', content: '想起 Tang 2023 那篇用的是人血清而不是小鼠血清' },
      { type: 'hypothesis', dimension: '共振', content: '與另一篇說蛋白冠穩定的結論互相打架，矛盾先保留' },
    ];
    nextResponse = () => openaiStream([JSON.stringify({ entries })]);

    const result = await extractInsights(paperId);

    assert.equal(result.insights.length, 6);
    assert.deepEqual(
      result.insights.map(i => i.dimension),
      ['概念', '悬题', '你的研究', '延伸', '闪回', '共振'],
    );
    const rows = db.prepare('SELECT dimension FROM insights WHERE source_paper_id = ?')
      .all(paperId).map(r => r.dimension);
    assert.equal(rows.length, 6);
    assert.deepEqual(new Set(rows), new Set(['概念', '悬题', '你的研究', '延伸', '闪回', '共振']));
    clearAll();
  });

  it('P2 非法維度 → 依 type 兜底成「悬题」並留 WARN', async () => {
    const paperId = addPaper();
    addMessages(paperId);
    nextResponse = () => openaiStream([JSON.stringify({
      entries: [{ type: 'hypothesis', dimension: 'foo', content: '蛋白冠的動態交換速率可能決定生物分佈，待驗證' }],
    })]);

    const originalLog = console.log;
    const lines = [];
    console.log = (...args) => { lines.push(args.join(' ')); };
    let result;
    try {
      result = await extractInsights(paperId);
    } finally {
      console.log = originalLog;
    }

    assert.equal(result.insights.length, 1);
    assert.equal(result.insights[0].dimension, '悬题');
    const warn = lines.find(l => l.includes('非法維度'));
    assert.ok(warn, lines.join('\n'));
    assert.match(warn, /\[WARN\]/);
    assert.match(warn, /"foo"/);
    assert.match(warn, /兜底 \[悬题\]/);
    clearAll();
  });

  it('P2b 缺 dimension 欄位 → fact 兜底成「概念」', async () => {
    const paperId = addPaper();
    addMessages(paperId);
    nextResponse = () => openaiStream([JSON.stringify({
      entries: [{ type: 'fact', content: '蛋白冠組成決定奈米粒子被哪一類細胞吞掉' }],
    })]);

    const result = await extractInsights(paperId);

    assert.equal(result.insights.length, 1);
    assert.equal(result.insights[0].dimension, '概念');
    clearAll();
  });

  it('P3 progress 不入庫、skipped + 1', async () => {
    const paperId = addPaper();
    addMessages(paperId);
    nextResponse = () => openaiStream([JSON.stringify({
      entries: [
        { type: 'progress', dimension: '你的研究', content: '已讀完這篇，下一步整理蛋白冠定量的方法表' },
        { type: 'fact', dimension: '概念', content: '血清濃度會改變蛋白冠的厚度' },
      ],
    })]);

    const result = await extractInsights(paperId);

    assert.equal(result.insights.length, 1);
    assert.equal(result.skipped, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM insights WHERE source_paper_id = ?').get(paperId).n, 1);
    clearAll();
  });

  it('P4 prompt 本體：六個維度與輸出格式都帶 dimension', () => {
    for (const d of ['概念', '延伸', '你的研究', '闪回', '共振', '悬题']) {
      assert.ok(EXTRACT_PROMPT.includes(`**${d}**`), d);
    }
    assert.ok(EXTRACT_PROMPT.includes('### 維度（dimension）——每條必填，六選一'));
    assert.ok(EXTRACT_PROMPT.includes('{"type": "fact", "dimension": "概念", "content": "..."}'));
    // gateway 契約的三 type 不得消失
    for (const t of ['**fact**', '**hypothesis**', '**progress**']) {
      assert.ok(EXTRACT_PROMPT.includes(t), t);
    }
  });
});

// ── B：提取 system 的三段組裝（零回歸線在這裡）──────────────────────

describe('B 提取 system 的組裝', () => {
  after(clearAll);

  function addInsight(paperId, { dimension = '概念', content = '一條既有洞察的內容' } = {}) {
    const id = `ins_${nanoid(8)}`;
    db.prepare(`INSERT INTO insights (id, dimension, title, content, source_paper_id, source_context, tags_json)
      VALUES (?, ?, ?, ?, ?, '', '[]')`).run(id, dimension, content.slice(0, 80), content, paperId);
    return id;
  }

  function addNode(name, { description = '', sortOrder = 0 } = {}) {
    const id = `ext_node_${nanoid(8)}`;
    db.prepare('INSERT INTO tree_nodes (id, parent_id, name, sort_order, description) VALUES (?, NULL, ?, ?, ?)')
      .run(id, name, sortOrder, description);
    return id;
  }

  function clearNodes() {
    db.prepare("DELETE FROM tree_nodes WHERE id LIKE 'ext_node_%'").run();
  }

  it('B1 無方向且無洞察：逐字等於 EXTRACT_PROMPT（零回歸線）', () => {
    clearAll();
    clearNodes();
    const paperId = addPaper();

    assert.equal(buildExtractSystem(paperId), EXTRACT_PROMPT);
    assert.equal(buildExtractSystem(paperId).slice(EXTRACT_PROMPT.length), '', '一個換行都不得多');
    clearAll();
  });

  it('B1b 無方向但有洞察：加「這兩個維度不要用」補句，且排在已有洞察之前', () => {
    clearAll();
    clearNodes();
    const paperId = addPaper();
    addInsight(paperId, { content: '膽固醇改變蛋白冠組成' });

    const system = buildExtractSystem(paperId);
    assert.ok(system.startsWith(EXTRACT_PROMPT), '提取 prompt 必須在最前面');
    // 注意：EXTRACT_PROMPT 本身就寫著「見【她的研究方向】」「見【已有洞察】」，
    // 所以「有沒有注入區塊」只能看接在後面的那一段（tail），不能看整個 system。
    const tail = system.slice(EXTRACT_PROMPT.length);
    assert.ok(tail.includes('這兩個維度不要用'), tail);
    assert.ok(!tail.includes('【她的研究方向】'), tail);
    assert.ok(
      tail.indexOf('這兩個維度不要用') < tail.indexOf('【已有洞察】'),
      '補句要排在【已有洞察】之前',
    );
    clearAll();
  });

  it('B2 有方向：不加補句、含方向區塊，三段順序是 prompt → 方向 → 已有洞察', () => {
    clearAll();
    clearNodes();
    const nodeId = addNode('nano plastics', { description: '奈米塑膠在血液中的分佈', sortOrder: 1 });
    const paperId = addPaper({ treeNodeId: nodeId });
    addInsight(paperId, { content: '膽固醇改變蛋白冠組成' });

    const system = buildExtractSystem(paperId);
    assert.ok(system.startsWith(EXTRACT_PROMPT));
    const tail = system.slice(EXTRACT_PROMPT.length);
    assert.ok(!tail.includes('這兩個維度不要用'), '有方向就不得出現補句');
    assert.ok(tail.includes('【她的研究方向】'), tail);
    assert.ok(
      tail.indexOf('【她的研究方向】') < tail.indexOf('【已有洞察】'),
      '方向在已有洞察之前',
    );
    clearAll();
    clearNodes();
  });

  it('B2b 有方向但無洞察：只接方向區塊，不帶【已有洞察】', () => {
    clearAll();
    clearNodes();
    const nodeId = addNode('nano plastics', { description: '奈米塑膠', sortOrder: 1 });
    const paperId = addPaper({ treeNodeId: nodeId });

    const system = buildExtractSystem(paperId);
    const tail = system.slice(EXTRACT_PROMPT.length);
    assert.ok(tail.includes('【她的研究方向】'), tail);
    assert.ok(!tail.includes('【已有洞察】'), tail);
    assert.ok(!tail.includes('這兩個維度不要用'), tail);
    clearAll();
    clearNodes();
  });

  it('B3 已有洞察區塊：本篇條目 ≤30、其他論文帶書名號標題、各截 120 字', () => {
    clearAll();
    clearNodes();
    const paperId = addPaper({ title: '本篇 Cholesterol corona' });
    const otherId = addPaper({ title: 'Nanoplastic corona 另一篇' });

    const longContent = '蛋白冠'.repeat(60); // 180 字
    for (let i = 0; i < 35; i++) {
      addInsight(paperId, { dimension: i === 0 ? '悬题' : '概念', content: `${longContent}#${i}` });
    }
    // 其他論文：標題要撈得到才會被 findRelatedInsights 拉進來
    addInsight(otherId, { dimension: '共振', content: '本篇 Cholesterol corona 這個說法與我們的結果呼應' });

    const block = renderExistingInsightsBlock(paperId);

    assert.ok(block.startsWith('【已有洞察】'));
    assert.ok(block.includes('本篇已提取（不要重複提取語義相同的條目）：'));

    const ownLines = block.split('\n').filter(l => l.startsWith('- [') );
    assert.equal(ownLines.length, 30, '本篇上限 30 條');
    for (const line of ownLines) {
      const content = line.replace(/^- \[[^\]]+\] /, '');
      assert.equal(content.length, 121, `120 字 + 省略號: ${content.length}`);
      assert.ok(content.endsWith('…'));
    }

    assert.ok(block.includes('來自其他論文（判斷「闪回」「共振」時引用；每條前面標了論文標題）：'), block);
    const otherLines = block.split('\n').filter(l => l.startsWith('- 《'));
    assert.equal(otherLines.length, 1, block);
    assert.match(otherLines[0], /^- 《Nanoplastic corona 另一篇》\[共振\] /);

    // 區塊真的上了飛機（不只是函式回傳字串）
    const system = buildExtractSystem(paperId);
    assert.ok(system.includes(block));
    clearAll();
  });

  it('B3c 區塊組裝失敗時退回「什麼都不注入」，不讓提取掛掉', () => {
    clearAll();
    clearNodes();
    const paperId = addPaper();
    const realPrepare = db.prepare;
    db.prepare = (sql) => {
      if (sql.includes('FROM insights WHERE source_paper_id = ? ORDER BY created_at')) {
        throw new Error('boom');
      }
      return realPrepare.call(db, sql);
    };
    try {
      assert.equal(renderExistingInsightsBlock(paperId), '');
      assert.equal(buildExtractSystem(paperId), EXTRACT_PROMPT);
    } finally {
      db.prepare = realPrepare;
    }
    clearAll();
  });

  it('B3b 只有其他論文有洞察時也成立（本篇段整段省略）', () => {
    clearAll();
    clearNodes();
    const paperId = addPaper({ title: '本篇 Unique corona marker' });
    const otherId = addPaper({ title: '別篇' });
    addInsight(otherId, { dimension: '概念', content: '本篇 Unique corona marker 的方法我們也用過' });

    const block = renderExistingInsightsBlock(paperId);
    assert.ok(block.startsWith('【已有洞察】'));
    assert.ok(!block.includes('本篇已提取'));
    assert.ok(block.includes('- 《別篇》[概念]'));
    clearAll();
  });
});

// ── D：落庫前去重（第二道閘）─────────────────────────────────────────

describe('D 落庫前去重', () => {
  before(installFetch);
  after(() => { restoreFetch(); clearAll(); });
  beforeEach(() => { captured.length = 0; nextResponse = null; useBase('https://api.openai.com/v1'); });

  const BASE = '膽固醇會改變奈米粒子表面蛋白冠的組成';

  function addInsight(paperId, content, dimension = '概念') {
    const id = `ins_${nanoid(8)}`;
    db.prepare(`INSERT INTO insights (id, dimension, title, content, source_paper_id, source_context, tags_json)
      VALUES (?, ?, ?, ?, ?, '', '[]')`).run(id, dimension, content.slice(0, 80), content, paperId);
    return id;
  }

  function respondWith(entries) {
    nextResponse = () => openaiStream([JSON.stringify({ entries })]);
  }

  /** 跑一次提取並把 log 行收下來（[DEDUP] 要驗）。 */
  async function extractCapturingLogs(paperId) {
    const originalLog = console.log;
    const lines = [];
    console.log = (...args) => { lines.push(args.join(' ')); };
    try {
      const result = await extractInsights(paperId);
      return { result, lines };
    } finally {
      console.log = originalLog;
    }
  }

  it('D1 exact（只差標點）→ 不 INSERT、duplicates+1、不出海', async () => {
    const paperId = addPaper();
    addMessages(paperId);
    const existingId = addInsight(paperId, BASE);
    respondWith([{ type: 'fact', dimension: '概念', content: '膽固醇，會改變奈米粒子表面蛋白冠的組成。' }]);

    const { result, lines } = await extractCapturingLogs(paperId);

    assert.equal(result.insights.length, 0);
    assert.equal(result.duplicates, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM insights WHERE source_paper_id = ?').get(paperId).n, 1);
    const dedupLine = lines.find(l => l.includes('[DEDUP]'));
    assert.ok(dedupLine, lines.join('\n'));
    assert.match(dedupLine, /kind=exact/);
    assert.match(dedupLine, new RegExp(`vs=${existingId}`));
    // 不出海：synced_at 只可能是那條既有的（本來就沒同步），沒有新 row 被建出來
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM insights WHERE id != ? AND source_paper_id = ?')
      .get(existingId, paperId).n, 0);
    clearAll();
  });

  it('D2 near ≥0.6 → 不 INSERT，log 帶 score 與閾值', async () => {
    const paperId = addPaper();
    addMessages(paperId);
    addInsight(paperId, BASE);
    respondWith([{ type: 'fact', dimension: '概念', content: '膽固醇改變了奈米粒子表面蛋白冠的組成' }]);

    const { result, lines } = await extractCapturingLogs(paperId);

    assert.equal(result.insights.length, 0);
    assert.equal(result.duplicates, 1);
    const dedupLine = lines.find(l => l.includes('[DEDUP]'));
    assert.ok(dedupLine, lines.join('\n'));
    assert.match(dedupLine, /kind=near/);
    assert.match(dedupLine, /score=0\.\d\d/);
    assert.match(dedupLine, /threshold=0\.6/);
    clearAll();
  });

  it('D3 0.46（同主題不同陳述）→ 照常 INSERT', async () => {
    const paperId = addPaper();
    addMessages(paperId);
    addInsight(paperId, BASE);
    const fresh = '膽固醇也會改變奈米粒子表面的蛋白吸附量';
    respondWith([{ type: 'fact', dimension: '概念', content: fresh }]);

    const result = await extractInsights(paperId);

    assert.equal(result.insights.length, 1);
    assert.equal(result.duplicates, 0);
    assert.equal(result.insights[0].content, fresh);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM insights WHERE source_paper_id = ?').get(paperId).n, 2);
    clearAll();
  });

  it('D4 同一輪回應內兩條近似 → 只入第一條', async () => {
    const paperId = addPaper();
    addMessages(paperId);
    respondWith([
      { type: 'fact', dimension: '概念', content: BASE },
      { type: 'fact', dimension: '概念', content: '膽固醇改變了奈米粒子表面蛋白冠的組成' },
      { type: 'hypothesis', dimension: '悬题', content: '靜態血清是否代表循環環境，尚未有人驗證' },
    ]);

    const { result, lines } = await extractCapturingLogs(paperId);

    assert.equal(result.insights.length, 2);
    assert.equal(result.duplicates, 1);
    assert.deepEqual(result.insights.map(i => i.content), [BASE, '靜態血清是否代表循環環境，尚未有人驗證']);
    // 同輪互重的 vs= 指向這一輪剛收下的那條
    const dedupLine = lines.find(l => l.includes('[DEDUP]'));
    assert.match(dedupLine, new RegExp(`vs=${result.insights[0].id}`));
    clearAll();
  });

  it('D5 與「其他論文」的洞察幾乎一樣 → 仍 INSERT（那是共振的材料，不是重複）', async () => {
    const paperId = addPaper({ title: '本篇' });
    const otherId = addPaper({ title: '別篇' });
    addMessages(paperId);
    addInsight(otherId, BASE, '共振');
    respondWith([{ type: 'fact', dimension: '共振', content: BASE }]);

    const result = await extractInsights(paperId);

    assert.equal(result.duplicates, 0);
    assert.equal(result.insights.length, 1);
    assert.equal(result.insights[0].dimension, '共振');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM insights WHERE source_paper_id = ?').get(paperId).n, 1);
    clearAll();
  });

  it('D6 對同一篇按第二次提取（模型吐一樣的東西）→ 0 條新增（附錄 A 的驗收形狀）', async () => {
    const paperId = addPaper();
    addMessages(paperId);
    const entries = [
      { type: 'fact', dimension: '概念', content: BASE },
      { type: 'hypothesis', dimension: '悬题', content: '靜態血清是否代表循環環境，尚未有人驗證' },
    ];
    respondWith(entries);
    const first = await extractInsights(paperId);
    assert.equal(first.insights.length, 2);

    respondWith(entries);
    const second = await extractInsights(paperId);

    assert.equal(second.insights.length, 0);
    assert.equal(second.duplicates, 2);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM insights WHERE source_paper_id = ?').get(paperId).n, 2);
    clearAll();
  });

  it('D7 回傳形狀：沒東西可提取時三個欄位都在', async () => {
    const paperId = addPaper();
    addMessages(paperId);
    respondWith([]);

    const result = await extractInsights(paperId);
    assert.deepEqual(result, { insights: [], skipped: 0, duplicates: 0 });

    // 對話不足 2 條那條路也一樣
    const lonely = addPaper();
    assert.deepEqual(await extractInsights(lonely), { insights: [], skipped: 0, duplicates: 0 });
    clearAll();
  });
});

// ── F：前端文案（工單 08 §3.5）───────────────────────────────────────
// 這裡沒有 jsdom／react-testing-library，而工單 §4 不准裝套件、也不准新增前端模組，
// 所以 F1 釘的是 ChatPanel.jsx 裡那段組字邏輯的**原文**：三段文案各自帶 >0 的守門，
// 加上「三段都 0 也要有一句回音」。真正的畫面以 vite 起站親看（報告 §F1）。

describe('F 前端提取結果文案', () => {
  const source = readFileSync(
    new URL('../frontend/src/components/ChatPanel.jsx', import.meta.url),
    'utf-8',
  );

  it('F1 三段文案與各自的 >0 守門都在', () => {
    assert.ok(source.includes('extractResult.insights.length > 0 && `新增 ${extractResult.insights.length} 條洞察`'), '新增段');
    assert.ok(source.includes('extractResult.skipped > 0 && `${extractResult.skipped} 條進度已跳過`'), '進度段');
    assert.ok(
      source.includes('extractResult.duplicates > 0 && `${extractResult.duplicates} 條與既有洞察重複已略過`'),
      '重複段（工單 §3.5 新增的那一條）',
    );
  });

  it('F1b 三段都 0 時有回音，不是一片空白', () => {
    assert.ok(source.includes(".filter(Boolean).join('；') || '沒有新的洞察'"), source.match(/filter\(Boolean\)[^\n]*/)?.[0]);
  });

  it('F1c 舊的無條件「新增 N 條洞察」寫法已經拿掉', () => {
    assert.ok(!source.includes('新增 {extractResult.insights.length} 條洞察'));
  });
});
