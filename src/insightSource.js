// 工單 18 §2 A：洞察的「出處」——它是從哪一則回覆長出來的。
//
// 為什麼要這一欄：洞察是長期資產，但她點卡片只會跳到論文頁，出處得自己翻對話。
// 存一個 `source_message_id` 就能一鍵跳回那一則。
//
// 三個規則（§2 A1／§3 紅線）：
//   ① 存之前**驗證**：訊息要存在、而且 `paper_id` 要跟 `source_paper_id` 同一篇；
//      不合格就存空字串——**不 400**，洞察本身永遠要存得成（欄位是加值，不是門檻）。
//   ② 讀的時候一次拿齊「那一問一答」：assistant 那則＋它前一則 user（用 seq 反推）。
//   ③ 存量洞察的回填**只在唯一命中時寫**，絕不猜（§3）。
import db from './db.js';
import { log } from './logger.js';

/** 回填時拿 `source_context` 的前幾個字去比對；60 是工單 §2 A1 拍板值。 */
export const BACKFILL_PROBE_CHARS = 60;

/**
 * 提取線湊 `source_context` 時會在前面加 `[assistant] ` / `[user] ` 的角色標記
 * （`memory.js`），那不是訊息原文的一部分——回填比對前要先剝掉，否則永遠撲空。
 * 她存量 4 條有 context 的洞察全部帶這個前綴（2026-09-14 於唯讀副本上親眼看過）。
 */
export function stripContextRoleTag(text) {
  return String(text || '').replace(/^\s*\[(assistant|user|system)\]\s*/i, '').trim();
}

/** 回填用的探針：context 第一段的前 60 字（剝掉角色標記、壓掉換行）。 */
export function backfillProbe(sourceContext, chars = BACKFILL_PROBE_CHARS) {
  const first = stripContextRoleTag(String(sourceContext || '').split('\n')[0]);
  return first.slice(0, chars).trim();
}

/**
 * 驗證並正規化 `source_message_id`。不合格一律回 ''（呼叫端照常存洞察）。
 * @returns {string}
 */
export function resolveSourceMessageId(messageId, paperId, database = db) {
  const id = typeof messageId === 'string' ? messageId.trim() : '';
  if (!id) return '';
  const msg = database.prepare('SELECT id, paper_id FROM messages WHERE id = ?').get(id);
  if (!msg) return '';
  if (!paperId || msg.paper_id !== paperId) return '';
  return id;
}

/**
 * 一次拿齊浮現卡中段要的「那一問一答」（§2 A2）。
 *
 * `source_question` 是同一篇裡 seq 小於它、**最近的一則 user** ——不是「seq-1」：
 * 中間可能夾著系統訊息或編輯留下的空隙。訊息被截掉（編輯／重生）時兩者都回 null，
 * 前端退回顯示 `source_context`。
 */
export function loadSourceConversation(insight, database = db) {
  const id = (insight?.source_message_id || '').trim();
  if (!id) return { source_message: null, source_question: null };

  const msg = database.prepare(
    'SELECT id, paper_id, role, content, seq, created_at FROM messages WHERE id = ?'
  ).get(id);
  if (!msg) return { source_message: null, source_question: null };

  const question = database.prepare(`
    SELECT id, content, seq FROM messages
    WHERE paper_id = ? AND role = 'user' AND seq < ?
    ORDER BY seq DESC LIMIT 1
  `).get(msg.paper_id, msg.seq ?? 0) || null;

  return {
    source_message: { id: msg.id, content: msg.content, seq: msg.seq ?? null },
    source_question: question ? { id: question.id, content: question.content, seq: question.seq ?? null } : null,
  };
}

/**
 * 存量洞察回填（§2 A1，一次性、冪等）。
 *
 * 只碰「`source_message_id` 空 **且** `source_context` 非空」的洞察；在同一篇的
 * assistant 訊息裡找 content 含探針者，**命中剛好一則才寫**（兩則以上＝分不出來，
 * 留空比猜錯好）。冪等：寫過的下一輪就不在候選集裡了。
 *
 * @returns {{scanned:number, filled:number, ambiguous:number, missed:number}}
 */
export function backfillInsightSources(database = db) {
  const candidates = database.prepare(`
    SELECT id, source_paper_id, source_context FROM insights
    WHERE COALESCE(source_message_id, '') = ''
      AND COALESCE(source_context, '') != ''
      AND source_paper_id IS NOT NULL
    ORDER BY created_at
  `).all();

  const msgStmt = database.prepare(
    "SELECT id FROM messages WHERE paper_id = ? AND role = 'assistant' AND instr(content, ?) > 0 LIMIT 3"
  );
  const updateStmt = database.prepare('UPDATE insights SET source_message_id = ? WHERE id = ?');

  let filled = 0;
  let ambiguous = 0;
  let missed = 0;

  for (const ins of candidates) {
    const probe = backfillProbe(ins.source_context);
    if (probe.length < 8) { missed++; continue; }
    const hits = msgStmt.all(ins.source_paper_id, probe);
    if (hits.length === 1) {
      updateStmt.run(hits[0].id, ins.id);
      filled++;
    } else if (hits.length > 1) {
      ambiguous++;
    } else {
      missed++;
    }
  }

  log(
    'INFO',
    `[INSIGHT] backfill=${filled} scanned=${candidates.length}`
    + ` ambiguous=${ambiguous} missed=${missed}`,
  );

  return { scanned: candidates.length, filled, ambiguous, missed };
}
