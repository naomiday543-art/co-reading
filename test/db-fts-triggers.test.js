import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';

// insights_fts 觸發器回歸測試（審查 M2）。
// 根因（2026-07-17 踩過）：insights_fts 是普通（非 external-content）FTS5 表，
// 舊觸發器誤用 'delete' 特殊命令 → 一切 UPDATE/DELETE insights 必炸 "SQL logic error"，
// 同步回填因此全軍覆沒。此檔用**真實 src/db.js 的 schema 與遷移**守住三件事：
//   (a) UPDATE / DELETE 不拋，且 FTS 檢索反映更新後內容；
//   (b) 帶舊版壞觸發器的存量庫，啟動遷移偵測命中並重建，之後 UPDATE 正常；
//   (c) 對新庫遷移跳過、且冪等（跑兩次無害）。
// 隔離：CO_READING_DB_PATH 指向 temp DB（見 src/db.js 逃生口），絕不碰 data/co-reading.db；
// 以 ?bust=N query 重新執行 db.js 模組，讓每個案例吃到獨立的真實建庫+遷移流程。

const tmpDir = fs.mkdtempSync(path.join(tmpdir(), 'co-reading-fts-'));
after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

let bust = 0;
/** 讓真實 src/db.js 在指定 temp DB 上完整跑一遍建庫+遷移，回傳其連線。 */
async function importDbAt(dbFile) {
  process.env.CO_READING_DB_PATH = dbFile;
  const mod = await import(`../src/db.js?bust=${++bust}`);
  return mod.default;
}

const triggerSql = (db, name) =>
  db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?").get(name)?.sql || '';
const ftsMatch = (db, q) =>
  db.prepare('SELECT rowid, content FROM insights_fts WHERE insights_fts MATCH ?').all(q);

describe('insights_fts triggers — real schema (fresh DB)', () => {
  it('(a) UPDATE and DELETE do not throw, FTS reflects the new content', async () => {
    const db = await importDbAt(path.join(tmpDir, 'fresh.db'));

    db.prepare("INSERT INTO insights (id, title, content) VALUES ('i1', '雲反饋', '低雲反饋影響氣候敏感度')").run();
    db.prepare("INSERT INTO insights (id, title, content) VALUES ('i2', '待刪', '這條洞察將被刪除驗證觸發器')").run();

    // UPDATE 不拋（舊壞觸發器在這裡必炸 SQL logic error）
    db.prepare("UPDATE insights SET content = '更新後的內容關於層積雲轉換' WHERE id = 'i1'").run();
    assert.strictEqual(ftsMatch(db, '層積雲').length, 1, 'FTS surfaces the updated content');
    assert.strictEqual(ftsMatch(db, '氣候敏感度').length, 0, 'stale FTS row for the old content is gone');

    // DELETE 不拋，FTS 同步移除
    db.prepare("DELETE FROM insights WHERE id = 'i2'").run();
    assert.strictEqual(ftsMatch(db, '將被刪除').length, 0, 'deleted insight leaves no FTS row');
  });
});

describe('insights_fts triggers — legacy DB migration', () => {
  it("(b) a stock DB with the old 'delete'-command triggers is detected, rebuilt, and works", async () => {
    const dbFile = path.join(tmpDir, 'legacy.db');

    // 手工造一個 2026-07-17 前的存量庫：舊表形（無 outbox 欄）+ 舊版壞觸發器（逐字取自 f80e30b）
    const legacy = new Database(dbFile);
    legacy.exec(`
      CREATE TABLE insights (
        id              TEXT PRIMARY KEY,
        dimension       TEXT NOT NULL DEFAULT '延伸',
        title           TEXT NOT NULL DEFAULT '',
        content         TEXT NOT NULL DEFAULT '',
        source_paper_id TEXT,
        source_context  TEXT NOT NULL DEFAULT '',
        tags_json       TEXT NOT NULL DEFAULT '[]',
        created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
        updated_at      INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
      );
      CREATE VIRTUAL TABLE insights_fts USING fts5(title, content, source_context, tokenize='trigram');
      CREATE TRIGGER insights_fts_ai AFTER INSERT ON insights BEGIN
        INSERT INTO insights_fts(rowid, title, content, source_context)
        VALUES (new.rowid, new.title, new.content, new.source_context);
      END;
      CREATE TRIGGER insights_fts_ad AFTER DELETE ON insights BEGIN
        INSERT INTO insights_fts(insights_fts, rowid, title, content, source_context)
        VALUES ('delete', old.rowid, old.title, old.content, old.source_context);
      END;
      CREATE TRIGGER insights_fts_au AFTER UPDATE ON insights BEGIN
        INSERT INTO insights_fts(insights_fts, rowid, title, content, source_context)
        VALUES ('delete', old.rowid, old.title, old.content, old.source_context);
        INSERT INTO insights_fts(rowid, title, content, source_context)
        VALUES (new.rowid, new.title, new.content, new.source_context);
      END;
    `);
    legacy.prepare("INSERT INTO insights (id, title, content) VALUES ('old1', '存量洞察', '存量庫裡的原始內容片段')").run();

    // 夾具健全性：壞觸發器下 UPDATE 真的炸（證明我們測的是真根因，不是空跑）
    assert.throws(
      () => legacy.prepare("UPDATE insights SET content = 'x' WHERE id = 'old1'").run(),
      /SQL logic error/,
      'legacy trigger must reproduce the original failure'
    );
    legacy.close();

    // 讓真實 db.js 在這個存量庫上跑啟動流程 → 遷移應偵測並重建觸發器
    const db = await importDbAt(dbFile);
    assert.ok(!triggerSql(db, 'insights_fts_ad').includes("'delete'"), 'ad trigger rebuilt without the special command');
    assert.ok(!triggerSql(db, 'insights_fts_au').includes("'delete'"), 'au trigger rebuilt without the special command');

    // 遷移後 UPDATE 正常、FTS 反映新內容；存量欄位遷移（outbox 欄）也已補上
    db.prepare("UPDATE insights SET content = '遷移後成功更新的內容' WHERE id = 'old1'").run();
    assert.strictEqual(ftsMatch(db, '成功更新').length, 1, 'post-migration UPDATE reaches FTS');
    assert.strictEqual(ftsMatch(db, '原始內容').length, 0, 'stale FTS row removed');
    const cols = db.prepare("PRAGMA table_info(insights)").all().map(c => c.name);
    assert.ok(cols.includes('external_ombre_id') && cols.includes('synced_at'), 'outbox columns migrated on stock DB');
  });
});

describe('insights_fts triggers — migration idempotency', () => {
  it('(c) on a fresh DB the migration is a no-op and running twice is harmless', async () => {
    const dbFile = path.join(tmpDir, 'idem.db');
    const db1 = await importDbAt(dbFile);
    const detect = () => db1.prepare(
      "SELECT name FROM sqlite_master WHERE type='trigger' AND name IN ('insights_fts_ad','insights_fts_au') AND sql LIKE '%''delete''%'"
    ).all();
    assert.strictEqual(detect().length, 0, 'fresh DB has no broken triggers to migrate');
    const adBefore = triggerSql(db1, 'insights_fts_ad');
    const auBefore = triggerSql(db1, 'insights_fts_au');

    // 第二次啟動（再跑一遍完整建庫+遷移）：無害、觸發器原樣、仍可正常 UPDATE
    const db2 = await importDbAt(dbFile);
    assert.strictEqual(triggerSql(db2, 'insights_fts_ad'), adBefore, 'ad trigger unchanged after second startup');
    assert.strictEqual(triggerSql(db2, 'insights_fts_au'), auBefore, 'au trigger unchanged after second startup');
    db2.prepare("INSERT INTO insights (id, title, content) VALUES ('k1', 't', '冪等測試內容一段')").run();
    db2.prepare("UPDATE insights SET content = '冪等測試更新後內容' WHERE id = 'k1'").run();
    assert.strictEqual(ftsMatch(db2, '更新後內容').length, 1);
  });
});
