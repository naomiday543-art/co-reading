// 討論線「打上游之前」的本地同步工作計時 —— 只對 DB 唯讀副本跑，不碰她的原檔。
// 用法：CO_READING_DATA_DIR=<copy-dir> node local-timing.mjs
const SRC = process.env.CR_SRC || '/Users/laine/research-stack/co-reading/src';
const db = (await import(`${SRC}/db.js`)).default;
const { searchInsights } = await import(`${SRC}/search.js`);
const { renderCarryoverForInjection } = await import(`${SRC}/carryover.js`);
const { loadConstitution } = await import(`${SRC}/constitution.js`);
const { buildDirectionsContext } = await import(`${SRC}/directions.js`);
const { buildChatSystem, buildPaperBlock } = await import(`${SRC}/ai.js`);

const N = 20;
function bench(label, fn) {
  fn(); // warm
  const t0 = process.hrtime.bigint();
  let out;
  for (let i = 0; i < N; i++) out = fn();
  const t1 = process.hrtime.bigint();
  const ms = Number(t1 - t0) / 1e6 / N;
  console.log(`${label.padEnd(42)} ${ms.toFixed(3)} ms   ${typeof out === 'string' ? `(${out.length} 字)` : ''}`);
  return out;
}

// 粗略 token 估：CJK 1 字 ≈ 1 token；其餘 ≈ 4 字元/token
function estTokens(s) {
  if (!s) return 0;
  const cjk = (s.match(/[㐀-鿿豈-﫿　-〿＀-￯]/g) || []).length;
  return Math.round(cjk + (s.length - cjk) / 4);
}

const papers = db.prepare('SELECT * FROM papers ORDER BY length(full_text) DESC').all();
const target = process.argv[2] || papers[0].id;
const paper = papers.find(p => p.id === target) || papers[0];
const userMessage = '用一句話說這篇在做什麼';

console.log(`\n=== 論文 ${paper.id} / ${paper.title.slice(0, 50)} / full_text=${paper.full_text.length} 字 ===\n`);

bench('loadConstitution()（每輪讀檔）', () => loadConstitution().text);
bench('buildDirectionsContext()（樹查詢）', () => buildDirectionsContext(paper.id).block);
bench('own insights SELECT (LIMIT 5)', () => JSON.stringify(db.prepare(
  'SELECT dimension, title, content FROM insights WHERE source_paper_id = ? ORDER BY updated_at DESC LIMIT 5'
).all(paper.id)));
bench('searchInsights() FTS5 trigram', () => JSON.stringify(searchInsights(userMessage, { excludePaperId: paper.id, limit: 3 })));
bench('renderCarryoverForInjection()', () => renderCarryoverForInjection(paper.id));
bench('getHistory() 全量歷史 SELECT', () => JSON.stringify(db.prepare(
  'SELECT role, content FROM messages WHERE paper_id = ? ORDER BY seq ASC'
).all(paper.id)));
bench('SELECT * FROM papers WHERE id=?（含全文）', () => db.prepare('SELECT * FROM papers WHERE id = ?').get(paper.id).full_text);
const paperBlock = bench('buildPaperBlock()（字串拼接 + 截斷）', () => buildPaperBlock(paper));
const sys = bench('buildChatSystem()（openai 格式）', () => buildChatSystem(paper, {
  constitution: loadConstitution().text,
  format: 'openai',
  directionsBlock: buildDirectionsContext(paper.id).block,
}));

// 整條「打上游之前」的路徑
const t0 = process.hrtime.bigint();
for (let i = 0; i < N; i++) {
  const c = loadConstitution().text;
  const d = buildDirectionsContext(paper.id);
  buildChatSystem(paper, { constitution: c, format: 'openai', directionsBlock: d.block });
  db.prepare('SELECT dimension, title, content FROM insights WHERE source_paper_id = ? ORDER BY updated_at DESC LIMIT 5').all(paper.id);
  searchInsights(userMessage, { excludePaperId: paper.id, limit: 3 });
  renderCarryoverForInjection(paper.id);
  db.prepare('SELECT role, content FROM messages WHERE paper_id = ? ORDER BY seq ASC').all(paper.id);
}
const t1 = process.hrtime.bigint();
console.log(`\n${'本地同步工作合計（一輪）'.padEnd(38)} ${(Number(t1 - t0) / 1e6 / N).toFixed(3)} ms\n`);

// prompt 規模
const history = db.prepare('SELECT role, content FROM messages WHERE paper_id = ? ORDER BY seq ASC').all(paper.id);
const historyChars = history.reduce((n, m) => n + m.content.length, 0);
console.log('--- prompt 規模 ---');
console.log(`constitution      ${loadConstitution().text.length} 字 ≈ ${estTokens(loadConstitution().text)} tok`);
console.log(`paperBlock        ${paperBlock.length} 字 ≈ ${estTokens(paperBlock)} tok  (實測比例 3.90 字/tok ⇒ ${Math.round(paperBlock.length / 3.9)} tok)`);
console.log(`system 全部       ${sys.length} 字 ≈ ${estTokens(sys)} tok  (3.90 ⇒ ${Math.round(sys.length / 3.9)} tok)`);
console.log(`history           ${history.length} 條 / ${historyChars} 字 ≈ ${estTokens(history.map(h => h.content).join(''))} tok`);
console.log(`一輪 prompt 合計  ${sys.length + historyChars} 字 ≈ ${estTokens(sys) + estTokens(history.map(h => h.content).join(''))} tok`);

console.log('\n--- 每篇論文的「單輪 system」規模 ---');
for (const p of papers) {
  const blk = buildChatSystem(p, { constitution: loadConstitution().text, format: 'openai', directionsBlock: buildDirectionsContext(p.id).block });
  const h = db.prepare('SELECT content FROM messages WHERE paper_id = ? ORDER BY seq ASC').all(p.id);
  const hc = h.reduce((n, m) => n + m.content.length, 0);
  console.log(`${p.id}  full=${String(p.full_text.length).padStart(6)}  sys=${String(blk.length).padStart(6)}字/${String(Math.round(blk.length / 3.9)).padStart(5)}tok  hist=${String(h.length).padStart(2)}條/${String(hc).padStart(5)}字  總≈${String(Math.round((blk.length + hc) / 3.9)).padStart(5)}tok`);
}
