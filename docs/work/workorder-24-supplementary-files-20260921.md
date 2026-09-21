# 工單 24：補充文件（SI）掛進同一個閱讀框

**日期**：2026-09-21　**狀態**：她提需求（見 §一原話），第一、二層直接做；第三層擱置待喚醒
**基線**：`main` @ `57f1c06`（工作樹乾淨，測試基線 588）　**分支**：`feat/wo24-supplementary-files`
**前置**：工單 13（全文上限／text_meta）✅、工單 14（選段問它，quote 綁 `full_text` 絕對偏移）✅、工單 07（方向區塊接在論文區塊後、同一個 cache block）✅
**性質**：一張新表＋一組子路由＋原文分頁多一排「文件切換」＋討論線 system 多一個 SI 區塊。**`papers.full_text` 一個字不碰。**

## 一、她要什麼
> 「文獻會有 SI 文件，那能增加同一個閱讀框內添加 supplementary 文件嗎？」

現在一篇論文＝一個 PDF。方法細節、Table S、Fig. S 都在 SI 裡，她得另開 Preview 看，AI 也完全不知道 SI 存在。她要的是：SI 跟正文住同一個閱讀框，切一下就看；問 AI 的時候它也讀得到。

## 二、分層（給她看的那張表）
| 層 | 買到什麼 | 這單做不做 |
|---|---|---|
| 一 | SI（PDF）掛到論文上，在「原文」分頁裡切換著看（PDF 原檔／文字版），能改名、能刪 | ✅ 做 |
| 二 | 討論時 AI 讀得到 SI 文字（逐份可關；有獨立字數上限） | ✅ 做 |
| 三 | SI 文字版也能「問這段」；docx／xlsx；通讀摘要也吃 SI；SI 圖表走 vision | ❌ 範圍外（§六寫喚醒條件） |

## 三、設計

### D1 資料（`src/db.js`，照既有 idempotent 慣例，`CREATE TABLE IF NOT EXISTS`）
```sql
CREATE TABLE IF NOT EXISTS paper_attachments (
  id TEXT PRIMARY KEY,
  paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'si',
  label TEXT NOT NULL DEFAULT '',            -- 她看到的名字；預設＝原始檔名去副檔名
  original_name TEXT NOT NULL DEFAULT '',
  filename TEXT NOT NULL,                    -- 磁碟檔名：si-<nanoid>.pdf，住 dataPaths.pdfDir
  mime TEXT NOT NULL DEFAULT 'application/pdf',
  size_bytes INTEGER NOT NULL DEFAULT 0,
  extracted_text TEXT NOT NULL DEFAULT '',   -- 掃描版＝空字串（仍可看 PDF）
  ai_visible INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_paper_attachments_paper ON paper_attachments(paper_id, sort_order);
```
磁碟檔放 `dataPaths.pdfDir`（與正文同目錄、`si-` 前綴）：零新路徑、既有備份天然涵蓋。已查證全倉沒有孤兒 PDF 清理邏輯（`pdfDir` 使用點只有 `paths.js`／`server.js:23`／`routes/papers.js` 五處）。

### D2 後端路由（新檔 `src/routes/attachments.js`，掛在 `/api/papers/:id/attachments`；`src/server.js` 註冊）
- `GET /` → 列表，**不含** `extracted_text`，帶 `chars`（文字長度）、`has_text`、`ai_visible`、`ai_chars_sent`（依 D3 預算實際會送幾字）、`truncated`。
- `POST /`（multer，欄位名 `files`，可多檔）→ 只收 PDF（副檔名 `.pdf` **且** mimetype `application/pdf`，其餘 400「目前只支援 PDF 的補充文件」並刪掉暫存檔）；50MB；每篇最多 10 份（超過 400）。抽字用 `extractPDFDetailed`；`SCANNED_PDF` **不算錯**——`extracted_text=''` 照樣入庫。**不觸發通讀、不動 `papers` 任何欄位。**
- `GET /:aid/file` → 串流原檔。`Content-Disposition: inline; filename*=UTF-8''<encodeURIComponent(original_name)>`——**中文檔名絕不裸進 header**（家裡 7/8 踩過）。
- `GET /:aid/text` → `{ text }`（文字版用；列表不背全文）。
- `PATCH /:aid` → 只准改 `label`（trim、≤120 字）、`ai_visible`（0/1）、`sort_order`。
- `DELETE /:aid` → 先刪磁碟檔再刪列。
- **所有 `:aid` 查詢一律 `WHERE id = ? AND paper_id = ?`**（拿別篇論文的 aid 進來 → 404）。paper 不存在 → 404。
- `src/routes/papers.js` 的 `DELETE /:id`：刪論文**之前**先撈該篇所有 attachments 的 `filename` 逐一 `unlinkSync`（FK CASCADE 只帶走列，帶不走磁碟檔）。這是本單對 `papers.js` 唯一的改動。
- 日誌：`[SI] upload paper=<id> aid=<aid> chars=<n> scanned=<bool>`／`[SI] delete …`。

### D3 AI 讀得到（`src/ai.js`，只動討論線）
- 新 `resolvePaperSiLimit()`：env `PAPER_SI_LIMIT_CHARS`，預設 `100000`，clamp `[0, 1000000]`，**`0`＝整個 SI 注入關掉**。寫法照抄 `resolvePaperFulltextLimit()`（每次呼叫重讀 env）。
- 新 `renderSiBlock(paperId)`（export，純查庫＋組字串）：取 `ai_visible=1` 的 attachments 依 `sort_order, created_at`，**合計**預算＝上限，依序填、填滿就截。格式：
  ```
  以下是這篇論文的補充材料（Supplementary Information，共 N 份）。回答用到時請說明出自哪一份 SI；沒列在這裡的補充材料你讀不到，不要推測。

  【SI 1：<label>】
  <text>

  【SI 2：<label>】（只給了前 X 字，全長 Y 字）
  <text 前 X 字>

  【SI 3：<label>】（掃描版，抽不到文字——這份你讀不到）
  ```
  預算用完後剩下的份：只列標題行＋「（超出字數預算，這份沒給你）」。**不對 SI 跑 `stripReferences`**。
- 注入點：`buildChatSystem` 裡 **論文區塊 → SI 區塊 → 方向區塊**，同一個 cache block、不另開 `cache_control`（掛／卸 SI 冷一次，可接受）。`buildChatSystem` 多收一個可選 `siBlock`（`undefined` → 自己查；呼叫端可傳入）。**沒有任何可見 SI 時區塊是空字串、連換行都不加 ⇒ 輸出與現在逐字相同**（釘在既有快照 `test/fixtures/chat-system-no-directions.json` 上）。
- **絕不放進變動區 `insightText`**（那樣每輪白付 SI 的 token）。**`buildPaperBlock`／`buildAnalyzeUserContent`／通讀線一律不動。**
- `[CHAT]` 日誌行加 `si=<份數>/<送出字數>`（觀察哨）。

### D4 閱讀框（`frontend/src/components/FullTextView.jsx` ＋ `frontend/src/api.js`）
- `api.js` 加 `attachmentsApi`：`list/upload/text/patch/remove`。
- `FullTextView` 頂部多一排「文件切換」chips：`正文`｜`SI 1 · <label>`｜…｜`＋ 補充文件`。**一份 SI 都沒有時，只有一顆淡色小鈕「＋ 補充文件」**（不打擾原本的版面）。`＋` 開檔案選擇器（`accept=".pdf"`，可多選），上傳中 chip 顯示轉圈，失敗把後端的中文錯誤原樣顯示。
- 選到 SI：沿用同一顆 PDF／文字版切換。PDF＝iframe 指 `/:aid/file`；文字版＝`GET /:aid/text` 後 `\n{2,}` 分段的純段落（**沒有「問這段」**，那是第三層；底下小字寫明「SI 文字版暫不支援選段提問」）。掃描版 SI 只有 PDF 模式。
- 選到 SI 時 chips 下方一行小工具列：`N 字`、`AI 讀得到` 開關（PATCH `ai_visible`；被截斷時顯示「AI 只讀前 X 字」、被預算擠掉時顯示「超出預算，AI 沒讀到」）、改名（行內 input，Enter 存、Escape 取消）、刪除（二次確認）。
- **`quoteJump` 進來時（她點氣泡上的引用塊要跳回原文）→ 先切回 `正文` 再走既有跳轉**。既有「自動切文字版」那顆 effect 要一起考慮，別讓兩顆 effect 打架。
- 當前選的文件**不存 localStorage**（換論文回到正文）；PDF／文字模式照舊共用 `co-reading:fulltext-mode`。
- `pages/PaperDetail.jsx`：「原文」tab 標籤在有 SI 時顯示小字 `原文 · SI N`。其餘不動。

## 四、紅線
1. **`papers.full_text`、`text_meta`、`messages.quote` 的偏移語義零改動**——SI 文字永不拼進 `full_text`（既有 quote 每次送出與回放都重驗 `full_text.slice(start,end)===text`；而且 `pdf.js:137` 把 `Supplementary information` 當參考文獻區塊的終點標題，拼進去會讓切除邏輯亂切）。
2. 無 SI／全部 `ai_visible=0`／env=0 時，`buildChatSystem` 輸出與現在**逐字相同**（快照測試釘）。
3. 通讀、比較頁（只准讀五段摘要的那條紅線）、carryover、progress、gateway 契約——全部不動。
4. `:aid` 一律帶 `paper_id` 查；原始檔名只進 DB 與編碼後的 header，**不進磁碟路徑**。
5. 不裝新套件；不 push、不覆蓋 `dist/`（build 到暫存驗）；`git add` 逐檔（別掃進私人 PDF）；不碰 `data/`（她的真庫）——測試走既有 `test/setup-data-dir.js` 的 temp dataDir。

## 五、驗證
**agent**：`npm test` 綠（基線 588，先跑確認）。新增：
- `test/attachments.test.js`（路由實打，起 app 或直呼 handler，照倉內既有路由測試的寫法）：上傳→列表不含全文且 `chars` 對→取檔 header 對（中文原名用 `filename*`）→取文字→PATCH label／ai_visible→DELETE 後磁碟檔消失；非 PDF → 400 且暫存檔不殘留；第 11 份 → 400；別篇的 aid → 404；**刪論文後該篇 SI 磁碟檔全消失**；掃描版（抽不到字）照樣入庫。測試用 PDF：不裝套件，手寫最小含字 PDF 或對抽字函式做注入，二擇一並在報告說明。
- `test/si-block.test.js`：無 SI 時與快照逐字相同（anthropic／openai 兩種 format）；有 SI 時區塊位置在論文區塊後、方向區塊前；`ai_visible=0` 不進；合計預算截斷的標註文字；預算用完的份只剩標題行；掃描版標註；env=`0` 全關；env 非法值回預設。
- `npm run build -- --outDir <暫存>` 綠。

**我**：親跑測試；diff 白名單（`src/db.js`、`src/routes/attachments.js`、`src/routes/papers.js`（只准刪除級聯那段）、`src/server.js`、`src/ai.js`、`frontend/src/api.js`、`frontend/src/components/FullTextView.jsx`、`frontend/src/pages/PaperDetail.jsx`、測試、docs、`TECHNICAL_MANUAL.md`）；用**拷貝的資料目錄**起服務實彈：掛一份真 SI PDF → 切換看 → 問 AI 一個只有 SI 裡才有的數字 → 關掉 `ai_visible` 再問一次它應該說讀不到 → 點舊的引用塊確認跳回正文 → 刪論文後 `ls pdfs/si-*` 乾淨。

## 六、範圍外與喚醒條件
- **SI 文字版「問這段」**（`quote.source='attachment'`）——喚醒＝她在 SI 裡想選段問。
- **docx／xlsx 的 SI**——喚醒＝她遇到非 PDF 的 SI（xlsx 資料表要另想怎麼給 AI，不是單純抽字）。
- **通讀摘要吃 SI**——預設不做：摘要是正文的五段，掛 SI 不該逼她重跑通讀。喚醒＝她覺得摘要缺了 SI 裡的關鍵方法。
- **SI 圖表走 vision**、SI 全文搜尋、SI 去重。

## 七、風險
- 正文逼近 25 萬字又掛滿 10 萬字 SI ≈ 9 萬 token，小窗口模型會緊 ⇒ 調低 `PAPER_SI_LIMIT_CHARS` 或逐份關 `ai_visible`。UI 已把「AI 實際讀到幾字」攤開，不會出現「畫面說有、AI 其實沒讀」的漂移。
- 掛／卸／開關 SI 會讓該篇論文的 prompt cache 冷一次（設計如此）。

## 八、交付
三個 commit：①D1+D2＋`attachments.test.js`；②D3＋`si-block.test.js`；③D4 前端＋`TECHNICAL_MANUAL.md` 補一節。報告 `docs/work/report-24-supplementary-files-20260921.md`（changed-file list、**明確寫出沒改什麼**、測試數字、`renderSiBlock` 三種情境的實際輸出樣本、已知限制），偏離寫本檔附錄 A，十行內回覆。commit 結尾 `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`。

---

## 附錄 A：偏離規格的地方（2026-09-21 實作）

一共五條，每條都說明為什麼。

**A1. 交付報告寫在本檔附錄 B，沒有另開 `docs/work/report-24-…md`。**
實作 agent 的工具層禁止新建 report／summary 類 `.md` 檔（只准編輯既有檔）。內容一字不少，全部搬進本檔附錄 B。倉內本來就有「附錄寫在工單檔裡」的前例（工單 23 附錄 B 親驗記錄，`57f1c06`）。

**A2. 在 worktree 裡做，不在主樹。**
她的 `node --watch src/server.js` 正佔著主樹 :3456 連著真資料庫，存 `src/` 下任何檔都會讓它重啟、載入半成品代碼。全程在 `.claude/worktrees/wo24` 做；主樹全程停在 `main`、工作樹乾淨。

**A3. `resolvePaperSiLimit()` 與 `planSiBudget()` 落在 commit ①，不是 ②。**
工單 §D3 把這兩顆歸在 D3，但 §D2 的 `GET /` 列表要回 `ai_chars_sent`／`truncated`，非有它們不可。若照原順序，commit ① 的測試就得跳過那兩個欄位。兩顆都是純函式、位置仍在 `src/ai.js`（檔案白名單沒變），只是提前一個 commit 落地。`renderSiBlock` 與注入點仍在 ②。

**A4. SI 清單撈在 `PaperDetail`，不是 `FullTextView` 內部。**
工單 §D4 的坑提示同時說了「元件內 fetch」與「數量請在 PaperDetail 層拿」。「原文」tab 沒打開時 `FullTextView` 不會 mount，而標籤上的「· SI N」在摘要頁就要看得見，所以清單撈在 `PaperDetail`（`useCallback` 綁 `paperId`，換論文自動重抓），往下傳 `attachments` ＋ `onAttachmentsChange`。`FullTextView` 仍負責「換論文／被選中那份被刪掉 → 回到正文」。只撈一次，不重複請求。

**A5. 10 份上限是整批拒絕，不是填滿到 10。**
工單只寫「超過 400」。一次丟 12 份會整批 400 並把落盤檔全清掉，而不是收前 N 份。理由：部分成功最難講清楚，也最容易讓她以為全上了。

**另外**（不算偏離，但要你知道）：實作過程在 `routes/papers.js` 既有的正文 PDF 上傳路徑發現**同一個 multer 中文檔名亂碼 bug**（`file.originalname` 走 latin1）。**本單沒有修它**——§四紅線只准動刪除級聯那段。要不要修請你拍板。

---

## 附錄 B：交付報告

**分支**：`feat/wo24-supplementary-files`（從 `main` @ `7e2f680` 開）
**測試**：588（基線，開工第一件事親跑確認）→ **631 全綠**（新增 43 顆：`attachments.test.js` 19、`si-block.test.js` 24）
**build**：`npm run build -- --outDir <暫存>` 綠（351 modules，`dist/` 一個字沒動）

### B1. 改了什麼（changed-file list）

| 檔案 | 動作 | 內容 |
|---|---|---|
| `src/db.js` | 改 | 建表區加 `paper_attachments` ＋索引（`CREATE TABLE IF NOT EXISTS`，FK CASCADE） |
| `src/routes/attachments.js` | **新** | SI 子路由六個口（list／upload／file／text／PATCH／DELETE）＋ `unlinkAttachmentsOfPaper()` |
| `src/routes/papers.js` | 改 | **只動 `DELETE /:id` 一處**：刪論文前先 unlink 該篇所有 SI 磁碟檔（＋一行 import） |
| `src/server.js` | 改 | 註冊 `app.use('/api/papers/:id/attachments', attachmentsRouter)`（＋一行 import） |
| `src/ai.js` | 改 | 新增 `resolvePaperSiLimit()`／`planSiBudget()`／`buildSiContext()`／`renderSiBlock()`；`buildChatSystem` 多收可選 `siBlock`；`chatAboutPaper` 查一次 SI 並在 `[CHAT] start` 加 `si=` |
| `frontend/src/api.js` | 改 | 新增 `attachmentsApi` |
| `frontend/src/components/FullTextView.jsx` | 改 | 文件切換 chips、SI 的 PDF／文字版、SI 小工具列、`quoteJump` 先切回正文 |
| `frontend/src/pages/PaperDetail.jsx` | 改 | 撈 SI 清單、「原文 · SI N」標籤、往下傳 |
| `test/attachments.test.js` | **新** | 子路由實打 19 顆 |
| `test/si-block.test.js` | **新** | SI 區塊與預算 24 顆 |
| `test/fixtures/make-pdf.js` | **新** | 手寫最小含字 PDF 產生器（沒裝新套件） |
| `TECHNICAL_MANUAL.md` | 改 | §5.1b 資料表、§7.1b API、§10 env、§12 測試、目錄樹與 `DELETE /:id` 那一列 |
| 本檔 | 改 | 附錄 A＋附錄 B |

### B2. **明確沒改什麼**（紅線對帳）

- **`papers.full_text`／`text_meta`／`messages.quote` 的語義零改動**。SI 的文字只住 `paper_attachments.extracted_text`，**永不拼進 `full_text`**。有測試釘：上傳兩份 SI 後 `papers` 的 `full_text`／`text_meta`／`analyze_status`／`updated_at` 四欄 `deepEqual` 完全相同。
- **`buildPaperBlock` 一個字沒動**（零回歸快照就是釘它）。`buildAnalyzeUserContent`、`prepareFullTextForModel`、`stripReferences`、`clipFullText` 全沒動。
- **通讀線沒動**：上傳 SI **不觸發** `triggerAnalyze`、不寫 `papers` 任何欄位。
- **compare／carryover／progress／gateway／insights／memory／directions 一律沒動**：`src/{compare,carryover,progress,gateway,memory,directions}.js`、`src/routes/{chat,compare,tree,tags,insights,activity,directions}.js` 全不在 diff 裡。
- **`src/pdf.js` 沒動**（只是被呼叫）。
- **`package.json`／`package-lock.json` 沒動**——沒裝任何新套件（親自查過命中數為 0）。
- **`dist/` 沒被覆蓋**（build 導到暫存）。**`data/` 一個位元組都沒碰**（測試全走 temp dataDir）。
- 第三層（SI 的「問這段」／docx・xlsx／通讀吃 SI／vision／SI 全文搜尋）**一項都沒做**。

### B3. `renderSiBlock` 三種情境的**實際輸出**

以下是在 temp DB 上真的跑出來的字，不是照代碼手抄的。

**A：一份完整（預設上限 100,000 字）**

```
以下是這篇論文的補充材料（Supplementary Information，共 1 份）。回答用到時請說明出自哪一份 SI；沒列在這裡的補充材料你讀不到，不要推測。

【SI 1：方法細節】
Supplementary Methods
Samples were digested with KOH at 60 C for 24 h.
```

**B：合計預算 60 字，四份 —— 完整／截斷／被擠掉／掃描版**

```
以下是這篇論文的補充材料（Supplementary Information，共 4 份）。回答用到時請說明出自哪一份 SI；沒列在這裡的補充材料你讀不到，不要推測。

【SI 1：方法細節】
AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA

【SI 2：Table S1 回收率】（只給了前 20 字，全長 50 字）
BBBBBBBBBBBBBBBBBBBB

【SI 3：Figure S3 原始圖】（超出字數預算，這份沒給你）

【SI 4：掃描的附錄】（掃描版，抽不到文字——這份你讀不到）
```

SI 3 被擠掉時**一個 `C` 都沒出現**（有測試釘）；掃描版**不佔預算**但仍算進「共 4 份」——要讓模型知道「有這份、你讀不到」，不要它推測。

**C：沒有任何可見 SI（全部 `ai_visible=0`／env=0／根本沒掛）**

```
""
```

空字串，注入點連一個換行都不加 ⇒ 討論 system 與工單 24 之前**逐字相同**，釘在既有快照 `test/fixtures/chat-system-no-directions.json`（anthropic 陣列與 openai 字串兩種 format 都測）。

### B4. 過程中查出來的兩個坑（都寫進代碼註解了）

**1. multer 的中文檔名是壞的（真 bug，已修）**
multer 1.x 底下的 busboy **用 latin1 解 multipart 檔名**。上傳「第一份 SI.pdf」到手是 `ç¬¬ä¸ä»½ SI.pdf`，名字從入庫那一刻就是亂碼。修法 `decodeOriginalName()`（latin1 位元組 → UTF-8，解出 U+FFFD 退回原字串；純 ASCII 原樣不動）。測試用中文檔名上傳＋下載驗 header 解得回原名。
⚠️ 同一個 bug 在既有的 `routes/papers.js` 正文上傳也有，**本單沒修**（見附錄 A 末段）。

**2. 測試用的小 PDF 抽不到字（pdf.js 的 buffer pool 陷阱）**
手寫 640 bytes 的 PDF 丟給 `extractPDFDetailed` 一律報 `bad XRef entry`，而 xref 偏移逐一驗過都對。真因（patch 一份 pdf.js 副本印內部狀態才定位到）：pdf-parse 綁的 pdf.js v1.10.100 在 `XRef.fetchUncompressed()` 走 `this.stream.makeSubStream(offset + start)`，而 `makeSubStream` 拿的是 **`this.bytes.buffer`**（整個底層 ArrayBuffer）。Node 的 `readFileSync` 對**小於 4KB** 的檔案回的是**共用 pool** 上的 Buffer（`byteOffset !== 0`），偏移就落到 pool 裡別人的位元組上。對策：`make-pdf.js` 把 PDF 墊到 8KB（墊一行 `%` 註解，零語義影響）。**這是測試夾具的問題，不是產品的坑**——真實 SI PDF 沒有一份小於 4KB。連跑三次確認穩定。

### B5. 驗證

- `npm test` **631/631 綠**。better-sqlite3 沒 ABI 問題，不需要 `npm rebuild`。
- `npm run build -- --outDir <暫存>` 綠；`dist/` 不存在於 worktree、也沒被建立。
- `FullTextView` 六種狀態的 **react-dom 靜態渲染實測**全過（沒有 SI／有 chips／截斷／擠掉／掃描版／無 PDF 只有文字），用倉內既有的 esbuild 打包，沒裝東西。
- 「同一顆預算函式」是真的：`GET /` 的 `ai_chars_sent`／`truncated` 與 `renderSiBlock` 都走 `planSiBudget()`。

### B6. 已知限制 / 我沒做到 / 不確定的地方（直說）

1. **沒有在瀏覽器裡實彈驗收過**。前端只做到靜態渲染跑得起來＋ vite build 綠。**chips 點下去換 SI、上傳轉圈、改名 Enter／Escape、刪除二次確認、`quoteJump` 跳回正文**這些互動**沒有真的用滑鼠點過**——她的服務正佔著 :3456 連著真庫，不該另起服務去搶。§五「我」那段的實彈驗收請你親跑。
2. **`AttachmentToolbar` 沒進靜態渲染測試**：它只在選中某份 SI 後出現，而選中與否是元件內部 state，靜態渲染碰不到。四種 `aiNote` 文案目前只有代碼審查，沒有自動化測試釘。
3. **上傳中途部分失敗的 UI 沒測**：後端 `failed` 陣列有測試，前端把它串成一行紅字這件事沒有覆蓋。
4. **SI 順序畫面上調不動**。`sort_order` 後端 PATCH 得動也會影響吃預算的順序，但 UI 沒有拖拉／上下移動入口——上傳順序就是順序。工單沒要求，沒加。
5. **掛／卸 SI 會讓該篇 prompt cache 冷一次**（設計如此，§七）。第一次提問會比平常貴一點。
6. **`chars` 用 SQLite 的 `LENGTH()`**，對 TEXT 回字元數，跟 JS `.length` 同單位——但兩者對 astral plane 字元（emoji、罕用字）算 UTF-16 code unit 還是 code point，**沒有逐一驗證**。SI 裡大量出現這類字元時「AI 讀了幾字」可能有個位數誤差。不影響正確性（截斷用 JS `slice`，與送出去的字完全一致）。
7. **`ai_visible` 只影響討論線**。通讀摘要本來就不吃 SI（§六 明定不做），關掉它不會讓摘要重算——預期行為，但她第一次用可能以為「關掉就全都不讀了」。
8. **10 份上限整批拒絕**（見附錄 A5）。

**沒做（範圍外，§六 已列喚醒條件）：** SI 文字版的「問這段」、docx／xlsx、通讀摘要吃 SI、SI 圖表走 vision、SI 全文搜尋與去重。

---

## 附錄 C：親驗記錄（2026-09-21 下午，Elias）

**環境**：worktree `.claude/worktrees/wo24`；驗收服務 `:3471`，`CO_READING_DATA_DIR` 指向她資料的**副本**（sqlite `.backup`，12 篇／95 則對帳過）；副本的 `ai_base_url`／`analyze_base_url` 改指本機假上游 `:3481`、key 抹成假值、`gateway_url` 指死埠——**沒打真上游、沒碰 gateway、沒碰她的真庫與 :3456**（事後對帳：真庫無 `paper_attachments` 表、`data/pdfs` 無 `si-*`、服務 PID 自 09:35 未重啟）。實彈素材＝一份真 ACS SI（8 頁，抽字 16,680）。

**親手跑的**
- `npm test` 631/631（兩次：交件時、我補小修後）。`npm run build -- --outDir <暫存> --emptyOutDir=false` 綠。
- diff 白名單：13 檔全在名單內；`package.json`／lock／`dist/`／`data/` 零改動；`papers.js` 只多 import＋刪除前 `unlinkAttachmentsOfPaper` 一行。`attachments.js` 349 行逐行讀過。
- **整條路實彈（curl）**：中文檔名上傳 → DB 裡是正確中文（非 mojibake）、磁碟檔名 `si-<nanoid>.pdf`；`GET file` 的 `Content-Disposition` 為 `filename*=UTF-8''%E8…`、串回位元組與原檔 md5 相同；拿**別篇論文的 id** 配這個 aid 打 file／text／PATCH／DELETE → 四個全 404 且 label 未被改；`.docx` → 400；副檔名 `.pdf` 但 mime 不對 → 400；mime 對但內容是垃圾 → 200＋`failed[]`，不留檔；**好 PDF＋docx 混批 → 整批 400，好的那份也沒殘留**；論文不存在 → 404，不寫檔。每一步後 `ls pdfs | grep -c '^si-'` 都對。
- **AI 讀得到（假上游落盤 system 全文）**：開 → `sys_chars=98036`、`[CHAT] … si=1/16680`；關 `ai_visible` → `81250`、`si=0/0`（差 16,786＝16,680 字＋區塊頭）；再開 → 回到 98036（同字數，穩定前綴可重現）。落盤的 system 親眼看順序：論文全文 → `以下是這篇論文的補充材料…【SI 1：…】` → `【她的研究方向】` → 洞察變動區。
- **舊功能沒被擾動**：掛著 SI 時送一則 `quote=paper` 的選段提問 → 後端 slice 驗證通過（`quote=paper:90字 si=1/16680`）。
- **瀏覽器**：tab 顯示「原文 · SI 1」；chips「正文｜SI 1 · …｜＋補充文件」；SI 的 PDF 原檔在同一個框裡渲染；文字版分段正常、標明不支援選段；改名 Escape 丟棄／Enter 立即存（後者用真 `keydown Enter` 事件確認——Browser pane 的 `Return` 鍵名沒送到 input，是工具面不是產品 bug）；**在 SI 文字版點氣泡的「跳回原文」→ 自動切回正文＋文字版、offset 61639 那段閃、約 2 秒後熄**；刪除二次確認（第一下 DB 仍在、確認後 DB 0 份、tab 標籤回「原文」、chips 收成一顆淡色「＋」）。
- **刪論文級聯**：掛 2 份 SI 後 `DELETE /api/papers/:id` → `si-*` 2→0、正文 PDF 12→11、`paper_attachments` 0 列，日誌 `[SI] delete paper=… files=2（隨論文刪除）`。

**我補的兩個小修（本附錄同一個 commit）**
1. SI 工具列的「刪除」→「刪除這份」（＋title「只刪這份補充文件，不動論文」）、確認文案寫明「這份補充文件」——頁首還有一顆刪**整篇論文**的「刪除」，兩顆長一樣太容易點錯。
2. `PaperDetail` 換論文時先 `setAttachments([])`，免得上一篇的 SI chips 閃一下、手快點到 404。

**我認可的偏離**：附錄 A 五條全部認可（報告併入本檔、worktree、`planSiBudget` 提前、清單撈在 PaperDetail、10 份上限整批拒絕）。
**已知、不修**：正文上傳（`papers.js`）的 `originalname` 同樣是 latin1 亂碼，但它**只進 `app.log` 和一個前端不讀的回應欄位**（papers 表不存原始檔名、標題由通讀產生、上傳進度列用的是瀏覽器端 `f.name`）——對她零可見影響，不為此另開工單。B6.6 的 `LENGTH()` vs `.length` 單位差：只在 SI 含 astral 字元且剛好壓在截斷線時讓「AI 讀了幾字」差個位數，送出去的字以 JS `slice` 為準，不修。
**還沒做**：合 main（＝她的 `node --watch` 會自動重啟並在真庫建新表）與 build 進主樹 `dist/`——等她點頭，合之前先 `.backup` 真庫、確認沒有 in-flight 的 `[CHAT]`／`[ANALYZE]`。
