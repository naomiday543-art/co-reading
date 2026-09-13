# 工單 10：通讀串流中途停滯——閒置逾時、自動重試、把錯誤講成人話

> 日期：2026-09-13
>
> 上位文件：9/9 修復（main merge `9629493`，`ANALYZE_MAX_TOKENS` 8000／串流／300s 總逾時／啟動對帳）。本工單是它的補完，不推翻它。
>
> 優先級：**P1**（她上傳新論文第一發就失敗，體感＝「通讀壞了」；重試能過，但她不該需要知道這件事）
>
> Repo：`~/research-stack/co-reading`；Base：`main` @ `8419259`（v1.3.0）
>
> 建議分支：`fix/analyze-stall-retry`
>
> 生產權限：**無**。不 push、不 build、不動 `data/`／`.env`。**不打真上游**（通讀花她額度、會寫她 DB；用 mock fetch＋臨時 DB）。她的 dev server 正在跑（`npm run dev`，:3456／:5173，`node --watch`）——**在 worktree 實作**，不然存檔就熱重啟她的後端、把她 in-flight 的通讀殺掉（9/9 犯過一次）。自驗用 `PORT=3457` 且 `CO_READING_DATA_DIR` 指向臨時目錄（9/9 有兩發實彈把 WARN 寫進她 app.log 的前科）。

## 1. 現況證據（已查，別重查）

`data/app.log` 2026-09-13：

```
16:02:10 [INFO] PDF 上傳成功: oHw4mU6IYUQHu-yX5Fs0D (s41392-026-02878-z.pdf, 6.2MB)
16:02:10 [INFO] 開始 AI 通讀: oHw4mU6IYUQHu-yX5Fs0D
16:02:10 [WARN] 找不到 pdftoppm（poppler 未安裝），視覺通讀本進程內一律跳過…
16:07:10 [ERROR] AI 通讀失敗: oHw4mU6IYUQHu-yX5Fs0D — The operation was aborted due to timeout
16:12:00 [INFO] 開始 AI 通讀: oHw4mU6IYUQHu-yX5Fs0D        ← 她手按「重新通讀」
16:12:22 [INFO] AI 通讀完成: oHw4mU6IYUQHu-yX5Fs0D (用時 22s)
```

- 失敗與開始相差 **300.0s** ＝ `REQUEST_TIMEOUT_MS` 預設值（`src/ai.js:187`）。這是總逾時打到，不是上游回錯。
- 同一篇、同一設定，重試 **22s** 完成、五段全齊（DB：`analyze_status=done`，summary 五欄 291–583 字，`full_text` 64,930 字，不算長——她 9/9 那篇 100,122 字 53s 完成）。⇒ **不是論文太長、不是預算不夠、不是 prompt 問題**，是第一發的連線在串流途中停滯（上游掛住或她的網路抖——她走 Shadowrocket VPN，握手／長連線被踢是家裡的老毛病）。
- 錯誤訊息是原生 `DOMException` 的 `The operation was aborted due to timeout`，**沒有**走 `makeRequest` 裡那句「AI 請求超時（300s 沒有結果）」——因為 `AbortSignal.timeout` 在 body 讀取階段觸發時，拋錯的是 `sseEvents()` 裡的 `reader.read()`（`src/ai.js:224-231`），不在 `makeRequest` 的 try/catch（`src/ai.js:196-208`）範圍內。前端 `SummaryView.jsx:34` 把 `analyze_error` 原樣印給她看，她看到一句英文。
- 通讀設定（DB settings，`-wal` 裡）：`analyze_base_url=https://opencode.ai/zen/go/v1`、`analyze_model=deepseek-v4-pro`、`analyze_format=openai`、`analyze_vision_mode=on`（pdftoppm 缺，實際走純文字）。
- 路徑：`src/routes/papers.js:93 triggerAnalyze()`（fire-and-forget，catch 裡寫 `analyze_error`）→ `src/ai.js:463 analyzePaper()` → `makeRequest()`（`stream:true`）→ `collectStream()` → `sseEvents()`。重試入口：`POST /api/papers/:id/analyze`（`papers.js:271`），前端 `PaperDetail.jsx:317-325` 的 Retry 按鈕。

## 2. 目標與非目標

**目標**

1. 串流「一直沒有新資料」時不要傻等滿 300s——加**閒置逾時**（每兩個 chunk 之間的最長間隔）。
2. 第一發因停滯／連線類錯誤失敗時**自動重試一次**，她不用手按。
3. 錯誤訊息一律講人話（繁體），並把「等了多久、收到多少、重試了幾次」放進去，方便下次查。
4. 日誌多一行看得出來的 `[ANALYZE]` 記錄（開始／每次嘗試結果／耗時／收到的 token 數），觀察哨 `grep '\[ANALYZE\]' data/app.log`。

**非目標**

- 不動 prompt、不動 `ANALYZE_MAX_TOKENS`、不動 `extractAnalyzeJson` 的搶救規則。
- 不動聊天線（`chatAboutPaper`／`streamOpenAI`／`streamAnthropic`）的行為——它們有 UI 逐字顯示，停滯由使用者自己看得到。**共用的 `sseEvents()` 可以加可選參數，但預設行為必須與現在逐字相同**（`test/chat.test.js` 有釘）。
- 不裝 poppler、不碰 vision 開關（她 9/9 拍板：先不裝、`vision_mode` 不改 auto）。
- 不做提取線（`memory.js`）的同型修復——那是工單 08 的事，已合。

## 3. 設計（已定案，照做，不要再問）

### 3.1 閒置逾時

- 新增 `ANALYZE_IDLE_TIMEOUT_MS = Number(process.env.ANALYZE_IDLE_TIMEOUT_MS) || 60_000`。**60s**：推理模型思考時 `reasoning_content` 一樣會逐 chunk 送，正常情況不會 60s 一個字都沒有；9/9 實測整篇 38.9–53s 完成。
- 實作方式建議：`sseEvents(response, { idleTimeoutMs })`——每次 `reader.read()` 用 `Promise.race` 配一顆可重置的計時器；超時就 `reader.cancel()` 並丟一顆自訂錯誤（例如 `class StreamIdleError extends Error { name='StreamIdleError' }`，帶 `receivedChunks`、`receivedChars`、`elapsedMs`）。**總逾時 300s 保留**，兩顆疊著用；總逾時觸發時要在同一層攔下 `TimeoutError`/`AbortError`，翻成同一種自訂錯誤形狀，不要再漏原生英文出去。
- `collectStream` 把參數透傳；`analyzePaper` 才決定用不用。聊天線不傳 ⇒ 行為不變。
- 數值對照 runtime 天花板：`setTimeout` 上限 2,147,483,647ms，60s／300s 都遠在內；但 env 可覆蓋，**解析時 clamp 到 [5_000, 2_147_483_647]**，避免有人填 0 或超大值（工作法第四條的教訓）。

### 3.2 自動重試一次

- 在 `analyzePaper` 內包一層（不要在 `triggerAnalyze`，讓單元測試好釘）：`ANALYZE_RETRIES = Number(process.env.ANALYZE_RETRIES) ?? 1`，clamp 到 [0, 3]。
- **只對「連線／停滯類」重試**：`StreamIdleError`、總逾時、`fetch failed`／`ECONNRESET`／`UND_ERR_*`、HTTP 502/503/504/429。**不重試**：4xx（400/401/404 是設定錯，重打只會再錯一次並多花錢）、`格式不正確`／`輸出預算用盡`（那是模型輸出問題，重打大概率同樣結果，還多燒一次 8000 token 預算）。
- 兩次之間等 2s（固定，不做指數退避——只重試一次沒必要）。
- 重試時 log `[ANALYZE] retry 1/1 paper=… reason=…`。
- 兩次都失敗：錯誤訊息合併，例如「通讀失敗（已自動重試 1 次）：上游串流中途停滯——等了 60 秒沒有新資料（已收到 1,204 字）。可能是網路抖動，請稍後按「重新通讀」」。

### 3.3 錯誤訊息（繁體、給她看的）

| 情況 | `analyze_error` 措辭 |
|---|---|
| 閒置逾時 | `上游串流中途停滯：{idle}s 沒有新資料（已收到 {chars} 字、{chunks} 個片段，共等 {elapsed}s）` |
| 總逾時 | `AI 請求超時：{total}s 內沒有完成（已收到 {chars} 字）` |
| 連線失敗 | `連不上通讀模型（{原始 err.message 前 80 字}）——請檢查網路或 VPN` |
| 重試後仍敗 | 前綴 `通讀失敗（已自動重試 {n} 次）：` ＋ 上面對應那句 ＋ 後綴 `。請稍後按「重新通讀」` |

現有的「格式不正確」「輸出預算用盡」「上次通讀被服務重啟打斷」三句**保留原文**（`test/analyze-reconcile.test.js`、`ai-provider.test.js` 可能有釘，先跑一遍看）。

### 3.4 日誌

`triggerAnalyze` 起止已有「開始 AI 通讀／AI 通讀完成／失敗」三句，**保留原句不改**（她看習慣了，我也 grep 習慣了）。新增：

- `[ANALYZE] attempt=1 paper=… model=deepseek-v4-pro chars_in=64930`
- `[ANALYZE] attempt=1 ok elapsed=22.1s chunks=… chars_out=… finish=stop usage=…`
- `[ANALYZE] attempt=1 fail elapsed=60.0s kind=idle chunks=0 chars_out=0`

## 4. 紅線

- 她的原話（2026-09-13）：「你不要跑這個測試，安排工單給 opus」——**不打真上游驗證**。真上游實彈由她自己下一次上傳論文時完成；工單交付寫「真實 smoke：未做，理由＝使用者禁止」。
- 不 push、不 build、不動 `data/`、`.env`、`release/`、`dist/`。
- 不在她的主工作樹上存檔（`node --watch`）；worktree 裡跑自己的 `PORT=3457`。
- 不動 `prompt` 字面、不動 `ANALYZE_MAX_TOKENS`、不動聊天線預設行為。
- 不「順手」重構 `makeRequest`／`buildBody`／`memory.js`。一張工單一類失效。

## 5. 驗證計畫（實作者自己做；我之後親手複跑）

用 mock fetch（回一個手工 `ReadableStream`）打整條 `analyzePaper` 路徑，至少釘這些：

1. **停滯**：先送 3 個 chunk 然後永遠不再送 → `idleTimeoutMs=200` 下約 200ms 拋 `StreamIdleError`，錯誤訊息含「已收到 N 字」；`reader.cancel()` 被呼叫（用 spy）。
2. **總逾時仍有效**：一個每 50ms 送一個字、永不結束的 stream，`timeoutMs=300`、`idleTimeoutMs=10_000` → 約 300ms 失敗，訊息是「AI 請求超時」而不是原生英文。
3. **自動重試**：第一次 stream 停滯、第二次正常回完整 JSON → `analyzePaper` 回正確摘要，fetch 被呼叫 2 次，log 含 `retry 1/1`。
4. **不重試的類別**：HTTP 400 → fetch 只呼叫 1 次；`格式不正確` → 1 次。
5. **重試上限**：兩次都停滯 → fetch 2 次，訊息含「已自動重試 1 次」。
6. **聊天線不變**：`test/chat.test.js` 全綠，`streamOpenAI` 對同一個 mock stream 的逐字輸出與改前逐字相同。
7. **env clamp**：`ANALYZE_IDLE_TIMEOUT_MS=0`、`=abc`、`=1e12` 各自落到合法值，不拋。
8. `npm test` 全綠（現在 204/204，工單 09 收官時的數字），`git diff --check` 乾淨。

## 6. 交付格式

- 分支 `fix/analyze-stall-retry`，分階段 commit（閒置逾時／重試／訊息與日誌／測試 各一顆或合理拆分），**每顆 commit message 帶該階段的證據**（測試數字）。
- 報告寫到 `docs/work/report-10-analyze-stream-stall-20260913.md`（harness 若拒寫 `docs/work/`，就寫進最後一顆 commit 的 message——9/9 發生過）。內容：changed-file list、diff 摘要、**明確寫出沒改什麼**、targeted 測試指令與數字、full `npm test` 數字、真實 smoke（寫「未做，使用者禁止」）、已知限制。
- 最終回覆十行內，只帶路標（分支名、commit 範圍、測試數字、報告路徑）。

## 7. 風險與後續

- 閒置逾時 60s 對 `deepseek-v4-pro` 是否太緊：推理模型思考鏈通常也逐 chunk 送 `reasoning_content`；但**如果 OpenCode Go 把 reasoning 憋到最後一次送**，60s 可能誤殺長論文的正常請求。實作者要在 mock 裡分別驗「有 reasoning chunk」與「無 reasoning 只有 content」兩型；上線後觀察哨 `grep 'kind=idle' data/app.log`，一週內若對正常篇誤殺，把 env 調 120s 即可，不用改代碼。
- 自動重試等於最壞情況多燒一次 8000 token 的輸出預算——只對連線類重試就是為了限制這件事。
- 後續（不在本單）：`isVisionEnabled` 該看 `analyze_vision_model`（9/9 留的洞，她未拍板）。

## 8. needs-decision

無。三個技術取捨（60s／只重試一次／只重試連線類）都有明顯正解，已替她點頭；她若覺得 60s 太短或想多重試幾次，改 env 不用改代碼。
