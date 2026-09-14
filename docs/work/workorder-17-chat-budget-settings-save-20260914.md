# 工單 17：討論線輸出預算被思考鏈吃光＋設定頁「進階設定」儲存失靈

> 日期：2026-09-14
>
> 上位文件：工單 12（`[CHAT]` 日誌就是抓到這顆病的眼睛）、9/9 通讀同型修法（記憶 `coreading-analyze-opencode-fix-20260909`：max_tokens 被 reasoning 吃光 → content 空）。
>
> 優先級：**P0**（她現在就卡著：問一句得到空氣泡；設定頁改了進階設定存不進去，今天視覺模式那次就是這樣丟的）
>
> Repo：`~/research-stack/co-reading`；Base：`main` @ 本工單 commit 的父 commit
>
> 建議分支：`fix/chat-budget-settings-save`
>
> 生產權限：**無**。不 push、不 build 安裝包、不動 `data/`／`.env`；不打真上游；**她的 dev server 正在跑（:3456，node --watch）——worktree 實作，`PORT=3457`＋臨時 data dir 自驗**。工單 16 分支 `fix/references-nature-layout` 未合（動 pdf.js／papers.js 的 text_meta），本單不碰那些。

## 1. 現況證據（已查，別重查）

**A. 空回覆**（`data/app.log` 2026-09-14 15:17）：

```
[CHAT] start paper=S0a0LhFZAaB2SLVKj89BK model=deepseek-v4-flash sys_chars=57664 hist=0條 … quote=none
[CHAT] ok … ttft=未提供s elapsed=23.8s chunks=8190 chars_out=0 reasoning_chars=12133 max_gap=747ms finish=length cache_hit=0/17337 usage={"prompt_tokens":17337,"completion_tokens":4096,…}
討論回覆: S0a0LhFZAaB2SLVKj89BK, assistant (0 字)
```

- `src/ai.js chatAboutPaper` 打上游時 `max_tokens: 4096` 寫死（約 L1347）。推理模型思考了 12,133 字（≈4,096 token）把預算用完，`finish_reason=length`、正文 0 字。
- 走的是 `ok` 路徑：`routes/chat.js` 把 0 字的 assistant **寫進了 DB**（messages 最新一列 `assistant|0`），前端畫出一個只有「重新生成／存為洞察」的空氣泡。按「重新生成」同樣預算會再空一次。
- 9/9 通讀線的同型病已有現成處理：`completionMeta().truncated`、`analyzeErrorKind` 的 `'output'`（「輸出預算用盡」）、`ANALYZE_MAX_TOKENS` 8000。討論線沒沿用。

**B. 進階設定存不進去**（`frontend/src/pages/Settings.jsx`）：

- 「儲存」按鈕在 L329，**在「進階設定」摺疊區（L353 toggle、L358 `advancedOpen && (...)`）之上**——進階區塊裡沒有任何儲存按鈕，她自然以為那裡不能存。
- 更糟：`saveSettings`（L154–165）只在 **`advancedOpen` 為 true 時**才寫進階值，否則一律用 preset 預設覆蓋：`analyze_vision_mode: advancedOpen ? analyzeVisionMode : (defaults.vision_mode || 'auto')`，而 `store.js` 的 `opencode_go` preset `vision_mode:'on'`。⇒ 她在進階區把視覺改成 off、把區塊收起來（或沒收）再按上面的儲存，**視覺就被寫回 on**。今天 13:40「按了關但 DB 仍 on」就是這條路。
- 同一個條件也套在 `analyze_api_key／base_url／model／format／vision_model`：只要摺疊區關著按儲存，通讀線設定全部被 chat 線的值蓋掉。

## 2. 設計（已定案，照做）

### 2.1 討論線輸出預算

- `CHAT_MAX_TOKENS` env，預設 **8192**，clamp [1024, 32768]，寫法同 `resolveChat*`。`chatAboutPaper` 用它取代寫死的 4096（`options.maxTokens` 可覆蓋，給測試）。
- **空正文守門**：串流收完後若 `fullResponse.trim()===''`：
  - 若 `stats.finishReason==='length'`（或 usage 顯示 completion 達預算）→ 這是「預算被思考吃光」：**自動用 2 倍預算重打一次**（上限 32768，只重打一次，log `[CHAT] retry 1/1 … reason=budget`），仍空就丟 kind `'output'` 的錯誤：「模型把輸出預算全花在思考上（思考 N 字、正文 0 字，預算 M token）。可在 .env 調高 CHAT_MAX_TOKENS，或在設定頁改用非推理模型」。
  - 若 finish 不是 length 但正文空 → 直接丟 `'output'` 錯誤「模型回了空正文（finish=…）」，不重試。
  - 這個重試**不受** `CHAT_RETRIES` 影響（那個是連線類），也不與它疊加超過各自上限。
- `routes/chat.js`：**永遠不把空正文 INSERT 成 assistant**——`error` 事件帶 `partial=0`、人話訊息、hint「按『重新生成』會用調高後的預算再試」。既有的 0 字 assistant 列：不做資料修復（她按重新生成會覆蓋成新版本；若重新生成路徑遇到最後一條是 0 字 assistant，視同正常 regen）。
- `[CHAT] ok` 行多印 `max_tokens=<n>`；`fail` 行 kind=output 時印 `reasoning_chars`。

### 2.2 設定頁進階區塊

- 進階區塊**內部**加一顆「儲存進階設定」按鈕（呼叫同一個 `saveSettings`），旁邊顯示同樣的「設定已儲存」狀態。
- `saveSettings` 改成**不看 `advancedOpen`**：改看一個持久化的 `advancedEnabled`（存 localStorage `co-reading-settings.advanced.enabled`，並存後端 settings `advanced_enabled='true'|'false'`）。進階區塊頂部一個開關「使用進階設定（通讀線與討論線分開設定）」；開＝寫進階值，關＝寫 preset 預設（與現在關著時的行為一樣，但**要在 UI 上明說**「關閉後通讀線會回到 preset 預設」）。第一次載入若後端沒有 `advanced_enabled` 但 `analyze_base_url` 等與 chat 線不同 ⇒ 推定為 true（別把她現在的設定當成沒開）。
- 視覺模式那顆 select：儲存時就是寫她選的值，不再有 `defaults.vision_mode` 的回填（只有 `advancedEnabled=false` 才回 preset）。
- 儲存成功後把後端回讀的值印一行到主控台（`console.info('[settings] saved', {...非密鑰欄位})`），方便她下次核對。

## 3. 紅線

- 不 push、不 build 安裝包、不動 `data/`／`.env`／`dist/`／`release/`；不打真上游；worktree；不碰工單 16 的檔案區域（pdf.js、papers.js 的 text_meta、fulltext 測試）。
- 不動穩定前綴、不動 `CHAT_IDLE_TIMEOUT_MS`／`CHAT_RETRIES` 語義、不動通讀線。
- 不改 preset 的值（`opencode_go.vision_mode:'on'` 留著，只是不再在關著摺疊區時偷偷寫回去）。
- 密鑰不印進主控台、不印進日誌。

## 4. 驗證（mock；實作者做，我複跑）

1. mock 上游：第一發只送 reasoning、`finish_reason=length`、content 空 → 自動重打，第二發 body 的 `max_tokens` 是第一發的 2 倍，回正文 → 200、DB 有 assistant、log 含 `reason=budget`。
2. 兩發都空 → `error` 事件 kind=output、人話訊息含「CHAT_MAX_TOKENS」與「思考 N 字」、DB **沒有** assistant 列、fetch 恰 2 次。
3. finish=stop 但正文空 → 1 次、error、DB 無 assistant。
4. `CHAT_MAX_TOKENS=abc/0/1e9` clamp；預設 body `max_tokens=8192`。
5. 連線類重試（工單 12）與預算重試互不疊加超過各自上限（先停滯後預算空 → 最多 3 次 fetch）。
6. 前端：`saveSettings` 在 `advancedOpen=false`、`advancedEnabled=true` 時仍寫進階值（node:test 釘純函式，把 payload 組裝抽成可測的函式）；`advancedEnabled=false` 寫 preset；進階區塊內有儲存按鈕；`npm run build` 過。
7. `npm test` 全綠（現 332/332，未含工單 16）、`git diff --check` 乾淨。

## 5. 交付

分支 `fix/chat-budget-settings-save`，分階段 commit（2.1 後端／2.1 路由／2.2 前端／測試）帶測試數字；報告 `docs/work/report-17-chat-budget-settings-save-20260914.md`（harness 拒寫就放最後 commit message）；最終回覆十行內。

## 6. needs-decision

無。8192／2 倍重打一次／`advancedEnabled` 三個都是明顯正解。
