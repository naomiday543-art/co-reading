// 工單 17 §4.6：設定頁「進階設定」的儲存。
//
// 病的形狀（她 9/14 13:40 親身踩到）：`saveSettings` 拿**摺疊狀態**當判斷——
// 進階區塊關著（或她按完儲存才收起來）時，analyze_* 六個欄位一律用 preset 預設覆蓋，
// 所以她把「圖表／識圖」改成 off、按上面那顆儲存，DB 裡又變回 opencode_go preset 的 'on'。
//
// frontend/src/store.js 是純 JS（zustand），node 直接 import 得動；payload 的組法與
// 「有沒有開進階」的推定都抽成純函式，不必開瀏覽器就釘得住（同 compare-frontend 的做法）。
// 版面與互動另有實彈驗收。
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.CO_READING_DB_PATH = `/tmp/co-reading-settings-advanced-${process.pid}.sqlite`;

import {
  useStore,
  getProviderDefaults,
  buildSettingsPayload,
  inferAdvancedEnabled,
  publicSettingsSummary,
  ADVANCED_ENABLED_KEY,
} from '../frontend/src/store.js';

/** 她現在這台機器的形狀：OpenCode Go，討論線 flash、通讀線 pro、視覺自己關掉。 */
const HERS = {
  chatFormat: 'openai',
  chatBaseUrl: 'https://opencode.ai/zen/go/v1',
  chatModel: 'deepseek-v4-flash',
  analyzeFormat: 'openai',
  analyzeBaseUrl: 'https://opencode.ai/zen/go/v1',
  analyzeApiKey: '',
  analyzeModel: 'deepseek-v4-pro',
  analyzeVisionModel: '',
  analyzeVisionMode: 'off',
};

describe('buildSettingsPayload：進階值只看 advancedEnabled，不看摺疊狀態', () => {
  it('advancedEnabled=true ⇒ 寫她填的值（摺疊與否都一樣）', () => {
    const payload = buildSettingsPayload({
      provider: 'opencode_go', apiKey: 'sk-test', advancedEnabled: true, advanced: HERS,
    });

    assert.equal(payload.ai_model, 'deepseek-v4-flash');
    assert.equal(payload.analyze_model, 'deepseek-v4-pro');
    assert.equal(payload.analyze_format, 'openai');
    assert.equal(payload.analyze_base_url, 'https://opencode.ai/zen/go/v1');
    assert.equal(payload.advanced_enabled, 'true');
  });

  it('🔴 這次的病：視覺模式 off 不會再被 preset 的 on 蓋回去', () => {
    assert.equal(getProviderDefaults('opencode_go').vision_mode, 'on', 'preset 的值不動（§3 紅線）');

    const payload = buildSettingsPayload({
      provider: 'opencode_go', apiKey: 'sk-test', advancedEnabled: true, advanced: HERS,
    });

    assert.equal(payload.analyze_vision_mode, 'off', '她選 off 就是 off');
  });

  it('advancedEnabled=false ⇒ 回 preset 預設（這是她自己按的開關，UI 上有寫）', () => {
    const defaults = getProviderDefaults('opencode_go');
    const payload = buildSettingsPayload({
      provider: 'opencode_go', apiKey: 'sk-test', advancedEnabled: false, advanced: HERS,
    });

    assert.equal(payload.ai_model, defaults.model);
    assert.equal(payload.ai_base_url, defaults.base_url);
    assert.equal(payload.analyze_model, defaults.analyze_model);
    assert.equal(payload.analyze_vision_mode, defaults.vision_mode);
    assert.equal(payload.analyze_vision_model, defaults.vision_model);
    assert.equal(payload.advanced_enabled, 'false');
  });

  it('關進階時通讀線的 key／base_url 跟著討論線走（維持舊行為）', () => {
    const payload = buildSettingsPayload({
      provider: 'deepseek', apiKey: 'sk-main', advancedEnabled: false, advanced: HERS,
    });
    assert.equal(payload.analyze_api_key, 'sk-main');
    assert.equal(payload.analyze_base_url, payload.ai_base_url);
    assert.equal(payload.analyze_format, payload.ai_format);
  });

  it('開進階但通讀線的 key／base_url／model 留空 ⇒ 沿用討論線的（「留空＝使用上方」）', () => {
    const payload = buildSettingsPayload({
      provider: 'custom',
      apiKey: 'sk-main',
      advancedEnabled: true,
      advanced: {
        ...HERS, analyzeApiKey: '', analyzeBaseUrl: '', analyzeModel: '',
      },
    });
    assert.equal(payload.analyze_api_key, 'sk-main');
    assert.equal(payload.analyze_base_url, 'https://opencode.ai/zen/go/v1');
    assert.equal(payload.analyze_model, 'deepseek-v4-flash', 'custom preset 沒有 analyze_model ⇒ 用討論線的');
  });

  it('不吃 undefined：沒有 advanced 物件也組得出一份合法 payload', () => {
    const payload = buildSettingsPayload({ provider: 'anthropic', apiKey: '', advancedEnabled: true });
    assert.equal(typeof payload.ai_base_url, 'string');
    assert.equal(payload.analyze_vision_mode, 'auto');
    assert.equal(payload.advanced_enabled, 'true');
  });
});

describe('inferAdvancedEnabled：第一次載入的推定（工單 17 §2.2）', () => {
  it('後端有 advanced_enabled 就聽後端的', () => {
    assert.equal(inferAdvancedEnabled({ advanced_enabled: 'true' }), true);
    assert.equal(inferAdvancedEnabled({ advanced_enabled: 'false' }), false);
    for (const raw of ['0', 'off', 'no', 'FALSE']) {
      assert.equal(inferAdvancedEnabled({ advanced_enabled: raw }), false, `raw=${raw}`);
    }
  });

  it('後端說 false，就算兩條線設得不一樣也照 false（她的意思優先於推定）', () => {
    assert.equal(inferAdvancedEnabled({
      advanced_enabled: 'false',
      ai_model: 'deepseek-v4-flash',
      analyze_model: 'deepseek-v4-pro',
    }), false);
  });

  it('🔴 沒有這個鍵、但通讀線與討論線不同 ⇒ 推定為開（別把她現在的設定當成沒開）', () => {
    assert.equal(inferAdvancedEnabled({
      ai_base_url: 'https://opencode.ai/zen/go/v1',
      ai_model: 'deepseek-v4-flash',
      ai_format: 'openai',
      analyze_base_url: 'https://opencode.ai/zen/go/v1',
      analyze_model: 'deepseek-v4-pro',
      analyze_format: 'openai',
    }), true);
  });

  it('沒有這個鍵、兩條線一模一樣 ⇒ 推定為關', () => {
    assert.equal(inferAdvancedEnabled({
      ai_base_url: 'https://api.deepseek.com/v1',
      ai_model: 'deepseek-chat',
      ai_format: 'openai',
      analyze_base_url: 'https://api.deepseek.com/v1',
      analyze_model: 'deepseek-chat',
      analyze_format: 'openai',
    }), false);
  });

  it('analyze_* 留空不算「不同」（那是沒有分開設定，不是差異）', () => {
    assert.equal(inferAdvancedEnabled({
      ai_base_url: 'https://api.anthropic.com/v1',
      ai_model: 'claude-sonnet-4-6',
      analyze_base_url: '',
      analyze_model: '',
    }), false);
  });

  it('空物件（後端還沒起來）不拋、回 false', () => {
    assert.equal(inferAdvancedEnabled(), false);
    assert.equal(inferAdvancedEnabled({}), false);
  });
});

describe('publicSettingsSummary：回讀印進主控台的東西不帶密鑰（§3 紅線）', () => {
  it('key／token 一律濾掉，其餘原樣', () => {
    const out = publicSettingsSummary({
      ai_api_key: 'sk-super-secret',
      analyze_api_key: 'sk-also-secret',
      gateway_token: 'tok',
      ai_model: 'deepseek-v4-flash',
      analyze_vision_mode: 'off',
      advanced_enabled: 'true',
    });

    assert.deepEqual(out, {
      ai_model: 'deepseek-v4-flash',
      analyze_vision_mode: 'off',
      advanced_enabled: 'true',
    });
    assert.doesNotMatch(JSON.stringify(out), /secret|sk-|tok/);
  });
});

describe('store 的 advancedEnabled：持久化、而且與摺疊狀態分家', () => {
  const realLocalStorage = globalThis.localStorage;
  let bucket;

  beforeEach(() => {
    bucket = new Map();
    globalThis.localStorage = {
      getItem: k => (bucket.has(k) ? bucket.get(k) : null),
      setItem: (k, v) => bucket.set(k, `${v}`),
      removeItem: k => bucket.delete(k),
    };
    useStore.setState({ advancedEnabled: false, advancedOpen: false });
  });

  afterEach(() => {
    if (realLocalStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = realLocalStorage;
  });

  it('setAdvancedEnabled 會寫進 localStorage', () => {
    useStore.getState().setAdvancedEnabled(true);
    assert.equal(useStore.getState().advancedEnabled, true);
    assert.equal(bucket.get(ADVANCED_ENABLED_KEY), '1');

    useStore.getState().setAdvancedEnabled(false);
    assert.equal(bucket.get(ADVANCED_ENABLED_KEY), '0');
  });

  it('🔴 收起摺疊區不會把進階關掉（舊版就是在這裡把她的設定弄丟的）', () => {
    useStore.getState().setAdvancedEnabled(true);
    useStore.getState().toggleAdvanced();          // 展開
    useStore.getState().toggleAdvanced();          // 收起

    assert.equal(useStore.getState().advancedOpen, false);
    assert.equal(useStore.getState().advancedEnabled, true, '摺疊只是版面，不是意圖');

    const payload = buildSettingsPayload({
      provider: 'opencode_go',
      apiKey: 'sk',
      advancedEnabled: useStore.getState().advancedEnabled,
      advanced: HERS,
    });
    assert.equal(payload.analyze_vision_mode, 'off', '收起來再按儲存，她改的 off 仍然存得進去');
  });

  it('localStorage 拋（隱私模式）時不炸，狀態照樣切得動', () => {
    globalThis.localStorage = {
      getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('denied'); },
    };
    useStore.getState().setAdvancedEnabled(true);
    assert.equal(useStore.getState().advancedEnabled, true);
  });
});

// ── 後端：PUT/GET /api/settings 的白名單 ─────────────────────────────────────
// `advanced_enabled` 不加進 src/server.js 那張逐條白名單就會被靜默丟掉——
// 前端以為存好了，下次載入又回到「推定」，等於這顆開關根本沒存過。
describe('PUT /api/settings：advanced_enabled 真的存得進去、回得出來', () => {
  let server, baseUrl;

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

  after(() => { if (server) server.close(); });

  const put = (body) => fetch(`${baseUrl}/api/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  it('整包 payload 存進去之後，GET 回得出同一組值（含 advanced_enabled 與 vision_mode）', async () => {
    const payload = buildSettingsPayload({
      provider: 'opencode_go', apiKey: 'sk-roundtrip', advancedEnabled: true, advanced: HERS,
    });

    const res = await put(payload);
    assert.equal(res.status, 200);

    const cfg = await (await fetch(`${baseUrl}/api/settings`)).json();
    assert.equal(cfg.advanced_enabled, 'true', '白名單漏了這個鍵的話這裡會是 undefined');
    assert.equal(cfg.analyze_vision_mode, 'off');
    assert.equal(cfg.analyze_model, 'deepseek-v4-pro');
    assert.equal(inferAdvancedEnabled(cfg), true, '下次載入讀得回同一個意思');
  });

  it('關掉進階再存 ⇒ advanced_enabled=false，下次載入不再靠推定翻回 true', async () => {
    await put(buildSettingsPayload({
      provider: 'opencode_go', apiKey: 'sk-roundtrip', advancedEnabled: false, advanced: HERS,
    }));

    const cfg = await (await fetch(`${baseUrl}/api/settings`)).json();
    assert.equal(cfg.advanced_enabled, 'false');
    assert.equal(inferAdvancedEnabled(cfg), false);
    assert.equal(cfg.analyze_vision_mode, 'on', '關進階＝回 preset，這是她按的開關');
  });
});
