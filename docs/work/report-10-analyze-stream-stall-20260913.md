════════════════════════════════════════════════════════════════════════
報告 10：通讀串流中途停滯——閒置逾時、自動重試、把錯誤講成人話
════════════════════════════════════════════════════════════════════════

日期：2026-09-13
對應工單：docs/work/workorder-10-analyze-stream-stall-20260913.md
分支：fix/analyze-stall-retry（base main @ 8419259 / v1.3.0），未 push、未 build、未部署
commit：ecaa3c3（§3.1 閒置逾時）、481aa2a（§3.2–3.4 重試／訊息／日誌）、本報告一顆

── 1. 結論 ──────────────────────────────────────────────────────────────

工單 §3 的三件事全部照做，沒有 needs-decision。

  §3.1 閒置逾時（預設 60s、env ANALYZE_IDLE_TIMEOUT_MS、clamp [5000,2147483647]）  ✅
  §3.1 總逾時 300s 保留、兩顆疊著用、body 階段的原生英文攔下來翻成自訂錯誤        ✅
  §3.2 自動重試（預設 1、env ANALYZE_RETRIES、clamp [0,3]、固定等 2s、只對連線類）  ✅
  §3.3 四種繁體錯誤訊息；既有三句原文保留                                          ✅
  §3.4 [ANALYZE] 日誌四行；原有「開始／完成／失敗」三句不動                        ✅
  §5  驗證計畫八項                                                                 ✅

── 2. changed-file list ────────────────────────────────────────────────

  .env.example                      |  10 ++
  src/ai.js                         | 359 +++++++++++++++++++++++++++---
  src/routes/papers.js              |   2 +
  test/analyze-retry.test.js        | 246 ++++++++++++++++++++++++ (新檔)
  test/analyze-stream-stall.test.js | 207 ++++++++++++++++++++++ (新檔)
  5 files changed, 798 insertions(+), 26 deletions(-)

── 3. diff 摘要 ────────────────────────────────────────────────────────

3.1 src/ai.js

新增的錯誤形狀（工單 §3.1「翻成同一種自訂錯誤形狀」）：
- StreamInterruptedError extends Error — 共用形狀，帶 kind / receivedChunks /
  receivedChars / elapsedMs。
- StreamIdleError（kind='idle'）——兩個 chunk 之間等太久。
- StreamTimeoutError（kind='timeout'）——總逾時在**讀 body** 階段打到，也就是 9/13
  漏出 `The operation was aborted due to timeout` 的那個位置。

sseEvents(response, options)（新增第二個可選參數）：
- idleTimeoutMs > 0 時，每次 reader.read() 配一顆**每次重新計時**的計時器
  （Promise.race）；超時就 await reader.cancel?.() 再丟 StreamIdleError。
- totalTimeoutMs > 0 時，把讀 body 階段的 TimeoutError／AbortError 翻成
  StreamTimeoutError。
- stats 是可選回填容器（receivedChunks／receivedChars／elapsedMs），給日誌用。
- **不傳 options ⇒ 與改動前逐字相同的分支**：guarded = idleTimeoutMs>0 ||
  totalTimeoutMs>0；guarded===false 時就是原本那句 await reader.read()，沒有計時器、
  沒有 try/catch、不碰 cancel。聊天線靠這條保持零改動。

collectStream(config, response, streamOptions) — 只是把第三個參數透傳給 sseEvents。

env 解析（都做 clamp）：
- resolveAnalyzeIdleTimeoutMs() — 未設／空／非數字／<=0 → 60_000；否則 clamp 到
  [5_000, MAX_TIMER_MS]（2_147_483_647，超過這值 setTimeout 會立刻觸發＝等於沒逾時）。
- resolveAnalyzeRetries() — 未設／空／非數字 → 1；否則 clamp 到 [0,3]。
- ANALYZE_RETRY_DELAY_MS = 2_000（固定，不做指數退避）。

失敗分類與人話：
- analyzeErrorKind(err) → 'idle' | 'timeout' | 'conn' | 'output' | 'http<status>' |
  'other'。判斷順序刻意先看「輸出類」，避免「格式不正確（…輸出預算用盡）」被別的
  規則搶走。
- isRetryableAnalyzeError(err) → idle/timeout/conn 為真，HTTP 只認 429/502/503/504；
  4xx、output、other 一律 false。
- describeAnalyzeError(err) → 工單 §3.3 那張表；output 與「上次通讀被服務重啟打斷」
  原文回傳。
- finalAnalyzeError(err, retriesUsed) → 有重試過就包成「通讀失敗（已自動重試 n 次）：
  … 。請稍後按「重新通讀」」並把原始錯誤放進 .cause；沒重試過且訊息本來就是人話時，
  **原物件原樣往上丟**（型別資訊對呼叫端有用）。

analyzePaper(fullText, options) — 多了 paperId / idleTimeoutMs / timeoutMs / retries /
retryDelayMs 五個可選參數（都有預設，呼叫端不傳行為不變），函式體改成
for (attempt=1; attempt<=maxRetries+1; attempt++) 的嘗試迴圈：
- buildAnalyzeUserContent()（含視覺筆記那一發上游請求）在迴圈**外面**只做一次
  ——重試不該把視覺筆記也重打一遍。
- prompt 的 messages 陣列一字未改。
- 每次嘗試：[ANALYZE] attempt=N paper=… model=… chars_in=… → 成功 … ok elapsed=
  chunks= chars_out= finish= usage= → 失敗 … fail elapsed= kind= chunks= chars_out=；
  決定重試時再多一行 [ANALYZE] retry N/M paper=… reason=…。
- 迴圈結束丟 finalAnalyzeError(lastError, retriesUsed)。

3.2 src/routes/papers.js
只有兩行：analyzePaper(...) 多傳一個 paperId，讓 [ANALYZE] 日誌指得出是哪一篇。
triggerAnalyze 原有的「開始 AI 通讀／AI 通讀完成／AI 通讀失敗」三句、
reconcileStuckAnalyses、路由本身全部沒動。

3.3 .env.example
新增「通讀的串流韌性（工單 10）」一段：ANALYZE_IDLE_TIMEOUT_MS 與 ANALYZE_RETRIES 的
預設值、區間、誤殺時怎麼調（120000），格式照既有 EXTRACT_MAX_TOKENS／
COMPARE_MAX_TOKENS 那兩段。

── 4. 明確寫出「沒改什麼」 ─────────────────────────────────────────────

- prompt 字面：analyzePaper 的 system/user 措辭一字未改。
- ANALYZE_MAX_TOKENS：8000，沒動。
- extractAnalyzeJson / completionMeta / diagnoseCompletion / responseText：搶救規則與
  診斷訊息一字未改。
- makeRequest / buildBody / buildEndpoint / buildHeaders / serializeContent /
  isVisionEnabled：沒動。makeRequest 那句「等標頭」階段的「AI 請求超時（300s 沒有
  結果）」保留原文（新的 body 階段訊息是另一句）。
- 聊天線：chatAboutPaper、streamOpenAI、streamAnthropic 的程式碼與行為都沒動
  （它們不傳 options ⇒ 走舊分支）。chat.test.js 與 ai-provider.test.js 的
  「chat generators keep yielding only visible text」全綠。
- 提取線 src/memory.js、對比線 src/compare.js：沒動（別張工單的事）。
- poppler / vision：沒裝、沒碰 vision_mode、沒動 9/9 留的那個洞
  （isVisionEnabled 該看 analyze_vision_model——仍未拍板）。
- 前端：SummaryView.jsx／PaperDetail.jsx 一行沒動——它們原樣印 analyze_error，
  訊息改成人話之後不需要配合改。
- data/、.env、release/、dist/、DB schema、migration：完全沒碰。
- 沒有 push、沒有 build、沒有 npm run dist:*、沒有部署。

── 5. 驗證 ─────────────────────────────────────────────────────────────

5.1 targeted
  node --import ./test/setup-data-dir.js --test test/analyze-stream-stall.test.js  → 10/10
  node --import ./test/setup-data-dir.js --test test/analyze-retry.test.js         → 14/14

對照工單 §5 八項：
 1 停滯：3 chunk 後停住、idleTimeoutMs=200 → 約 200ms 拋 StreamIdleError、訊息含
   「已收到 N 字」、reader.cancel() 被呼叫 → stall #1（cancel 用計數 spy，實測 229ms）✅
 2 總逾時仍有效：每 50ms 一個字、永不結束、timeoutMs=300／idleTimeoutMs=10_000 →
   約 300ms 失敗、訊息是「AI 請求超時」→ stall #5（mock fetch 服從 init.signal，走真的
   AbortSignal.timeout；實測 306ms，並斷言訊息**不含** aborted due to timeout）✅
 3 自動重試：第一次停滯、第二次正常 → 拿到摘要、fetch 2 次、log 含 retry 1/1
   → retry #1（跑測試時肉眼可見 [ANALYZE] retry 1/1 paper=p1 reason=idle）✅
 4 不重試的類別：HTTP 400 → 1 次；「格式不正確」→ 1 次 → retry #3、#5 ✅
 5 重試上限：兩次都停滯 → fetch 2 次、訊息含「已自動重試 1 次」→ retry #2 ✅
 6 聊天線不變 → stall #6（故意用**沒有 cancel 方法**的 reader，舊路徑若偷偷 cancel
   就 TypeError）＋ chat.test.js 全綠 ＋ ai-provider.test.js 既有那條 ✅
 7 env clamp：0／abc／1e12 各自落到合法值、不拋 → stall #9–11、retry #12–13 ✅
 8 npm test 全綠、git diff --check 乾淨 → 見 5.2 ✅

工單 §7 的風險（「reasoning 憋到最後才送會不會誤殺」）另外釘了兩條：**有 reasoning
chunk** 與 **只有 content** 兩型，各自在總時長超過 idle 閾值、但每兩個 chunk 只隔
60ms 的情況下都不誤殺——證明計時器確實每個 chunk 重置，不是從頭算的總時長。

5.2 full
  npm test
  → tests 228 / suites 58 / pass 228 / fail 0 / cancelled 0 / skipped 0 / todo 0
  base 是 204/204（工單 09 收官數字，本分支開工前親跑確認），新增 24 條 ⇒ 228/228。
  git diff --check 無輸出（exit 0）。

5.3 本機 server 自驗
  CO_READING_DATA_DIR=<scratchpad>/smoke-data PORT=3457 node src/server.js
  curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3457/api/papers   → 200
  只驗「改動後服務起得來、路由還通」，起完即殺，:3457 已釋放。她的 :3456 dev server
  全程沒受影響（事後 curl 仍 200；data/app.log 最後寫入時間停在 16:12、
  grep -c ANALYZE = 0 ⇒ **本次工作一個字都沒寫進她的 app.log**）。

5.4 真實 smoke
  **未做，理由＝使用者禁止**（工單 §4 紅線：「你不要跑這個測試，安排工單給 opus」）。
  整份工作沒有對 opencode.ai 或任何真上游發出過一個請求；所有上游互動都是
  mock global.fetch ＋ 手工 ReadableStream。真實上游實彈由她下一次上傳論文時完成。

── 6. 已知限制 ─────────────────────────────────────────────────────────

1. 「已收到 N 字」算的是**串流原始字元數**，不是摘要正文字數。sseEvents 這一層看不到
   重組後的 content（那是 collectStream 的事），所以數的是解碼後的 SSE 原始文字長度
   （含 `data: {...}` 的框架字元）。判斷「停在哪個階段」夠用，但別當 token 數或正文
   長度。同理 [ANALYZE] … fail chars_out= 也是這個口徑；只有 **ok** 那行的 chars_out=
   是真正的正文字數（走 responseText）。
2. 閒置逾時只蓋「讀 body」，蓋不到「等標頭」。上游收了請求但遲遲不回 headers 時，擋住
   的還是 300s 總逾時（makeRequest 的 AbortSignal.timeout）。要蓋那段得動 makeRequest，
   工單 §4 明文禁止「順手重構」，所以沒做。9/13 那發就是 body 階段停滯，這一刀打在
   正確的位置。
3. 60s 閾值沒有真上游背書。只驗了「計時器每個 chunk 重置」這件機制正確；
   「deepseek-v4-pro 會不會憋著 reasoning 超過 60 秒不送」沒有實測資料。上線後觀察哨
   grep 'kind=idle' data/app.log：一週內若正常論文被誤殺，ANALYZE_IDLE_TIMEOUT_MS=120000
   即可，不用改代碼。
4. 重試最壞情況多燒一次 ANALYZE_MAX_TOKENS（8000）的輸出預算。只對連線類重試就是為了
   限制這件事；ANALYZE_RETRIES=0 可完全關掉。停滯那發實際燒掉的 completion 通常遠小於
   8000（連線斷在半途），但上游那邊可能已生成完並計費，這點看不到也管不了。
5. 重試不改 analyze_status。整個重試迴圈在 analyzePaper 內，對 DB 而言仍是一次
   analyzing → done/error；前端在重試期間看到的還是「通讀中」。這是刻意的（工單 §3.2
   要求包在 analyzePaper 裡），代價是她在 UI 上看不到「正在重試」——只有日誌看得到。
   最壞情況 UI 轉圈時間變成 2×300s + 2s。
6. retryDelayMs 是為了測試才開的參數（真實預設 2000，測試用 10，否則每條重試測試都要
   陪等 2 秒）。生產呼叫端沒有傳，不是給使用者調的旋鈕，所以沒寫進 .env.example。
7. env 在每次通讀時讀取（resolveAnalyzeIdleTimeoutMs() / resolveAnalyzeRetries() 是
   函式，不是模組載入時的 const）。與工單 §3.1 字面上寫的 const 形式不同，理由：可以在
   測試裡改 env 而不必重新 import 整個模組，而且她改 .env 重啟就生效的語意完全一樣
   （dotenv 啟動時載入，process.env 之後不變）。env 變數名與 clamp 區間完全照工單。
8. HTTP 錯誤的人話化是工單 §3.3 表格之外的一點延伸：`API error 502: <html>…` 這種英文
   原樣印給她，跟 9/13 那句英文是同一類問題，所以一併翻成「上游回了 HTTP 502（…）
   ——請稍後再試」／4xx 則是「——請檢查通讀模型設定（base URL／API key／模型名）」，
   並保留原始 body 前 80 字。不影響任何既有斷言。

── 7. 上線與回滾 ───────────────────────────────────────────────────────

上線：純本機 Electron/Express，沒有 VPS 部署鏈。合進 main 之後她下次 npm run dev 就
生效（node --watch 會自己重啟——**注意她 in-flight 的通讀會被打斷**，合併前先確認沒有
論文正在通讀）。
關掉新行為：ANALYZE_RETRIES=0（不自動重試）、ANALYZE_IDLE_TIMEOUT_MS 調很大（實務上等於
只剩 300s 總逾時）。兩個都是 env，不用改代碼。
完整回滾：git revert 481aa2a ecaa3c3，或直接不合這個分支——main @ 8419259 完全沒被碰過。
觀察哨：grep '\[ANALYZE\]' data/app.log；特別看 kind=idle（誤殺）與 retry 1/1（真的
救回來幾次）。

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>

── 附錄（Elias 親驗，2026-09-13 16:45）────────────────────────────────

- `npm test` 親跑：228/228，0 fail（base 204 + 停滯 10 + 重試 14）。
- 紅線點名：`git diff main..HEAD --name-only` 只有 .env.example／src/ai.js／src/routes/papers.js／兩個新測試檔；未動 data/、.env、dist/、release/、memory.js、prompt 字面、ANALYZE_MAX_TOKENS。她主樹 `data/app.log` 內 `[ANALYZE]` 筆數 0。
- 真 socket 實彈（本機假上游，非真上游——使用者禁止）：
  - 第 1 發送 2 chunk 後永遠停住 → 5.0s 觸發 kind=idle，上游看到 client 主動關 socket（reader.cancel 生效），retry 1/1，第 2 發 0.0s 五段全齊。
  - 兩發都停 → 最終訊息「通讀失敗（已自動重試 1 次）：上游串流中途停滯：5s 沒有新資料（已收到 47 字、1 個片段，共等 5s）。請稍後按「重新通讀」」。
- 真上游 smoke：未做（使用者原話「你不要跑這個測試」）；由她下次上傳論文完成，觀察哨 `grep '\[ANALYZE\]' data/app.log`。
