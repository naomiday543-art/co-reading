# 工單 04：閱讀活動歡迎面板（熱力圖 + 統計格）

> 日期：2026-09-07
>
> 優先級：P2 功能，小型（一個只讀端點 + 一個前端面板）
>
> Repo：`~/research-stack/co-reading`
>
> Base branch：`main` @ `c1ce559`（不是 `feat/carryover-client`；理由見 §8）
>
> 建議分支名：`feat/activity-panel`
>
> 預估改動：`src/routes/activity.js`（新）、`src/server.js`（掛路由一行）、`frontend/src/api.js`（尾端加一個 export）、`frontend/src/components/ActivityPanel.jsx`（新）、`frontend/src/pages/Library.jsx`（插一個元件）、`test/activity.test.js`（新）
>
> 生產權限：**無**。不 push、不 `dist:mac`、不碰 `.env`、不碰 `data/`、不做 migration。
>
> 非目標：點擊格子跳轉到當天的訊息／洞察、gateway 側資料、token 統計、annotations／section_progress 計數、匯出、圖表函式庫。

## 1. 背景與動機

使用者看到 Claude Code 的歡迎頁（sessions／messages／tokens／active days／streak／peak hour／favorite model + 一年份的活動熱力圖），提出：

> 「我在想一個功能 就像是圖上這種歡迎頁，能看到哪一天收入 insight 或者互動的頻率。你覺得用什麼作為計算基準比較好呢？」

co-reading 是她實際「讀」的地方，所有帶時間戳的活動（訊息、洞察、論文上傳）都在本機 `data/co-reading.db`。研究棧的目標是「積累」而非「活動量」，所以這張圖要回答兩個分開的問題：**這天有沒有來**（互動）和**這天有沒有留下東西**（洞察）。

## 2. 已驗證的現況基線（2026-09-06 查證，勿重查）

真實資料分佈，來自 `data/co-reading.db`：

| 來源 | 分佈 | 對基準選擇的含義 |
|---|---|---|
| `messages` (role=user) | 7 個活躍日，每日 1–7 則（6/9 5、6/10 1、6/11 4、6/17 1、6/24 4、6/25 7、7/8 2） | 是「主動追問次數」，最誠實的認真程度代理 |
| `insights` | 只落在 2 天（6/10 8 條、6/11 5 條） | 時間戳是「按下提取那一刻」，一按一批；6/24–25 討論 11 輪卻零洞察——**不能當連續色階** |
| `papers` | 4 個上傳日 | 對應截圖的 sessions |
| `annotations`、`section_progress` | **0 筆** | 未啟用，不能當基準 |

Schema 事實：
- `messages.created_at`、`insights.created_at`、`papers.created_at` 都是 **ms epoch INTEGER**（`src/db.js`）。
- `messages` 既有索引 `idx_msg_paper(paper_id, created_at)`，無純 `created_at` 索引。資料量幾十筆，全表掃描可接受，**本工單不加索引**。
- `insights.dimension` 六值：`概念 / 延伸 / 你的研究 / 闪回 / 共振 / 悬题`（`src/routes/insights.js:9`）。

## 3. 必讀檔案

開工前按順序讀：

1. `src/server.js:24-29`：路由掛載方式（`app.use('/api', xxxRouter)`）；
2. `src/routes/insights.js`：route 檔慣例——`import db from '../db.js'`、同步 `db.prepare().all()`、錯誤回 `{ error }`；
3. `src/db.js:1-20, 252`：DB 開啟與測試逃生口 `CO_READING_DATA_DIR`／`CO_READING_DB_PATH`；
4. `test/chat.test.js:1-40` 與 `test/setup-data-dir.js`：測試怎麼起 server（`startServer(0,'127.0.0.1')`）、怎麼用臨時 DB、怎麼 teardown；
5. `frontend/src/api.js`：`request()` 慣例；**只在檔案尾端新增 export，不動 `papersApi`**；
6. `frontend/src/pages/Library.jsx`：首頁結構，toolbar 結束於 `</div>`（約 L89），`{/* Paper list */}` 之前是插入點；
7. `frontend/src/components/InsightCard.jsx:3-8`：維度→顏色 token 對映（`概念=fact`、`延伸=progress`、`悬题=hyp`），面板「最多的維度」那格沿用；
8. `frontend/index.html`：設計 token（`--accent`、`--surface-alt`、`--hyp`…）與 `[data-theme="dark"]` 自動切換；Tailwind 走 CDN、fonts 自託管，**不新增任何外部資源**；
9. `frontend/src/App.jsx:33-69`：頁面切換是 `page` state，不是 router——本工單**不加新 page**。

## 4. 已定案語義（使用者已拍板，照此實作、不要再問）

### 4.1 熱力圖基準

- **格子深淺 = 當天 `role='user'` 的訊息數。** 不算 assistant（一問一答成對，算進去等於乘二）；不算 token（每輪帶論文全文，token 反映論文長度不反映使用者）。
- **洞察 = 格子角落一個小點，不參與色階。** 當天 `insights.created_at` 有任一筆就亮。
- **色階用分檔，不用線性**：`0 / 1–2 / 3–5 / 6+` 四檔。
- **連續打卡（streak）依「有 user 訊息的天」**，不依洞察。
- **這頁放 co-reading，不放 gateway**（資料在這裡；兩邊管子未通）。

### 4.2 端點

```
GET /api/activity?days=365
```

- `days`：整數，`1..730`；`0` 代表不限（All）；缺省 `365`。非整數或超界 → `400 { error }`。
- 分桶用 SQLite `date(created_at/1000,'unixepoch','localtime')`——co-reading 是本機應用，伺服器時區即使用者時區。**若日後部署到遠端，改為前端分桶或傳 tz offset**，本工單不做。
- 回應形狀（只回有活動的天，前端補空格）：

```json
{
  "from": "2025-09-08",
  "to": "2026-09-07",
  "days": [
    { "day": "2026-06-09", "messages": 5, "insights": 0, "papers": 1 }
  ],
  "totals": { "messages": 24, "insights": 13, "papers": 4, "active_days": 7 },
  "streak": { "current": 0, "longest": 3 },
  "peak_hour": 15,
  "dimensions": [ { "dimension": "概念", "count": 11 } ]
}
```

- `to` = 今天（localtime）；`from` = `to − days + 1`；`days=0` 時 `from` = 最早活動日（三表取最小），無活動則等於 `to`。
- `active_days` = `messages > 0` 的天數。
- `streak.longest` = 範圍內最長連續 active 天數。`streak.current` = 從今天往回數的連續 active 天數；**今天無活動則從昨天起算**（一天寬限，GitHub 語義）；昨天也無 → `0`。
- `peak_hour` = user 訊息 `strftime('%H', …, 'localtime')` 眾數（0–23）；無訊息 → `null`。
- `dimensions` 依 count 降序；範圍與 `days` 一致。
- **只回計數，絕不回 `content`**（見 §6 紅線）。
- 空 DB 必須回全零結構，不得 500。

### 4.3 面板

- 新元件 `frontend/src/components/ActivityPanel.jsx`，自持 state，**不改 `store.js`、不改 `App.jsx`**。
- 插入 `Library.jsx` toolbar 之後、論文列表之前；**只在未篩選狀態顯示**（`!selectedTag && !selectedTreeNode && !searchQuery`）——篩選時是工作模式，不是歡迎頁。
- 頂列：標題「這段時間」＋範圍切換 `All / 90d / 30d`（對應 `days=0/90/30`；使用者資料目前只有三個月，不做 7d）＋收合鈕。收合狀態存 `localStorage['co-reading:activity-collapsed']`，收合時只留一行摘要：「7 個活躍日 · 24 則訊息 · 13 條洞察」。
- 八格統計，2×4，對映截圖：

| 位置 | 標籤 | 來源 |
|---|---|---|
| 1 | 論文 | `totals.papers` |
| 2 | 訊息 | `totals.messages` |
| 3 | 洞察 | `totals.insights` |
| 4 | 活躍天數 | `totals.active_days` |
| 5 | 目前連續 | `streak.current` |
| 6 | 最長連續 | `streak.longest` |
| 7 | 高峰時段 | `peak_hour`，顯示 `15:00`；null 顯示 `—` |
| 8 | 最多的維度 | `dimensions[0]`，顯示維度名＋數量，顏色沿用 `InsightCard.jsx` 對映 |

- 熱力圖：純 CSS grid（列＝週，行＝週一…週日，**週一起始**），每格 11px、圓角 2px、間距 3px；月份標籤在頂列。**不引入任何圖表函式庫。**
  - 色階：`0 → var(--surface-alt)`；`1–2 / 3–5 / 6+ → color-mix(in srgb, var(--accent) 30% / 60% / 100%, var(--surface-alt))`。dark theme 靠 token 自動對。
  - 洞察點：格內右下角 3px 圓，`var(--hyp)`。
  - 每格 `title`：「2026-06-25 · 7 則訊息 · 0 條洞察」。
  - 圖例一行：四檔色塊＋「有洞察」點。
- 響應式：`<768px` 只畫最近 26 週，容器 `overflow-x: auto`。
- 載入失敗：面板內一行 `text-danger` 文案「活動資料載入失敗」，**不得讓 Library 整頁掛掉**。

## 5. 實作範圍

允許：

- 新增 `src/routes/activity.js`，在 `src/server.js:29` 之後加 `app.use('/api', activityRouter)`；
- `frontend/src/api.js` **尾端**新增 `export const activityApi = { get: (days) => … }`；
- 新增 `ActivityPanel.jsx`，在 `Library.jsx` 插入一行；
- 新增 `test/activity.test.js`；
- `TECHNICAL_MANUAL.md` 補一小節端點說明（可選）。

禁止：

- 動 `src/db.js`、`src/routes/papers.js`、`frontend/src/api.js` 的 `papersApi` 物件（`feat/carryover-client` 正在改這三處，**凍結期**）；
- 新增 migration、索引、settings 鍵；
- 任何寫入 DB 的路徑；
- 引入 npm 套件或 CDN 資源；
- 改 `App.jsx` 加新 page、改 `store.js`；
- 順手重構 `Library.jsx` 其他部分。

## 6. 紅線

- **`TECHNICAL_MANUAL.md:486`：「不要把 messages 全量同步到外部：原始對話可能含敏感推測或半成品」**——活動端點只回計數，回應 JSON 裡不得出現任何 `messages.content`／`insights.content`／`insights.title`。測試要用 `JSON.stringify(body)` 斷言不含測試訊息文字。
- 使用者原話（2026-09-06）已定案的基準見 §4.1，**不得**在實作中改回線性色階、改用 assistant 計數、改用洞察當色階。
- `.env`、`data/` 不進 git、不被測試碰到（測試走 `CO_READING_DATA_DIR` 臨時目錄，沿 `setup-data-dir.js`）。
- 實作在 feature branch，不 push、不 build。

## 7. 必測矩陣（`test/activity.test.js`）

起 server 沿 `chat.test.js` 模式；固定資料以「今天 localtime 正午」為錨（`new Date().setHours(12,0,0,0)`），往回減 `k × 86400000`，避免日界誤差。

| 案例 | 資料 | 預期 |
|---|---|---|
| 基本分桶 | P1 上傳於 D-2；user 訊息 D-2 ×3、D-1 ×2、D0 ×1；assistant 訊息 D-2 ×3 | `days` 含 3 天；D-2 `{messages:3, insights:0, papers:1}`；assistant 不計 |
| 洞察標記 | insight D-1 ×2（`概念`、`悬题`） | D-1 `insights:2`；`dimensions[0]` 為 `概念` 或依 count 排序正確 |
| totals | 同上 | `messages:6, insights:2, papers:1, active_days:3` |
| streak | 同上（D-2、D-1、D0 連續） | `current:3, longest:3` |
| streak 寬限 | 只有 D-1 有訊息 | `current:1`（今天無活動從昨天起算） |
| streak 斷開 | D-5 ×1、D-4 ×1、D-1 ×1 | `longest:2, current:1` |
| peak_hour | 訊息全在正午 | `12` |
| days 範圍 | `?days=1` | 只回 D0 |
| days=0 | 同基本資料 | `from` = D-2 |
| 參數驗證 | `?days=abc`、`?days=-1`、`?days=9999` | `400` 且有 `error` |
| 空 DB | 清空三表後 | `200`，全零，`peak_hour:null`，`dimensions:[]` |
| 內容不外洩 | 訊息 content 為 `SECRET_MARKER_xyz` | `JSON.stringify(body)` 不含該字串 |
| teardown | — | `server.close()`，測試進程正常退出，不 hang |

## 8. Base 決策與凍結

- `feat/carryover-client`（`fa57ad2`）比 `main`（`c1ce559`）領先 5、落後 0，已完工待合併（真實 E2E 已過、未部署）。
- 本功能與 carryover 正交。從 `main` 切，避免 carryover 若被退回連帶弄髒本分支。
- 兩邊唯一交集是 `frontend/src/api.js`：carryover 改的是 `papersApi` 內部（L43-49），本工單只在檔案尾端加新 export，git 三方合併可自動處理；仍在 §5 列為凍結以防手癢。
- 若 carryover 先合併，本分支 `git rebase main` 一次即可。

## 9. 交付標準（DoD）

- `npm test` 親手跑、全綠，回報 pass/fail/cancelled 精確數字，不得只報 targeted；
- `git diff --check` 全綠；
- `git diff main --name-only` 只含 §5 允許清單；
- 實彈：`npm run dev` 起本機，開 `http://localhost:5173`，用**真實 `data/co-reading.db`** 看到 7 個活躍日、6/25 最深、6/10–11 有洞察點、`dimensions[0]` 為 `概念 11`；切換 `All/90d/30d`；收合後刷新仍收合；切深色主題；視窗縮到 375px 不橫向溢出；
- 面板載入失敗（把端點暫時改成 500 打一發）Library 其餘部分照常；
- 無 push、無 build、無 `.env`／`data/` 變動。

## 10. 回滾

無 migration、無 DB 寫入。撤回四個檔案的改動即完全回滾；`localStorage` 殘留鍵無害。

## 11. 風險與後續（範圍外，另開工單）

- 點擊某格跳到當天的訊息／洞察列表（需要 messages 查詢端點加 `day` 參數）。
- gateway 側記憶（`memories`）納入同一張圖——等管子接通。
- 遠端部署時的時區處理（見 §4.2）。
- annotations／section_progress 一旦開始使用，可考慮納入第二種標記。

## 12. needs-decision（2026-09-07 使用者已拍板：「嗯呢 都照你推薦的」）

1. **面板位置**：✅ Library 頂部可收合。篩選／搜尋時自動隱藏。
2. **預設展開還是收合**：✅ 預設展開；收合狀態存 `localStorage['co-reading:activity-collapsed']`，刷新保持。

## 附錄：實作偏離記錄

實作於 2026-09-07 完成，分支 `feat/activity-panel`（base `main` @ `c1ce559`）。
完整交付報告：`docs/work/report-04-activity-heatmap-20260907.md`。

共 5 處偏離，都是本工單未規定而必須做選擇的地方，**無一違反 §4 已定案語義或 §6 紅線**：

1. **面板預設範圍選 `All`（`days=0`），不是端點缺省的 365。**
   §4.3 規定切換鈕是 `All / 90d / 30d`，但沒說面板首次載入用哪一檔（§4.2 的 365 是**端點**缺省）。
   選 All 的理由：資料橫跨 6/5–7/8，而今天（9/7）往回 90 天正好是 6/9 —— 90d 會把 6/5 的論文
   上傳與 6/9 那 5 則訊息切在邊界上，首屏就少東西。`activityApi.get()` 的簽名仍保留 `days = 365`。

2. **維度→顏色對映在 `ActivityPanel.jsx` 複製一份，沒有 import `InsightCard.jsx`。**
   `InsightCard.jsx:5` 的 `DIMENSIONS` 沒有 `export`，要共用就得改那個檔，而 §5 的允許清單沒有它。
   選擇不碰既有檔，在面板內複製並加註解指回 InsightCard。代價：兩處重複，日後改色要改兩個地方。

3. **八格統計在 <640px 排成 4 列 × 2 欄。**
   §4.3 寫「2×4」；在 ≥640px（Tailwind `sm:`）確實是 2 列 × 4 欄。窄螢幕硬撐 4 欄的話每格只剩
   約 80px，「最多的維度」那格必被截斷，故用 `grid-cols-2 sm:grid-cols-4`。與 §4.3 響應式意圖一致。

4. **測試比 §7 矩陣多兩個案例**：參數驗證多測 `?days=1.5`（同屬「非整數」類的漏網形狀）；
   空 DB 多測 `days=0` 變體（走的是「三表取最小、無資料退回今天」另一條分支）。

5. **月份標籤不標在最後一欄**（`monthLabelsFor()` 跳過 `i === weeks.length - 1`）。
   §4.3 只說「月份標籤在頂列」。若月份剛好從最後一欄起頭，標籤會超出容器被裁成半個字。

**驗收結果**：`npm test` 45 pass / 0 fail / 0 cancelled / 0 skipped，進程正常退出（其中本工單新增
13 個）；`git diff --check` 全綠；`git diff main --name-only` 只含 §5 允許清單。後端實彈（真實
`data/co-reading.db`，唯讀）逐項對上 §2 基線：7 個活躍日、七天的 user 訊息數全中、6/25 messages=7、
6/10 insights=8、6/11 insights=5、`dimensions[0]` = 概念 11。

**尚待她親手驗收**：§9 DoD 的瀏覽器項目（目視深淺、切換範圍、收合後刷新、深色主題、375px 溢出、
端點打成 500 時 Library 其餘部分照常）。前端只做到「vite 實際轉譯 JSX 無錯」這一層。
