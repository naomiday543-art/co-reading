// 工單 09 §3.3：對比的前端狀態（勾選上限、不持久化、結果 key）。
//
// frontend/src/store.js 是純 JS（zustand），node 直接 import 得動——勾選邏輯與
// 洞察 body 的組法都是純函式，不必開瀏覽器就能釘住。版面與互動另有實彈驗收。
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  useStore,
  COMPARE_MIN,
  COMPARE_MAX,
  compareKey,
} from '../frontend/src/store.js';

const reset = () => useStore.setState({ compareSelection: [], compareResult: null });

describe('compareSelection 勾選態', () => {
  beforeEach(reset);

  it('上下限就是後端的 2–4', () => {
    assert.equal(COMPARE_MIN, 2);
    assert.equal(COMPARE_MAX, 4);
  });

  it('toggle 加入、再 toggle 移除，順序照勾選順序', () => {
    const { toggleCompare } = useStore.getState();
    toggleCompare('p1');
    toggleCompare('p2');
    assert.deepEqual(useStore.getState().compareSelection, ['p1', 'p2']);

    toggleCompare('p1');
    assert.deepEqual(useStore.getState().compareSelection, ['p2']);
  });

  it('滿 4 篇後第 5 個不加（既有 4 篇原封不動）', () => {
    const { toggleCompare } = useStore.getState();
    for (const id of ['p1', 'p2', 'p3', 'p4', 'p5']) toggleCompare(id);

    assert.deepEqual(useStore.getState().compareSelection, ['p1', 'p2', 'p3', 'p4']);
  });

  it('滿了還是能取消已勾的（不是整條鎖死）', () => {
    const { toggleCompare } = useStore.getState();
    for (const id of ['p1', 'p2', 'p3', 'p4']) toggleCompare(id);
    toggleCompare('p2');

    assert.deepEqual(useStore.getState().compareSelection, ['p1', 'p3', 'p4']);
  });

  it('clearCompare 清空', () => {
    const { toggleCompare, clearCompare } = useStore.getState();
    toggleCompare('p1');
    toggleCompare('p2');
    clearCompare();
    assert.deepEqual(useStore.getState().compareSelection, []);
  });

  it('不持久化：store 沒碰 localStorage，初始值是空陣列', () => {
    // 勾選是一次動作不是偏好——這裡釘住「沒有 compare 的 storage key」。
    const src = readStoreSource();
    assert.ok(
      !/compare[^\n]*localStorage|localStorage[^\n]*compare/i.test(src),
      'compareSelection 不該寫進 localStorage',
    );
  });
});

describe('compareKey', () => {
  it('排序後 join：勾選順序不同但同一組＝同一個 key', () => {
    assert.equal(compareKey(['b', 'a']), compareKey(['a', 'b']));
    assert.equal(compareKey(['a', 'b']), 'a,b');
  });

  it('不同組就是不同 key（換了選擇要重打）', () => {
    assert.notEqual(compareKey(['a', 'b']), compareKey(['a', 'c']));
  });

  it('不改動傳進來的陣列', () => {
    const ids = ['b', 'a'];
    compareKey(ids);
    assert.deepEqual(ids, ['b', 'a']);
  });
});

function readStoreSource() {
  return readFileSync(new URL('../frontend/src/store.js', import.meta.url), 'utf8');
}
