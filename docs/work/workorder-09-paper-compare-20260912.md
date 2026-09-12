# 工單 09：多篇摘要對比（優化總方案批次四，最後一批）

> 日期：2026-09-12
>
> 上位文件：`docs/work/optimization-plan-20260910.md` §3.3、§4.3。依賴工單 07（方向）、08（六維度、提取線接回 ai.js）已合入。
>
> 優先級：P1 功能，中型（一個端點、一個 prompt 模組、一個新頁面、Library 多選）
>
> Repo：`~/research-stack/co-reading`；Base：`main` @ `9a571a8`（已含 v1.2.0）
>
> 建議分支：`feat/paper-compare`
>
> 生產權限：**無**。不 push、不 build、不動 `data/`／`.env`、不打真上游（mock fetch；真上游的一發由我合併後用她的論文親手打）。她的 dev server 可能在跑，worktree 實作，自驗 `PORT=3457` + `vite --port 5174`。

## 1. 背景與動機

使用者原話（2026-09-10）：

> 「目前是不支持多个文献一起对比嘛，要先读一篇提取洞察之后再读另外一篇，那如果我需要有方法对比的话要怎么办呢？」

現況一篇論文一個聊天室，跨論文只靠 FTS 被動撈三條洞察。**不能帶多篇全文**（單篇 45k–147k 字）；但每篇都有五段結構化摘要（她六篇各 526–2161 字），正是「方法對比」的料。六維度裡的「**共振**」本來就是「兩篇互相呼應或打架」的位置，對比結果一鍵存進去。

## 2. 現況（已查，別重查）

- 路由：`papers.js` 掛在 `/api/papers`，只有 POST `/upload` 與 `/:id/...`；`chat.js` 同掛點。**新端點掛 `/api/compare`（新 router，`server.js` 加一行 `app.use('/api', compareRouter)`），不會撞 `/:id`。**
- 摘要欄位：`papers.summary_bg / summary_methods / summary_results / summary_conclusions / summary_limitations`，`analyze_status='done'` 才齊。
- AI 傳輸層可複用（工單 08 已示範）：`ai.js` 的 `getChatConfig`、`buildEndpoint`、`buildHeaders({key,format,baseUrl,scope})`、`buildBody`、`collectStream`、`completionMeta`、`responseText`、`REQUEST_TIMEOUT_MS`。**新模組 `src/compare.js` 只能 import ai.js，ai.js 不得 import 它。**
- 洞察寫入：POST `/api/insights` 收 `{dimension,title,content,source_paper_id,source_context,tags}`；`DIMENSIONS` 已 export。
- 前端：`App.jsx` 用 `page` state 切頁（`library|detail|insights|settings`），`navigate(p, id)` 存 sessionStorage；`Library.jsx:147-149` 卡片列表 `papers.map(<PaperCard paper onClick onRefresh>)`；`PaperCard` 根是 `<div class="card p-5 cursor-pointer" onClick>`；`store.js` zustand。
- 她真資料：6 篇全 `done`；有兩個方向；適合首發實彈的組合＝膽固醇蛋白冠（`jGPpnDhR…`）× Nanoplastic shape（`gW9HxlV_…`）。

## 3. 已定案語義

### 3.1 端點 `POST /api/compare`

- body `{ paper_ids: string[] }`：長度 **2–4**，否則 400；任一不存在 404；任一 `analyze_status !== 'done'` → 400 並列出哪幾篇（`{ error, not_analyzed: [{id,title}] }`）。
- 組 prompt（`src/compare.js` 純函式 `buildComparePrompt(papers, { directionsBlock })`）：
  - system：「你是科研導師，正在替研究者對比幾篇論文的結構化摘要。只能依據下面給的摘要，摘要沒寫的不要編；比不出來的格子寫『摘要未提及』。**用摘要本身的語言回答**。」＋（若有方向）工單 07 的方向區塊（用 `renderDirectionsBlock` 對**第一篇**取，其他篇的方向以「另有」形式已含在內）。
  - user：每篇一段 `## 論文 N：《標題》（作者，年份）` 接五段摘要（各截 **1500 字**）。
  - 要求嚴格輸出 JSON：
    ```json
    { "table": { "背景": {"<paper_id>": "…"}, "方法": {…}, "結果": {…}, "結論": {…}, "局限": {…} },
      "analysis": { "same": ["…"], "differ": ["…"], "conflict": ["…"], "for_her": "…" } }
    ```
    `for_her`：一段話，對照【她的研究方向】說這組對比對她的題目意味著什麼；無方向時寫空字串。
- 傳輸：`stream:true` + `collectStream`；`buildHeaders` 的 `scope:'compare'`；預算 `COMPARE_MAX_TOKENS = Number(process.env.COMPARE_MAX_TOKENS) || 6000`；`temperature 0.2`；逾時 `REQUEST_TIMEOUT_MS`；空正文診斷與 reasoning 搶救規則照工單 08（truncated 不救）。
- 解析：`table` 五個鍵都要在，缺的補 `{}`；每格缺的 paper_id 補「摘要未提及」；`analysis` 三陣列缺的補 `[]`。解析失敗 502 帶診斷。
- 回應：`{ papers:[{id,title,authors,year}], table, analysis, model, elapsed_ms }`。
- log：`[COMPARE] ids=<a,b,…> elapsed=<ms> model=<m>`。
- **不快取、不落庫**（純計算；她要留就存洞察）。

### 3.2 存成「共振」洞察

- 前端按鈕「存成共振洞察」→ POST `/api/insights`：
  - `dimension:'共振'`
  - `title`：`對比：《A 短標》× 《B 短標》`（各截 30 字，多篇用「×」串）
  - `content`：`analysis.same/differ/conflict` 各條前綴「相同／相異／打架：」逐行，最後接 `for_her`（有才接）
  - `source_paper_id`：第一篇
  - `source_context`：對比表壓成純文字（每維度一段、每篇一行）
  - `tags`：`['compare', 'paper:<id>' …所有篇]`
- 存完顯示「已存為共振洞察」並可點去洞察頁（`onNavigate('insights')`）。

### 3.3 前端

- `store.js`：`compareSelection: []`、`toggleCompare(id)`、`clearCompare()`，上限 4（第 5 個不加、按鈕提示「最多 4 篇」）；**不持久化**。
- `PaperCard`：右上角加一個 checkbox（`onClick` 要 `stopPropagation`，不觸發開論文）；只有 `analyze_status==='done'` 才可勾（否則 disabled，title「先通讀才能對比」）。
- `Library`：選了 ≥1 篇時底部（UploadZone 之上）出現一條 sticky bar：「已選 N 篇」＋「對比」（<2 篇 disabled）＋「清除」；點「對比」→ `onNavigate('compare')`。
- **新頁 `frontend/src/pages/Compare.jsx`**，`App.jsx` 加 `page === 'compare'`（sidebar 照常、不進 tabbar）。進頁即以 `store.compareSelection` 呼叫 `POST /api/compare`；loading 態顯示「對比中…（通常 30–60 秒）」；錯誤（含 `not_analyzed`）顯示可讀文案＋返回。
- 結果版面：頂列各論文標題卡（可點進 detail）；**表格**：列＝五維度，欄＝論文，格內文字可換行、`overflow-x:auto`，手機直排；表格下方三段（相同／相異／打架）＋「對你的題目」段（有才顯示）；底部「存成共振洞察」「重新對比」「返回」。
- 同一組 ids 的結果在 store 記一份（`compareResult`），返回 Library 再進來不重打；換了選擇就重打。

## 4. 實作範圍

允許：`src/compare.js`（新）、`src/routes/compare.js`（新）、`src/server.js`（掛一行）、`frontend/src/api.js`（尾端加 `compareApi`）、`frontend/src/store.js`、`frontend/src/pages/Compare.jsx`（新）、`frontend/src/pages/Library.jsx`、`frontend/src/components/PaperCard.jsx`、`frontend/src/App.jsx`（加一個 page 分支）、`.env.example`（`COMPARE_MAX_TOKENS`）、`test/`。

禁止：帶全文進 prompt；動 `analyzePaper`／`chatAboutPaper`／`memory.js`／`directions.js`／gateway；新表或 schema；`ai.js` 只准新增 export；裝套件；改 `PaperCard` 既有點擊行為；讀 `section_progress`（進階版另開）。

## 5. 紅線

- 對比 prompt **只含摘要**，斷言 prompt 長度上限（4 篇 × 5 段 × 1500 字 ＋ 骨架 < 40k 字）。
- `opencode.ai` base 帶 `x-opencode-session`、其他不帶（測試釘）。
- 存洞察走既有 POST `/api/insights`，不繞過驗證。
- 非對比頁的 Library 行為零回歸：不勾選時無 sticky bar；卡片點擊仍開論文。

## 6. 必測矩陣（mock fetch）

| 案例 | 預期 |
|---|---|
| V1 1 篇 / 5 篇 | 400 |
| V2 不存在 | 404 |
| V3 未通讀 | 400 + `not_analyzed` 列表 |
| P1 prompt | 每篇五段、各 ≤1500 字、含標題作者年份、不含 full_text 任何片段（放一個哨兵字串在 full_text 斷言不出現） |
| P2 有方向 | system 含【她的研究方向】；無方向不含且 `for_her` 說明省略 |
| H1/H2 | opencode 帶標頭／openai 不帶 |
| S1 串流 | 兩段 SSE 拼成完整 JSON |
| S2 缺格 | table 缺一維度／缺一篇 → 補齊「摘要未提及」 |
| S3 預算用盡 | 502 帶「輸出預算用盡」 |
| S4 非 JSON | 502 |
| R1 回應形狀 | papers/table/analysis/model/elapsed_ms |
| I1 存洞察 | 前端組的 body 走 POST /api/insights 得 `dimension:'共振'`、tags 含每篇 |
| 前端實彈（temp DB 假摘要 + mock 上游）| 勾選上限 4、未通讀 disabled、bar 出現/消失、進頁自動對比、表格 4 欄可捲、存洞察後洞察頁可見、返回再進不重打 |

## 7. 交付標準

- `npm test` 全綠（開工前 170）、`git diff --check`、檔案 ⊆ §4；
- 報告 `docs/work/report-09-paper-compare-20260912.md`（harness 拒寫就放最後 commit message）；
- 分階段 commit：compare.js＋路由＋測試 → store/PaperCard/Library 多選 → Compare 頁＋App → 存洞察；
- 最終回覆十行內。

## 8. 回滾

無 schema、無落庫（除她主動存的洞察）。撤代碼即回滾。

## 9. 範圍外

- 按章節抽全文段落做「實驗參數級」對比（進階，另開）
- 對比結果的歷史記錄／分享
- 五篇以上

## 附錄：實作偏離記錄

（實作者填寫）
