# 工單 20：方向線——精煉餵進「研究方向」而不是單篇

**日期**：2026-09-19　**狀態**：她已點頭總設想（`vision-research-map-20260918.md` 步驟 1），直接做
**基線**：`main` @ `08c0f11`　**分支**：`feat/wo20-direction-line`
**前置**：總設想步驟 0 ✅（gateway 精煉 9/19 16:02 生產第一次成功）；她 9/19 已把 10 篇全掛到方向（nano plastics 6／py-GCMS 3／高分論文閱讀 1）
**姊妹單**：gateway `workorder-refine-claims-paper-tag-20260919.md`（獨立、可先後任一順序上）

---

## 一、目標與非目標

**目標**：她在任一篇論文按「精煉本次共讀」時，那一篇的新對話送進**該篇所屬頂層方向**的研究線（`topic:<方向節點 id>`），而不是單篇線。同方向第二篇進來時，模型看得到第一篇留下的 claims，跨篇的支持／矛盾／取代開始長出來。

**非目標**：畫圖（步驟 2）；「研究進度」新頁；自動精煉；改 gateway 契約（payload 欄位不加）；改提取線／洞察庫；改 `REFINE_PROMPT`。

## 二、現況（已查，引 `檔案:行號`）

- `src/carryover.js:18` `sessionKeyFor(paperId)` 固定回 `paper:<id>`；`:31` `buildRefineRequest` 送 `session_key`／`paper_id`／`paper_title`／`transcript`／`since_seq`／`insights`。
- `:94` `requestRefine`：`since_seq` 取自 `carryover_cache.last_seq`（**以 session_key 為鍵，一條線只有一個游標**）；成功後 `cacheCarryover` 以 `session_key` 存 payload＋`last_seq=maxSeq`。
- `:229` `renderCarryoverForInjection(paperId)` 用 `sessionKeyFor(paperId)` 讀快取；呼叫點 `src/ai.js:1385`。「帶上」開關 `settings` 表 `carryover_inject:<paperId>`（`:76`／`:82`）。
- 路由 `src/routes/papers.js:395`（refine）、`:415`（GET carryover）、`:436`（inject）都以 `sessionKeyFor(paper.id)` 取鍵。
- `src/directions.js:76` **已有** `directionOfPaper(paperId)`：沿 `parent_id` 走到頂層節點，回 `{id,name,description}` 或 null（MAX_DEPTH 防環）。
- gateway 側：`session_key` 正則 `^(paper|topic):[A-Za-z0-9_-]+$`（nanoid 字元集剛好符合）；`since_seq` 只是對**我送去的 transcript** 做 `seq > since_seq` 過濾；冪等鍵＝`(session_key, sha256(transcript))`；`paper_id` 在 topic 線也會印進 prompt 的「## 論文」段；既有 claims 全線列給模型。⇒ **gateway 不用改就能收方向線**。
- 前端 `CarryoverPanel.jsx:137` `load()` 打 `papersApi.getCarryover(paperId)`；`PaperDetail.jsx:438` 「分類」區塊＝掛方向的地方（她 9/19 問「怎麼掛」找了很久）。
- 測試基線：`npm test` 484／484；`test/carryover.test.js` 已有假 gateway 寫法。

## 三、設計

### A1 鍵的解析：`resolveSessionKey(paperId)`（`src/carryover.js`）
- `directionOfPaper(paperId)` 有頂層節點 → `topic:<node.id>`；沒掛 → `paper:<id>`（照舊）。
- 節點 id 不符 `^[A-Za-z0-9_-]+$` → 退回 `paper:<id>` 並 `log('WARN', '[CARRYOVER] direction id 不合契約，退回單篇線')`。
- 回 `{ sessionKey, scope: 'direction'|'paper', direction: {id,name}|null }`。`sessionKeyFor` 保留給單篇鍵。
- 所有讀寫鍵的地方（`buildRefineRequest`／`requestRefine`／`renderCarryoverForInjection`／三條路由）改用它。

### A2 每篇一個游標：新表 `refine_cursor`
```sql
CREATE TABLE IF NOT EXISTS refine_cursor (
  paper_id       TEXT PRIMARY KEY REFERENCES papers(id) ON DELETE CASCADE,
  session_key    TEXT NOT NULL,        -- 這次精煉送去的線
  last_seq       INTEGER NOT NULL,
  covered_digest TEXT NOT NULL,        -- sha256(seq|role|content of messages seq<=last_seq)
  updated_at     INTEGER NOT NULL
);
```
- `src/db.js` 照既有 `CREATE TABLE IF NOT EXISTS` 冪等寫法（不做舊 `carryover_cache.last_seq` 搬遷：她只有一篇有舊游標且已改掛方向，重送全文正確）。
- `requestRefine` 的 `since_seq`：**游標存在且 `session_key` 相同**才用 `last_seq`；線換了（例如從單篇改掛方向）→ `null` 全文重送。成功後寫游標（`last_seq=maxSeq`、`covered_digest`）。
- `carryover_cache` 仍以 `session_key` 存 payload（方向線＝一份共用）；它的 `last_seq` 欄不再讀（留著不動）。

### A3 「對話改過了」＝她拍板的手動型（總設想 §九 ③）
- `refineStaleness(paperId)`：游標存在 → 重算 `seq<=last_seq` 的 digest 與 `covered_digest` 比 → 不同＝`stale:true`。無游標＝`never`；相同＝`fresh`。
- `GET /api/papers/:id/carryover` 回應加 `session_key`／`scope`／`direction`／`refine_state: 'never'|'fresh'|'stale'|'new_messages'`（有游標且 maxSeq>last_seq＝`new_messages`）。
- `POST /api/papers/:id/refine` 收 `{ full: true }` → `since_seq=null` 全文重送（gateway 冪等鍵是 transcript 指紋，改過的內容指紋不同，會真跑；模型會對既有 claims 下 UPDATE／SUPERSEDE）。**系統絕不自動重跑。**
- 面板：`stale` 時在觸發列顯示 `⚠ 這篇的對話改過了` ＋ 按鈕「重新精煉這篇」（呼叫 `full:true`）；`new_messages` 時按鈕文字維持「精煉本次共讀」。

### A4 面板標頭讓她看得出在哪條線
- 觸發列右側小字：`scope==='direction'` → `研究續窗 · 方向：<name>`；`paper` → `研究續窗 · 本篇`。展開後六段照舊（方向級內容；「只看這篇貢獻」等步驟 2 的 `/claims` 補欄位）。
- 「帶上」仍 per-paper 開關，注入的是解析後那條線的 payload。

### A5 「分類」改名「方向」
`PaperDetail.jsx:438` 的 h3 文字與按鈕預設「未分類」→「方向」／「未掛方向」。只改字，不搬位置（搬到標題旁是步驟 2 的頁面工作）。

## 四、紅線
1. gateway 契約 payload **不加欄位**（`session_key`／`paper_id`／`paper_title`／`transcript`／`since_seq`／`insights` 六個，一個不多）。
2. 不動 `src/memory.js`（提取線）、`EXTRACT_PROMPT`、洞察表、`insight_links`。
3. `src/ai.js` 只准改 `:1385` 那一行的呼叫方式（如需）；注入文字格式 `renderCarryoverForPrompt` 不動。
4. 不自動精煉、不自動重跑（她 8/29 ＋ 9/18 兩次拍板）。
5. 沒掛方向的論文行為與今日 byte-identical（測試釘住：鍵、body、路由回應多出的欄位除外）。
6. 不部署、不 push；她本機 `data/co-reading.db` 不碰（測試用 setup-data-dir 的臨時目錄）。

## 五、範圍外
- 「研究進度」新頁、圖、`/claims` 補欄位、「這個方向還有 N 篇沒精煉」（步驟 2）。
- 舊單篇線的 claims（Py-GC/MS 篇 12 條在 `paper:S0a0…`）：留在 gateway 不清；她改掛方向後第一次精煉會在 `topic:` 線重建。
- 把方向按鈕搬到標題旁。

## 六、驗證
**agent**：`npm test` 全綠報數字；新測試（`test/carryover-direction.test.js`）：
1. `resolveSessionKey`：頂層→`topic:`；子節點→頂層 `topic:`；未掛→`paper:`；壞字元→`paper:`＋WARN。
2. 游標：首次 `since_seq=null`；成功後寫入；同線第二次送 `last_seq`；線換了送 `null`。
3. staleness：改一則 `seq<=last_seq` 的 content → `stale`；加新訊息 → `new_messages`；都沒 → `fresh`；無游標 → `never`。
4. `full:true` → body `since_seq=null`。
5. 假 gateway 抓到的 body 六欄且 `session_key` 為 `topic:<id>`、`paper_id` 為該篇。
6. 未掛方向的論文：body 與改前 deepEqual。
**我**：親跑測試、diff 白名單、瀏覽器親手：對 py-GCMS 方向的 NIST 篇按精煉（真 gateway，這是她要的真資料）→ 面板標頭「方向：py-GCMS」→ gateway `rc_claims` 出現 `topic:` 線且有跨篇關係或至少兩篇 claims 並存 → 再對 PE/PVC 篇按 → 看 contradicts／supports 有沒有跨篇。**跨篇邊長不出來＝總設想 §三的假設不成立，記錄後另議 prompt 明示，不在本單修。**

## 七、交付
分三個 commit（A1+A2／A3／A4+A5），每個帶測試；報告 `docs/work/report-20-direction-line-20260919.md`（changed-file list、沒改什麼、測試數字、假 gateway 抓到的 body 原文一份）；偏離寫本檔附錄 A；最終回覆十行內。commit 結尾 `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`。

---

## 附錄 A：實作偏離（2026-09-19，tip `d97f7d1`）

設計 A1–A5 全部照做，以下五處與工單字面不同，都是為了測得到或不去動她正在跑的東西：

1. **`directionOfPaper` 多了一個 `database` 注入口。** 工單 §二寫它「現成可用」，但它綁在 module 層的 `db` 上，鍵解析就測不了記憶體 DB。改成 `directionOfPaper(paperId, { database = db } = {})`，**既有三個呼叫點一個字都不用改**，`directions.test.js` 全綠。
2. **`test/carryover.test.js` 的 fixture 補了三處 schema**（`papers.tree_node_id`、`tree_nodes` 表、`refine_cursor` 表）。原 fixture 沒有這些表，鍵解析會在查方向時拋（生產 schema 有，所以這是把 fixture 補成真的，不是遷就）。**12 條斷言一條沒改，全綠**——這就是紅線 5「未掛方向零回歸」的活證據。
3. **`requestRefine` 的回傳與 `POST /refine` 的回應多了 `session_key`／`scope`／`direction`。** 工單 A3 只寫 GET 加欄位。多這三欄是**自家 API 的回應**，不是出海 payload（紅線 1 只管出海），面板精煉完才知道自己剛餵進哪條線。前端實際上是精煉後再 `load()` 一次，這三欄目前只作記錄與除錯用。
4. **`npm run build` 建到暫存目錄驗，沒有覆蓋 `dist/`。** 她的 `npm start`／`npm run dev` 靠 `dist/` 出畫面，覆蓋等於當場換掉她正在看的頁面。build 綠（311 modules），`dist/` mtime 仍是 9/14。**代價：A4／A5 的畫面要等她自己 build。**
5. **她的 `node --watch` 自己重啟了 12 次，並把 `refine_cursor` 建進了 live DB**（唯讀確認：表在、0 列、`carryover_cache` 原有那列沒動）。我沒有下過重啟命令，也沒有寫過 `data/`；是改 `src/` 觸發她自己的 watch。記在這裡是因為紅線 6 提到那顆 DB。
