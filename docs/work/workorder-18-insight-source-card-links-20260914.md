# 工單 18：洞察來源浮現卡＋洞察之間的自動聯想

> 日期：2026-09-14
>
> 上位文件：她 9/14 晚的兩個想法（原話：「存為洞察之後，我點擊那個卡片，頁面自動跳轉到提問的窗口，但是要自己翻看紀錄，能否做成浮現的卡片？還有各個洞察之間如果有 connection 的話，是否能做到自動聯想？」）→ 我答兩件都做得到，她說「開 18 先改這兩個」。
>
> 優先級：P1（她的使用體驗主線：洞察是這個系統的長期資產，現在卡片點了只會跳頁）
>
> Repo：`~/research-stack/co-reading`；Base：`main` @ 本工單 commit 的父 commit（v1.4.0 之後，`239051e`+）
>
> 建議分支：`feat/insight-source-links`
>
> 生產權限：**無**。不 push、不 build 安裝包、不動 `data/`／`.env`；**A 部分零上游；B 部分的「為什麼相關」預設關、實作時只 mock**；worktree 實作、`PORT=3457`；她的真 DB 只能三檔 cp 唯讀（用來跑一次聯想看結果表）。

## 1. 現況（已查，別重查）

- `insights` 表：`id, dimension, title, content, source_paper_id, source_context, tags_json, created_at, updated_at, external_ombre_id, synced_at`。**沒有來源訊息 id**。她 14 條裡只有 4 條有 `source_context`（都是 assistant 回覆的開頭摘錄）。
- 「存為洞察」：`ChatPanel.jsx` L393–399 的按鈕呼叫 `onSaveInsight`（不帶參數）→ `PaperDetail.jsx` 開 `InsightForm` 預填（`source_context` 由呼叫端組）。`InsightForm.jsx` 有 `sourcePaperId／sourceContext` 欄位；`POST /api/insights`（`routes/insights.js` L87）收 `dimension,title,content,source_paper_id,source_context,tags`。提取線 `memory.js` L372 INSERT 時 `source_context` 用關鍵字比對 transcript 湊的；對比線 `Compare.jsx` 走同一個 POST。
- 卡片點擊：`InsightsPanel.jsx` L108 `onClick → onNavigate('detail', source_paper_id)`——只跳論文頁。`InsightCard.jsx` 有 `onClick/onEdit/onDelete/compact`。
- 相關：`search.js searchInsights(query,{excludePaperId,limit})`（FTS5 trigram，給討論注入用）、`findRelatedInsights(paperId,max)`（用論文標題＋標籤，論文層級）；`GET /api/insights/related?paper_id=` 在 `PaperDetail` 顯示。**洞察↔洞察之間沒有任何連線**。FTS 表 `insights_fts`（trigram）已在，`db-fts-triggers.test.js` 有釘。
- 跳到某則訊息並閃一下：工單 14 已有 `quoteJump`／`cr-quote-flash` 的模式（store 事件 → 目標元件 effect → `scrollIntoView`＋閃 1.75s），**照抄那套做「跳到訊息」**。
- 洞察出海（`gateway.js syncInsight`）契約只認既有欄位；新欄位不進 payload（除非契約明示）。

## 2. 設計（已定案，照做）

### A. 來源浮現卡

**A1 存來源**
- `insights` 加欄 `source_message_id TEXT DEFAULT ''`（migration 照既有 try 寫法）。`POST /api/insights` 與 `PATCH` 接受它；存前驗證該 id 存在於 `messages` 且 `paper_id === source_paper_id`，不合就忽略（不 400，洞察本身要存得成）。
- `ChatPanel` 的「存為洞察」改成 `onSaveInsight(msg)`：帶 assistant 訊息 id、**以及它上一則 user 訊息的 id**（表單只存 assistant 的 id，user 那則在展示時用 seq 反推）；`PaperDetail` 預填時把 `source_message_id` 塞進表單（隱藏欄位）；`source_context` 照舊。
- 提取線（`memory.js`）：提取時模型看的是整段 transcript，能定位就把「最匹配的 assistant 訊息 id」寫進去（用它現在湊 `source_context` 的關鍵字比對結果反查訊息 id；找不到留空）。對比線留空（來源是多篇）。
- **舊洞察補算**：`POST /api/insights/backfill-sources`（一次性，冪等）：對 `source_message_id` 空但 `source_context` 非空的洞察，在同 paper 的 assistant 訊息裡找 `content` 包含 `source_context` 前 60 字者，命中唯一才寫回。回填筆數印日誌 `[INSIGHT] backfill=…`。她 14 條裡預期最多 4 條補得到。

**A2 浮現卡**
- 點 `InsightCard`（洞察面板、論文頁的相關洞察、知識樹裡的卡片——**凡是渲染 InsightCard 的地方行為一致**）不再直接跳頁，改開一張浮現卡（popover 桌機／底部抽屜手機）：
  - 上：維度標籤、標題、內容全文、標籤、來源論文標題。
  - 中：「出自的對話」——有 `source_message_id` 時顯示那一問一答：user 問題全文＋assistant 回覆摘錄（前 300 字，可展開全文）；沒有時顯示 `source_context`（若有）或「沒有記錄來源對話」。
  - 下：按鈕「去對話」（切到該論文、討論面板滾到那則 assistant 訊息並閃一下——照 `quoteJump` 模式做 `messageJump`）、「去論文」（現在的行為）、「編輯」「刪除」（沿用既有 onEdit/onDelete）。
  - B 部分做完後這張卡底部再加「相關洞察」區（見 B3）。
- `GET /api/insights/:id` 回傳多帶 `source_message`（`{id, content, seq}`）與 `source_question`（上一則 user 的 `{id, content}`），一次拿齊，前端不用再打。

### B. 洞察自動聯想

**B1 連線表**
- 新表 `insight_links(a TEXT, b TEXT, score REAL, reason TEXT DEFAULT '', method TEXT DEFAULT 'fts', created_at INTEGER, PRIMARY KEY(a,b))`，**a<b 正規化**（無向）；外鍵 ON DELETE CASCADE 到 insights。
- 計算：`computeInsightLinks(insightId)`——用該洞察的 `title + content` 前 400 字對 `insights_fts` 做 trigram 查詢（排除自己），取 bm25 分數並正規化到 0–1；門檻 `INSIGHT_LINK_MIN_SCORE` env 預設 0.35（clamp [0.05, 0.95]），每條最多 `INSIGHT_LINK_MAX` 5 條。**零 token。** 同時對「被連到的那些」不用反算（無向表一列就夠）。
- 觸發：`POST /api/insights`、`PATCH`（title/content 變才重算）、提取線每插一條、對比線存共振都跑一次；`DELETE` 靠 CASCADE。另加 `POST /api/insights/relink-all`（一次性重算全部，冪等，印 `[INSIGHT] relink total=… links=…`）。
- **對她真 DB 唯讀副本跑一次 relink-all，把 14 條的連線結果表放進報告**（誰連誰、分數）；已知她有兩對近重複（報告見工單 08 §2：#4↔#8、#5↔#9）應該被連上且分數最高——這是驗收基準。

**B2 「為什麼相關」（預設關）**
- `INSIGHT_LINK_REASON=true` 時，對新建的連線批次問便宜模型（用討論線的 `getChatConfig`）：給兩條洞察，一句話（≤40 字）說它們怎麼相關，寫進 `reason`；失敗留空不重試；每次 relink-all 最多問 20 對。串流＋逾時＋錯誤分類**沿用 `src/ai.js` 的 `makeRequest`／`collectStream`／`describeAnalyzeError`**，不另造。**實作時只 mock，不打真上游。**

**B3 顯示**
- `InsightCard` 右上角「相關 N」小標（N>0 才顯示）；A2 的浮現卡底部列相關洞察（維度、標題、來源論文、分數以三檔文字顯示「很像／有關／略有關」，有 reason 就顯示那句），點一條就換成那條的浮現卡（可一路點下去，卡上有「←」回上一張，最多記 10 層）。
- `GET /api/insights/:id/links` 回 `[{insight:{id,dimension,title,source_paper_title}, score, reason}]`；`GET /api/insights` 列表多帶 `link_count`（一個 LEFT JOIN 計數，別 N+1）。

## 3. 紅線

- 不 push、不 build 安裝包、不動 `data/`／`.env`／`dist/`／`release/`；不打真上游（B2 只 mock）；worktree；她真 DB 只讀副本。
- 不動討論線 prompt、不動 `chatAboutPaper`、不動穩定前綴；洞察注入討論的那段（`chatAboutPaper` 的 ownInsights／related）**不改**。
- 出海 payload（`gateway.js buildInsightPayload`）不加新欄位。
- FTS 表結構與既有 triggers 不改（`db-fts-triggers.test.js` 全綠）。
- 舊洞察回填只在「唯一命中」時寫；絕不猜。

## 4. 驗證（mock；實作者做，我複跑）

1. 存為洞察帶 `source_message_id` → DB 有值；帶不存在的 id → 洞察仍存、欄位空。
2. `GET /api/insights/:id` 回 `source_message`＋`source_question`；沒來源時兩者 null。
3. backfill：fixture 三條洞察（唯一命中／兩則命中→不寫／無命中）→ 只第一條回填；跑兩次結果相同。
4. 連線：fixture 5 條洞察（兩對明顯相似、一條孤立）→ links 表恰兩列、孤立者 0；門檻 env clamp；DELETE 一條 → 它的連線消失。
5. relink-all 冪等（兩次結果一致）；`link_count` 正確且 SQL 只一趟（測試可用 `db.prepare` spy 或看查詢字串）。
6. B2 關閉時零 fetch；開啟時 mock 上游被叫的次數 ≤ 新連線數且 ≤20，reason 寫入，失敗留空。
7. 前端純函式：浮現卡的來源區塊三態（有訊息／只有 context／都沒有）、分數三檔文字、歷史堆疊上限 10。`npm run build` 過。
8. `npm test` 全綠（現 383/383）、`git diff --check` 乾淨。

## 5. 交付

分支 `feat/insight-source-links`，分階段 commit（A1／A2／B1／B2／B3／測試）帶測試數字；報告 `docs/work/report-18-insight-source-links-20260914.md`（harness 拒寫就放最後 commit message）含她 14 條的連線結果表與回填筆數；最終回覆十行內。

## 6. needs-decision

無。門檻 0.35／每條 5 連／reason 預設關，都是可用 env 調的技術取捨。
