# 工單 21：研究進度圖（靜態版）——一個方向一張，手寫 SVG＋HTML 節點

**日期**：2026-09-19　**狀態**：她說「現在開吧」，直接做
**基線**：`main` @ `7c34c6f`　**分支**：`feat/wo21-progress-map`
**前置**：總設想步驟 0、1 ✅（`vision-research-map-20260918.md`）；姊妹單 gateway `workorder-claims-graph-fields-20260919.md`（`/claims` 補欄位；本單先照該單定義的回應形狀寫，用假 gateway 測，真 gateway 等兩邊都上）
**性質**：新頁面＋新後端代理＋純函數佈局引擎。不碰精煉、不碰提取、不碰洞察。

---

## 一、目標與非目標

**目標**：側欄新頁「研究進度」，選一個方向，畫出該方向研究線上所有 claims 與關係：以方向為根往外長的樹，「矛盾」是橫跨的虛線，被取代的節點預設不畫、開關打開才淡色出現。點節點看溯源。頁頂顯示「這個方向還有 N 篇沒精煉」＋她按才跑的「逐篇精煉」。

**非目標**：拖曳、縮放手勢、時間軸滑桿、局部聚焦視圖（步驟 3）；圖上手改任何東西（紅線：圖唯讀）；改 gateway 契約以外的東西；設定頁那棵方向×知識樹的圖形化；洞察聯想圖併入。

## 二、真資料長什麼樣（2026-09-19 py-GCMS 線，設計依據）

| 事實 | 對設計的影響 |
|---|---|
| 33 條 active claims：finding 12／methodological_note 14／open_question 3／next_action 2／decision 1／research_question **1** | 根不能只靠 research_question（有的方向會是 0 或多個） |
| 14 條關係：supports 9／contradicts 2／refines 2／answers 1；**沒有**多父節點 | 兩趟佈局仍要做（別的方向會有多父） |
| **14 條 claims 完全沒有關係（42%）** | 孤兒必須有結構父，否則圖上飄一半 ⇒ **每條 claim 的保底父＝它出自的論文** |
| 三篇各 9／9／8 條＋7 條「討論產生」（無 paper 來源） | 需要一個「討論（跨篇）」虛擬分組節點 |
| 1 條跨篇 contradicts（PE/PVC → Py-GC/MS），note 非空 | 橫線要能顯示 note |
| statement 22–51 字，平均 35 | 節點卡寬 220px、最多 3 行足夠；超過截斷＋title |
| `rc_revisions` 0 筆、superseded 0 筆 | 「走過的路」開關先用假資料測，真資料等她回退時才有 |

## 三、資料來源（co-reading 後端代理，前端不直連 gateway）

### B1 `GET /api/directions/:nodeId/progress`（新，`src/routes/directions.js` 或掛在 tree 路由）
- `nodeId` 必須是頂層方向（`parent_id IS NULL`），否則 400。
- 組 `topic:<nodeId>`，打 gateway `GET /claims?session_key=…&include=superseded`（姊妹單定義的形狀，見 §四），失敗回 502 帶 `reason`（照 `carryover.js` 的 log 風格，不拋）。
- 本地補：該方向底下的論文清單（含子節點的論文，用 `directionOfPaper` 反向：撈所有 papers 逐篇解析，或直接沿 tree 找子孫節點 id 集合），每篇 `{ id, title, message_count, refine_state }`（`refineStaleness(paperId)`，沿用工單 20）。
- 回應：
```json
{ "direction": {"id","name","description"},
  "session_key": "topic:…",
  "papers": [{ "id","title","message_count","refine_state" }],
  "claims": [ …gateway 原樣… ],
  "relations": [ …gateway 原樣… ],
  "fetched_at": 1700000000000 }
```
- 15s 逾時（沿用 `FETCH_TIMEOUT_MS`）；不快取（頁面每次進來都回源，資料小）。

### B2 「逐篇精煉」不加後端
前端拿 `papers` 裡 `refine_state ∈ {never,new_messages}` 的清單，**逐篇、序列**呼叫既有 `POST /api/papers/:id/refine`（一篇約 15–40s），每篇完成後更新進度文字並重拉 B1。她按才跑；中途可停（下一篇不發）。`stale` 的篇不自動納入（她拍板③手動型），另列「N 篇對話改過」提示，點進論文頁去按「重新精煉這篇」。

## 四、gateway `/claims` 的新形狀（姊妹單交付；本單以此寫假 gateway）

```json
{ "session_key": "topic:…",
  "claims": [{
    "id","claim_kind","epistemic_origin","origin_actor","status",   // active | superseded | merged
    "statement","confidence","created_at","updated_at",
    "paper_ids": ["…"],                 // 來自 rc_sources source_kind=paper，去重，可空
    "superseded_by": null | "claim id",
    "merged_into": null | "claim id",
    "supersede_reason": null | "string"  // rc_revisions reason=SUPERSEDE 那筆的 note／snapshot 摘要，沒有就 null
  }],
  "relations": [{ "id","from_id","to_id","kind","note","created_at" }],  // 整條線，一列一條
  "counts": { "active": 33, "superseded": 0, "merged": 0, "relations": 14 } }
```
`include=superseded` 才回非 active 的；預設只回 active（與現行相容）。

## 五、佈局引擎（純函數，`frontend/src/lib/progressLayout.js`，可單元測）

**輸入**：`{ direction, papers, claims, relations, showSuperseded }`
**輸出**：`{ nodes: [{id, kind:'direction'|'paper'|'group'|'claim', x, y, w, h, data}], treeEdges: [{from,to}], overlayEdges: [{from,to,kind,note,crossPaper:boolean}], warnings: [] }`

**兩趟走（調研報告坑①，不可省）**：
1. **建結構樹**：
   - 根＝方向。第二層＝每篇論文一個 paper 節點（只列有 claims 的）＋一個 `group:'討論'` 節點（放 `paper_ids` 為空的 claims）＋ research_question 直接掛根（若有）。
   - 每條 active claim 的**結構父**：取它**第一條 outgoing** `answers`／`refines`／`supports`／`partially_supports` 的目標（目標須在同線且不造成環，DFS 檢查）；沒有 → 它的第一個 `paper_ids` 的 paper 節點；還沒有 → `討論` 節點。
   - 有環或多父：只留第一條當結構邊，其餘**降級成 overlay**，`warnings` 記一筆。
   - `contradicts` **永不**進樹。
   - `showSuperseded=false` 時 superseded／merged 的 claim 不進 nodes；`true` 時進，父同上（找不到父就掛 `討論`），並多一條 overlay `{kind:'superseded_by'}` 指向後繼。
2. **算座標**：`d3-hierarchy` 的 `hierarchy()`＋`tree()`（**只裝 `d3-hierarchy`**，5.5 KB、ISC，不裝 d3 全家）。水平樹（左→右）：`nodeSize([rowH, colW])`，rowH＝節點高＋12、colW＝260。節點高由 statement 長度估：≤24 字 1 行、≤48 字 2 行、其餘 3 行（每行 20px＋padding），**估算只用來排版，真正換行交給瀏覽器**。
3. **overlay**：`contradicts`（全部）＋第 1 步降級的邊＋`superseded_by`，照兩端已算好的座標畫；`crossPaper = from 與 to 的 paper_ids 無交集`。

**必測（`test/progress-layout.test.js`）**：多父不拋且只一條進樹；有環不拋；多根（兩個 research_question）不拋；孤兒掛 paper；無 paper 掛討論；contradicts 永不在 treeEdges；superseded 開關兩態；空線（0 claims）回只有根的圖。

## 六、頁面（`frontend/src/pages/Progress.jsx`＋`components/ProgressGraph.jsx`）

- **入口**：`App.jsx` 加 `page === 'progress'`；`Sidebar.jsx` 在「洞察」旁加「研究進度」。
- **頁頂**：方向下拉（頂層節點；預設＝側欄當前選的方向，否則第一個）；統計列 `N 條 claims · M 條關係 · 已精煉 a/b 篇`；**「這個方向還有 N 篇沒精煉」＋按鈕「逐篇精煉」**（跑時顯示「精煉中 2/3：<title>」＋「停」）；「N 篇對話改過」提示（連到論文頁）；開關「顯示走過的路」（預設關）；論文篩選 chips（點一篇 → 該篇節點與其邊高亮，其餘淡）。
- **畫布**：一個 `position:relative; overflow:auto` 的容器，裡面 `<svg>` 邊層（絕對定位、`pointer-events:none`）＋ HTML 節點層（每個節點 `position:absolute`）。畫布尺寸＝佈局輸出的包圍盒＋邊距。**不做縮放手勢**；提供「適應視窗」按鈕（CSS `transform: scale()` 到剛好放下，最小 0.5）。
- **節點卡**（HTML）：寬 220px；內容＝statement（**CSS 必須**：`overflow-wrap:anywhere; line-break:strict; white-space:normal; display:-webkit-box; -webkit-line-clamp:3`，完整句放 `title`）；左側 3px 色條＝出身（沿用 `CarryoverPanel.jsx` 的 `ORIGIN_BADGE` 配色，抽成共用常數）；右下角小字＝kind 中文（研究問題／假設／發現／證據／方法論／決定／被否決／開放問題／下一步）；有 paper 就顯示論文短名 chip（標題前 14 字）。superseded 的卡：整體 `opacity:.45`＋刪除線，chip「被取代」。paper 節點：粗體標題＋`已精煉／沒精煉／對話改過` 小標。
- **邊**：樹邊＝細實線曲線（`M x1 y1 C …`），顏色 `text-faint`；overlay：`supports/partially_supports` 淡綠實線、`refines` 灰實線、`answers` 藍實線、**`contradicts` 紅色虛線 `stroke-dasharray:6 4`、寬 2px**、`superseded_by` 灰虛線帶箭頭。跨篇的 overlay 再粗 0.5px。hover 邊：顯示 `note`（用 `<title>` 即可）。
- **點節點**：開溯源視窗——把 `CarryoverPanel.jsx` 裡的 `ProvenanceModal` 抽到 `components/ProvenanceModal.jsx` 共用（它現在要 `paperId` 走 `/papers/:id/claims/:claimId/provenance` 代理；本頁傳該 claim 的第一個 paper_id，沒有就傳方向底下任一篇——代理只用 paperId 找 gateway 設定，不影響結果）。
- **深色模式**：全部用既有 Tailwind 語意色（`text-muted`／`bg-surface`／`border-border`／`text-danger`），不寫死色碼。
- **空狀態**：方向下沒有精煉過的論文 → 只畫根＋「還沒有東西，先精煉幾篇」＋逐篇精煉按鈕。

## 七、紅線
1. **圖唯讀**：不提供任何改 claim／拉關係／刪節點的操作。
2. **gateway 是唯一事實源**：co-reading 不另存 claims（B1 不落庫）。
3. **contradicts 永不參與佈局、永不被省略**。
4. **不自動精煉**：「逐篇精煉」只在她按了之後跑，且序列一篇一篇；`stale` 的不納入。
5. 只裝 `d3-hierarchy`；不裝 React Flow／cytoscape／elkjs／tldraw／mind-elixir（授權與體積，調研報告坑④）。
6. 不動 `src/carryover.js` 的精煉邏輯、`src/memory.js`、洞察任何檔、`CONSTITUTION`。`CarryoverPanel.jsx` 只准做「抽出 ProvenanceModal」這一件事，行為不變。
7. 不部署、不 push；她本機 `data/` 不碰；她正跑 `npm run dev`（`node --watch`），改 `src/` 會讓她 server 自動重啟——**改後端前先 `curl` 確認 `/api/papers` 沒有進行中的精煉**（看 `data/app.log` 最近 1 分鐘無「精煉」INFO 即可）。

## 八、範圍外
拖曳／縮放手勢／時間軸／局部聚焦（步驟 3）；「去對話」跳到訊息（claims 沒有 message 級來源，等 gateway 補）；方向按鈕搬到標題旁；洞察聯想併圖；匯出圖片。

## 九、驗證
**agent**：`npm test` 全綠報數字（基線 507）；佈局引擎測試 §五全部；B1 路由測試（假 gateway：正常／gateway 502／非頂層 400／refine_state 逐篇）；`npm run build` 綠（建到暫存目錄，不覆蓋 `dist/`）；報告附一張 **用真資料形狀做的假 fixture**（3 篇＋討論、33 claims、14 關係、1 跨篇 contradicts、1 superseded）跑出的 nodes／edges 統計。
**我**：親跑測試；diff 白名單；`npm run build` 進 `dist/`；瀏覽器親手：側欄「研究進度」→ py-GCMS → 看到三篇＋討論四個分組、跨篇紅虛線、點節點開溯源、篩選一篇高亮、開關「走過的路」（真資料 0 筆，只驗不炸）、「逐篇精煉」對 nano plastics 方向按一次看序列跑（6 篇約 2–4 分鐘，真上游）。

## 十、交付
四個 commit（B1 後端＋測試／佈局引擎＋測試／頁面＋圖／逐篇精煉＋ProvenanceModal 抽出），報告 `docs/work/report-21-progress-map-20260919.md`（changed-file list、沒改什麼、測試數字、build、fixture 統計、已知限制），偏離寫本檔附錄 A，十行內回覆。commit 結尾 `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`。

---

## 附錄 A：實作偏離（2026-09-19，agent）

1. **§五 的估行 ≤24 字 1 行／≤48 字 2 行 → 改成 16 字／行**。卡寬 220px 扣掉色條與左右 padding 剩約 200px，statement 是 12px，一個中文字就 12px ⇒ 一行只放得下 16 個字。照 24 估會把兩行的句子當成一行，卡片高度不夠、字被 `overflow:hidden` 切掉。估算的用途是排版，排得對才有意義（常數 `CHARS_PER_LINE` 在 `progressLayout.js`，要調一行就好）。
2. **§六「ORIGIN_BADGE 抽成共用常數」連帶動到 `CarryoverPanel.jsx` 的第二處**：`ProvenanceModal` 依賴 `OriginBadge`，所以配色常數搬到 `frontend/src/lib/claim-visual.js`、`OriginBadge` 成為 `components/OriginBadge.jsx`。`CarryoverPanel.jsx` 的實際 diff 是 **＋2 行 import／−97 行**（純搬移），行為零變動、既有測試零退步。
3. **§三 B1 的路由做成工廠** `createDirectionsRouter({database, fetchImpl, config})`，`src/routes/directions.js` 的 default export 是 `createDirectionsRouter()`。理由：路由層要能整條走假 gateway（紅線：不打她的生產）。
4. **逐篇精煉一篇失敗就停**（工單未規定）：網路不穩時連著打只會把上游打更死；錯誤顯示在頁面，已完成的那幾篇不受影響。
5. **紅線 3 的延伸**：`contradicts` 的另一端被藏起來（superseded 關著）時畫不出線，這種情況記 `warnings` 並在頁面底下用一行小字說出來，不靜靜吞掉。
6. **頁面多一顆「重新整理」**（工單未列）：B1 不快取，但精煉完、或 gateway 剛好抽風時她需要一個不用換頁的回源入口。
7. **gateway 姊妹單 9/19 交付說明的四點已吃下**：懸空邊略過＋記 warning、`supersede_reason` 文案寫「原本是：…」、結構父取第一條前先按 `(created_at, id)` 排序、頁頂統計用 `counts`（整線帳）。

## 附錄 B：主窗口親驗＋收尾（2026-09-19 晚）

- 親跑 `npm test`：552→553（補一顆）全綠；diff 白名單內（多 `frontend/index.html` 的節點 CSS、`src/server.js` 掛路由，皆合理）；只裝 d3-hierarchy。
- 瀏覽器親手（`dist` 已 build，真 gateway）：側欄「研究進度」→ py-GCMS：33 claims／14 關係、三篇＋「討論（跨篇）」四個分組、40 條 path（37 樹邊＋2 條紅虛線 contradicts 其中 1 條標「跨篇」帶 note＋1 條 overlay）、點節點溯源視窗（出身／來源論文／七條關係）、篩選一篇其餘 25 張卡淡到 0.18、「走過的路」開關兩態不炸。
- **親驗抓到兩個洞，已修**：①「適應視窗」只算寬不算高，這張圖又高又窄永遠不縮 → 寬高取小、ResizeObserver 真的 observe（`317a33b`）；②「逐篇精煉」碰到 0 則對話的論文被後端 400「對話不足 2 條」整條佇列停死 → 後端標 `no_discussion` 不進佇列＋頁頂「（另 N 篇還沒討論過）」、迴圈失敗記下來繼續、連續兩篇失敗才停（`bc5815c`）。
- 「逐篇精煉」真上游實彈（nano plastics，4 篇有討論／2 篇沒討論）：4/4 成功，18.2s（膽固醇 41 則）／12.4s／14.3s／11.8s，圖長到 39 claims／24 關係、兩個研究問題（多根排得開）、1 條多父邊降級成橫線（提示有顯示）。
- 誠實限制：nano plastics 線 24 條關係**零跨篇**（3 條 contradicts 都在同篇或討論 claims 之間）；py-GCMS 線有 1 條跨篇 contradicts。跨篇邊會不會長，取決於論文內容是否真的互相碰撞——這批六篇題目分散（蛋白冠／脂雙層／efferocytosis）本來就少交集。總設想 §三的「prompt 明示跨篇」退路仍留著，等她讀了真圖再說。
- 合入 main `6488dc7`（未 push）。Escape 不關溯源視窗（點背景關）＝小瑕疵，留步驟 3。
