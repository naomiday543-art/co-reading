import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

process.env.CO_READING_DB_PATH = `/tmp/co-reading-ai-provider-${process.pid}.sqlite`;
const {
  buildBody, buildEndpoint, isVisionEnabled, serializeContent,
  extractAnalyzeJson, ANALYZE_MAX_TOKENS,
  collectStream, streamOpenAI, streamAnthropic, REQUEST_TIMEOUT_MS,
} = await import('../src/ai.js');

/** 把 SSE 文字做成一個能餵給 collectStream / streamXxx 的假 Response。 */
function sseResponse(lines) {
  const encoder = new TextEncoder();
  return {
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
  };
}
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
// 實測證據見 commit cea1c15 的訊息（分支 fix/analyze-opencode）。
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

// ── 2026-09-09：通讀改走串流（躲 OpenCode Go 的 60 秒非串流閘門） ─────────────
describe('stream collection', () => {
  test('reassembles an OpenAI stream into the non-streaming response shape', async () => {
    const collected = await collectStream({ format: 'openai' }, sseResponse([
      'data: {"choices":[{"delta":{"reasoning_content":"先想"}}]}\n',
      'data: {"choices":[{"delta":{"reasoning_content":"一下"}}]}\n',
      'data: {"choices":[{"delta":{"content":"{\\"title\\":"}}]}\n',
      // 故意把一個事件切在兩個 chunk 中間——真實串流一定會這樣切。
      'data: {"choices":[{"delta":{"content":"\\"T\\"}"}',
      '}]}\ndata: {"choices":[{"finish_reason":"stop","delta":{}}],"usage":{"completion_tokens":7}}\n',
      'data: [DONE]\n',
    ]));
    assert.equal(collected.choices[0].message.content, '{"title":"T"}');
    assert.equal(collected.choices[0].message.reasoning_content, '先想一下');
    assert.equal(collected.choices[0].finish_reason, 'stop');
    assert.deepEqual(collected.usage, { completion_tokens: 7 });
    // 重組結果必須能直接餵回同一套解析器（串流／非串流共用一份邏輯）
    assert.equal(extractAnalyzeJson({ format: 'openai' }, collected).title, 'T');
  });

  test('a stream truncated by the output budget still reports finish_reason=length', async () => {
    const collected = await collectStream({ format: 'openai' }, sseResponse([
      'data: {"choices":[{"delta":{"reasoning_content":"想到一半就沒預算了"}}]}\n',
      'data: {"choices":[{"finish_reason":"length","delta":{}}]}\n',
    ]));
    assert.equal(collected.choices[0].message.content, '');
    assert.throws(() => extractAnalyzeJson({ format: 'openai' }, collected), /finish_reason=length/);
  });

  test('reassembles an Anthropic stream, including stop_reason and thinking', async () => {
    const collected = await collectStream({ format: 'anthropic' }, sseResponse([
      'data: {"type":"message_start","message":{"usage":{"input_tokens":9}}}\n',
      'data: {"type":"content_block_delta","delta":{"thinking":"嗯"}}\n',
      'data: {"type":"content_block_delta","delta":{"text":"{\\"title\\":\\"T\\"}"}}\n',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":4}}\n',
    ]));
    assert.equal(collected.stop_reason, 'end_turn');
    assert.equal(extractAnalyzeJson({ format: 'anthropic' }, collected).title, 'T');
    assert.deepEqual(collected.usage, { input_tokens: 9, output_tokens: 4 });
  });

  test('anthropic max_tokens truncation survives the stream round-trip', async () => {
    const collected = await collectStream({ format: 'anthropic' }, sseResponse([
      'data: {"type":"content_block_delta","delta":{"thinking":"想"}}\n',
      'data: {"type":"message_delta","delta":{"stop_reason":"max_tokens"}}\n',
    ]));
    assert.throws(
      () => extractAnalyzeJson({ format: 'anthropic' }, collected),
      /finish_reason=max_tokens[\s\S]*輸出預算用盡/,
    );
  });

  // 聊天線的兩個 generator 被換到共用的 SSE 解析器上，行為必須一字不差。
  test('chat generators keep yielding only visible text after the refactor', async () => {
    const openaiChunks = [];
    for await (const c of streamOpenAI(sseResponse([
      'data: {"choices":[{"delta":{"reasoning_content":"思考不該外洩"}}]}\n',
      'data: {"choices":[{"delta":{"content":"你"}}]}\n',
      'data: {"choices":[{"delta":{"content":"好"}}]}\ndata: [DONE]\n',
      'data: {"choices":[{"delta":{"content":"這段在 DONE 之後，不該出現"}}]}\n',
    ]))) openaiChunks.push(c);
    assert.deepEqual(openaiChunks, ['你', '好']);

    const anthropicChunks = [];
    for await (const c of streamAnthropic(sseResponse([
      'data: {"type":"content_block_delta","delta":{"text":"你"}}\n',
      'data: not json\n',
      'data: {"type":"content_block_delta","delta":{"text":"好"}}\n',
    ]))) anthropicChunks.push(c);
    assert.deepEqual(anthropicChunks, ['你', '好']);
  });

  test('there is a finite request timeout', () => {
    assert.ok(Number.isFinite(REQUEST_TIMEOUT_MS) && REQUEST_TIMEOUT_MS > 0,
      'makeRequest 以前完全沒有 timeout，上游不回就永遠卡在 analyzing');
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
