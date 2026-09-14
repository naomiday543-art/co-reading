docs(manual): 手冊補選段引用＋報告 14 全文（harness 拒寫 docs/，290/290）

手冊三處：5.2 `messages.quote` 欄、7.2 chat body 的 `quote` 參數與 GET 回傳、
9.2 討論流程補「選段提問」那一段（選段只進 user 訊息與變動區）。

工單 §6 的報告 `docs/work/report-14-ask-about-selection-20260914.md` 這個 harness
不讓寫（Write 被擋：subagent 不得產出報告檔），全文放在這裡。

================================================================================
報告 14：選一段文字問它——選取原文帶位置進討論
================================================================================
日期：2026-09-14
工單：docs/work/workorder-14-ask-about-selection-20260914.md
分支：feat/ask-about-selection（worktree 實作，**未 push、未合 main**）
Base：main @ 35c3a8e（工單 12 已合入）
上游：**全程本機假 server**，真上游一發都沒打（§4 紅線）

## 1. 一句話

她在閱讀模式選一段原文，浮出「問這段」；那段話帶著**它在全文的字元偏移**進討論——
user 訊息裡是「引用＋問題＋答題指令」，變動區裡是前後各 600 字的位置脈絡，穩定前綴
（憲章＋論文區塊）逐字沒動。後端收到選段必驗 full_text.slice(start,end) === text，
對不上就 400，寧可讓她重選，也不讓算錯的偏移悄悄把別段餵給模型。

## 2. changed files

| 檔案 | 做了什麼 |
|------|----------|
| src/quote.js | **新**。純函式：validateQuote（閘門）、renderQuotedMessage（送出與回放共用）、buildQuoteContextBlock（變動區脈絡）、paragraphIndexAt、parseQuote、quoteLogLabel |
| src/db.js | messages 加 quote TEXT DEFAULT ''（照既有 columnExists + ALTER TABLE 寫法，冪等） |
| src/routes/chat.js | body 收可選 quote → 驗 → 存；三個讀歷史的入口收斂成 loadHistory()；GET /chat 回 quote；編輯／分支往返保住 quote |
| src/ai.js | chatAboutPaper 收 options.quote：位置脈絡接在 **insightText 之後**；[CHAT] start 加 quote=；有引用時洞察搜尋改用她打的那句 |
| frontend/src/lib/fulltext-offsets.js | **新**。純函式：buildParagraphs（段落帶 [start,end)）、resolveEndpointOffset、resolveSelectionQuote、formatRange、quotePreview |
| frontend/src/components/FullTextView.jsx | 多一個「文字版（可選取提問）」模式；段落掛 data-cr-offset；選取 ≥8 字浮出「問這段」；跳回原文時捲動＋閃一下 |
| frontend/src/components/ChatPanel.jsx | 輸入框上方的引用卡（✕ 可取消）；送出帶 quote；user 氣泡上方的引用塊（點開全文／跳回原文） |
| frontend/src/api.js | streamChat(…, { quote })；non-2xx 先翻成錯誤（400 是 JSON 不是 SSE） |
| frontend/src/store.js | pendingQuote / quoteJump 兩顆訊號（都不持久化） |
| frontend/src/pages/PaperDetail.jsx | 兩顆 effect：按「問這段」在閱讀模式拉開抽屜；跳回原文時把左欄切到「原文」 |
| frontend/index.html | 浮鈕／引用卡／引用塊／跳回閃光的樣式（走既有 token，深色模式已看過） |
| test/ask-about-selection.test.js | **新**，38 顆 |
| TECHNICAL_MANUAL.md | 5.2／7.2／9.2 三處 |

## 3. 沒改什麼（工單 13 的地盤與紅線）

- src/pdf.js、buildPaperBlock／buildAnalyzeUserContent／PAPER_FULLTEXT_LIMIT、
  papers.js 的 text_meta、SummaryView.jsx、PaperDetail 頂部提示、憲章
  （src/constitution.js 與內建 CONSTITUTION.md）——**一個字都沒動**
  （test/constitution.test.js 9/9 原樣綠）。
- papers.full_text 不改、不重寫既有列；偏移一律以它為準。
- buildChatSystem／buildPaperBlock 不動 ⇒ 穩定前綴（憲章 block ＋ 論文 block）逐字不變。
- 沒做閱讀進度、沒做自動標註、沒做外部檢索、沒碰 annotations 表。
- 沒 push、沒 build 安裝包、沒動 data/／.env／release/／dist/（npm run build 跑過，dist/ 不入庫）。

## 4. 偏移映射法（工單點名要寫清楚）

### 4.1 先讀懂原本怎麼渲染，才知道為什麼需要映射

FullTextView 原本兩條路：

1. paper.pdf_filename 存在 ⇒ <iframe src="/api/papers/:id/pdf">，也就是**瀏覽器內建的
   PDF 檢視器**。那是一個我們碰不到的 document：window.getSelection() 拿不到裡面的
   選取，更沒有「這個字是全文第幾個字」這種資訊。原本那句提示「選中文字後，複製貼到
   右側聊天框」就是這個限制的產物。
2. 沒有 PDF ⇒ paper.full_text.split(/\n{2,}/).filter(p => p.trim()).map(...) 渲成 <p>。
   **分隔字元（那幾個換行）沒有任何 DOM 節點，而 .filter() 丟掉的空白段也不留痕跡**
   ⇒「這個 <p> 裡的第 N 個字」跟「全文第 N 個字」對不起來，且誤差會一路累積。

所以做了兩件事：

- **加一個文字版模式**（工單沒明寫，見 §7 偏離①）：有 PDF 時預設仍是 PDF 原檔，頂部
  一個兩顆按鈕的開關可以切到「文字版（可選取提問）」，選擇記在 localStorage。選段
  提問只在文字版裡出現；PDF 模式的版面與提示都沒動。
- **段落切分改成帶偏移的版本**（buildParagraphs）：用 /\n{2,}/g 掃描而不是 split，
  每段回 { start, end, text }，且 text === fullText.slice(start, end) **逐字成立**
  （不 trim、不清洗）；空白段跳過不渲染，但偏移照樣往前走，後面每段不會錯位。

### 4.2 映射本身

  全文偏移 = 最近的 [data-cr-offset] 祖先的值（= 該段在 full_text 的起點）
           + 該端點在這個段落元素內、之前所有文字節點的字數總和

- 每個 <p> 掛 data-cr-offset="<段起點>"（OFFSET_ATTR）。
- 端點 (node, offset) 取自 window.getSelection() 的 anchorNode/anchorOffset 與
  focusNode/focusOffset。往上走 parentNode 找到最近的錨點元素，再在那個元素底下依序
  數文字節點的長度，數到目標節點為止加上 offset；目標是元素時，offset 是子節點索引
  （Range 的語意），就數前 offset 個子樹的字數 ⇒ 段落裡未來加 <mark>／<span> 也不會壞。
- 兩端各算一次，取 min/max（反向拖曳自動排好）。
- **引用文字一律取 fullText.slice(start, end)，不是 selection.toString()**：跨段落時
  瀏覽器給的字串少掉了段間的換行，直接送會被後端的 slice===text 擋下。
- 這顆函式只碰 nodeType / nodeValue / childNodes / parentNode / getAttribute，不碰
  document／TreeWalker／window ⇒ node:test 裡用一顆假 DOM 就能釘死（§5.5）。

### 4.3 為什麼後端還要再驗一次

前端算對是常態，算錯是事故。事故的形狀是「AI 一本正經地解釋了另一段」——沒有任何
報錯，她也看不出來。所以後端把 full_text.slice(start,end) === text 當硬閘門，不等就
400、不寫 DB、不打上游。這條線是這個功能唯一的安全網。

### 4.4 「約第 P 段」

顯示用的近似值，後端 paragraphIndexAt 與前端 buildParagraphs 用同一條 /\n{2,}/ 規則、
同樣跳過空白段，測試裡直接交叉比對（前端切出來的每一段起點，後端都算得出同一個段號）。
因為只依賴 (full_text, offset)，回放時算出來的段號與送出當輪一定相同。

## 5. 給模型看到的東西（自驗實錄）

送出當輪（user 訊息）：

  【引用原文（全文第 110–143 字，約第 2 段）】
  > ，量測蛋白冠在不同脂質環境下的組成差異。結果顯示，膽固醇會顯著改變吸

  這句在全文裡是什麼位置？

  （回答時先引用你依據的原文句子（用「」標出），再說你的理解；原文沒寫的要說是你的推測。）

變動區尾巴（system 的最後一塊，憲章與論文區塊之後）：

  她這一輪引用的是全文第 110–143 字（約第 2 段）。以下是那一段在原文裡的位置脈絡，
  用來判斷它在講什麼、承接什麼：
  【選段前文】
  …（前 600 字以內的原文）
  【選段後文】
  …（後 600 字以內的原文）

DB 那一列：content = "這句在全文裡是什麼位置？"（只有她打的字），
quote = {"text":"…","start":109,"end":143,"page":null}。
日誌：[CHAT] start paper=smoke_quote_1 … quote=34字。

## 6. 測試

| 項目 | 數字 |
|------|------|
| 新檔 test/ask-about-selection.test.js | 38 顆全綠 |
| npm test 全量 | **290/290**（工單前 252/252） |
| npm run build | 過（464.69 kB，dist/ 未入庫） |
| git diff --check | 乾淨 |

工單 §5 逐條：

1. 帶 quote 且 slice 相等 → 200：DB quote 有值、送模型的最後一則 user 含「【引用原文」
   與她的問題 ✅；slice!==text → 400 且**上游零請求、DB 零列** ✅；end-start>4000 → 400 ✅。
2. 歷史回放：第二輪送出時，第一輪的 user 與當時**逐字相同**（同一顆 renderQuotedMessage）✅；
   重新生成也走同一條，且沿用最後一則 user 的選段脈絡 ✅。
3. 變動區：前後各 ≤600 字、開頭／結尾明說沒有內容 ✅；**穩定前綴逐字相同**——同一篇
   論文帶 quote 的 system startsWith 不帶 quote 的 system，多出來的那截才是脈絡 ✅。
4. 空問題只選段 → 200 且用預設問題，DB content 是空字串 ✅；沒選段也沒打字仍是
   400「消息不能為空」（原行為不變）✅。
5. 前端偏移映射（假 DOM）：段內／跨段落／反向拖曳／段落內有內層元素／元素端點／
   選太短／選到錨點外面／4000 字上限，8 顆 ✅。
6. [CHAT] start 含 quote=34字，不帶選段是 quote=none ✅。
7. 另外釘了：GET /chat 回 quote、編輯訊息後 quote 還在、壞 JSON 一律當沒有引用（不拋）。

### 6.1 真實 smoke（**未打真上游**）

PORT=3457 ＋ 臨時 CO_READING_DATA_DIR ＋ 本機假上游 :3999，種一篇四段的假論文，在
瀏覽器裡真的走了一遍：

- 選取 → 浮鈕「問這段」出現在選取上方 ✅
- 引用卡顯示「第 110–143 字」——與手算的 97+12 … 97+46 完全吻合 ✅
- 送出 → 假上游收到的 user 訊息與變動區如 §5 ✅ → 回覆串流進氣泡 ✅
- 氣泡上方的引用塊、「跳回原文」→ 捲到第 2 段並閃一下（250ms 時 .cr-quote-flash 在
  offset=97 那段，2 秒後歸零）✅
- 把論文改成「有 PDF」：預設回到 PDF 原檔、開關出現、切到文字版後錨點與浮鈕都在 ✅
- 閱讀模式下按「問這段」→ 討論抽屜自動拉開、引用卡在裡面 ✅
- 深色模式：引用卡／引用塊／浮鈕／開關都看得清楚 ✅
- 故意送錯偏移 → 400 {"error":"選取內容與原文不一致"} ✅

**真上游的實彈（她的真論文、真模型）未做**——工單 §4 紅線。

### 6.2 自驗抓到的一個 bug（已修，commit 9202b57）

「跳回原文」的高亮永遠不滅：熄燈的 setTimeout 跟跳轉寫在同一顆 effect 裡，而那顆
effect 最後呼叫 clearQuoteJump() 會讓自己立刻重跑，cleanup 把 timer 清掉。拆成兩顆
effect 就好了。**單測抓不到這個**（它是 effect 生命週期的事），是真的在瀏覽器裡點了
才看見。

## 7. 偏離工單之處

1. **多做了「文字版／PDF 原檔」開關**（工單 §3.3 只說「FullTextView 取 getSelection」）。
   理由在 §4.1：有 PDF 時閱讀模式是 iframe 裡的 PDF 檢視器，選取根本拿不到。不加開關
   的話，這個功能對「有 PDF 的論文」（＝她全部的論文）完全不存在。預設沒變（仍是 PDF
   原檔），PDF 模式的渲染一個字沒改。
2. **options.quote 多帶一個 question 欄位**（只是傳參，不進 DB 的 quote JSON、不參與
   驗證）：有引用時 chatAboutPaper 的跨論文洞察搜尋改用她打的那句，而不是「引用原文＋
   問題」整串。整串可能上千字，拿去做 FTS phrase match 等於白跑。
3. **編輯／分支的 tail_json 與還原 INSERT 補上 quote**（工單沒提）：不補的話，編輯一次
   訊息或切一次分支，引用就悄悄消失了。
4. **GET /api/papers/:id/chat 多回一個 quote**（工單 §3.3 要求氣泡畫引用塊，不回的話
   畫不出來；視為 §3.3 的必要條件而非偏離）。
5. **順手更新 TECHNICAL_MANUAL.md** 三處（5.2 欄位表、7.2 API 表、9.2 討論流程）。工單
   §6 沒要求，但手冊是這個 repo 的參考事實源；改動範圍刻意壓到最小，避開工單 13 會動的
   5.1／papers 那幾行。
6. **報告寫進這顆 commit message**，不是 docs/work/report-14-…md——harness 擋下 subagent
   寫報告檔（工單 §6 的備案）。

## 8. 給下一棒

- quote.page 目前恆為 null，等工單 13 的 text_meta.pages 進來後可以回填頁碼，引用卡就能
  顯示「第 7 頁」而不只是「第 110–143 字」。
- 文字版目前整篇一次渲染。她那幾篇十幾萬字的論文在文字版下會有一長串 <p>，真機翻頁順
  不順沒量過——如果卡，下一步是虛擬捲動（錨點機制不用改，data-cr-offset 本來就跟渲染
  範圍無關）。
- 選段 →「存為洞察」目前沒有接線（她要的是先問，不是先存）。

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>


── 附錄 C（Elias 親驗，2026-09-14 13:45）──────────────────────────────

- `npm test` 親跑 290/290（改前 252）；`npm run build` 親跑通過；改動 13 檔，未碰工單 13 的區域（pdf.js／buildPaperBlock／SummaryView／憲章）。
- 後端真 socket 實彈（假上游，完整 `POST /api/papers/:id/chat`）：壞偏移 → 400「選取內容與原文不一致」且上游零請求；正確選段 → 200，穩定前綴與無引用那發逐字相同（`startsWith` 成立，只多 126 字變動區含【選段前文】【選段後文】）；user 內容以「【引用原文（全文第 29–58 字，約第 2 段）】」開頭並含她的問題；下一輪歷史回放的那則 user 與當輪送出逐字相同；DB `content` 只存她打的字、`quote` 另存。
- 瀏覽器親手操作（worktree build，:3457，臨時 DB）：文字版拖選一段 → 「問這段」浮鈕出現在選取上方 → 點後輸入框上方出現引用卡「引用原文 · 第 110–152 字」且 placeholder 換成「想問這段什麼？…」→ 送出後 user 氣泡帶引用塊、假上游回顯它收到的 user 開頭確為「【引用原文（全文第 110–162 字，約第 2 段）】」。
- Enter 送出：瀏覽器自動化的合成 Return 沒觸發，但對 textarea 派真實 `keydown Enter` 會送出並清空——是自動化的假象，不是回歸。
- 主控台 404 兩筆＝`/carryover`（無續窗快取，既有行為）與 `/pdf`（測試論文沒有 PDF 檔），與本工單無關。
- 真上游 smoke：未做（使用者禁止）。
