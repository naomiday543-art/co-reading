# 工單 21 交付報告：研究進度圖（靜態版）

**日期**：2026-09-19　**分支**：`feat/wo21-progress-map`（基線 `main` @ `7c34c6f`，工單 commit `d66d931`）
**狀態**：進行中——每完成一塊就 commit 並回來追加這份報告（她網路會吞回覆，磁碟不會）。

---

## 一、Commit ①：B1 後端代理（`88f4dab`）

### 改了什麼
| 檔 | 動作 |
|---|---|
| `src/progress.js` | **新**。`sessionKeyForDirection`／`listDirectionPapers`／`fetchDirectionClaims`／`buildDirectionProgress` |
| `src/routes/directions.js` | **新**。唯讀路由工廠 `createDirectionsRouter({database,fetchImpl,config})`，只有一條 `GET /directions/:nodeId/progress` |
| `src/server.js` | 註冊路由（兩行：import ＋ `app.use('/api', directionsRouter)`） |
| `test/progress-route.test.js` | **新**，17 條 |
| `package.json`／`package-lock.json` | `d3-hierarchy@3.1.2`（ISC，給 commit ② 用） |

### 契約
- `nodeId` 不是頂層方向 → 400；節點不存在 → 404（**不打 gateway**）；gateway 失敗 → 502 帶 `reason`。
- 外呼固定帶 `include=superseded`（畫不畫是前端開關的事，資料一次拿齊），15s 逾時，失敗只 log（`[PROGRESS]`）不拋。
- `claims`／`relations`／`counts` **原樣轉發**（紅線 2：不落庫、不改欄位）。本地只補 gateway 不知道的兩件事：方向底下（含子題）的論文清單、每篇的 `refine_state`（沿用工單 20 的 `refineStaleness`）。
- gateway 形狀壞掉（沒有 `claims` 欄位）→ 退成空陣列，不是 500。

---

## 二、Commit ②：佈局引擎（`frontend/src/lib/progressLayout.js`）

### 改了什麼
| 檔 | 動作 |
|---|---|
| `frontend/src/lib/progressLayout.js` | **新**。純函式 `layoutProgress()` ＋ `estimateLines`／`nodeHeight`／`edgePath`／`nodeIndex` |
| `test/fixtures/progress-direction.js` | **新**。§九 要求的假 fixture（照真資料形狀捏，無一字真資料） |
| `test/progress-layout.test.js` | **新**，28 條 |

### 兩趟走（調研報告坑①）
1. **選生成樹**：`answers`／`refines`／`supports`／`partially_supports` 才可能當結構邊，一個節點最多一個父。研究問題直接掛根；孤兒掛它出自的論文；沒有論文的掛「討論（跨篇）」。多父／成環的邊降級成疊圖層橫線並記 `warnings`。
2. **算座標**：`d3-hierarchy` 的 `tree()`，`nodeSize([1, 260])` ＋ `separation = (h(a)+h(b))/2 + 12`，所以 x 的單位直接是像素、**節點高度不同也不會疊在一起**（測試裡逐層驗過）。
3. **疊橫線**：`contradicts` 全部（紅線 3：永不進樹、永不因佈局被省略）、降級的邊、`superseded_by`。`crossPaper = 兩端 paper_ids 無交集`。

### 吃下 gateway 姊妹單的四個已知行為
1. **懸空邊**（`relations` 指向不在 `claims` 清單裡的節點）→ 略過 ＋ `warnings` 記 `dangling_edge`，**不拋**；懸空的 `contradicts` 另記 `contradicts_hidden`（矛盾不能靜靜消失）。
2. `supersede_reason` 實際是舊 statement 前 120 字 → UI 文案寫「原本是：…」。
3. 同毫秒的 relations 順序不保證 → 取結構父前一律按 `(created_at, id)` 排序；測試用「換輸入順序結果一樣」釘死。
4. `counts` 是整線帳、不隨 `include` 變 → 頁頂統計直接用它。

### §九 要求的 fixture 統計
fixture：3 篇論文（9／9／8 條）＋7 條討論產生、33 條 active claims、14 條關係（supports 9／contradicts 2／refines 2／answers 1）、其中 1 條跨篇 contradicts、另有 1 條 superseded。

| 開關 | nodes | 其中 | treeEdges | overlayEdges | warnings | 畫布 |
|---|---|---|---|---|---|---|
| 「走過的路」關（預設） | **38** | 方向 1／論文 3／討論 1／claim 33 | **37** | **2**（contradicts 跨篇 1 ＋ 同篇 1） | 0 | 1308×1961 |
| 「走過的路」開 | **39** | claim 34 | **38** | **3**（多 1 條 `superseded_by`） | 0 | 1308×2047 |

`treeEdges = nodes − 1` 兩態都成立＝每個非根節點恰好一個結構父，沒有一條 claim 飄在圖外（42% 孤兒靠「保底父＝來源論文」接住）。

### 測試
`npm test`：**552 全綠**（基線 507 → ①524 → ②552）。

---

## 三、Commit ③：頁面＋圖＋側欄入口

### 改了什麼
| 檔 | 動作 |
|---|---|
| `frontend/src/pages/Progress.jsx` | **新**。頁頂（方向下拉／統計／開關／適應視窗）＋篩選 chips＋畫布 |
| `frontend/src/components/ProgressGraph.jsx` | **新**。SVG 邊層 ＋ HTML 節點層 |
| `frontend/src/lib/claim-visual.js` | **新**。ORIGIN_BADGE／色條／kind 中文／邊樣式／論文短名（共用常數） |
| `frontend/src/api.js` | ＋`directionsApi.progress(nodeId)` |
| `frontend/src/App.jsx` | ＋`page === 'progress'` |
| `frontend/src/components/Sidebar.jsx` | ＋「研究」區塊的「研究進度」入口（洞察上面） |
| `frontend/index.html` | ＋`.cr-node-statement`／`.cr-node-desc` 的 CJK 換行規則 |
| `frontend/src/lib/progressLayout.js`／`test/progress-layout.test.js` | 估行改 16 字／行（見附錄 A 偏離①） |

### 幾個關鍵決定
- **節點是 HTML、邊是 SVG**（坑②）：`overflow-wrap:anywhere; line-break:strict; -webkit-line-clamp:3` 寫在 `index.html` 的 `<style>` 裡（Tailwind CDN 沒有這些 utility），完整句放 `title`。
- **顏色全用既有語意色**：色條＝`--accent`（論文報告類）／`--muted`（假設類）／`--faint`／`--danger`；矛盾＝`--danger` 紅虛線 2px、跨篇再粗 0.5px；`superseded_by`＝灰虛線帶箭頭。深色模式自動跟著翻，沒有寫死色碼。
- **不做縮放手勢**：只有「適應視窗」一顆按鈕，CSS `transform: scale()`，下限 0.5。
- **統計用 gateway 的 `counts`**（整線帳，不隨 `include` 變），論文精煉數用本地的 `refine_state`。
- **降級與藏起來的邊會說出來**：頁面底下一行小字報「N 條矛盾邊的另一端不在圖上／N 條多父成環已降級／N 條懸空邊已略過」——紅線 3 不允許靜靜吞掉。
- `supersede_reason` 照 gateway 現況（舊 statement 前 120 字）寫成「原本是：…」，不寫「取代原因」。

### 驗證
`npm test` **552 全綠**；`npx vite build --outDir <scratchpad>/dist-wo21-c3` 綠（349 modules，507.77 kB／gzip 156.06 kB），**`dist/` 沒被覆蓋**（mtime 仍是她 16:55 那次）。
