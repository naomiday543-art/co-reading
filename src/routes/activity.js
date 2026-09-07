import { Router } from 'express';
import db from '../db.js';
import { log } from '../logger.js';

const router = Router();

const DEFAULT_DAYS = 365;
const MAX_DAYS = 730;

// 分桶交給 SQLite：co-reading 是本機應用，伺服器時區即使用者時區（工單 04 §4.2）。
// 若日後部署到遠端，改為前端分桶或由客戶端傳 tz offset。
// created_at 三表都是 ms epoch INTEGER（src/db.js），所以要先 /1000。
const DAY_EXPR = "date(created_at/1000,'unixepoch','localtime')";

// 只回計數。紅線（工單 §6 / TECHNICAL_MANUAL.md:486）：這個端點的回應
// 絕不能出現 messages.content / insights.content / insights.title。
function toDayString(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// 正午錨點：日期加減一律在本地正午做，避開 DST 日界把 -1 天算成 -23/-25 小時。
function shiftDays(dayStr, delta) {
  const [y, m, d] = dayStr.split('-').map(Number);
  const date = new Date(y, m - 1, d, 12, 0, 0, 0);
  date.setDate(date.getDate() + delta);
  return toDayString(date);
}

function bucketMap(rows) {
  const map = new Map();
  for (const r of rows) map.set(r.day, r.n);
  return map;
}

function computeStreaks(activeDays, from, to) {
  const sorted = [...activeDays].sort();

  let longest = 0;
  let run = 0;
  let prev = null;
  for (const day of sorted) {
    run = prev && shiftDays(prev, 1) === day ? run + 1 : 1;
    if (run > longest) longest = run;
    prev = day;
  }

  // current：從今天往回數。今天無活動時給一天寬限，從昨天起算（GitHub 語義）。
  let cursor = to;
  if (!activeDays.has(cursor)) {
    const yesterday = shiftDays(to, -1);
    if (!activeDays.has(yesterday) || yesterday < from) return { current: 0, longest };
    cursor = yesterday;
  }
  let current = 0;
  while (cursor >= from && activeDays.has(cursor)) {
    current += 1;
    cursor = shiftDays(cursor, -1);
  }
  return { current, longest };
}

// GET /api/activity?days=365
// days：整數 1..730；0 = 不限（All）；缺省 365。非整數或超界 → 400。
router.get('/activity', (req, res) => {
  try {
    const raw = req.query.days;
    let days = DEFAULT_DAYS;
    if (raw !== undefined && raw !== '') {
      const str = String(raw);
      if (!/^-?\d+$/.test(str)) {
        return res.status(400).json({ error: 'days 必須是整數' });
      }
      days = parseInt(str, 10);
      if (days !== 0 && (days < 1 || days > MAX_DAYS)) {
        return res.status(400).json({ error: `days 必須在 1..${MAX_DAYS} 之間，或 0 代表不限` });
      }
    }

    const to = toDayString(new Date());
    let from;
    if (days === 0) {
      // 不限：起點 = 三表最早的活動日；完全沒資料時退回今天。
      const row = db.prepare(`
        SELECT MIN(day) AS day FROM (
          SELECT ${DAY_EXPR} AS day FROM messages WHERE role = 'user'
          UNION ALL
          SELECT ${DAY_EXPR} AS day FROM insights
          UNION ALL
          SELECT ${DAY_EXPR} AS day FROM papers
        )
      `).get();
      from = row && row.day ? row.day : to;
    } else {
      from = shiftDays(to, -(days - 1));
    }

    // 色階基準 = 當天 role='user' 的訊息數（工單 §4.1，不算 assistant、不算 token）。
    const messageRows = db.prepare(`
      SELECT ${DAY_EXPR} AS day, COUNT(*) AS n
      FROM messages
      WHERE role = 'user' AND ${DAY_EXPR} BETWEEN ? AND ?
      GROUP BY day
    `).all(from, to);

    const insightRows = db.prepare(`
      SELECT ${DAY_EXPR} AS day, COUNT(*) AS n
      FROM insights
      WHERE ${DAY_EXPR} BETWEEN ? AND ?
      GROUP BY day
    `).all(from, to);

    const paperRows = db.prepare(`
      SELECT ${DAY_EXPR} AS day, COUNT(*) AS n
      FROM papers
      WHERE ${DAY_EXPR} BETWEEN ? AND ?
      GROUP BY day
    `).all(from, to);

    const msgMap = bucketMap(messageRows);
    const insMap = bucketMap(insightRows);
    const papMap = bucketMap(paperRows);

    const dayKeys = [...new Set([...msgMap.keys(), ...insMap.keys(), ...papMap.keys()])].sort();
    const daysOut = dayKeys.map(day => ({
      day,
      messages: msgMap.get(day) || 0,
      insights: insMap.get(day) || 0,
      papers: papMap.get(day) || 0,
    }));

    const activeDays = new Set(daysOut.filter(d => d.messages > 0).map(d => d.day));

    const totals = {
      messages: daysOut.reduce((s, d) => s + d.messages, 0),
      insights: daysOut.reduce((s, d) => s + d.insights, 0),
      papers: daysOut.reduce((s, d) => s + d.papers, 0),
      active_days: activeDays.size,
    };

    const streak = computeStreaks(activeDays, from, to);

    const peakRow = db.prepare(`
      SELECT CAST(strftime('%H', created_at/1000, 'unixepoch', 'localtime') AS INTEGER) AS hour,
             COUNT(*) AS n
      FROM messages
      WHERE role = 'user' AND ${DAY_EXPR} BETWEEN ? AND ?
      GROUP BY hour
      ORDER BY n DESC, hour ASC
      LIMIT 1
    `).get(from, to);

    const dimensions = db.prepare(`
      SELECT dimension, COUNT(*) AS count
      FROM insights
      WHERE ${DAY_EXPR} BETWEEN ? AND ?
      GROUP BY dimension
      ORDER BY count DESC, dimension ASC
    `).all(from, to);

    res.json({
      from,
      to,
      days: daysOut,
      totals,
      streak,
      peak_hour: peakRow ? peakRow.hour : null,
      dimensions,
    });
  } catch (err) {
    log('ERROR', `活動統計失敗: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

export default router;
