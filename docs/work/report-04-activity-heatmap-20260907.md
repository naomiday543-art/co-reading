# 交付報告 04：閱讀活動歡迎面板（熱力圖 + 統計格）

> 日期：2026-09-07
> 工單：`docs/work/workorder-04-activity-heatmap-20260907.md`
> 分支：`feat/activity-panel`（從 `main` @ `c1ce559` 切出，**不是** `feat/carryover-client`）
> 狀態：實作完成、測試全綠、後端實彈對過基線。**未 push、未 build、未部署。**

---

## 1. changed-file list

`git diff main --name-only`：

```
TECHNICAL_MANUAL.md
frontend/src/api.js
frontend/src/components/ActivityPanel.jsx
frontend/src/pages/Library.jsx
src/routes/activity.js
src/server.js
test/activity.test.js
```

全部落在工單 §5 的允許清單內（`TECHNICAL_MANUAL.md` 是 §5 列的「可選」項）。

`git diff main --stat`：

```
 TECHNICAL_MANUAL.md                       |  15 ++
 frontend/src/api.js                       |   5 +
 frontend/src/components/ActivityPanel.jsx | 329 ++++++++++++++++++++++++++++++
 frontend/src/pages/Library.jsx            |   4 +
 src/routes/activity.js                    | 178 ++++++++++++++++
 src/server.js                             |   2 +
 test/activity.test.js                     | 222 ++++++++++++++++++++
 7 files changed, 755 insertions(+)
```

**755 行全是新增，0 行刪除、0 行修改。** 沒有任何一行既有代碼被改寫。

---

## 2. diff 摘要

### 新檔

| 檔案 | 內容 |
|---|---|
| `src/routes/activity.js`（178 行） | 唯讀 `GET /api/activity`。參數驗證、三表分桶、totals、streak、peak_hour、dimensions。無任何寫入 DB 的語句。 |
| `frontend/src/components/ActivityPanel.jsx`（329 行） | 自持 state 的面板：熱力圖（純 CSS，無函式庫）、八格統計、範圍切換、收合、錯誤態。 |
| `test/activity.test.js`（222 行） | 13 個案例，覆蓋工單 §7 必測矩陣全部 13 列。 |

### 既有檔的改動（逐處）

| 檔案 | 改動 | 行數 |
|---|---|---|
| `src/server.js` | 加 `import activityRouter from './routes/activity.js';`；在 `app.use('/api', insightsRouter);` 之後加 `app.use('/api', activityRouter);` | +2 |
| `frontend/src/api.js` | **僅檔案尾端**新增 `export const activityApi = { get: (days = 365) => request(...) }` + 一行註解 | +5 |
| `frontend/src/pages/Library.jsx` | 加 `import ActivityPanel`；在 toolbar `</div>` 與 `{/* Paper list */}` 之間插入 `{!selectedTag && !selectedTreeNode && !searchQuery && <ActivityPanel />}` + 一行註解 | +4 |
| `TECHNICAL_MANUAL.md` | §7.4 之前插入新的 §7.3a「閱讀活動」端點說明（含時區與紅線註記） | +15 |

### 明確寫出「沒改什麼」

以下**一個字都沒動**（逐項確認過 `git diff main` 無對應 hunk）：

- `src/db.js` —— 無 migration、無新索引、無 schema 變更。
- `src/routes/papers.js`、`src/routes/chat.js`、`src/routes/insights.js`、`src/routes/tags.js`、`src/routes/tree.js`。
- `frontend/src/api.js` 的 `papersApi` 物件（L20-43）—— 以及 `tagsApi` / `treeApi` / `settingsApi` / `logsApi` / `insightsApi` / `request()` / `readSSEStream()` / `streamChat` / `regenerateChat` / `continueChat`。新增的 5 行全部在 `continueChat` 之後、檔尾。
  （工單 §8：這是與 `feat/carryover-client` 的唯一交集，凍結範圍完整守住，三方合併應可自動處理。）
- `frontend/src/store.js`、`frontend/src/App.jsx` —— 未加 page、未加 store 欄位。
- `frontend/src/components/InsightCard.jsx` —— 未動（維度→顏色的對映在 ActivityPanel 內複製一份，理由見 §7 偏離 2）。
- `frontend/src/pages/Library.jsx` 的其他部分 —— toolbar、排序、搜尋、`loadPapers()`、輪詢、論文列表全部原樣，沒有順手重構。
- `frontend/index.html` —— 未新增任何 CSS token、未引入任何外部資源（無 npm 套件、無 CDN、無圖表函式庫）。
- `package.json` —— 依賴未動。
- `.env`、`data/`（`.gitignore:3` / `.gitignore:5` 已確認被忽略）—— 全程未寫入；實彈只走唯讀端點，詳見 §5。

---

## 3. `npm test` 精確數字

親手跑 `npm test`（= `node --import ./test/setup-data-dir.js --test test/*.test.js`），全套：

```
ℹ tests 45
ℹ suites 15
ℹ pass 45
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 204.325584
```

- **pass 45 / fail 0 / cancelled 0 / skipped 0**，`echo $?` = `EXIT=0`，**進程正常退出、沒有 hang**（`activity.test.js` 的 `after()` 有 `server.close()` 並清空三表）。
- 其中 `test/activity.test.js` 單檔：**tests 13 / pass 13 / fail 0 / cancelled 0**。
- 基線對照：本工單開工前是 32 個測試；新增 13 個 → 45。既有 32 個全數維持綠燈，沒有一個被本次改動打壞。

`test/activity.test.js` 13 案例 ↔ 工單 §7 必測矩陣：

| 矩陣列 | 對應測試 | 結果 |
|---|---|---|
| 基本分桶（assistant 不計） | `buckets by local day, counts only user messages` | ✔ |
| 洞察標記 + dimensions 排序 | `marks insight days and ranks dimensions` | ✔ |
| totals | `reports totals over the range` | ✔ |
| streak 連續 | `computes current and longest streak on consecutive days` | ✔ |
| streak 寬限（今天無活動從昨天起算） | `grants one day of grace when today has no activity` | ✔ |
| streak 斷開 | `breaks the streak across a gap` | ✔ |
| peak_hour | `returns the modal hour as peak_hour` | ✔ |
| days 範圍 `?days=1` | `honours ?days=1 (today only)` | ✔ |
| `days=0` | `honours ?days=0 (all — from = earliest activity day)` | ✔ |
| 參數驗證 | `rejects invalid days with 400`（`abc` / `-1` / `9999` / `1.5`） | ✔ |
| 空 DB | `returns an all-zero shape on an empty DB` + `…with days=0` | ✔ |
| 內容不外洩 | `never leaks message or insight content` | ✔ |
| teardown 不 hang | `after()` → `server.close()`；EXIT=0 | ✔ |

---

## 4. `git diff --check`

```
$ git diff --check
（無輸出）
$ git diff --cached --check
（無輸出）
```

**全綠**，無行尾空白、無衝突標記。每個 commit 在提交前都先跑過 `git diff --cached --check`。

---

## 5. 實彈結果

### 5.1 先確認不會寫她的真實 DB

`startServer()` 會 fire-and-forget 跑 `flushUnsynced()`（洞察出海補傳），成功時**會回寫** `external_ombre_id` / `synced_at`。開跑前先唯讀查證：

```
$ sqlite3 -readonly data/co-reading.db "SELECT key, CASE WHEN value='' THEN '(empty)' ELSE '(set)' END FROM settings WHERE key IN ('gateway_url','gateway_token'); SELECT 'unsynced_insights=' || COUNT(*) FROM insights WHERE synced_at IS NULL;"
gateway_token|(set)
gateway_url|(set)
unsynced_insights=0
```

`unsynced_insights=0` → 補傳撈不到任何列，**零寫入**。實跑後的伺服器日誌也只有啟動那一行、沒有 `啟動補傳` 行，佐證這點。

### 5.2 `PORT=3456 node src/server.js` + `curl '…/api/activity?days=0'`

原始 JSON（未加工）：

```json
{"from":"2026-06-05","to":"2026-09-07","days":[{"day":"2026-06-05","messages":0,"insights":0,"papers":1},{"day":"2026-06-09","messages":5,"insights":0,"papers":1},{"day":"2026-06-10","messages":1,"insights":8,"papers":0},{"day":"2026-06-11","messages":4,"insights":5,"papers":1},{"day":"2026-06-17","messages":1,"insights":0,"papers":0},{"day":"2026-06-24","messages":4,"insights":0,"papers":0},{"day":"2026-06-25","messages":7,"insights":0,"papers":0},{"day":"2026-07-07","messages":0,"insights":0,"papers":1},{"day":"2026-07-08","messages":2,"insights":0,"papers":0}],"totals":{"messages":24,"insights":13,"papers":4,"active_days":7},"streak":{"current":0,"longest":3},"peak_hour":13,"dimensions":[{"dimension":"概念","count":11},{"dimension":"延伸","count":1},{"dimension":"悬题","count":1}]}
```

### 5.3 對照工單 §2 基線

| §2 基線 | 實測 | 判定 |
|---|---|---|
| 7 個活躍日 | `totals.active_days = 7` | ✅ |
| user 訊息分佈 6/9 **5**、6/10 **1**、6/11 **4**、6/17 **1**、6/24 **4**、6/25 **7**、7/8 **2** | 逐日完全一致（見上方 JSON） | ✅ 七天七個數字全中 |
| `2026-06-25` messages = 7 | `{"day":"2026-06-25","messages":7,…}` | ✅ |
| `2026-06-10` insights = 8 | `{"day":"2026-06-10","insights":8,…}` | ✅ |
| `2026-06-11` insights = 5 | `{"day":"2026-06-11","insights":5,…}` | ✅ |
| `dimensions[0]` = `概念` 11 | `{"dimension":"概念","count":11}` | ✅ |
| insights 只落在 2 天、共 13 條 | 只有 6/10、6/11 有 insights；`totals.insights = 13`（8+5） | ✅ |
| papers 4 個上傳日 | `totals.papers = 4`（6/5、6/9、6/11、7/7） | ✅ |

其他觀察（皆符合 §4.2 語義，非異常）：

- `days` 陣列有 9 列而 `active_days` 只有 7 —— 6/5 與 7/7 是「只有論文上傳、沒有 user 訊息」的日子。§4.2 規定 `days` 回三表聯集、`active_days` 只數 `messages > 0`，所以 9 ≠ 7 是對的。
- `from = 2026-06-05`（`days=0`）—— §4.2「最早活動日（三表取最小）」，最早的是 6/5 那次論文上傳，比最早的 user 訊息（6/9）更早。
- `streak.current = 0` —— 最後一次活動是 7/8，離今天（9/7）兩個月，今天與昨天都沒活動 → 0。`longest = 3` 來自 6/9→6/11。
- `peak_hour = 13` —— §2 沒給這項基線，屬新資訊。

### 5.4 參數驗證（實彈）

```
days=abc  -> 400
days=9999 -> 400
```

### 5.5 缺省 `days=365`

```json
{"from": "2025-09-08", "to": "2026-09-07", "totals": {"messages": 24, "insights": 13, "papers": 4, "active_days": 7}, "streak": {"current": 0, "longest": 3}, "peak_hour": 13, "dimensions": [{"dimension": "概念", "count": 11}, {"dimension": "延伸", "count": 1}, {"dimension": "悬题", "count": 1}]}
```

`from` = `to − 365 + 1` = 2025-09-08 ✅。

跑完已 `kill`，`pgrep -fl "src/server.js"` → `server stopped`。

### 5.6 前端可編譯（不跑 build）

依指示不跑 `npm run build` / `npx vite build`。改用 `npm run dev` 起 vite，向 dev server 索取模組讓它實際做 JSX transform：

```
GET /src/components/ActivityPanel.jsx  → HTTP 200（回的是轉譯後的 JS，非錯誤 payload）
GET /src/pages/Library.jsx             → HTTP 200，內含 2 處 ActivityPanel 引用
GET /src/api.js                        → HTTP 200，內含 activityApi
GET /api/activity?days=0（經 vite proxy 到 :3456） → 回上面同一份真實 JSON
```

vite 啟動日誌 `grep -iE "error|fail|warn|Pre-transform"` **零命中**：無 JSX 語法錯、無 import 解析錯、無 pre-transform 錯誤。跑完已 kill（vite + backend + concurrently 全部確認停掉）。

### 5.7 未做（留給她親手驗收）

工單 §9 DoD 中的瀏覽器項目，依派工指示不由我執行：開 `http://localhost:5173` 目視熱力圖深淺、切換 `All/90d/30d`、收合後刷新是否保持、深色主題、375px 不橫向溢出、把端點打成 500 看 Library 其餘部分是否照常。這些的代碼路徑都已實作（見 §6 已知限制第 1 條）。

---

## 6. 已知限制

1. **UI 只做過靜態與編譯層驗證，未經人眼**。熱力圖對齊（月份標籤 vs 週欄）、深色主題下 `color-mix` 的實際觀感、375px 的溢出行為，都只推理未目視。
2. **時區**：分桶寫死 `'localtime'`（伺服器＝她的 Mac）。工單 §4.2 明確接受這點；一旦部署到遠端 VPS 就會錯天，必須改成前端分桶或傳 tz offset。已寫進 `TECHNICAL_MANUAL.md` §7.3a 與 `activity.js` 的檔頭註解。
3. **無 `created_at` 索引**，走全表掃描。工單 §2 明示資料量只有幾十筆、本工單不加索引。資料長到幾萬筆時 `date()` 包在 WHERE 裡會讓索引也失效，屆時要改成存日期欄或用範圍比較 ms 邊界。
4. **`peak_hour` 眾數平手時取較小的小時**（`ORDER BY n DESC, hour ASC`）；工單未規定平手規則，這是為了讓結果穩定可測。
5. **`dimensions` 同 count 平手時按維度名 BINARY 升序**（`ORDER BY count DESC, dimension ASC`）；同上，工單只規定「依 count 降序」。測試因此不硬斷言平手時誰在前，改斷言「不遞增」＋逐維度計數。
6. **`days=0` 且完全無資料**時 `from === to`，熱力圖只畫一欄。行為正確但畫面單薄。
7. **收合狀態存 `localStorage`**，隱私模式下讀寫都包了 try/catch，失敗時退回「展開」。
8. **面板固定拉整個範圍的資料**，切換 All/90d/30d 各打一次端點，無快取。資料量小，可接受。
9. **`.slice(-26)` 的響應式**靠 JS 監聽 `resize` 而非純 CSS，所以是視窗寬度（非容器寬度）決定；Electron 視窗縮到 <768px 時同樣會切成 26 週。

---

## 7. 偏離工單之處

共 5 處，都是工單未規定而必須做選擇的地方，無一違反 §4 已定案語義或 §6 紅線。（同步填入工單末尾「附錄：實作偏離記錄」。）

1. **面板預設範圍選 `All`（`days=0`），不是端點缺省的 365。**
   工單 §4.3 規定切換鈕是 `All / 90d / 30d`，但沒說面板首次載入用哪一檔；§4.2 的 365 是**端點**缺省。選 All 的理由：她的資料橫跨 6/5–7/8，而今天（9/7）往回 90 天是 6/9 —— **90d 會把 6/5 的論文上傳和 6/9 那 5 則訊息切在邊界上**，首屏就少東西。All 保證第一眼看到全部 7 個活躍日。`activityApi.get()` 的函式簽名仍保留 `days = 365` 的預設值，與端點一致。

2. **維度→顏色對映在 `ActivityPanel.jsx` 複製一份，沒有 import `InsightCard.jsx`。**
   `InsightCard.jsx:5` 的 `DIMENSIONS` 常數沒有 `export`，要共用就得改那個檔；§5 的允許清單沒有它。取捨後選擇「不碰既有檔」，在 ActivityPanel 內複製六個維度的 token 對映並加註解指回 InsightCard。代價是兩處重複，日後改色要改兩個地方。

3. **八格統計在 <640px 排成 4 列 × 2 欄。**
   工單 §4.3 寫「2×4」。在 ≥640px（Tailwind `sm:`）是規定的 2 列 × 4 欄；窄螢幕若硬撐 4 欄，每格只剩約 80px，「最多的維度」那格（維度名＋數量）必被截斷。故用 `grid-cols-2 sm:grid-cols-4`。這與 §4.3「響應式」的意圖一致。

4. **參數驗證多測一個 `?days=1.5`，空 DB 多測一個 `days=0` 變體。**
   矩陣列的是 `abc` / `-1` / `9999`；`1.5` 是同一類（非整數）的漏網形狀，順手補上。空 DB 的 `days=0` 走的是另一條分支（`from` 取三表最小值、無資料時退回今天），值得單獨釘住。13 個測試 = 矩陣 13 列（其中「空 DB」拆成兩個測試、「teardown」由 EXIT=0 佐證）。

5. **月份標籤不標在最後一欄。**
   `monthLabelsFor()` 跳過 `i === weeks.length - 1`。工單只說「月份標籤在頂列」。若月份剛好從最後一欄起頭，標籤會超出容器被裁成半個字；寧可少標一個月份也不要畫破。

### 明確**沒有**偏離的地方（工單 §6 逐條核對）

- 色階是分檔 `0 / 1–2 / 3–5 / 6+`，**不是**線性。
- 計數用 `role='user'`，**沒有**改用 assistant 或 token。
- 洞察是格角的點，**沒有**拿來當色階。
- streak 依「有 user 訊息的天」，**不依**洞察。
- 回應 JSON 不含任何 `content` / `title`；測試以 `SECRET_MARKER_xyz` / `SECRET_TITLE_xyz` / `SECRET_BODY_xyz` 三個標記，對 `''` / `?days=0` / `?days=30` 三種查詢各斷言一次，並額外斷言字串裡不出現 `"content"` / `"title"` 欄位名。
- 無 push、無 build、無 `.env` 或 `data/` 變動、無 migration、無新索引、無新 npm 套件或 CDN 資源。
- 面板放 Library 頂部、預設展開、篩選／搜尋時隱藏（§12 兩個已拍板決策）。
- 分支從 `main` @ `c1ce559` 切，不是 `feat/carryover-client`。

---

## 8. commit 紀錄

| SHA | 內容 |
|---|---|
| `1c52118` | `feat(activity): add read-only /api/activity aggregation endpoint`（`src/routes/activity.js`、`src/server.js`、`test/activity.test.js`） |
| `1680be6` | `feat(activity): add ActivityPanel to the Library welcome view`（`ActivityPanel.jsx`、`api.js`、`Library.jsx`） |
| （本 commit） | `docs(activity): document /api/activity + implementation report`（`TECHNICAL_MANUAL.md`、工單附錄、本報告） |

三個 commit 都帶 `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`。**未 push**，遠端沒有這個分支
（`git branch -r --contains HEAD` 無輸出）。

一個提交過程中抓到並修掉的失手：docs commit 一開始用 `git add docs/work/`，把開工前就躺在工作樹裡的
四個**不相干**未追蹤檔（`biomedical-safety-closeout-20260831.md`、`workorder-01/02/03-*.md`）一起掃了
進去。已 `git rm --cached` 後 `--amend`，那四個檔現在原封不動回到未追蹤狀態，`git diff main --name-only`
只剩本工單的檔案。

---

## 9. 回滾

無 migration、無 DB 寫入。`git branch -D feat/activity-panel` 即完全回滾；`localStorage['co-reading:activity-collapsed']` 殘留鍵無害。
