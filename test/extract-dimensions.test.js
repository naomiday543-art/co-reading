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
import { nanoid } from 'nanoid';

import db, { setSetting } from '../src/db.js';
import { extractInsights, EXTRACT_MAX_TOKENS, EXTRACT_PROMPT } from '../src/memory.js';

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
