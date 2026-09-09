import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

process.env.CO_READING_DB_PATH = `/tmp/co-reading-ai-provider-${process.pid}.sqlite`;
const {
  buildBody, buildEndpoint, isVisionEnabled, serializeContent,
  extractAnalyzeJson, ANALYZE_MAX_TOKENS,
} = await import('../src/ai.js');
const { selectVisualPageNumbers } = await import('../src/pdf.js');

const canonical = [
  { type: 'text', text: 'read this chart' },
  { type: 'image', mediaType: 'image/png', data: 'YWJj' },
];

describe('multimodal provider serialization', () => {
  test('serializes canonical image for Anthropic Messages', () => {
    assert.deepEqual(serializeContent(canonical, 'anthropic'), [
      { type: 'text', text: 'read this chart' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'YWJj' } },
    ]);
  });

  test('serializes canonical image for OpenAI Chat Completions', () => {
    const result = serializeContent(canonical, 'openai');
    assert.equal(result[1].type, 'image_url');
    assert.equal(result[1].image_url.url, 'data:image/png;base64,YWJj');
    assert.equal(result[1].image_url.detail, 'high');
  });

  test('builds the expected wire endpoints', () => {
    assert.equal(buildEndpoint({ baseUrl: 'https://api.example/v1/', format: 'anthropic' }), 'https://api.example/v1/messages');
    assert.equal(buildEndpoint({ baseUrl: 'https://api.example/v1/', format: 'openai' }), 'https://api.example/v1/chat/completions');
  });

  test('keeps system separate in Anthropic and content parts in OpenAI', () => {
    const messages = [
      { role: 'system', content: 'system' },
      { role: 'user', content: canonical },
    ];
    const anthropic = buildBody({ model: 'claude', format: 'anthropic' }, { messages });
    assert.equal(anthropic.system, 'system');
    assert.equal(anthropic.messages[0].content[1].type, 'image');
    const openai = buildBody({ model: 'vision', format: 'openai' }, { messages });
    assert.equal(openai.messages[1].content[1].type, 'image_url');
  });

  test('preserves Anthropic cache controls on system blocks', () => {
    const body = buildBody({ model: 'claude', format: 'anthropic' }, {
      messages: [
        { role: 'system', content: [{ type: 'text', text: 'stable', cache_control: { type: 'ephemeral' } }] },
        { role: 'user', content: 'hello' },
      ],
    });
    assert.deepEqual(body.system[0].cache_control, { type: 'ephemeral' });
  });

  test('vision auto-detection is conservative', () => {
    assert.equal(isVisionEnabled({ visionMode: 'auto', model: 'deepseek-v4-flash', baseUrl: '' }), false);
    assert.equal(isVisionEnabled({ visionMode: 'auto', model: 'deepseek-v4-flash-vision-exp', baseUrl: '' }), true);
    assert.equal(isVisionEnabled({ visionMode: 'on', model: 'text-only', baseUrl: '' }), true);

    // §4.1：明確宣告壓過名字猜測。這一組是真實觸發路徑——
    // Antigravity 的 gemini-3.7-flash-low 只吃文字，卻會命中 /gemini/。
    assert.equal(
      isVisionEnabled({ visionMode: 'auto', model: 'gemini-3.7-flash-low', baseUrl: '' }),
      true,
      '名字猜測的舊行為：命中 /gemini/ 就當作看得懂圖（這正是要防的）',
    );
    assert.equal(
      isVisionEnabled({ visionMode: 'auto', model: 'gemini-3.7-flash-low', baseUrl: '', visionCapable: false }),
      false,
      'visionCapable=false 必須否決名字猜測，否則圖片會被送去 text-only provider 靜默丟失',
    );
    assert.equal(
      isVisionEnabled({ visionMode: 'auto', model: 'deepseek-v4-flash', baseUrl: '', visionCapable: true }),
      true,
      'visionCapable=true 也要能推翻猜測（名字看不出來但實際支援的 provider）',
    );
    assert.equal(
      isVisionEnabled({ visionMode: 'off', model: 'gpt-4o', baseUrl: '', visionCapable: true }),
      false,
      'visionMode 的手動 off 仍是最高優先，不被 capability 宣告推翻',
    );
    assert.equal(
      isVisionEnabled({ visionMode: 'auto', model: 'gpt-4o', baseUrl: '' }),
      true,
      '未宣告時行為完全照舊（零破壞）',
    );
  });
});

// ── 2026-09-09：OpenCode Go / 推理模型的空正文事故 ────────────────────────────
// 實測證據見 docs/work/report-analyze-slow-fail-20260909.md §A。
describe('analyze completion parsing (reasoning models)', () => {
  const openai = { format: 'openai' };

  function completion(message, finish_reason = 'stop', usage = undefined) {
    return { choices: [{ finish_reason, message }], ...(usage ? { usage } : {}) };
  }

  test('parses a normal completion out of message.content', () => {
    const result = extractAnalyzeJson(openai, completion({
      content: '{"title":"T","authors":"A","year":2025,"background":"b","methods":"m","results":"r","conclusions":"c","limitations":"l"}',
    }));
    assert.equal(result.title, 'T');
    assert.equal(result.year, 2025);
  });

  test('tolerates prose and code fences around the JSON', () => {
    const result = extractAnalyzeJson(openai, completion({
      content: '好的，結果如下：\n```json\n{"title":"T"}\n```\n以上。',
    }));
    assert.equal(result.title, 'T');
  });

  test('budget exhausted in the reasoning phase reports why instead of a blank error', () => {
    // 這就是生產事故的形狀：HTTP 200、外層 JSON 合法、content 是空字串，
    // 2000 tokens 全被思考鏈吃光。舊訊息印成「…格式不正確: 」冒號後面一片空白。
    let err;
    try {
      extractAnalyzeJson(openai, completion(
        { content: '', reasoning_content: 'Let me think about the title… ' },
        'length',
        { completion_tokens: 600, completion_tokens_details: { reasoning_tokens: 600 } },
      ));
    } catch (e) { err = e; }
    assert.ok(err, '必須拋錯');
    assert.match(err.message, /finish_reason=length/);
    assert.match(err.message, /content=0 字/);
    assert.match(err.message, /reasoning_content=/);
    assert.match(err.message, /輸出預算用盡/);
  });

  test('does NOT salvage a truncated reasoning chain, even if a draft JSON is in there', () => {
    // 截斷的思考鏈裡常躺著寫壞一半／尚未定稿的草稿 JSON，撿回來＝悄悄存下半成品摘要。
    assert.throws(
      () => extractAnalyzeJson(openai, completion(
        { content: '', reasoning_content: 'draft: {"title":"草稿，還沒核對作者"}' },
        'length',
      )),
      /finish_reason=length/,
    );
  });

  test('salvages the answer from reasoning_content when the model finished normally', () => {
    const result = extractAnalyzeJson(openai, completion(
      { content: '', reasoning_content: '{"title":"答案跑到思考欄了"}' },
      'stop',
    ));
    assert.equal(result.title, '答案跑到思考欄了');
  });

  test('surfaces a tool_calls shell as the reason for the empty body', () => {
    let err;
    try {
      extractAnalyzeJson(openai, completion(
        { content: '', tool_calls: [{ id: 'c1', function: { name: 'x' } }] },
        'tool_calls',
      ));
    } catch (e) { err = e; }
    assert.match(err.message, /tool_calls=1/);
  });

  test('anthropic truncation (stop_reason=max_tokens) is diagnosed the same way', () => {
    assert.throws(
      () => extractAnalyzeJson({ format: 'anthropic' }, {
        content: [{ type: 'text', text: '' }],
        stop_reason: 'max_tokens',
      }),
      /finish_reason=max_tokens[\s\S]*輸出預算用盡/,
    );
  });

  test('the analyze budget leaves room for a reasoning chain', () => {
    // 實測 deepseek-v4-pro 在這篇論文上光思考就燒掉 1421 tokens。
    assert.ok(ANALYZE_MAX_TOKENS >= 4000, `通讀預算 ${ANALYZE_MAX_TOKENS} 太小，思考鏈會把正文擠掉`);
  });
});

test('selectVisualPageNumbers prioritizes caption-bearing pages', () => {
  assert.deepEqual(selectVisualPageNumbers([
    'Abstract',
    'Figure 1. Cohort flow',
    'Methods',
    'Table 2 Baseline characteristics\nFigure 3. Survival',
  ], 2), [2, 4]);
});
