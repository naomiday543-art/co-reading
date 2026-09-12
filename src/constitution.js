// 導師憲章：把「你是誰」從代碼裡抽成文件（工單 05，2026-09-08）。
//
// 解析順序：
//   1. <dataDir>/CONSTITUTION.md   — 使用者自己的版本，改了立即生效，不用重建 app
//   2. src/prompts/CONSTITUTION.md — 隨 app 打包的內建預設
//   3. 硬編一句身份                 — 保險絲，導師永遠不會沒有身份
//
// 每輪讀一次（2 KB），不做快取。
import { readFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dataPaths } from './paths.js';
import { log } from './logger.js';

export const FALLBACK_CONSTITUTION = '你是一位科研導師，正在幫助用戶閱讀和理解一篇學術論文。';

export const builtinConstitutionPath = fileURLToPath(new URL('./prompts/CONSTITUTION.md', import.meta.url));

function readNonEmpty(path) {
  try {
    const text = readFileSync(path, 'utf-8');
    return text.trim() ? text.trim() : null;
  } catch {
    return null;
  }
}

export function userConstitutionPath(dataDir = dataPaths.dataDir) {
  return join(dataDir, 'CONSTITUTION.md');
}

export function loadConstitution({ dataDir = dataPaths.dataDir, builtinPath = builtinConstitutionPath } = {}) {
  const user = readNonEmpty(userConstitutionPath(dataDir));
  if (user) return { text: user, source: 'user' };

  const builtin = readNonEmpty(builtinPath);
  if (builtin) return { text: builtin, source: 'builtin' };

  log('WARN', `[CONSTITUTION] 內建憲章讀不到（${builtinPath}），回退硬編身份`);
  return { text: FALLBACK_CONSTITUTION, source: 'fallback' };
}
