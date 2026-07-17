import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

mkdirSync(new URL('../data', import.meta.url).pathname, { recursive: true });

const dbPath = new URL('../data/co-reading.db', import.meta.url).pathname;
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS tree_nodes (
    id          TEXT PRIMARY KEY,
    parent_id   TEXT REFERENCES tree_nodes(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
  );

  CREATE TABLE IF NOT EXISTS papers (
    id              TEXT PRIMARY KEY,
    title           TEXT NOT NULL DEFAULT '',
    authors         TEXT NOT NULL DEFAULT '',
    year            INTEGER,
    doi             TEXT,
    pdf_filename    TEXT,
    full_text       TEXT NOT NULL DEFAULT '',
    summary_bg          TEXT NOT NULL DEFAULT '',
    summary_methods     TEXT NOT NULL DEFAULT '',
    summary_results     TEXT NOT NULL DEFAULT '',
    summary_conclusions TEXT NOT NULL DEFAULT '',
    summary_limitations TEXT NOT NULL DEFAULT '',
    status          TEXT NOT NULL DEFAULT 'unread',
    notes           TEXT NOT NULL DEFAULT '',
    tree_node_id    TEXT REFERENCES tree_nodes(id) ON DELETE SET NULL,
    analyze_status  TEXT NOT NULL DEFAULT 'pending',
    analyze_error   TEXT NOT NULL DEFAULT '',
    created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
    updated_at      INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
  );

  CREATE TABLE IF NOT EXISTS messages (
    id          TEXT PRIMARY KEY,
    paper_id    TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
    role        TEXT NOT NULL,
    content     TEXT NOT NULL,
    created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
  );
  CREATE INDEX IF NOT EXISTS idx_msg_paper ON messages(paper_id, created_at);

  CREATE TABLE IF NOT EXISTS tags (
    id    TEXT PRIMARY KEY,
    name  TEXT NOT NULL UNIQUE,
    color TEXT NOT NULL DEFAULT '#6366f1'
  );

  CREATE TABLE IF NOT EXISTS paper_tags (
    paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
    tag_id   TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (paper_id, tag_id)
  );

  CREATE TABLE IF NOT EXISTS insights (
    id              TEXT PRIMARY KEY,
    dimension       TEXT NOT NULL DEFAULT '延伸',
    title           TEXT NOT NULL DEFAULT '',
    content         TEXT NOT NULL DEFAULT '',
    source_paper_id TEXT REFERENCES papers(id) ON DELETE SET NULL,
    source_context  TEXT NOT NULL DEFAULT '',
    tags_json       TEXT NOT NULL DEFAULT '[]',
    created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
    updated_at      INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
  );
  CREATE INDEX IF NOT EXISTS idx_insights_dimension ON insights(dimension);
  CREATE INDEX IF NOT EXISTS idx_insights_source ON insights(source_paper_id);

  CREATE TABLE IF NOT EXISTS annotations (
    id          TEXT PRIMARY KEY,
    paper_id    TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
    quote       TEXT NOT NULL DEFAULT '',
    note        TEXT NOT NULL DEFAULT '',
    author      TEXT NOT NULL DEFAULT 'user',
    kind        TEXT NOT NULL DEFAULT 'note',
    parent_id   TEXT REFERENCES annotations(id) ON DELETE CASCADE,
    created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
  );
  CREATE INDEX IF NOT EXISTS idx_ann_paper ON annotations(paper_id, created_at);

  CREATE TABLE IF NOT EXISTS section_progress (
    id              TEXT PRIMARY KEY,
    paper_id        TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
    section_title   TEXT NOT NULL DEFAULT '',
    section_order   INTEGER NOT NULL DEFAULT 0,
    read            INTEGER NOT NULL DEFAULT 0,
    created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
  );
  CREATE INDEX IF NOT EXISTS idx_sec_paper ON section_progress(paper_id, section_order);

  -- FTS5 trigram search for insights (Chinese + English mixed text)
  CREATE VIRTUAL TABLE IF NOT EXISTS insights_fts USING fts5(
    title, content, source_context,
    tokenize='trigram'
  );

  CREATE TRIGGER IF NOT EXISTS insights_fts_ai AFTER INSERT ON insights BEGIN
    INSERT INTO insights_fts(rowid, title, content, source_context)
    VALUES (new.rowid, new.title, new.content, new.source_context);
  END;

  CREATE TRIGGER IF NOT EXISTS insights_fts_ad AFTER DELETE ON insights BEGIN
    INSERT INTO insights_fts(insights_fts, rowid, title, content, source_context)
    VALUES ('delete', old.rowid, old.title, old.content, old.source_context);
  END;

  CREATE TRIGGER IF NOT EXISTS insights_fts_au AFTER UPDATE ON insights BEGIN
    INSERT INTO insights_fts(insights_fts, rowid, title, content, source_context)
    VALUES ('delete', old.rowid, old.title, old.content, old.source_context);
    INSERT INTO insights_fts(rowid, title, content, source_context)
    VALUES (new.rowid, new.title, new.content, new.source_context);
  END;
`);

// Backfill existing insights into FTS index (idempotent)
db.exec(`
  INSERT OR IGNORE INTO insights_fts(rowid, title, content, source_context)
  SELECT rowid, title, content, source_context FROM insights;
`);

// ── Idempotent migration: messages new columns + message_branches table ──
function columnExists(table, column) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  return cols.some(c => c.name === column);
}

if (!columnExists('messages', 'seq')) {
  db.exec(`ALTER TABLE messages ADD COLUMN seq INTEGER`);
  // Backfill seq: per-paper sequential ordering by (created_at, rowid)
  db.exec(`
    UPDATE messages SET seq = (
      SELECT COUNT(*) FROM messages m2
      WHERE m2.paper_id = messages.paper_id
        AND (m2.created_at < messages.created_at
          OR (m2.created_at = messages.created_at AND m2.rowid <= messages.rowid))
    )
  `);
}

if (!columnExists('messages', 'regen_versions')) {
  db.exec(`ALTER TABLE messages ADD COLUMN regen_versions TEXT`);
}
if (!columnExists('messages', 'regen_idx')) {
  db.exec(`ALTER TABLE messages ADD COLUMN regen_idx INTEGER`);
}
if (!columnExists('messages', 'edited')) {
  db.exec(`ALTER TABLE messages ADD COLUMN edited INTEGER DEFAULT 0`);
}
if (!columnExists('messages', 'edit_branches')) {
  db.exec(`ALTER TABLE messages ADD COLUMN edit_branches TEXT`);
}

// ── Idempotent migration: insights outbox columns (gateway sync, M3.b) ──
// external_ombre_id = research-gateway 回填的記憶 id（契約 §二 ombre_id / §六 對應）。
// synced_at IS NULL = 尚未出海，供啟動補傳撈取（契約 §五）。ALTER 不重建表。
if (!columnExists('insights', 'external_ombre_id')) {
  db.exec(`ALTER TABLE insights ADD COLUMN external_ombre_id TEXT`);
}
if (!columnExists('insights', 'synced_at')) {
  db.exec(`ALTER TABLE insights ADD COLUMN synced_at INTEGER`);
}
// UNIQUE（§六）：以 partial index 實作，允許多個未同步的 NULL 值並存。
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_insights_external_ombre
  ON insights(external_ombre_id) WHERE external_ombre_id IS NOT NULL`);

db.exec(`
  CREATE TABLE IF NOT EXISTS message_branches (
    id TEXT PRIMARY KEY,
    paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
    fork_message_id TEXT NOT NULL,
    tail_json TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
  );
  CREATE INDEX IF NOT EXISTS idx_message_branches_fork ON message_branches(fork_message_id);
  CREATE INDEX IF NOT EXISTS idx_message_branches_paper ON message_branches(paper_id);
  CREATE INDEX IF NOT EXISTS idx_msg_paper_seq ON messages(paper_id, seq);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_msg_paper_seq_unique ON messages(paper_id, seq);
`);

export function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

export function setSetting(key, value) {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);
}

export function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const obj = {};
  for (const { key, value } of rows) {
    obj[key] = value;
  }
  return obj;
}

export default db;
