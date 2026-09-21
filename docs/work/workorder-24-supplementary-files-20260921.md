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
