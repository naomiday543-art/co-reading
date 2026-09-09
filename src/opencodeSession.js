/**
 * x-opencode-session —— OpenCode Go 的路由／快取親和標頭。
 *
 * OpenCode Go 從 2026-09 起硬性要求每個請求帶這顆標頭，缺了就 400：
 *   {"type":"MissingSessionID","message":"Request is missing x-opencode-session
 *    and cannot be routed efficiently ..."}
 * 官方語義：送一個「穩定」的 session id，它拿這個 key 把同一段對話黏在同一個後端節點，
 * prompt cache 前綴才熱得起來。
 *
 * 兩個設計決定（移植自 kitten-cache-proxy/src/opencodeSession.js，2026-09-07）：
 * 1）只在 base URL 指向 opencode.ai 時才加——這是供應商私有標頭，往別家閘道打最好被忽略、
 *    最壞被算進簽章或快取 key。
 * 2）值按 scope 派生成確定性的 UUID v5 形狀：討論線用 `paper:<id>`（同一篇論文的全文就是
 *    共用前綴，分桶親和性最好）、通讀線固定 'analyze'、測試連線固定 'test'。跨重啟不變。
 */
import { createHash } from 'node:crypto';

// 派生命名空間。改動它＝把所有 scope 的 session id 換一輪（等同棄掉上游的快取親和）。
const NAMESPACE = 'co-reading/opencode-session/v1';

/**
 * baseUrl 是否指向 OpenCode。只認 opencode.ai 本體與其子網域。
 * @param {string} baseUrl
 * @returns {boolean}
 */
export function isOpencodeBase(baseUrl) {
  if (!baseUrl || typeof baseUrl !== 'string') return false;
  let host;
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    try {
      host = new URL(`https://${baseUrl}`).hostname.toLowerCase();
    } catch {
      return false;
    }
  }
  return host === 'opencode.ai' || host.endsWith('.opencode.ai');
}

/**
 * 由 scope 派生一顆確定性的 UUID v5 形狀 session id。同 scope 永遠同值。
 * @param {string} scope
 * @returns {string}
 */
export function opencodeSessionId(scope) {
  const hex = createHash('sha256').update(`${NAMESPACE}|${scope}`).digest('hex');
  const version = '5';
  const variant = '89ab'[parseInt(hex[16], 16) % 4];
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    version + hex.slice(13, 16),
    variant + hex.slice(17, 20),
    hex.slice(20, 32),
  ].join('-');
}

/**
 * 給 fetch 用的標頭片段。非 opencode 的 baseUrl 回空物件。
 * @param {string} baseUrl
 * @param {string} scope
 * @returns {{ 'x-opencode-session'?: string }}
 */
export function opencodeSessionHeaders(baseUrl, scope) {
  if (!isOpencodeBase(baseUrl)) return {};
  return { 'x-opencode-session': opencodeSessionId(scope || 'chat') };
}
