# 工單 19：引用 AI 的原話來提問

> 日期：2026-09-17
>
> 上位文件：工單 14（選一段問它——引用論文原文）、工單 18（浮現卡＋「去對話」跳到訊息閃一下）。本工單＝把引用來源從「論文原文」擴成「論文原文 或 AI 先前的回覆」，**骨架全部共用，不另造**。
>
> 優先級：P1（她原話 9/17：「我想在 co-reading 中加個功能，就是引用 AI 的原話來提問」→ 我答半天量，她說「好喔」）
>
> Repo：`~/research-stack/co-reading`；Base：`main` @ 本工單 commit 的父 commit（工單 18 之後，`ef1b92b`+）
>
> 建議分支：`feat/quote-ai-reply`
>
> 生產權限：**無**。不 push、不 build 安裝包、不動 `data/`／`.env`；不打真上游（mock）；worktree 實作、`PORT=3457`＋臨時 data dir。

## 1. 現況（已查，別重查）

- `src/quote.js`：`parseQuote`／`validateQuote(fullText, raw)`（`slice(start,end)===text` 否則 400；上限 4000 字）／`renderQuotedMessage(quote, message, fullText)`（「【引用原文（全文第 S–E 字，約第 P 段）】」）／`buildQuoteContextBlock(fullText, quote)`（前後 600 字，進變動區）／`formatQuoteRange`／`quoteLogLabel`。**全部以 `papers.full_text` 為唯一來源**。
- `src/routes/chat.js`：L188 `validateQuote(paper.full_text, rawQuote)`；L166／L280 `renderQuotedMessage(..., paper.full_text)`（歷史回放與當輪同一規則）；`messages.quote` 欄存 JSON `{text,start,end,page}`。`src/ai.js` L1392 `buildQuoteContextBlock(paper.full_text, quote)`。
- 前端：`store.js` `pendingQuote`／`setPendingQuote`／`clearPendingQuote`；`FullTextView.jsx` 文字版 `getSelection` → 偏移映射（`lib/fulltext-offsets.js`，段落 `data-cr-offset` 錨點）→「問這段」浮鈕；`ChatPanel.jsx` 引用卡（輸入框上方）＋氣泡引用塊；工單 18 的訊息跳轉（`messageJump`／`cr-msg-flash`）。
- AI 氣泡用 ReactMarkdown 渲染：畫面上的字 ≠ DB 的原始 markdown 字串（星號、井號、清單符號、程式碼圍欄）。

## 2. 設計（已定案，照做）

### 2.1 引用物件加來源

- `quote` JSON 加 `source: 'paper' | 'message'`（缺省＝`'paper'`，舊列不動）與 `message_id`（`source==='message'` 時必填）。`parseQuote` 正規化這兩欄。
- **偏移基準**：`source==='message'` 時，`start/end` 以該訊息 `content` 的**純文字投影**為準（見 2.2），不是原始 markdown。

### 2.2 純文字投影（前後端同一份函式）

- 新增 `src/markdownPlain.js`（純函式，零依賴，前端經 `frontend/src/lib/` 重用同一份或 symlink／複製並用測試釘兩份逐字相同）：把 markdown 字串投影成純文字——去掉 `#`、`*`／`_` 強調、`` ` `` 與圍欄標記（保留程式碼內容）、清單前綴（`- `、`1. `）、連結只留文字、表格管線換成空白；**換行與空白保留**（偏移才穩）。不追求完整 markdown 規範，只處理 AI 回覆常見的這幾種；用她 DB 裡真回覆當 fixture（唯讀副本取 3 則）。
- `validateQuote(sourceText, raw)`：`sourceText` 由呼叫端決定——`paper` → `paper.full_text`；`message` → `plainText(message.content)`。核對規則不變（`slice===text`）。
- 前端氣泡選取：AI 氣泡的 markdown 容器包一層 `data-cr-msg-id`，`getSelection` 後用 `selection.toString()` 對照 `plainText(msg.content)` 找唯一命中（`indexOf`；命中多於一次就取離 anchor 節點最近的——照 `fulltext-offsets.js` 的錨點法做，或簡化為「唯一命中才允許，否則提示她多選幾個字」，**選後者，寫進附錄**）。

### 2.3 給模型

- `renderQuotedMessage`：`source==='message'` 時前綴改「【引用你先前的回答（第 N 輪）】\n> …\n\n<她的問題>」，N＝該 assistant 訊息在對話裡的輪次（seq 反推）；指令句改「回答時先說明你先前那句話的意思與依據，再回應她的問題；若先前說錯了，直接承認並更正」。
- `buildQuoteContextBlock`：`message` 來源時的脈絡＝那則回覆**整段**（≤2,000 字，超過就選段前後各 800 字）＋它對應的 user 問題（上一則 user 的 content，≤300 字），標「【被引用回答的上下文】」。仍只進變動區，**穩定前綴逐字不變**（釘子同工單 14 §5.3）。
- 歷史回放：同一規則（`chat.js` 三個讀歷史的入口都走 `getHistory`，改一處）。

### 2.4 前端

- AI 氣泡 `onMouseUp`／`selectionchange`：選中 ≥8 字且選取完全落在同一個氣泡內 → 浮出「問這段」（同 `cr-ask-selection` 樣式；手機貼底）。點 → `setPendingQuote({source:'message', message_id, text, start, end})`。
- 引用卡：`message` 來源顯示「引用 AI 回答 · 第 N 輪」而非「第 S–E 字」；氣泡引用塊同理；點引用塊 → 工單 18 的 `messageJump` 跳到那則回覆閃一下（不是跳原文）。
- `[CHAT] start … quote=<chars>|none` 改成 `quote=<source>:<chars>|none`。

### 2.5 不做

- 引用 user 自己的訊息（她要引自己的話直接複製就好）。
- 跨論文引用。
- 引用進洞察／提取／出海 payload（`messages.content` 仍只存她打的字）。

## 3. 紅線

- 不 push、不 build 安裝包、不動 `data/`／`.env`／`dist/`／`release/`；不打真上游；worktree；她真 DB 只讀副本（取 fixture）。
- 穩定前綴（憲章＋論文區塊）逐字不變；引用與脈絡只進 user 訊息與變動區。
- `paper` 來源的行為與工單 14 逐字相同（既有 `test/ask-about-selection.test.js` 全綠）。
- 後端必驗 `slice===text`（對純文字投影），不合 400「選取內容與回答原文不一致」。
- 不動 `FullTextView.jsx` 的選取邏輯（只新增氣泡那條）。

## 4. 驗證（mock；實作者做，我複跑）

1. `plainText` 對 fixture（標題／粗體／清單／行內碼／圍欄／連結／表格）輸出正確且冪等；她三則真回覆的投影不含 `**`／`##`／`- ` 前綴。
2. 帶 `source:'message'`＋正確偏移 → 200，DB `quote` 含 source／message_id，送模型的 user 以「【引用你先前的回答（第 N 輪）】」開頭；偏移錯 → 400 零上游；`message_id` 不屬於該論文或不是 assistant → 400。
3. 穩定前綴逐字等於不帶引用那發；變動區含「【被引用回答的上下文】」與對應 user 問題。
4. 歷史回放與當輪逐字相同（cache 穩定）。
5. `paper` 來源全部既有測試不變。
6. 前端純函式：氣泡選取 → 偏移（唯一命中／多次命中→拒）；引用卡文案分兩型。`npm run build` 過。
7. `[CHAT] start` 含 `quote=message:`。
8. `npm test` 全綠（現 436/436）、`git diff --check` 乾淨。

## 5. 交付

分支 `feat/quote-ai-reply`，分階段 commit 帶測試數字；報告 `docs/work/report-19-quote-ai-reply-20260917.md`（harness 拒寫就放最後 commit message）；最終回覆十行內。

## 6. needs-decision

無。她已預先拍板「做完直接上」的慣例沿用（合前查 in-flight）。
