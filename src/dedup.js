// 落庫前的去重（工單 08 §3.4）——提取的**第二道**閘。
//
// 第一道在模型側：buildExtractSystem 把本篇已有洞察塞進 system，要求「不要重複提取語義
// 相同的條目」。模型會漏（她 13 條裡就有兩對語義重複：bigram-Jaccard 0.74 與 0.57，
// 不是逐字重複——多按幾次「提取」就多幾條），所以寫入前再用字元 bigram 的 Jaccard 擋一次。
//
// 兩條刻意的設計決定：
// 1）閾值 0.6 而不是 0.5。她資料上 0.43–0.45 那些是「同主題不同陳述」（各自有資訊），
//    壓到 0.5 會誤殺；0.57 那一對會漏，由模型側那道閘負責。寧可漏殺不誤殺。
// 2）只比**同一篇**。跨論文相似不是重複，那是「共振」「闪回」的材料（工單 §5 紅線）。
const DEFAULT_THRESHOLD = 0.6;

export const DEDUP_NEAR_THRESHOLD = Number(process.env.EXTRACT_DEDUP_THRESHOLD) || DEFAULT_THRESHOLD;

// 空白 + 中英標點。正規化只吃「排版差異」，不動字詞本身。
const NOISE = /[\s，。、；：「」『』（）()“”‘’,.;:\-—–]/g;

/**
 * 去掉空白與中英標點，讓「同一句話不同排版」正規化成同一個字串。
 * @param {string} s
 * @returns {string}
 */
export function normalizeContent(s) {
  return (s || '').replace(NOISE, '');
}

function bigrams(normalized) {
  const set = new Set();
  for (let i = 0; i + 1 < normalized.length; i++) set.add(normalized.slice(i, i + 2));
  return set;
}

/**
 * 兩段文字的字元 bigram Jaccard（內部先做 normalizeContent）。
 * 任一邊短到沒有 bigram 就回 0——一個字的「洞察」不值得拿相似度去猜。
 * @param {string} a
 * @param {string} b
 * @returns {number} 0–1
 */
export function bigramJaccard(a, b) {
  const A = bigrams(normalizeContent(a));
  const B = bigrams(normalizeContent(b));
  if (A.size === 0 || B.size === 0) return 0;
  let intersection = 0;
  for (const g of A) if (B.has(g)) intersection++;
  return intersection / (A.size + B.size - intersection);
}

/**
 * 這條 content 是不是已有條目的重複。
 * 正規化後完全相同 → exact（優先，即使它排在後面）；否則取 Jaccard 最高且 ≥ 閾值的那條 → near。
 * @param {string} content
 * @param {{id: string, content: string}[]} existing 同一篇的既有洞察
 * @param {number} [threshold]
 * @returns {{kind: 'exact'|'near', id: string, score: number} | null}
 */
export function findDuplicate(content, existing, threshold = DEDUP_NEAR_THRESHOLD) {
  const norm = normalizeContent(content);
  if (!norm) return null;

  let best = null;
  for (const row of existing || []) {
    if (!row || !row.content) continue;
    if (normalizeContent(row.content) === norm) return { kind: 'exact', id: row.id, score: 1 };
    const score = bigramJaccard(content, row.content);
    if (score >= threshold && (!best || score > best.score)) {
      best = { kind: 'near', id: row.id, score };
    }
  }
  return best;
}
