# 工單 12：討論線串流韌性——[CHAT] 日誌、看得見的思考、前端三件、閒置逾時

> 日期：2026-09-14
>
> 上位文件：`docs/work/report-11-chat-latency-diagnosis-20260914.md`（診斷，§5 探針數字、§7 逾時路徑、§8 選項 A/C/H/B）。姊妹工單：`workorder-10-analyze-stream-stall-20260913.md`（通讀線同型修法，錯誤型別與 `sseEvents` 參數可直接複用）。
>
> 優先級：**P1**（她每問一句先盯 10–17 秒三個點；撞到上游停滯就是 150 秒＋，到期還把半截答案抹掉）
>
> Repo：`~/research-stack/co-reading`；Base：`main` @ 本工單 commit 的父 commit（含報告 11 與 `scripts/diag/`）
>
> 建議分支：`fix/chat-stream-resilience`
>
> 生產權限：**無**。不 push、不 build、不動 `data/`／`.env`。**不打真上游**（診斷已打 3 發，數字夠了；全部 mock fetch）。她的 dev server 正在跑（`npm run dev`，`node --watch` :3456／vite :5173）——**在 worktree 實作**，自驗 `PORT=3457` + `CO_READING_DATA_DIR` 臨時目錄。

## 1. 使用者拍板（2026-09-14）

我提了四件事（A 日誌、C 便宜版思考提示、H 前端三件、B 討論線閒置逾時 45s＋首字前才重試），並明說 B 推翻工單 10「不動聊天線」的非目標。她的原話：「**做吧**」。⇒ 四件全做，B 的閾值與重試條件照本工單，不要再問。

## 2. 現況（報告 11 已查，別重查）

- 討論線路徑：`src/routes/chat.js` 預設送出分支（L130–170：先 INSERT user 訊息 → SSE `delta`/`done`/`error`）→ `src/ai.js chatAboutPaper`（L860：組 system → `makeRequest` `stream:true` 300s 總逾時 → `streamOpenAI`／`streamAnthropic`）→ `sseEvents(response)` **不帶 options ⇒ `guarded=false`**：無閒置逾時、300s 到期漏原生英文 `The operation was aborted due to timeout`。
- `streamOpenAI`／`streamAnthropic`（`src/ai.js` 約 L432–445）只 yield 正文；`reasoning_content`／`thinking` 與 `usage` 全丟。`buildBody` 的 openai 分支沒送 `stream_options:{include_usage:true}`（探針證實 OpenCode Go 認這顆並回 `prompt_tokens_details.cached_tokens`）。
- 前端：`frontend/src/api.js` L91–123（`readSSEStream`、fetch 不帶 AbortController、無逾時）；`frontend/src/components/ChatPanel.jsx` L86（delta 逐字上屏）、L92–97（onError 先 setError 再 `setStreamingContent('')` ⇒ 半截被抹）、L445–451（三個 typing-dot，無文字）。
- 失敗時 assistant 訊息不進 DB（`chat.js` L163–166 只在成功路徑），user 訊息已在 L135–137 寫入 ⇒ 孤兒 user 尾巴；`chat.js` L48–51「重新生成」看到最後一條不是 assistant 就 400「請改用『繼續』」。
- 探針數字：首字前 10–17s（TTFB 2–10s＋reasoning 8–12s）；reasoning 是逐 chunk 送的，raw chunk 最大間隔 0.86–0.91s；一次停滯實測 31.2s。prompt cache 99.1% 命中。
- 論文區塊：`buildPaperBlock`（`src/ai.js` L818）全文 >100,000 字截斷並附「[全文已截斷]」，UI 沒提示。

## 3. 設計（已定案，照做）

### 3.1 A：`[CHAT]` 日誌

- `buildBody` openai 分支加 `stream_options: { include_usage: true }`，env `CHAT_STREAM_USAGE=false` 可關（預設開）。anthropic 分支不用（`message_delta.usage` 本來就有）。
- `streamOpenAI(response, opts)`／`streamAnthropic(response, opts)` 改成接受 `{ stats, idleTimeoutMs, totalTimeoutMs, onReasoning }`，透傳給 `sseEvents`；同時把 `reasoning_content`／`thinking` 的 delta 交給 `opts.onReasoning?.(text)`（**不 yield 進正文**），`usage`／`finish_reason` 回填 `opts.stats`。**不傳 opts 時逐字行為與現在相同**（`test/chat.test.js` 既有釘子必須全綠）。
- `chatAboutPaper` 起止各一行：
  - `[CHAT] start paper=<id> model=<m> sys_chars=<n> hist=<n>條 scope=paper:<id>`
  - `[CHAT] ok paper=<id> ttfb=<s> ttft=<s> elapsed=<s> chunks=<n> chars_out=<n> reasoning_chars=<n> max_gap=<ms> finish=<r> cache_hit=<cached>/<prompt> usage={...}`
  - 失敗：`[CHAT] fail paper=<id> elapsed=<s> kind=<idle|timeout|conn|httpNNN|other> chars_out=<n> max_gap=<ms>`
  - `ttfb`＝標頭到達、`ttft`＝**第一個正文字**、`max_gap`＝相鄰 raw chunk 最大間隔。`sseEvents` 的 `stats` 要多回填 `maxGapMs` 與 `firstByteAt`／`firstContentAt`（`firstContentAt` 由呼叫端在收到第一個正文 delta 時打）。
- 觀察哨：`grep '\[CHAT\]' data/app.log`。

### 3.2 B：討論線閒置逾時＋條件式重試

- `CHAT_IDLE_TIMEOUT_MS` 預設 **45_000**（clamp [5000, 2147483647]，0／非數字退回預設，寫法同 `resolveAnalyzeIdleTimeoutMs`）。`chatAboutPaper` 傳 `{ idleTimeoutMs, totalTimeoutMs: REQUEST_TIMEOUT_MS, stats }` 給串流產生器 ⇒ 走 `guarded` 路徑，原生英文被翻成 `StreamIdleError`／`StreamTimeoutError`。
- 重試：`CHAT_RETRIES` 預設 **1**（clamp [0,3]），**只在「尚未收到任何正文字」且錯誤可重試**（`isRetryableAnalyzeError` 同一套：idle／timeout／conn／429／502／503／504）時重試；已經吐過正文就**不重試**，直接報錯（半截由 H③ 保住）。兩次間隔 2s。重試前 log `[CHAT] retry 1/1 paper=… reason=…`。
- 錯誤訊息繁體（複用 `describeAnalyzeError`，把「通讀」字樣參數化或另寫 `describeChatError`）：例「上游串流中途停滯：45s 沒有新資料（已收到 812 字）」。重試後仍敗前綴「回覆失敗（已自動重試 1 次）：」。
- `routes/chat.js` 的 `error` 事件多帶 `partial: <已吐正文長度>` 與 `hint`：若這一輪 user 訊息已寫入而 assistant 沒寫入，hint＝「你的問題已保存，按『繼續』可讓 AI 接著回答」（對應 L48–51 的 400 分支——**或者**直接把 L48–51 放寬：最後一條是 user 時「重新生成」等價於「繼續」。二選一，實作者選後者更省她一步；選了要在 §附錄寫明）。

### 3.3 C 便宜版：看得見的思考

- `routes/chat.js` 收到 `onReasoning` 時送 SSE `{type:'thinking', chars:<累計 reasoning 字數>}`，**節流每 500ms 最多一次**；正文第一個 delta 到時送一次 `{type:'thinking_done', chars, seconds}`。**reasoning 內容不送前端、不進 DB、不進下一輪 prompt。**
- `frontend/src/api.js readSSEStream` 認 `thinking`／`thinking_done`（新回呼 `onThinking`）；舊事件不變。
- `ChatPanel.jsx` L445–451：三個點換成「正在思考…（已想 8 秒 · 420 字）」，秒數前端自己用 `Date.now()` 計，字數來自事件；正文開始後這行消失。等待 0–2s 內不顯示字數（避免閃 0）。

### 3.4 H：前端三件

1. 等待提示帶秒數（併入 3.3）。
2. 中止按鈕：`api.js` fetch 帶 `AbortController`，`ChatPanel` 串流中顯示「停止」；中止後把已收到的半截留在畫面並標「（已停止，未保存）」，不寫 DB（後端 `req.on('close')` 要能中止上游：`chat.js` 把 `AbortSignal` 傳進 `chatAboutPaper`→`makeRequest`；`makeRequest` 目前只用 `AbortSignal.timeout`，改成 `AbortSignal.any([timeout, external])`（Node ≥20.3 有；若 runtime 不支援，手動合併）。
3. 失敗不抹半截：`ChatPanel.jsx` L92–97 拿掉 `setStreamingContent('')`，改成保留並標「（未完成，未保存）」＋錯誤訊息＋hint。

### 3.5 順手：全文截斷提示

- `GET /api/papers/:id` 回 `full_text_truncated: boolean`（`full_text.length > 100000`）與 `full_text_chars`；`SummaryView` 或 `PaperDetail` 頂部一行小字「全文 146,272 字，AI 只讀前 100,000 字」。不改截斷邏輯。

## 4. 紅線

- 不 push、不 build、不動 `data/`、`.env`、`release/`、`dist/`；不打真上游；worktree 實作、`PORT=3457` 自驗。
- **reasoning 內容絕不寫進 `messages.content`、絕不進 DB、絕不進下一輪 prompt**（會污染歷史並撐大 cache 前綴）。
- 通讀線（`analyzePaper`）行為不變（`test/analyze-*.test.js` 全綠）。
- 不做 D（論文瘦身）與 E（歷史裁剪）——報告 11 已證明不提速。
- 不順手重構 `makeRequest` 以外的傳輸層；`sseEvents` 只加回填欄位。

## 5. 驗證計畫（mock fetch，實作者自己做；我之後親手複跑）

1. 停滯：mock 串流送 3 個 reasoning chunk 後不再送 → `idleTimeoutMs=200` 下約 200ms 拋 `StreamIdleError`；因尚無正文 ⇒ 自動重試，第二發正常 → 回覆完整，fetch 2 次，log 含 `[CHAT] retry`。
2. 吐過正文再停滯 → **不重試**，錯誤訊息繁體、`error` 事件帶 `partial>0`。
3. HTTP 400 → 1 次不重試。
4. `thinking` 事件節流：mock 每 10ms 送 100 個 reasoning chunk → 前端收到的 `thinking` 事件 ≤ 3 個，最後一個 `thinking_done` 帶正確字數；正文 delta 逐字與改前相同。
5. 中止：client 端 abort → 上游 mock 的 `req.on('close')` 被觸發、DB 無 assistant 列。
6. `[CHAT] ok` 行含 `cache_hit=26624/26853` 形狀（mock usage 帶 `prompt_tokens_details.cached_tokens`）；`CHAT_STREAM_USAGE=false` 時 body 無 `stream_options`。
7. 不傳 opts 的 `streamOpenAI`／`streamAnthropic` 逐字輸出與改前相同（既有 `test/chat.test.js`）。
8. 全文截斷旗標：100,001 字 → `full_text_truncated=true`；100,000 → false。
9. `npm test` 全綠（現 228/228）、`git diff --check` 乾淨。前端改動用 `npm run build` 確認能編譯（產物在 dist/，**不要 commit dist/**）。

## 6. 交付

- 分支 `fix/chat-stream-resilience`，分階段 commit（A／B／C／H／3.5／測試），每顆帶測試數字。
- 報告 `docs/work/report-12-chat-stream-resilience-20260914.md`（harness 拒寫就放最後一顆 commit message）：changed-file list、diff 摘要、**明確寫出沒改什麼**、targeted 與 full 測試數字、真實 smoke「未做，使用者禁止」、偏離工單之處逐條。
- 最終回覆十行內。

## 7. needs-decision

無。B 她已拍板（§1）。閾值 45s／重試只在首字前，是技術取捨，已定。
