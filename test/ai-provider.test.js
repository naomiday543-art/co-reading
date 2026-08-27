import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

process.env.CO_READING_DB_PATH = `/tmp/co-reading-ai-provider-${process.pid}.sqlite`;
const { buildBody, buildEndpoint, isVisionEnabled, serializeContent } = await import('../src/ai.js');
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
