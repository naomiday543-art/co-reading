import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

process.env.CO_READING_DB_PATH = `/tmp/co-reading-opencode-${process.pid}.sqlite`;
const { isOpencodeBase, opencodeSessionId, opencodeSessionHeaders } = await import('../src/opencodeSession.js');
const { buildHeaders } = await import('../src/ai.js');

const UUID5 = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('x-opencode-session header', () => {
  test('recognises opencode.ai and its subdomains only', () => {
    assert.equal(isOpencodeBase('https://opencode.ai/zen/go'), true);
    assert.equal(isOpencodeBase('https://zen.opencode.ai/v1'), true);
    assert.equal(isOpencodeBase('opencode.ai/zen/go'), true);
    assert.equal(isOpencodeBase('https://notopencode.ai/v1'), false);
    assert.equal(isOpencodeBase('https://api.openai.com/v1'), false);
    assert.equal(isOpencodeBase('https://api.anthropic.com/v1'), false);
    assert.equal(isOpencodeBase(''), false);
    assert.equal(isOpencodeBase(null), false);
    assert.equal(isOpencodeBase(undefined), false);
  });

  test('session id is deterministic, scope-distinct, and uuid-v5 shaped', () => {
    const a1 = opencodeSessionId('paper:abc');
    const a2 = opencodeSessionId('paper:abc');
    const b = opencodeSessionId('paper:xyz');
    const c = opencodeSessionId('analyze');
    assert.equal(a1, a2);
    assert.notEqual(a1, b);
    assert.notEqual(a1, c);
    for (const id of [a1, b, c]) assert.match(id, UUID5);
  });

  test('header fragment is empty for non-opencode bases', () => {
    assert.deepEqual(opencodeSessionHeaders('https://api.openai.com/v1', 'paper:1'), {});
    assert.deepEqual(opencodeSessionHeaders(undefined, 'paper:1'), {});
    const h = opencodeSessionHeaders('https://opencode.ai/zen/go', 'paper:1');
    assert.match(h['x-opencode-session'], UUID5);
  });

  test('buildHeaders adds x-opencode-session only when base is opencode (openai format)', () => {
    const on = buildHeaders({ key: 'k', format: 'openai', baseUrl: 'https://opencode.ai/zen/go', scope: 'paper:p1' });
    assert.equal(on.Authorization, 'Bearer k');
    assert.match(on['x-opencode-session'], UUID5);

    const off = buildHeaders({ key: 'k', format: 'openai', baseUrl: 'https://api.openai.com/v1', scope: 'paper:p1' });
    assert.equal(off.Authorization, 'Bearer k');
    assert.equal('x-opencode-session' in off, false);
  });

  test('buildHeaders keeps anthropic wire headers and still adds the session on opencode', () => {
    const h = buildHeaders({ key: 'k', format: 'anthropic', baseUrl: 'https://opencode.ai/zen/go', scope: 'analyze' });
    assert.equal(h['x-api-key'], 'k');
    assert.equal(h['anthropic-version'], '2023-06-01');
    assert.match(h['x-opencode-session'], UUID5);
    const plain = buildHeaders({ key: 'k', format: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', scope: 'analyze' });
    assert.equal('x-opencode-session' in plain, false);
  });

  test('same paper scope yields the same id across calls; missing scope falls back to chat', () => {
    const base = 'https://opencode.ai/zen/go';
    assert.equal(
      buildHeaders({ key: 'k', format: 'openai', baseUrl: base, scope: 'paper:same' })['x-opencode-session'],
      buildHeaders({ key: 'k', format: 'openai', baseUrl: base, scope: 'paper:same' })['x-opencode-session'],
    );
    assert.equal(
      buildHeaders({ key: 'k', format: 'openai', baseUrl: base })['x-opencode-session'],
      opencodeSessionId('chat'),
    );
  });
});
