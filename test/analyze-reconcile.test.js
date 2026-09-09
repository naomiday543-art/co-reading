import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import db from '../src/db.js';
import { reconcileStuckAnalyses } from '../src/routes/papers.js';

// 2026-09-09：triggerAnalyze 是 fire-and-forget 的 in-process promise。進程一死
// （`node --watch` 存檔重啟／Ctrl-C／crash）那條 promise 就蒸發，catch 不會跑，
// 連失敗日誌都沒有，而 analyze_status 永遠停在 'analyzing'，前端一直轉圈。
// 實錄：14:25:44 與 14:25:52 開始通讀的兩篇，14:26:24 服務重啟，掛了四分半
// 零音訊，她等不到只好刪掉。
describe('啟動對帳：卡住的 analyzing', () => {
  before(() => {
    db.exec('DELETE FROM papers;');
    const insert = db.prepare(
      `INSERT INTO papers (id, title, full_text, analyze_status, analyze_error, created_at, updated_at)
       VALUES (?, ?, ?, ?, '', 1, 1)`
    );
    insert.run('stuck-1', '重啟時還在通讀的', 'text', 'analyzing');
    insert.run('stuck-2', '重啟時也還在通讀的', 'text', 'analyzing');
    insert.run('finished', '已經通讀完的', 'text', 'done');
    insert.run('waiting', '還沒開始的', 'text', 'pending');
    insert.run('failed', '真的失敗過的', 'text', 'error');
  });

  it('把 analyzing 收成 error，並留下可讀的原因', () => {
    const changed = reconcileStuckAnalyses();
    assert.equal(changed, 2);
    for (const id of ['stuck-1', 'stuck-2']) {
      const row = db.prepare('SELECT analyze_status, analyze_error FROM papers WHERE id = ?').get(id);
      assert.equal(row.analyze_status, 'error');
      assert.match(row.analyze_error, /重啟/);
    }
  });

  it('不碰 done / pending / error 的論文', () => {
    const statuses = db.prepare(
      "SELECT id, analyze_status FROM papers WHERE id IN ('finished','waiting','failed') ORDER BY id"
    ).all();
    assert.deepEqual(statuses, [
      { id: 'failed', analyze_status: 'error' },
      { id: 'finished', analyze_status: 'done' },
      { id: 'waiting', analyze_status: 'pending' },
    ]);
  });

  it('沒有卡住的論文時是 no-op', () => {
    assert.equal(reconcileStuckAnalyses(), 0);
  });
});
