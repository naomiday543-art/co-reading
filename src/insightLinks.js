// 工單 18 §2 B：洞察之間的自動聯想。
//
// **零 token**（§2 B1）：純 FTS5 trigram。把一條洞察的 `title + content` 前 400 字
// 切成一堆重疊的 5 字窗，OR 起來丟給 `insights_fts`，拿 bm25 排名。
//
// 分數怎麼變成 0–1：bm25 是負值、量綱隨查詢長度浮動，沒有絕對刻度。所以拿
// **「自己查自己」的 bm25 當分母**——把自己也留在結果裡，`score = rank_other / rank_self`。
// 語意就是「它和我的相似度佔『我和我自己』的幾成」，近重複 ≈0.5–1.0、無關 ≈0。
// 她真資料上（15 條唯讀副本，2026-09-14）這個定義乾淨切出兩對近重複、其餘全 0，
// 見報告 18 的結果表。
//
// 無向表 `insight_links` 一對只有一列（a<b）。bm25 不對稱（A 查 B 與 B 查 A 不同分），
// relink-all 用 `MAX(score)` 合併兩個方向 ⇒ **與處理順序無關、兩次結果一致**（§4.5 冪等）。
import db from './db.js';
import { log } from './logger.js';
import { getChatConfig, makeRequest, collectStream, responseText, describeAnalyzeError } from './ai.js';

// ── 參數（全部可 env 調；預設值是工單 §2 B1 拍板值）──────────────────
export const LINK_MIN_SCORE_DEFAULT = 0.35;
export const LINK_MIN_SCORE_FLOOR = 0.05;
export const LINK_MIN_SCORE_CEIL = 0.95;
export const LINK_MAX_DEFAULT = 5;
export const LINK_MAX_CEIL = 50;

/** 查詢用的來源文字上限、切窗長度／步長、詞數上限。 */
export const LINK_SOURCE_CHARS = 400;
export const LINK_TERM_LEN = 5;
export const LINK_TERM_STEP = 3;
export const LINK_MAX_TERMS = 80;

/** B2：一次 relink-all 最多問幾對「為什麼相關」（§2 B2）。 */
export const LINK_REASON_BATCH_MAX = 20;
export const LINK_REASON_MAX_CHARS = 40;

export function resolveLinkMinScore(env = process.env) {
  const raw = Number(env.INSIGHT_LINK_MIN_SCORE);
  if (!Number.isFinite(raw)) return LINK_MIN_SCORE_DEFAULT;
  return Math.min(LINK_MIN_SCORE_CEIL, Math.max(LINK_MIN_SCORE_FLOOR, raw));
}

export function resolveLinkMax(env = process.env) {
  const raw = Number(env.INSIGHT_LINK_MAX);
  if (!Number.isFinite(raw) || raw < 1) return LINK_MAX_DEFAULT;
  return Math.min(LINK_MAX_CEIL, Math.floor(raw));
}

/** 「為什麼相關」**預設關**（§2 B2）。只有明確寫 true/1 才打上游。 */
export function resolveLinkReasonEnabled(env = process.env) {
  const raw = String(env.INSIGHT_LINK_REASON ?? '').trim().toLowerCase();
  return raw === 'true' || raw === '1' || raw === 'yes';
}

/** a<b 正規化（無向）。同一個 id 回 null。 */
export function normalizeLinkPair(x, y) {
  if (!x || !y || x === y) return null;
  return x < y ? { a: x, b: y } : { a: y, b: x };
}

/**
 * 把一條洞察切成 trigram 查得動的詞。
 *
 * 不做去標點正規化：trigram 是**逐字**比對，`PY-GCMS` 正規化成 `PYGCMS` 之後
 * 反而比不中庫裡的原文。只壓連續空白、轉小寫（FTS5 trigram 本身 case-fold）。
 */
export function buildLinkTerms(text, {
  len = LINK_TERM_LEN,
  step = LINK_TERM_STEP,
  maxTerms = LINK_MAX_TERMS,
  sourceChars = LINK_SOURCE_CHARS,
} = {}) {
  const flat = String(text || '').slice(0, sourceChars).replace(/\s+/g, ' ').trim().toLowerCase();
  const terms = [];
  const seen = new Set();
  for (let i = 0; i + len <= flat.length && terms.length < maxTerms; i += step) {
    const term = flat.slice(i, i + len);
    if (!/[\p{L}\p{N}]/u.test(term)) continue;   // 純標點的窗不查
    if (seen.has(term)) continue;
    seen.add(term);
    terms.push(term);
  }
  // 太短（<len）的洞察至少留一個 trigram，否則永遠沒有連線
  if (terms.length === 0 && flat.length >= 3) terms.push(flat.slice(0, 3));
  return terms;
}

/**
 * FTS5 MATCH 運算式。**只查 title／content 兩欄**——`source_context` 是整段對話摘錄，
 * 三條洞察可能共用同一段（她資料上就有），拿它當相似度會把「同一次對話」誤判成
 * 「同一個想法」。
 */
export function buildLinkMatch(terms) {
  if (!terms || terms.length === 0) return '';
  const quoted = terms.map(t => `"${t.replace(/"/g, '""')}"`).join(' OR ');
  return `{title content} : (${quoted})`;
}

/**
 * 算一條洞察的候選連線（**不寫庫**）。
 * @returns {Array<{id:string, score:number}>} 已過門檻、已排序、已截斷
 */
export function scoreCandidates(insight, {
  database = db,
  minScore = resolveLinkMinScore(),
  max = resolveLinkMax(),
} = {}) {
  const terms = buildLinkTerms(`${insight?.title || ''} ${insight?.content || ''}`);
  const match = buildLinkMatch(terms);
  if (!match) return [];

  let rows;
  try {
    rows = database.prepare(`
      SELECT i.id AS id, insights_fts.rank AS raw
      FROM insights_fts
      JOIN insights i ON insights_fts.rowid = i.rowid
      WHERE insights_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `).all(match, Math.max(max * 4, 20));
  } catch (err) {
    // 查詢語法炸掉不該讓「存洞察」失敗——聯想是加值功能。
    log('WARN', `[INSIGHT] link query failed for ${insight?.id}: ${err.message?.slice(0, 120)}`);
    return [];
  }

  const self = rows.find(r => r.id === insight.id);
  const selfRaw = self?.raw;
  if (!selfRaw) return [];   // 自己都查不到自己（例如剛好沒有可用的詞）⇒ 不猜

  return rows
    .filter(r => r.id !== insight.id)
    .map(r => ({ id: r.id, score: Math.min(1, Math.max(0, r.raw / selfRaw)) }))
    .filter(r => r.score >= minScore)
    .sort((x, y) => y.score - x.score)
    .slice(0, max);
}

/** 寫一列（無向、a<b）。已存在就取較高分，`reason` 保留既有的那句（別白白丟掉）。 */
function upsertLink(database, a, b, score, method = 'fts') {
  const pair = normalizeLinkPair(a, b);
  if (!pair) return;
  database.prepare(`
    INSERT INTO insight_links (a, b, score, method)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(a, b) DO UPDATE SET
      score = MAX(insight_links.score, excluded.score),
      method = excluded.method
  `).run(pair.a, pair.b, score, method);
}

/**
 * 重算單一洞察的連線（§2 B1 觸發點：POST／PATCH／提取線每插一條）。
 *
 * 先清掉所有碰到它的列再寫自己這一輪算出來的——**單向**。代價是「別人查得到我、
 * 但我查不到別人」的那種不對稱連線會在這裡掉一條，下次 relink-all（雙向 MAX）補回來。
 * 換到的是每次存洞察只跑一個 FTS 查詢，存的當下不卡。
 *
 * @returns {{links:Array, reasonTask:Promise}} `reasonTask` 給測試 await；路由不等它。
 */
export function computeInsightLinks(insightId, {
  database = db,
  minScore = resolveLinkMinScore(),
  max = resolveLinkMax(),
  reasonEnabled = resolveLinkReasonEnabled(),
  reasonConfig,
} = {}) {
  const insight = database.prepare('SELECT id, title, content FROM insights WHERE id = ?').get(insightId);
  if (!insight) return { links: [], reasonTask: Promise.resolve({ asked: 0, written: 0 }) };

  const candidates = scoreCandidates(insight, { database, minScore, max });

  const apply = database.transaction(() => {
    database.prepare('DELETE FROM insight_links WHERE a = ? OR b = ?').run(insightId, insightId);
    for (const c of candidates) upsertLink(database, insightId, c.id, c.score);
  });
  apply();

  const links = listLinkRows(insightId, database);
  const reasonTask = maybeGenerateReasons(
    links.filter(l => !l.reason).map(l => ({ a: l.a, b: l.b })),
    { database, reasonEnabled, config: reasonConfig },
  );
  return { links, reasonTask };
}

/**
 * 全量重算（§2 B1，`POST /api/insights/relink-all`）。
 *
 * 砍掉重練＋雙向 `MAX` 合併 ⇒ 順序無關、冪等。`insight_links` 是推導資料，
 * 全表清空沒有資料損失（`reason` 例外——所以先撈起來，重建後貼回同一對）。
 */
export function relinkAll({
  database = db,
  minScore = resolveLinkMinScore(),
  max = resolveLinkMax(),
  reasonEnabled = resolveLinkReasonEnabled(),
  reasonConfig,
} = {}) {
  const insights = database.prepare('SELECT id, title, content FROM insights ORDER BY rowid').all();
  const keptReasons = database.prepare("SELECT a, b, reason FROM insight_links WHERE reason != ''").all();

  const rebuild = database.transaction(() => {
    database.prepare('DELETE FROM insight_links').run();
    for (const ins of insights) {
      for (const c of scoreCandidates(ins, { database, minScore, max })) {
        upsertLink(database, ins.id, c.id, c.score);
      }
    }
    const restore = database.prepare('UPDATE insight_links SET reason = ? WHERE a = ? AND b = ?');
    for (const r of keptReasons) restore.run(r.reason, r.a, r.b);
  });
  rebuild();

  const total = insights.length;
  const linkCount = database.prepare('SELECT COUNT(*) AS n FROM insight_links').get().n;
  log('INFO', `[INSIGHT] relink total=${total} links=${linkCount}`);

  const pending = database.prepare("SELECT a, b FROM insight_links WHERE reason = ''").all();
  const reasonTask = maybeGenerateReasons(pending, { database, reasonEnabled, config: reasonConfig });
  return { total, links: linkCount, reasonTask };
}

/** 一條洞察的所有連線列（原始列，含 a／b 兩欄）。 */
export function listLinkRows(insightId, database = db) {
  return database.prepare(`
    SELECT a, b, score, reason, method FROM insight_links
    WHERE a = ? OR b = ?
    ORDER BY score DESC
  `).all(insightId, insightId);
}

/**
 * 一條洞察的連線（給 `GET /api/insights/:id/links`）。**一趟 SQL**，不 N+1。
 */
export function listInsightLinks(insightId, database = db) {
  return database.prepare(`
    SELECT
      other.id             AS id,
      other.dimension      AS dimension,
      other.title          AS title,
      other.content        AS content,
      p.title              AS source_paper_title,
      other.source_paper_id AS source_paper_id,
      l.score              AS score,
      l.reason             AS reason
    FROM insight_links l
    JOIN insights other ON other.id = CASE WHEN l.a = ? THEN l.b ELSE l.a END
    LEFT JOIN papers p ON p.id = other.source_paper_id
    WHERE l.a = ? OR l.b = ?
    ORDER BY l.score DESC
  `).all(insightId, insightId, insightId).map(row => ({
    insight: {
      id: row.id,
      dimension: row.dimension,
      title: row.title,
      content: row.content,
      source_paper_id: row.source_paper_id,
      source_paper_title: row.source_paper_title || null,
    },
    score: row.score,
    reason: row.reason || '',
  }));
}

// ── B2「為什麼相關」：預設關，開了才打上游 ─────────────────────────────

export const LINK_REASON_SYSTEM =
  '你是科研共讀助手。使用者會給你兩條研究洞察，請用一句話（不超過 40 字，繁體中文）'
  + '說明它們為什麼相關——指出共同的對象、機制或問題。只輸出那一句話，不要前綴、不要標點編號。';

export function buildReasonPrompt(one, two) {
  return `洞察 A：${(one?.title || '').slice(0, 80)}\n${(one?.content || '').slice(0, 300)}\n\n`
    + `洞察 B：${(two?.title || '').slice(0, 80)}\n${(two?.content || '').slice(0, 300)}\n\n`
    + '它們為什麼相關？一句話。';
}

/** 模型有時候會裹上引號／「原因：」；剪乾淨並壓到 40 字。 */
export function sanitizeReason(text) {
  const line = String(text || '').replace(/\s+/g, ' ').trim()
    .replace(/^[「"'『]+|[」"'』]+$/g, '')
    .replace(/^(原因|理由|關聯|关联)[：:]\s*/, '')
    .trim();
  return line.slice(0, LINK_REASON_MAX_CHARS);
}

/**
 * 批次問「為什麼相關」。
 *
 * - 關閉（預設）⇒ **一次 fetch 都不打**，直接回 `{asked:0, written:0, skipped:true}`（§4.6）。
 * - 開啟 ⇒ 每次最多 `LINK_REASON_BATCH_MAX`（20）對；串流／逾時／錯誤分類全部沿用
 *   `ai.js` 的 `makeRequest`／`collectStream`／`describeAnalyzeError`，不另造一份。
 * - 任何一對失敗就**留空、不重試**（§2 B2）。
 */
export async function maybeGenerateReasons(pairs, {
  database = db,
  reasonEnabled = resolveLinkReasonEnabled(),
  config,
  batchMax = LINK_REASON_BATCH_MAX,
} = {}) {
  if (!reasonEnabled) return { asked: 0, written: 0, skipped: true };
  const todo = (pairs || []).slice(0, batchMax);
  if (todo.length === 0) return { asked: 0, written: 0, skipped: false };

  const cfg = config || getChatConfig();
  if (!cfg.key && !/127\.0\.0\.1|localhost/.test(cfg.baseUrl || '')) {
    log('WARN', '[INSIGHT] link reason 開著但沒有 API key，跳過');
    return { asked: 0, written: 0, skipped: true };
  }

  const get = database.prepare('SELECT id, title, content FROM insights WHERE id = ?');
  const save = database.prepare('UPDATE insight_links SET reason = ? WHERE a = ? AND b = ?');

  let asked = 0;
  let written = 0;
  for (const pair of todo) {
    const one = get.get(pair.a);
    const two = get.get(pair.b);
    if (!one || !two) continue;
    asked++;
    try {
      const response = await makeRequest({ ...cfg, scope: 'insight-link' }, {
        messages: [
          { role: 'system', content: LINK_REASON_SYSTEM },
          { role: 'user', content: buildReasonPrompt(one, two) },
        ],
        stream: true,
        max_tokens: 200,
        temperature: 0.3,
      });
      const data = await collectStream(cfg, response);
      const reason = sanitizeReason(responseText(cfg, data));
      if (reason) {
        save.run(reason, pair.a, pair.b);
        written++;
      }
    } catch (err) {
      log('WARN', `[INSIGHT] link reason 失敗 ${pair.a}↔${pair.b}: ${describeAnalyzeError(err)}`);
      // 留空、不重試（§2 B2）
    }
  }

  log('INFO', `[INSIGHT] link reason asked=${asked} written=${written}`);
  return { asked, written, skipped: false };
}
