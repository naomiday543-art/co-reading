# 工單 23：研究進度圖——節點展開／收縮

**日期**：2026-09-19　**狀態**：她看過圖後說「感覺還是加個展開收縮比較好」，直接做
**基線**：`main` @ `cb61701`（已 push）　**分支**：`feat/wo23-progress-collapse`
**前置**：工單 21 ✅（`frontend/src/lib/progressLayout.js` 兩趟佈局、`pages/Progress.jsx`、`components/ProgressGraph.jsx`）
**性質**：佈局引擎多一個輸入（哪些節點收起）＋卡片一顆小三角＋兩顆全域鈕。不動資料、不動後端、不動 gateway。

## 一、她要什麼
六篇論文的方向一展開又高又窄，「適應視窗」縮到 0.5 字就看不清。她要能把不看的那幾篇收起來，只留正在看的。

## 二、設計

### D1 佈局引擎（`progressLayout.js`，純函數）
`layoutProgress({ …既有, collapsed })`，`collapsed` 是節點 id 的 `Set`（`paper:<id>`／`group:discussion`／`claim:<id>`）。**兩趟走照舊**，在第 1 步建完結構樹之後、第 2 步算座標之前做修剪：

1. **修剪**：任一節點若其祖先（沿結構父）在 `collapsed` 裡 → 不進 `nodes`。收起的節點本身留著，多帶：
   - `collapsed: true`
   - `hiddenClaims: <被藏起來的 claim 後代數>`
   - `hiddenOverlays: { contradicts: n, supports: n, refines: n, answers: n, partially_supports: n, superseded_by: n }`（見 3）
2. **可收合的節點**：`collapsible = 結構子節點數 > 0`（paper／group 幾乎都是；claim 只有當它是別的 claim 的結構父時才是）。方向根不可收。
3. **橫線怎麼辦（這單唯一要想清楚的地方）**：對每條 overlay 邊，把兩端各自換成「最近的可見祖先」（自己可見就是自己；被藏就是把它藏起來的那個收起節點）：
   - 兩端都可見 → 照畫。
   - 一端被藏 → 畫到那個收起的卡，邊多帶 `retargeted: true`，該卡 `hiddenOverlays[kind]++`。
   - 兩端被同一個收起節點藏 → 不畫，該卡 `hiddenOverlays[kind]++`（矛盾不能憑空消失：卡上要有紅點）。
   - 兩端被不同收起節點藏 → 畫在兩張收起卡之間，`retargeted: true`，兩張卡都 `++`。
   - 同一對可見端點多條邊合併成一條（避免重疊），`count` 欄記幾條。
4. `treeEdges` 只含可見節點之間的邊。`bounds` 隨修剪後的樹重算——這才是她要的「收起來圖就變小」。
5. `collapsed` 為空或未給 → 輸出與現在 **deepEqual**（零回歸釘子）。

### D2 卡片（`ProgressGraph.jsx`）
- `collapsible` 的卡右下角一顆小三角：展開時 `▾`、收起時 `▸`，`title`「收起這底下的 N 條」／「展開」。點三角只切換收合，**不開溯源**（`stopPropagation`）。
- 收起的 paper／group 卡：標題下改顯示 `N 條 claims` 小字；有 `hiddenOverlays.contradicts>0` 時右上一個紅點，`title`「藏著 N 條矛盾」；其他種類藏著的以灰點＋`title` 列數。
- 收起的 claim 卡：statement 照顯示，右下三角 `▸`，下方小字 `+N`。
- `retargeted` 的邊：樣式同原 kind，`<title>` 前綴「（接到收起的節點）」；`count>1` 時 title 尾巴加「×N」。

### D3 頁面（`Progress.jsx`）
- 狀態 `collapsed: Set`，**預設全部展開**。
- 工具列多兩顆鈕：「全部收起」（把所有 paper／group 節點加進 set）、「全部展開」（清空）。放在「顯示走過的路」旁邊。
- 記憶：`localStorage` key `co-reading:progress-collapsed:<directionId>`，存 id 陣列；**讀寫都包 try/catch**，讀不到就當全展開。切方向讀該方向的；不進資料庫。
- 「篩選某篇」與收合各自獨立：篩選只改透明度，收合改結構。
- 「適應視窗」用修剪後的 `bounds`（自然變小）。

### D4 順手：溯源視窗按 Escape 關閉
`components/ProvenanceModal.jsx` 加 `keydown` 監聽 Escape → `onClose()`，卸載時移除。她昨天親驗時 Escape 沒反應。

## 三、紅線
1. 圖仍唯讀（收合只是視圖狀態）。
2. `collapsed` 空集合時佈局輸出與現在 deepEqual（測試釘）。
3. contradicts 永不因收合而消失：要嘛畫到收起卡，要嘛卡上有紅點計數。
4. 不動 `src/`（後端零改動）、不動 `progressLayout.js` 兩趟走的既有規則（只加修剪一段）、不裝新套件。
5. 不部署不 push；不覆蓋 `dist/`（build 到暫存驗）；`git add` 逐檔。

## 四、驗證
**agent**：`npm test` 綠（基線 578）；`test/progress-layout.test.js` 加：①收起一篇 → 該篇 claims 不在 nodes、`hiddenClaims` 對；②一端被藏的 contradicts 接到收起卡且 `hiddenOverlays.contradicts=1`；③兩端同藏 → 不畫、計數 1；④兩端異藏 → 畫在兩收起卡之間；⑤收起有子節點的 claim；⑥同對多邊合併 `count`；⑦空 `collapsed` deepEqual；⑧`bounds` 收起後變小。`npm run build --outDir <暫存>` 綠。
**我**：親跑測試；diff 白名單（只准 `frontend/src/lib/progressLayout.js`、`components/ProgressGraph.jsx`、`components/ProvenanceModal.jsx`、`pages/Progress.jsx`、測試、docs）；build 進 dist；瀏覽器：nano plastics 收起兩篇 → 圖變矮、收起卡顯示條數；收起 py-GCMS 的 PE/PVC 篇 → 跨篇矛盾紅虛線改接到收起卡、紅點「藏著 1 條矛盾」；重新整理後收合狀態還在；Escape 關溯源。

## 五、交付
兩個 commit（D1＋測試／D2+D3+D4），報告 `docs/work/report-23-progress-collapse-20260919.md`（changed-file list、沒改什麼、測試數字、用工單 21 那份 fixture 收起一篇前後的 nodes／edges／bounds 對照），偏離寫本檔附錄 A，十行內回覆。commit 結尾 `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`。
