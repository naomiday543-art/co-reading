import { appendFileSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';

const LOG_PATH = new URL('../data/app.log', import.meta.url).pathname;
const MAX_LINES = 1000;

mkdirSync(new URL('../data', import.meta.url).pathname, { recursive: true });

if (!existsSync(LOG_PATH)) {
  writeFileSync(LOG_PATH, '');
}

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function log(level, message) {
  const line = `[${timestamp()}] [${level}] ${message}`;
  console.log(line);

  try {
    appendFileSync(LOG_PATH, line + '\n');
    rotate();
  } catch {
    // silently fail logging to file
  }
}

function rotate() {
  try {
    const content = readFileSync(LOG_PATH, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);
    if (lines.length > MAX_LINES) {
      writeFileSync(LOG_PATH, lines.slice(-MAX_LINES).join('\n') + '\n');
    }
  } catch {
    // ignore rotation errors
  }
}

export function getRecentLogs(lines = 100) {
  try {
    const content = readFileSync(LOG_PATH, 'utf-8');
    const all = content.trim().split('\n').filter(Boolean);
    return all.slice(-lines).reverse();
  } catch {
    return [];
  }
}
