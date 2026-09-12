// 工單 08 §3.4：落庫前去重的純函式。
// 閾值 0.6 是拍板值——她資料上真重複 0.74／0.57（0.57 那對故意漏，交給模型側那道閘），
// 0.43–0.46 那些是「同主題不同陳述」，壓到 0.5 會誤殺。寧可漏殺不誤殺。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeContent, bigramJaccard, findDuplicate, DEDUP_NEAR_THRESHOLD } from '../src/dedup.js';

describe('normalizeContent', () => {
  it('去掉空白與中英標點，字詞本身不動', () => {
    assert.equal(normalizeContent('膽固醇，會改變蛋白冠的組成。'), '膽固醇會改變蛋白冠的組成');
    assert.equal(normalizeContent('  膽固醇 會 改變\n蛋白冠 '), '膽固醇會改變蛋白冠');
    assert.equal(normalizeContent('SGLT2「抑制劑」（近端腎小管）'), 'SGLT2抑制劑近端腎小管');
    assert.equal(normalizeContent('a-b—c–d'), 'abcd');
    assert.equal(normalizeContent('“quoted”, ‘single’; x.y:z'), 'quotedsinglexyz');
  });

  it('空值與 undefined 回空字串', () => {
    assert.equal(normalizeContent(''), '');
    assert.equal(normalizeContent(undefined), '');
    assert.equal(normalizeContent(null), '');
  });
});

describe('bigramJaccard', () => {
  it('正規化後相同 → 1', () => {
    assert.equal(bigramJaccard('膽固醇，會改變蛋白冠的組成。', '膽固醇會改變蛋白冠的組成'), 1);
  });

  it('完全不同 → 0', () => {
    assert.equal(bigramJaccard('奈米塑膠', '腎小管'), 0);
  });

  it('短到沒有 bigram → 0（不拿相似度猜一個字）', () => {
    assert.equal(bigramJaccard('好', '好'), 0);
    assert.equal(bigramJaccard('', '蛋白冠的組成'), 0);
  });

  it('對稱', () => {
    const a = '膽固醇會改變奈米粒子表面蛋白冠的組成';
    const b = '膽固醇改變了奈米粒子表面蛋白冠的組成';
    assert.equal(bigramJaccard(a, b), bigramJaccard(b, a));
  });

  it('真重複與同主題不同陳述分得開（這兩個數字就是閾值的依據）', () => {
    const near = bigramJaccard('膽固醇會改變奈米粒子表面蛋白冠的組成', '膽固醇改變了奈米粒子表面蛋白冠的組成');
    const sameTopic = bigramJaccard('膽固醇會改變奈米粒子表面蛋白冠的組成', '膽固醇也會改變奈米粒子表面的蛋白吸附量');
    assert.ok(near >= 0.6, `近重複應 ≥0.6，實際 ${near}`);
    assert.ok(sameTopic > 0.4 && sameTopic < 0.6, `同主題不同陳述應落在 0.4–0.6，實際 ${sameTopic}`);
  });
});

describe('findDuplicate', () => {
  const existing = [
    { id: 'a1', content: '膽固醇會改變奈米粒子表面蛋白冠的組成' },
    { id: 'a2', content: '靜態血清是否代表循環環境，尚未有人驗證' },
  ];

  it('閾值預設 0.6', () => {
    assert.equal(DEDUP_NEAR_THRESHOLD, 0.6);
  });

  it('正規化後完全相同 → exact', () => {
    const hit = findDuplicate('膽固醇會改變奈米粒子表面蛋白冠的組成。', existing);
    assert.deepEqual(hit, { kind: 'exact', id: 'a1', score: 1 });
  });

  it('≥0.6 → near，帶 score 與命中的 id', () => {
    const hit = findDuplicate('膽固醇改變了奈米粒子表面蛋白冠的組成', existing);
    assert.equal(hit.kind, 'near');
    assert.equal(hit.id, 'a1');
    assert.ok(hit.score >= 0.6, hit.score);
  });

  it('0.46 那種同主題不同陳述 → null（不誤殺）', () => {
    assert.equal(findDuplicate('膽固醇也會改變奈米粒子表面的蛋白吸附量', existing), null);
  });

  it('exact 優先於 near，即使 exact 排在後面', () => {
    const pool = [
      { id: 'near1', content: '膽固醇改變了奈米粒子表面蛋白冠的組成' },
      { id: 'exact1', content: '膽固醇會改變奈米粒子表面蛋白冠的組成' },
    ];
    assert.deepEqual(
      findDuplicate('膽固醇會改變奈米粒子表面蛋白冠的組成', pool),
      { kind: 'exact', id: 'exact1', score: 1 },
    );
  });

  it('多條都過閾值時取分數最高的', () => {
    const pool = [
      { id: 'lower', content: '膽固醇會改變奈米粒子表面蛋白的吸附量' },
      { id: 'higher', content: '膽固醇改變了奈米粒子表面蛋白冠的組成' },
    ];
    const hit = findDuplicate('膽固醇會改變奈米粒子表面蛋白冠的組成', pool);
    assert.equal(hit.id, 'higher');
  });

  it('空池、空內容、壞 row 都不炸', () => {
    assert.equal(findDuplicate('隨便一句話的內容', []), null);
    assert.equal(findDuplicate('隨便一句話的內容', undefined), null);
    assert.equal(findDuplicate('', existing), null);
    assert.equal(findDuplicate('隨便一句話的內容', [null, {}, { id: 'x' }]), null);
  });

  it('閾值可由呼叫端覆蓋（env EXTRACT_DEDUP_THRESHOLD 走同一個參數）', () => {
    const content = '膽固醇也會改變奈米粒子表面的蛋白吸附量';
    assert.equal(findDuplicate(content, existing), null);
    const hit = findDuplicate(content, existing, 0.4);
    assert.equal(hit.kind, 'near');
    assert.equal(hit.id, 'a1');
  });
});
