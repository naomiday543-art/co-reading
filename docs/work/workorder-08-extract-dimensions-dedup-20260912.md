# 工單 08：提取線收口——六維度直出、去重、接回 ai.js 傳輸層（優化總方案批次三）

> 日期：2026-09-12
>
> 上位文件：`docs/work/optimization-plan-20260910.md` §3.5、§4.5、§5 批次三。依賴工單 07（方向區塊）已合入。
>
> 優先級：**P0 含一個現役 bug**（§2 第一條）＋ P1 功能
>
> Repo：`~/research-stack/co-reading`；Base：`main` @ `f6b9b07`
>
> 建議分支：`feat/extract-dimensions`
>
> 生產權限：**無**。不 push、不 build、不動 `data/`／`.env`；不打真上游（提取要花她額度、會寫她 DB；用 mock fetch 與臨時 DB）。她的 dev server 可能在跑（:3456／:5173），worktree 實作，自驗 `PORT=3457`。

## 1. 背景與動機

使用者原話（2026-09-10）：「好像只能提取到洞察，而没有归类到别的分类诶？」——六個維度只有「概念」「悬题」有自動通路。工單 07 已把「她的研究方向」注入提取 system，本工單讓模型**直接判六維度**，並解決兩件一起發現的事：

1. **現役 bug**：`src/memory.js:74-88` 有一份**私有** `buildHeaders`，沒有 `x-opencode-session`。9/9 的修復只進了 `src/ai.js`。她現在指著 OpenCode Go，按「提取洞察」會 **400 MissingSessionID**。
2. **同一坑第二次**：`callExtractAPI`（L119）非串流、`max_tokens: 2000`、60s 逾時——與 9/9 通讀失敗完全同型（推理模型思考鏈吃光預算→正文空；OpenCode Go 非串流 60s 閘）。
3. **重複**：她 13 條洞察裡有兩對語義重複（bigram-Jaccard 0.74、0.57），不是逐字重複——多按幾次「提取」就多幾條。

## 2. 現況（已查代碼與資料，別重查）

- `src/memory.js`：`EXTRACT_PROMPT`（L8-46，三 type：fact／hypothesis／progress）；`TYPE_TO_DIMENSION = { fact:'概念', hypothesis:'悬题' }`（L52）；`buildExtractSystem(paperId)`（工單 07 加）；私有 `buildEndpoint`／`buildHeaders`／`buildBody`（L68-117，**與 ai.js 重複且缺 opencode 標頭**）；`callExtractAPI`（L119，非串流、2000、60s）；`parseExtractResponse`（L143）；`extractInsights`（L172）：讀 messages→組 transcript→呼叫→逐條 INSERT（title=content 前 80 字、source_context=關鍵字比對）→`syncInsightFireAndForget`。**沒有任何去重。**
- `src/ai.js` 可複用出口：`buildEndpoint`、`buildHeaders({key,format,baseUrl,scope})`（含 opencode 標頭）、`buildBody`、`collectStream(config, response)`（把 SSE 重組成非串流形狀）、`completionMeta(config, data)`（finish_reason／truncated／reasoning）、`REQUEST_TIMEOUT_MS`、`ANALYZE_MAX_TOKENS` 的寫法。**注意 ai.js 已 import memory.js 嗎？** 目前 `memory.js` import `ai.js` 的 `getChatConfig`；反向不能再加（循環）。傳輸層從 memory.js 呼叫 ai.js 是安全方向。
- `src/routes/insights.js:9`：`DIMENSIONS = ['概念','延伸','你的研究','闪回','共振','悬题']`（未 export；本工單可 export）。
- `src/search.js:46 findRelatedInsights(paperId, max)`：以標題＋tags 做 FTS，回其他論文的洞察（含 `source_paper_id`）。
- `src/gateway.js:47-58` 出海 body 帶 `dimension: insight.dimension`；**契約只認 dimension 為六值字串，不看 type**——直出六維度對契約無影響。
- 前端：`frontend/src/components/ChatPanel.jsx:227` `handleExtract`→`setExtractResult(result)`；L527 顯示 `skipped`（進度跳過數）。
- 測試：`test/directions-injection.test.js` L15 import `EXTRACT_PROMPT`／`buildExtractSystem`，斷言「無方向時 `buildExtractSystem === EXTRACT_PROMPT`」——**這條在本工單後仍必須成立**（prompt 內容可以變，等式不變）。
- 她真資料：13 條，概念 11／悬题 1／延伸 1；近重複對：#4↔#8（0.74）、#5↔#9（0.57）；其餘兩兩 <0.45。

## 3. 已定案語義

### 3.1 傳輸層接回 ai.js（修 bug）

- 刪掉 memory.js 私有的 `buildEndpoint`／`buildHeaders`／`buildBody`，改用 `ai.js` 的同名出口；`buildHeaders` 傳 `scope: 'extract'`（固定，不按論文——提取 prompt 前綴跟論文無關）。
- `callExtractAPI` 改 `stream: true` + `collectStream`，`signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)`；預算 `EXTRACT_MAX_TOKENS = Number(process.env.EXTRACT_MAX_TOKENS) || 4000`（提取輸出比摘要短，4000 給思考鏈留位）。
- 空正文診斷：沿 `completionMeta`——`finish_reason=length` 時錯誤訊息寫「輸出預算用盡（調高 EXTRACT_MAX_TOKENS）」；模型正常收尾但 content 空且 `reasoning_content` 含 `{…}` 時從 reasoning 搶救（同 analyze 規則：truncated 不救）。
- `temperature` 維持 0.1。

### 3.2 六維度直出

`EXTRACT_PROMPT` 改為輸出 `{type, dimension, content}`：

- `type` 三值不變（fact／hypothesis／progress，gateway 契約與 `section_progress` 語義）。
- `dimension` 六值，prompt 給定義（逐字用這段，可微調排版）：

```
### 維度（dimension）——每條必填，六選一
**概念** — 從這篇論文學到的事實、機制、方法（type 通常是 fact）
**悬题** — 沒解決的疑問、推測、待驗證的假設（type 通常是 hypothesis）
**你的研究** — 直接關於她自己所屬方向的判斷或計畫（見【她的研究方向】：跟這篇所屬方向直接相關）
**延伸** — 從這篇跳到她**另一個**方向的連結（見【她的研究方向】：不是這篇所屬的那個）
**闪回** — 讀這篇時想起**另一篇**論文的具體內容（見【已有洞察】裡來自其他論文的條目）
**共振** — 這篇與**另一篇**論文的說法互相呼應或打架（見【已有洞察】；打架也算，保留矛盾）
判斷不了就用「概念」或「悬题」，不要硬湊跨論文維度。
```

- 沒有【她的研究方向】區塊時，prompt 仍列六維度，但「你的研究」「延伸」的定義句後加「（本次沒有方向資訊，這兩個維度不要用）」——這個補句由 `buildExtractSystem` 依有無方向動態加，**不是**寫死在 EXTRACT_PROMPT。
- 解析：`dimension` 不在六值內 → 以 `TYPE_TO_DIMENSION[type] || '概念'` 兜底並 log WARN；`progress` 仍不入庫。
- `DIMENSIONS` 從 `routes/insights.js` export 供 memory.js 用（單一事實源）。

### 3.3 【已有洞察】區塊（給去重與跨論文維度）

`buildExtractSystem(paperId)` 在方向區塊之後再接一段（無任何洞察時整段省略、不加換行）：

```
【已有洞察】
本篇已提取（不要重複提取語義相同的條目）：
- [概念] …
來自其他論文（判斷「闪回」「共振」時引用；每條前面標了論文標題）：
- 《標題》[悬题] …
```

- 本篇：`SELECT dimension, content FROM insights WHERE source_paper_id=? ORDER BY created_at`，**上限 30 條**，每條 content 截 120 字。
- 其他論文：`findRelatedInsights(paperId, 8)`，每條帶 `source_paper_title`，content 截 120 字。
- 順序：EXTRACT_PROMPT → 方向區塊 → 已有洞察區塊。**無方向且無洞察時 `buildExtractSystem === EXTRACT_PROMPT` 必須仍成立**（現有測試）。

### 3.4 落庫前去重（第二道閘）

新增純函式 `src/dedup.js`：

- `normalizeContent(s)`：去空白與中英標點（`[\s，。、；：「」『』（）()“”‘’,.;:\-—–]`）。
- `bigramJaccard(a, b)`：字元 bigram 集合的 Jaccard。
- `findDuplicate(content, existing)`：`existing` = 同篇已有洞察 `{id, content}`；正規化後**完全相同** → `{ kind:'exact', id }`；`bigramJaccard ≥ 0.6` → `{ kind:'near', id, score }`；否則 `null`。
- 閾值 `DEDUP_NEAR_THRESHOLD = Number(process.env.EXTRACT_DEDUP_THRESHOLD) || 0.6`（她資料上真重複 0.74／0.57 → 0.57 那對會漏；**故意不把閾值壓到 0.5**，因為 0.43–0.45 那些是「同主題不同陳述」，寧可漏殺不誤殺；模型側的【已有洞察】負責抓語義重複）。
- `extractInsights` 對每條 entry：先在**同一次回應內**互相去重（模型可能同輪吐兩條近似），再對 DB 已有的去重；命中的不 INSERT、不出海，log `[DEDUP] paper=… kind=exact|near score=… vs=<id>`，計入回傳 `duplicates`。
- **不做**歷史清理（她的 13 條不動）；§9 給她一個 dry-run 查詢。

### 3.5 回傳與前端

- `extractInsights` 回 `{ insights, skipped, duplicates }`（`duplicates` 新增，整數）。
- `ChatPanel.jsx:527` 那行改成同時顯示：`（新增 N 條）`／`（M 條進度已跳過）`／`（K 條與既有洞察重複已略過）`，各自 >0 才顯示。

## 4. 實作範圍

允許：`src/memory.js`、`src/dedup.js`（新）、`src/routes/insights.js`（只加 `export { DIMENSIONS }`——它現在已有 `export { DIMENSIONS }` 在檔尾，確認即可）、`src/ai.js`（**只允許**新增 export，不改既有函式體）、`frontend/src/components/ChatPanel.jsx`（L527 附近）、`test/` 新增與必要的既有測試更新、`.env.example`（加 `EXTRACT_MAX_TOKENS`、`EXTRACT_DEDUP_THRESHOLD` 註解）。

禁止：改 `TYPE_TO_DIMENSION` 的兜底語義、改 gateway 出海 body、改 `analyzePaper`／`chatAboutPaper`、動 `directions.js`、動 `data/`、打真上游、裝套件、改 `insights` schema。

## 5. 紅線

- 三個 mock 上游的回歸測試必須釘住：(a) 指向 `opencode.ai` 的 base URL 時提取請求**帶** `x-opencode-session`（現役 bug 的回歸線）；(b) 非 opencode base **不帶**；(c) 請求 body `stream: true`。
- `buildExtractSystem` 無方向無洞察 `=== EXTRACT_PROMPT`（既有測試不得刪改成弱斷言）。
- 去重只比**同一篇**的既有洞察；跨論文相似不算重複（那是「共振」的材料）。
- 出海仍逐條 fire-and-forget、只對真的 INSERT 的條目。

## 6. 必測矩陣（mock fetch，臨時 DB）

| 案例 | 預期 |
|---|---|
| H1 opencode base | 請求 headers 含 `x-opencode-session`（UUID 形狀） |
| H2 openai base | 不含 |
| H3 body | `stream:true`、`max_tokens`=EXTRACT_MAX_TOKENS、`temperature:0.1` |
| S1 串流重組 | mock SSE 兩段 content → 完整 JSON 被解析 |
| S2 預算用盡 | `finish_reason:length`、content 空 → 拋錯含「輸出預算用盡」 |
| S3 搶救 | `finish_reason:stop`、content 空、reasoning 含 JSON → 解析成功 |
| P1 六維度 | 六種 dimension 各一條 → 各自入庫 |
| P2 非法維度 | `dimension:'foo', type:'hypothesis'` → 入庫為「悬题」＋WARN |
| P3 progress | 不入庫、`skipped+1` |
| B1 prompt 無方向 | 含「這兩個維度不要用」補句；無洞察時 `=== EXTRACT_PROMPT`（注意：補句必須也不出現，否則等式破——**補句只在有洞察或有方向時才可能出現？** 不對：無方向＝要補句。⇒ 解法：把補句放在【已有洞察】之前、且**只在 `renderDirectionsBlock` 為空但至少有一條洞察時**加；完全空 → 純 EXTRACT_PROMPT。實作者照此，別破既有等式） |
| B2 有方向 | 無補句、含方向區塊 |
| B3 已有洞察 | 區塊含本篇條目與其他論文條目（帶標題）、各截 120 字、本篇 ≤30 |
| D1 exact | 正規化相同 → 不 INSERT、`duplicates+1`、不出海 |
| D2 near ≥0.6 | 同上、log 帶 score |
| D3 0.45 | 照常 INSERT |
| D4 同輪互重 | 回應內兩條近似 → 只入一條 |
| D5 跨篇 | 與其他論文洞察 0.9 相似 → 仍 INSERT |
| F1 前端 | result 帶 `duplicates:2` → 文案出現「2 條與既有洞察重複已略過」 |

## 7. 交付標準

- `npm test` 全綠（開工前 124）；`git diff --check`；`git diff main --name-only` ⊆ §4；
- 報告 `docs/work/report-08-extract-dimensions-dedup-20260912.md`（harness 拒寫就放最後 commit message）：矩陣逐項、偏離；
- 分階段 commit：傳輸層接回 ai.js（修 bug）→ 六維度 prompt＋解析 → 已有洞察區塊 → dedup.js＋落庫閘 → 前端；
- 最終回覆十行內。

## 8. 回滾

無 schema 變更。撤代碼即回滾；已入庫的六維度洞察對舊代碼無害（`DIMENSIONS` 六值本來就合法）。

## 9. 範圍外／合併後

- **她既有 13 條的近重複**（#4↔#8、#5↔#9）：不自動刪。合併後我給她一個 dry-run 清單，她在洞察頁手動決定。
- 六維度直出後模型分得準不準：合併後用她真對話跑一次「提取」（要她在場、花她額度），看維度分佈是否還是概念獨大。
- 批次四：多篇摘要對比（4.3）。

## 附錄：實作偏離記錄

（實作者填寫）
