# 工單 14：選一段文字問它——選取原文帶位置進討論

> 日期：2026-09-14
>
> 上位文件：她 9/14 讀到「AI 逐句伴讀」文章後的討論（記憶 `coreading-fulltext-quality-questions-20260914`）。此 repo **從沒做過**這功能（`annotations` 表有 quote/note 欄但無 API 無 UI，git log 無相關 commit）——她記得的是 `co-reading with love`。
>
> 優先級：**P1**（把「整篇顧問」推向「知道你手指按在哪一句」；她 9/11 做了閱讀模式，確實在 app 裡讀全文）
>
> Repo：`~/research-stack/co-reading`；Base：`main` @ 本工單 commit 的父 commit（含工單 12：`chatAboutPaper` 已有 stats／abort／thinking；`routes/chat.js` 已有 SSE thinking/partial/hint）
>
> 建議分支：`feat/ask-about-selection`
>
> 生產權限：**無**。不 push、不 build 安裝包、不動 `data/`／`.env`。**不打真上游**（mock fetch）。worktree 實作、`PORT=3457`。**與工單 13 並行**：13 動 `src/pdf.js`、`buildPaperBlock`／`buildAnalyzeUserContent`、`papers.js` 的 `text_meta`、`SummaryView`／`PaperDetail` 頂部提示、憲章。**本工單不要碰那些**；`src/ai.js` 只動 `chatAboutPaper` 的變動區（insightText 之後）與新增的小函式。

## 1. 使用者拍板（2026-09-14）

- 「選一段文字直接問它」——她點頭做（「現在開吧」）。
- 閱讀進度（讀到第幾節）進 prompt：**不做**（範圍外）。
- 外部檢索：**不做**。

## 2. 現況（已查，別重查）

- `frontend/src/components/FullTextView.jsx`：閱讀模式（工單 06）渲染 `paper.full_text`；目前沒有任何選取／標註互動；`grep getSelection` 全前端為 0。
- `frontend/src/components/ChatPanel.jsx`：工單 12 後 `handleSend` 走 `api.js` 的 SSE（`onDelta/onThinking/onDone/onError`），有 AbortController、`streamNote`。
- `src/routes/chat.js` 預設送出：`{ message }` → INSERT user → `chatAboutPaper(paper, history, message, onChunk, { signal, onReasoning })`。
- `src/ai.js chatAboutPaper`：system＝憲章＋論文區塊（含全文，穩定前綴）＋變動區（洞察／續窗）；`messages`＝system＋歷史＋user。**選段內容必須進變動區或 user 訊息，絕不能進穩定前綴**（會打掉 cache）。
- `messages` 表：`id, paper_id, role, content, created_at, seq, regen_versions, regen_idx, edited, edit_branches`；沒有位置欄。
- `papers.full_text` 是抽字原文（工單 13 保證不改它）；閱讀模式顯示的就是這個字串（若 FullTextView 有做段落切分／清洗，偏移要以**原字串**為準，實作者要查清楚顯示層有沒有改動文字）。

## 3. 設計（已定案，照做）

### 3.1 資料：user 訊息帶 `quote`

- `messages` 加欄 `quote TEXT DEFAULT ''`（JSON：`{ text, start, end, page:null }`，`start/end` 是 `full_text` 的字元偏移，page 留 null 給工單 13 的 `text_meta.pages` 之後回填），migration 照既有 `ALTER TABLE` try 寫法。
- `POST /api/papers/:id/chat` body 接受可選 `quote: { text, start, end }`；後端驗證：`start<end`、`end-start ≤ 4000`、且 `full_text.slice(start,end) === text`（**不相等就拒 400「選取內容與原文不一致」**，防前端偏移算錯而悄悄問錯段）。通過才寫進 `messages.quote`。
- 歷史回放：`getHistory` 把有 quote 的 user 訊息渲成 `【引用原文（第 X 段附近）】\n> …\n\n問題：…` 的**單一 content 字串**（給模型的 messages），DB 裡 `content` 仍只存她打的字。**規則要跟送出當輪一致**，這樣 cache 前綴在歷史裡也穩定。

### 3.2 給模型

- 送出當輪：user 內容＝`【引用原文（全文第 S–E 字，約第 P 段）】\n> <text>\n\n<她的問題>`；**不放進 system**。若她沒打問題只選了段（允許），問題預設「請解釋這段在說什麼、它在全文裡的作用，以及它與前後文的關係」。
- 變動區（insightText 之後）加一小段**位置脈絡**：選段前後各 600 字的原文（從 `full_text` 取，標「選段前文」「選段後文」），讓模型知道位置與上下文——這段每輪不同，本來就在變動區，不影響穩定前綴。
- 憲章不改（13 在改）；改用 user 訊息裡的一句指令：「回答時先引用你依據的原文句子（用「」標出），再說你的理解；原文沒寫的要說是你的推測。」

### 3.3 前端

- `FullTextView.jsx`：`onMouseUp`／`selectionchange` 取 `window.getSelection()`，把選取範圍映射回 `full_text` 偏移（顯示層若有段落包裝，要用 `data-offset` 之類的錨點算；**實作者先讀 FullTextView 怎麼渲染再決定映射法，並在報告寫清楚**）。選中 ≥ 8 字時在選取旁浮出一顆「問這段」按鈕（手機版：底部工具列）。
- 點「問這段」→ 把 `{text,start,end}` 放進 store 的 `pendingQuote`，切到討論面板（若閱讀模式與討論不在同一畫面，做最小的切換），`ChatPanel` 輸入框上方顯示引用卡（前 120 字＋「第 S–E 字」＋ ✕ 可取消）。送出時帶 `quote`。
- 訊息氣泡：有 quote 的 user 訊息在自己上方顯示縮起的引用塊（點開全文），點引用塊可跳回閱讀模式該位置（`scrollIntoView` 到對應錨點；做不到精確就滾到最近段落）。
- 樣式沿用現有 Tailwind token；深色模式要對。

### 3.4 日誌

- `[CHAT] start …` 行（工單 12）加 `quote=<chars>|none`。不新增其他日誌。

## 4. 紅線

- 不 push、不 build 安裝包、不動 `data/`、`.env`、`dist/`、`release/`；不打真上游；worktree、`PORT=3457`。
- **選段與脈絡絕不進穩定前綴**（憲章＋論文區塊）；`buildPaperBlock`／`buildChatSystem` 不動（13 在動）。
- `papers.full_text` 不改；偏移一律以它為準；**後端必驗 `slice===text`**。
- 不做閱讀進度、不做自動標註、不做外部檢索；不碰 `src/pdf.js`、`SummaryView`、憲章。
- `messages.content` 只存她打的字（引用另存 `quote`），避免污染搜尋與提取。

## 5. 驗證計畫（mock；實作者做，我複跑）

1. 後端：帶 quote 且 `slice===text` → 200，DB `quote` 欄有值，送模型的最後一則 user content 含「【引用原文」與她的問題；`slice!==text` → 400；`end-start>4000` → 400。
2. 歷史回放：兩輪對話第一輪有 quote，第二輪送模型的 messages 裡第一輪 user 是渲染後的字串，且與第一輪送出當時逐字相同（cache 穩定）。
3. 變動區：含選段前後文各 ≤600 字；穩定前綴（system 前兩塊）與不帶 quote 時**逐字相同**。
4. 空問題只選段 → 用預設問題。
5. 前端：node:test 釘偏移映射函式（給一段有段落包裝的 DOM 模型，選取 → 偏移正確、跨段落也正確）；`npm run build` 過。
6. `[CHAT] start` 行含 `quote=`。
7. `npm test` 全綠（現 252/252）、`git diff --check` 乾淨。

## 6. 交付

分支 `feat/ask-about-selection`，分階段 commit（migration＋API／prompt／前端選取／前端引用卡與氣泡／測試），每顆帶測試數字；報告 `docs/work/report-14-ask-about-selection-20260914.md`（harness 拒寫就放最後 commit message）：changed-file list、沒改什麼、偏移映射法說明、測試數字、真實 smoke「未做」、偏離逐條。最終回覆十行內。

## 7. needs-decision

無。
