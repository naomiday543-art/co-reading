# 工單 26：論文閱讀頁版面落地（Claude Design 方案 A ＋ 上傳收成頂列一顆鈕）

**日期**：2026-09-21　**狀態**：設計稿她親手從 Claude Design 拿回來；兩個選擇題她已拍板（見 §二）——**照此實作，不要再問**
**基線**：`main` @ `b6b11b7`（631 綠）　**分支**：`feat/wo26-reading-page-layout`（**worktree**——她的 `node --watch`＋vite 掛在主樹）
**設計稿（唯一依據，先整份讀完）**：`~/Archives/design-handoffs/co-reading-reading-page-20260921/ReaderShell.dc.html`（版面元件，尺寸／顏色／間距全在行內 style）＋同目錄 `design-doc.dc.html`（兩方案說明、高度預算表、「每顆按鈕現在在哪」清單）。**設計稿不進 git**（裡面的假資料帶她未發表的研究想法；本倉是公開倉）。
**性質**：純前端版面重排。後端零改動、資料零改動、功能一顆不少。

## 一、她要什麼
工單 24b／25 之後她說閱讀頁還是擠，我寫了 brief（`docs/work/design-brief-reading-page-20260921.md`）讓她交給 Claude Design。稿子的三招：**合併**（全域頂欄＋標題列併一行；分頁列變成跨兩欄的工作列，右半就是「討論」標頭）、**內縮**（SI 小工具列收進膠囊本身；輸入框下兩行小字鈕收進輸入卡）、**對齊**（全頁 10px 節奏，兩欄底邊同一條線）。

## 二、她拍板的（9/21 21:35）
1. 頂部＝**方案 A 雙層 88px**（52px 頂列＋36px 工作列）。不做方案 B。
2. 上傳條＝**拿掉細條，收成頂列右側圖示組裡的一顆 ⬆ 鈕**；把檔案拖進視窗時整個畫面變拖放層。（稿子把鈕畫在輸入卡裡；她選放頂列——上傳論文是全域動作。）

## 三、我替她定的三處「不照稿」（都是稿子吃了我 brief 的錯）
- **最右那顆 ✕ 不是「關閉」，是「刪除這篇論文」**（`PaperDetail.handleDelete`，有 `confirm`）。我 brief 寫錯了。落地＝**垃圾桶圖示**、`title="刪除這篇論文"`、保留 `confirm`，位置照稿（頂列最右、細線分隔之後）。
- **閱讀模式保留現有行為**（工單 06：論文撐滿、討論收成右下角抽屜、ChatPanel 不 unmount）。不照稿子改成「分隔線推到 97%」。
- **「精煉本次共讀」不是一顆狀態膠囊，是三個動作**（`CarryoverPanel`）：`✦ 精煉本次共讀`（觸發，可能一分鐘）、`帶上／✓ 已帶上`（注入開關）、`研究續窗 · 方向：X`（**可點**，展開／收起 carryover 卡）。三個都要留、都要能按；外觀照稿子的膠囊語言。

## 四、設計（數值一律以 `ReaderShell.dc.html` 為準；下面只寫結構與稿子沒講的決定）

### D1 頂列 52px（只在 `page === 'detail'`）
- `App.jsx` 的全域 `<header>` 在 detail 頁換成 **detail 變體**：高 52px、`padding:0 10px`、`gap:8px`、`background:var(--surface)`、`border-bottom:1px solid var(--border)`。由左到右：漢堡（沿用現有 toggle sidebar）→ 22px 的 `C` 徽章 → 1×18px 細線 → **`headerMainSlot`**（`flex:1;min-width:0`）→ ⬆ 上傳鈕 → 深色／全螢幕／設定（28×28 圖示鈕，沿用現有行為）→ 1×16px 細線 → **`headerEndSlot`**。
- 兩個 slot 是 DOM node，用 `useState` 存、當 props 傳給 `PaperDetail`（同工單 24b 的作法）。`PaperDetail` 用 `createPortal` 把「‹ 返回列表／閱讀模式膠囊／標題（serif 15.5px、單行截斷、`title`＝全名）／閱讀狀態下拉」畫進 main slot，把**刪除（垃圾桶）**畫進 end slot。slot 為 `null` 時退回原本的 `cr-detail-topbar`（功能不少）。
- 其他頁面（論文庫／對比／進度／洞察／設定）的 header **完全不變**。

### D2 工作列 36px（跨欄）
- `PaperDetail` 在 `cr-detail-split` **上方**新增一條 `cr-workbar`：`display:flex;align-items:stretch;padding:0 10px;border-bottom:1px solid var(--border-soft);min-height:36px`。
  - 左半 `width:${split}%`（閱讀模式 100%）、`padding-right:8px`、`flex-wrap:wrap-reverse;justify-content:space-between;gap:4px 10px`：兩顆底線式分頁（`min-height:35px`）＋工單 24b 那個 controls 插槽（搬到這裡）。窄欄時膠囊組整塊折到分頁上方一行——行為保留。
  - 中間 6px 空隙（對齊分隔線）。
  - 右半 `flex:1;min-width:0;padding-left:8px`：**`chatHeadSlot`**。閱讀模式不渲染右半。
- 左欄裡原本的分頁列移除（搬上來了）。工作列與分欄區左右 padding 同為 10px，分隔線才對得齊。

### D3 分欄區與分隔線
- detail 頁 `main` 的 padding 歸零；`cr-detail-split` 自己 `padding:10px`。左欄＝`width:${split}%`，右欄 `flex:1;padding-left:8px`。
- 分隔線照稿：6px 寬、靜止時中央 1px `--border` 直線＋4×40px `--faint` 握把；hover／拖曳時底槽 `--accent-soft`、直線隱藏、握把 `--accent` 4×64px；命中範圍左右各外擴 5px（透明絕對定位層）。
- **保留工單 25 的全部行為**：`localStorage` `co-reading:detail-split`、預設 58、範圍 30–70、放手才存、`mousedown` 自己量雙擊（不能用 `onDoubleClick`）、百分比以分欄容器為基準——**容器現在有 10px padding，基準要用 content box**（`(clientX − left − 10) / (width − 20)`）。

### D4 SI 膠囊內縮（`FullTextView.jsx`）
- 拿掉 `AttachmentToolbar` 那一行。**選中的** SI 膠囊就地展開：`SI 1 ｜ 16,680 字 ｜ 👁 ｜ ⋯`（分隔＝1px 左邊線；字數 mono 10px；數值見稿）。
- 👁＝`ai_visible`：睜眼／劃線兩個 svg、opacity 1／.55、點了 PATCH（`stopPropagation`）。`title` 要帶實情：讀得到／讀不到／**「AI 只讀前 X 字」／「超出預算，AI 沒讀到」／「掃描版，AI 讀不到文字」**——被截斷或被擠掉時眼睛要看得出不一樣（半透明＋`title`），**畫面不能說有、AI 其實沒讀**（工單 24 §七的紅線）。
- `⋯` 選單（絕對定位、`min-width:186px`、樣式見稿）：標頭＝原始檔名（mono 10.5px）→ `AI 讀得到　開啟／關閉`（下面一行小字寫上面那幾種實情）→ `改名`（點了該列變 input：Enter 存、Escape 取消、blur 存）→ `刪除這份`（danger；二次確認就在選單裡）。點選單外／Escape 關閉。
- `＋`＝22×22 圓形描邊鈕；沒有任何 SI 時仍顯示「＋ 補充文件」全文。
- **文字版**照稿給真排版：外框卡（1px `--border`、radius 8、`--surface`、`padding:22px 26px`、自己 `overflow:auto`）、內文 `max-width:620px`、serif 14.5px／1.75。原本頂上的說明小字放進卡內第一行。**`TextBody` 的 `data-cr-offset`／選段／跳回機制一個字不動，只換樣式 class。** SI 文字版同款外框。
- PDF 框：`flex:1;min-height:0`＋保留 `PDF_FRAME_MIN_HEIGHT`。左欄捲動容器的右內距 16px → 8px。

### D5 討論欄頭尾（`ChatPanel.jsx`、`CarryoverPanel.jsx`）
- **頭**：`討論` 標頭（13px／600＋accent 圖示）、精煉三個動作、`提取洞察` 膠囊鈕 → 同一行，畫進 `chatHeadSlot`。
  - 🔴 **不准讓 `CarryoverPanel` 因為切閱讀模式而 remount**（它有 `refining` 等 state，精煉要跑一分鐘）。`createPortal` 換目標＝React 會卸載重掛子樹。**指定作法**：`ChatPanel` 用 `useRef(document.createElement('div'))` 建一個**穩定容器**，頭部永遠 portal 進這個容器；另用一顆 effect 把這個容器 `appendChild` 到「當前目標」（有 `chatHeadSlot` 就掛那裡，沒有就掛 `ChatPanel` 內部頂端的 fallback 容器）。DOM 搬家不會重掛 React 子樹。
  - `CarryoverPanel`：邏輯、API 呼叫、state **一律不動**。只把「觸發列」那一段用 `createPortal` 畫進 `ChatPanel` 傳下來的頭部容器（prop 為空就照舊畫在原地）；carryover 卡／錯誤文案（工單 22）／`ProvenanceModal` 留在原地（討論區頂部，有內容才出現）。三顆鈕換成稿子的膠囊語言：精煉＝描邊膠囊（精煉中顯示「… 精煉中」）；帶上＝小膠囊，已帶上時 `--accent-soft` 底；`研究續窗 · …`＝淡色、可點、`min-width:0` 截斷。
  - `提取洞察`：現有的出現條件（至少兩條訊息）、`extracting` 狀態、提取完的結果提示——**條件與邏輯不動**，鈕搬到頭部；結果提示留在輸入卡上方（暫時性出現）。
- **尾**：輸入區改成稿子的輸入卡（1px `--border`、radius 12、`--surface`、`padding:8px 8px 6px 12px`）：無邊框 textarea（現有自動增高／Enter 送出／IME 處理不動）＋卡內底排：`貼上原文提問`、`Aa 小 ▾`、spacer、`送出` 膠囊（`--accent`、12.5px、`padding:6px 18px`）。串流中的「停止」等既有狀態映射到同一個位置。待送出的引用卡（`pendingQuote`，✕ 取消）照舊在輸入卡上方。輸入框下面原本那兩行拿掉。

### D6 上傳（`UploadZone.jsx`、`App.jsx`）
- `UploadZone` 新增 `variant="overlay"`（detail 頁用）：**不渲染細條**；保留 hidden `<input type=file>`；在 `window` 上聽 `dragenter/dragover/dragleave/drop`（只在拖的是檔案時反應），顯示全畫面拖放層（樣式見稿：`rgba(201,100,66,.10)` 底、內框 2px dashed `--accent`、「放開以加入論文庫 · 支援批次匯入」＋「這篇屬於」下拉）。用 `forwardRef`＋`useImperativeHandle` 暴露 `open()`，頂列 ⬆ 鈕呼叫它。
- 上傳中：⬆ 鈕轉圈、`title` 寫進度；結束後若有失敗，在頂列下方出一條 4 秒的小提示列出失敗檔名（**不能靜悄悄失敗**）。`onUploaded` 照舊。
- 論文庫頁＝原本大靶；對比／進度／洞察＝工單 25 的 compact 細條——**都不變**。

## 五、紅線
1. `ChatPanel` 的串流／中止／分支／引用／重新生成／編輯邏輯零改動；切閱讀模式時 `ChatPanel` 與 `CarryoverPanel` **都不 remount**。
2. 後端、`data/`、`package.json`／lock、`dist/` 不動。不裝套件。
3. 所有顏色走 token（亮／深兩套都要成立）；文案繁體中文、用「你」。
4. 每一顆現有按鈕都還在、都還能按（對照 `design-doc.dc.html` 的「每顆按鈕現在在哪」，但以 §三 的三處更正為準）。
5. worktree 裡做；`git add` 逐檔；不 push；build 一律 `npm run build -- --outDir <暫存> --emptyOutDir=false`。
6. 行動版（≤767px）不特別調校，但不准溢出或重疊（`index.html` 既有的 `!important` 規則照舊生效）。

## 六、驗證
**agent**：`npm test` 綠（基線 631）；build 綠；四個 commit（①D1+D6 ②D2+D3 ③D4 ④D5），每個 commit 前測試要綠；交付報告寫本檔附錄 A（changed-file list、**沒改什麼**、每顆按鈕的新位置對照、偏離、沒做到或不確定的直說）；十行內回覆。commit 結尾 `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`。
**我**：親跑測試；diff 白名單（`App.jsx`、`pages/PaperDetail.jsx`、`components/{FullTextView,ChatPanel,CarryoverPanel,UploadZone}.jsx`、`frontend/index.html`（只准加 css）、`store.js`（如需要）、docs）；副本＋假上游實彈：@1300×660 量頂部總高（目標 88±2）與 PDF 框高（稿子預算 552，≥540 算過）；SI 膠囊 👁／⋯ 全流程對 API；跳回原文；**慢速串流中切閱讀模式，串流不斷、精煉狀態不丟**；⬆ 鈕開檔案選擇器；刪除論文有確認；亮／深各一張截圖；論文庫頁外觀不變。

---

## 附錄 A — 交付報告（agent，2026-09-21）

**分支**：`feat/wo26-reading-page-layout`（worktree，未 push）　**基線**：`main` @ `b6b11b7`（631 綠）
**測試**：631/631 綠（每個 commit 前都跑過，數字全程沒變）　**build**：綠（輸出到暫存目錄，`--emptyOutDir=false`，沒碰 `dist/`）

### A.1 四個 commit

| # | SHA | 內容 |
|---|-----|------|
| ① | `2c6ed31` | D1 頂列 52px ＋ D6 上傳收成 ⬆ 鈕／全視窗拖放層 |
| ② | `abbc726` | D2 跨欄工作列 ＋ D3 分欄區 10px 節奏、分隔線重畫 |
| ③ | `4d94230` | D4 SI 膠囊內縮、⋯ 選單、文字版排版卡 |
| ④ | `1cdfa2b` | D5 討論欄頭升進工作列、尾收進輸入卡 |

### A.2 changed files（只有這 7 個檔 ＋ 本文件）

```
frontend/index.html                        +113/-…   只加／改 CSS，token 定義區一個字沒動
frontend/src/App.jsx                       detail 頁的 52px 頂列變體＋兩個插槽＋⬆ 鈕；其他頁 header 只把三顆圖示的 svg 抽成共用函式（輸出相同）
frontend/src/pages/PaperDetail.jsx         頂列 portal、跨欄工作列、分欄區 padding、分隔線、chatHeadSlot
frontend/src/components/FullTextView.jsx   SI 膠囊展開＋⋯ 選單、文字版卡、拿掉 AttachmentToolbar
frontend/src/components/ChatPanel.jsx      穩定頭部容器＋portal、輸入卡
frontend/src/components/CarryoverPanel.jsx 只多一個 headContainer prop＋觸發列 portal＋膠囊外觀
frontend/src/components/UploadZone.jsx     forwardRef/open()、variant="overlay"、全視窗拖放層、失敗提示
```

### A.3 **沒改什麼**（逐條）

- **後端 `src/` 零改動**；`data/`、`package.json`／lock、`dist/`、`test/` 一個位元都沒動；沒裝任何套件。
- `store.js` **沒動**（不需要）。`api.js`、`lib/*`（`fulltext-offsets`、`message-quote`、`insight-source`）、`textQuality.js` 沒動。
- 其他頁面元件沒動：`Library`、`Compare`、`Progress`、`InsightsPanel`、`Settings`、`Sidebar`、`SummaryView`、`InsightCard/Form/Popover`、`ProvenanceModal`、`OriginBadge`、`TagBadge`。
- `index.html` 的 `:root` / `[data-theme="dark"]` token、Tailwind config、字體設定沒動；既有的 `.cr-main--reading`／`@media (max-width:767px)` 區塊只**加**規則，唯一刪掉的是兩條已經失效的閱讀模式內距（見 A.5-③）。
- **`ChatPanel` 的串流機制零改動**：`runStream`／`handleSend`／`handleStop`／`handleRegenerate`／`handleStartEdit`／`handleSaveEdit`／`handleSwitchVersion`／`handleSwitchBranch`／`captureReplySelection`／`handleAskReply`／`jumpFromQuote`／`messageJump`＋`msgFlash`／`loadMessages`／`handleExtract`、訊息串的 JSX、引用塊、編輯歷史下拉——全部原樣。
- **`CarryoverPanel` 的 state／effect／API 呼叫零改動**：`load`／`handleRefine`／`handleToggleInject`／`meta`／`stale`／`lineLabel`／`ClaimItem`／`Section`／`ProvenanceModal`。只加了一個 prop 與 portal 包裝，外加三顆鈕的 class。
- **`FullTextView` 的 `TextBody` 機制零改動**：`data-cr-offset`（`OFFSET_ATTR`）、`captureSelection`／`resolveSelectionQuote`、`quoteJump` 跳回、兩顆分開的 flash effect、`cr-ask-selection`——只換了 `className`。`pendingJump` 那顆「先切回正文再切文字版」的 effect 原封不動。
- **工單 25 的分欄行為零改動**：`SPLIT_KEY`／`loadSplit`／預設 58／30–70 夾限／放手才寫 `localStorage`／`lastHandleDownRef` 自己量雙擊／`resetSplit`。只改了百分比的**基準**（見 A.5-①）。
- **工單 06 的閱讀模式機制零改動**：右欄同一個 div 換 className 變抽屜、`ChatPanel` 永不 unmount、抽屜 grip／✕／Esc／FAB／未讀小點／`--cr-drawer-top` 量測。
- 論文庫頁的上傳大靶、對比／進度／洞察的 compact 細條：**外觀與行為完全沒變**（`variant` 預設 `'strip'`，走的是原本那條 return）。

### A.4 每顆按鈕的新位置（對著 `design-doc` 的清單逐條核，以工單 §三 為準）

| 按鈕 | design-doc 說 | 實際落地 | 備註 |
|---|---|---|---|
| 漢堡選單 | 頂列最左 | ✅ 頂列最左，沿用 `toggleSidebar()` | |
| Logo | 22px 的 C 徽章 | ✅ 22px 徽章，點了回論文庫 | 窄螢幕（≤767px）隱藏，見 A.5-⑤ |
| 返回列表 | C 徽章右側文字鈕 | ✅ 頂列 main slot 第一顆 | |
| 閱讀模式 | 返回列表右側膠囊 | ✅ 同上，第二顆 | **行為維持工單 06**（不照稿改成推到 97%），工單 §三 |
| 論文標題 | 頂列中段 serif 15.5px 整行寬 | ✅ `flex-1 min-w-0 truncate`，`title`＝全名 | |
| 閱讀狀態 ▾ | 緊貼標題右側 | ✅ 同一格右側；**補了點外面／Escape 關閉** | 原本只能再點一次關 |
| 深色／全螢幕／設定 | 頂列最右三顆 28×28 | ✅ | 行為沿用 |
| 「關閉 ✕」 | 頂列最右、細線之後 | ⚠️ **改成垃圾桶、`title="刪除這篇論文"`、保留 `confirm`** | 工單 §三：它刪的是論文不是關頁面 |
| ⬆ 上傳 | 稿子畫在輸入卡 | ⚠️ **放頂列右側圖示組**（她拍板） | 上傳中轉圈＋title 寫進度 |
| AI 摘要／原文 分頁 | 工作列左半最左，底線式 tab | ✅ `min-height:35px`、2px 底線 | 「· SI N」計數保留 |
| 正文／SI 膠囊組 | 工作列左半右側，窄欄折到分頁上方 | ✅ 沿用工單 24b 的 `controlsSlot`＋`wrap-reverse` | |
| ＋ 加補充文件 | 膠囊組右側圓形 ＋ | ✅ 22×22 圓形描邊；沒有 SI 時仍是「＋ 補充文件」全文 | |
| PDF 原檔／文字版 | ＋ 的右側第二組膠囊 | ✅ 沒動邏輯（同一個 `localStorage` 偏好、掃描版 SI 不給切） | |
| 檔名／字數 | 字數進膠囊、檔名進 ⋯ 標頭 | ✅ | |
| AI 讀得到 | 膠囊內眼睛 ＋ ⋯ 內文字開關 | ✅ 兩個都有；**截斷／擠掉／掃描版時眼睛半透明＋title 說實話** | 工單 24 §七 |
| 改名／刪除這份 | ⋯ 選單 | ✅ 改名就地變 input（Enter 存／Esc 取消／blur 存）；刪除二次確認在選單裡並寫明「不動論文」 | |
| 精煉本次共讀 | 稿子：一顆含「已帶上」的狀態膠囊 | ⚠️ **拆成三個動作**（工單 §三）：精煉膠囊／帶上膠囊／續窗 meta | 三顆都在、都能按 |
| 提取洞察 | 工作列右半，精煉右側 | ✅ 條件（≥2 條訊息）與 `extracting` 沒動；**結果回音留在輸入卡上方** | |
| 續窗 meta | 工作列右半最右，淡色截斷 | ✅ **可點**（展開／收起 carryover 卡），工單 §三 | |
| 貼上原文提問 / Aa | 輸入卡內底排左側 | ✅ | |
| 送出 | 輸入卡內底排最右，膠囊 | ✅ 串流中的「停止」映射到同一個位置 | |
| ↻ 重新生成／存為洞察 | 維持在回覆卡底部 | ✅ 一個字沒動 | |
| 上傳細條／這篇屬於 | (b) ⬆ 鈕＋拖檔時全畫面拖放層 | ✅ 細條在論文頁整條拿掉；拖放層帶「這篇屬於」下拉（沿用 `directionChoice`） | |
| 重新精煉這篇（stale） | 稿子沒畫 | ✅ 留在原地（討論區頂部），只在 stale 時出現 | |
| 抽屜 grip／✕／FAB | 稿子沒畫 | ✅ 沒動 | |

### A.5 偏離規格之處與理由

1. **分隔線拖曳基準改成 content box**——工單 §D3 已指明；`(clientX − left − 10) / (width − 20)`。不改的話拖到兩端會跟工作列的切點差 10px。
2. **膠囊分隔線用 `color-mix(in srgb, currentColor 35%, transparent)`**，不是稿子的 `rgba(255,255,255,.35)`——工單坑清單指定（深色模式不能寫死白色）。選中膠囊的 `currentColor` 就是 `--accent-fg`，亮／深自動成立。
3. **刪掉 `.cr-main--reading .cr-detail-topbar` 與 `.cr-main--reading .cr-detail-split` 兩條內距**——detail 頁的 `main` padding 已歸零，這兩條會讓閱讀模式的分欄區變成 16px、跟工作列的 10px 對不齊。頂列那條的對象（`cr-detail-topbar`）現在只是 fallback，正常情況不渲染。
4. **文案微調兩處**：精煉中「… 精煉中（可能需要一分鐘）」→ 膠囊寫「… 精煉中」、「可能需要一分鐘」移進 `title`（36px 一行塞不下）；提取中「… 提取中...」→「… 提取中」。工單 §D5 本來就寫「精煉中顯示『… 精煉中』」。
5. **稿子沒畫行動版，我自己加了兩條保險**（≤767px）：工作列改成上下兩條、各自吃滿寬（右半照樣渲染，「討論」標頭不會不見）；頂列的 C 徽章與它右邊的細線隱藏。目的只是「不溢出、不重疊」，不是調校。
6. **精煉膠囊保留既有的「✦」文字**，沒換成稿子的星星 svg——那是她既有的詞彙，少改一個字串少一分風險。
7. **SI 膠囊的外層從 `<button>` 改成 `<div role="button" tabIndex={0}>`**——裡面要塞可點的眼睛與 ⋯，按鈕不能巢狀。鍵盤（Enter／Space）有補。
8. **上傳失敗提示用 `position: fixed; top: 52px`**（頂列高度是 inline style 的固定值，不受 `.cr-main` 的 `!important` padding 影響），不是掛在頂列 DOM 底下——`UploadZone` 住在 App 根層，硬要掛進 header 反而要再開一個插槽。

### A.6 我沒做到／不確定／沒法自己驗的（照實說）

**最重要的前提：我沒有瀏覽器，這一版的版面完全是讀代碼推出來的，一張都沒親眼看過。** 下面這些一定要你在真機上過一遍：

1. **頂部總高 88±2 與 PDF 框高度**：數字上是 52 + 36 = 88，分欄區上下各 10px。但**工作列左半用的是 `flex-wrap-reverse`**——左欄拖窄時膠囊組會折到分頁上方，那一列就會漲成兩行（這是工單 24b 就有的行為，不是新增的）。**58% 預設值下會不會折行，我量不出來**，請你在 1300×660 實測。
2. **分隔線與工作列切點是否真的對齊**：兩邊同 padding、同中縫、同 `split` 值，數學上該對齊；但 `width: 58%` 在兩個不同 flex 容器裡的次像素捨入可能差 0.5px。肉眼該看不出來，沒驗。
3. **慢速串流中切閱讀模式，串流不斷、精煉狀態不丟**——這是本工單最要緊的一條，我**沒有實測**。邏輯上：`ChatPanel` 與 `CarryoverPanel` 都沒被條件渲染包住，頭部靠 `appendChild` 搬 DOM 節點而不是換 portal target，所以 React 子樹不會重掛。但「邏輯上成立」跟「真的不掉」之間隔著一次實彈。**請優先驗這條。**
4. **⋯ 選單壓不壓得過 PDF iframe**：工作列給了 `z-index:20`、選單 `z-index:60`，路徑上沒有 `overflow:hidden`。但 iframe 在某些情況下會很霸道，沒實測。另外**點在 PDF 上時 document 收不到 mousedown，選單不會關**——這是工單允許的，我補了 Escape 當保命索。
5. **全視窗拖放層**：`dragenter/leave` 的計數器邏輯在真實拖檔下容易有邊角（例如從視窗邊緣快速拖出去）。我加了 `dragend` 與 `relatedTarget === null` 兩道收層，但**沒實際拖過檔案**。若層卡住，按一下任意處不會收——這點要驗。
6. **文字版卡內的「跳回原文」flash**：`TextBody` 確實在卡內（捲動祖先＝那張卡），`scrollIntoView` 會自己找最近的可捲動祖先。但 `block:'center'` 在一個只有 620px 內容寬的卡裡實際落點如何，沒看過。
7. **深色模式**：全部走 token，沒有一處寫死色值（唯一的半透明走 `color-mix`）。但**沒有截圖比對過**，特別是選中 SI 膠囊裡那條分隔線與眼睛的 `.55` 透明度在深色下夠不夠看得出來。
8. **上傳失敗提示**只在 overlay 版（論文頁）出現；細條版維持原本那排 ✓／✕。兩者行為不同是刻意的，但我沒驗過失敗路徑（要真的傳一份壞檔）。
9. `npm test` 的 631 條**沒有一條測前端版面**（只有兩條讀 `ChatPanel.jsx`／`CarryoverPanel.jsx`／`PaperDetail.jsx` 的原文釘文案，我確認過那些字串一個都沒被我改掉）。**測試綠不代表版面對。**

---

## 附錄 B：親驗記錄（2026-09-21 深夜～22 凌晨，Elias）

**環境**：worktree `wo26` @ `4737987`；驗收服務 `:3476` 吃她資料的**新副本**（sqlite `.backup`，papers 13／messages 97／attachments 1 對帳過），副本設定改指本機**慢速串流假上游** `:3481`（每 300–400ms 吐一段，共 30–45 段；key 抹掉、gateway 指死埠）。她的真服務當時已關（:3456／:5173 無 listener），真庫零觸碰。瀏覽器 1300×660。

**親手跑的**
- `npm test` 631/631；`npm run build -- --outDir <暫存> --emptyOutDir=false` 綠；diff 白名單 7 個前端檔＋工單，`src/`／`data/`／`package*.json`／`dist/`／`test/` 零改動。
- **高度（1300×660）**：頂列 52 ＋ 工作列 37 ＝ **89px**（目標 88±2 ✅）；分欄區頂 y=89；**PDF 框 551px**（稿子預算 552、原 463 ✅）；框底 650 ／ 分欄底 660 ／ 視窗底 660——兩欄同一條底線、無外層捲軸、無橫向溢出；舊 `cr-detail-topbar` 與上傳細條都不在 DOM。論文庫頁不變（header 50、上傳大靶 57px）。
- **串流中切閱讀模式（最要緊的一項）**：送出後 1.8s 切閱讀模式 → 3.6s 切回分欄 → 串流照走到第 30 段結束；假上游日誌 `finished all 30 chunks`、無 `CLIENT DISCONNECTED`；後端 `[CHAT] ok chunks=31`；DB 落庫完整。切換全程 `精煉本次共讀` 鈕與 textarea 是**同一個 DOM 節點**（`data-probe` 標記存活）⇒ `CarryoverPanel`／`ChatPanel` 沒有 remount；頭部容器在工作列右半 ↔ 抽屜 fallback 之間搬家正常；展開中的 carryover 卡切換後仍展開。
  - 🔴 驗收時第一發「串流 45s 停滯失敗」是**我假上游的 bug**（Node ≥16 的 `req 'close'` 在請求收完就響，被我當成斷線）——不是產品問題，修了假上游重打三次都過。
- **SI 膠囊**：選中展開成 `SI 1｜28,402 字｜👁｜⋯`，舊工具列消失、工作列仍 37px；👁 點一下 `ai_visible` 1→0，title 由「AI 讀得到這份」變「AI 讀不到這份」；⋯ 選單（186px，浮在 PDF 之上）：檔名標頭／`AI 讀得到 關閉`／改名／刪除這份；改名 Enter 存、Escape 不存（對 API）；刪除第一下只出「確定刪除這份補充文件？不動論文。」＋刪除／取消，DB 仍在；Escape 關選單。驗完把 label／ai_visible 還原。
- **頂列**：⬆ 鈕開的是 `UploadZone` 的 hidden input（`accept=".pdf"` multiple）；垃圾桶＝「刪除這篇論文」，`confirm` 文案照舊、取消後論文仍在。
- **拖檔進視窗**：帶 `Files` 的 dragenter → 全畫面拖放層（z-index 80、含「這篇屬於」下拉）；離開視窗關；純文字拖曳不觸發。
- **分隔線**：拖到 x=700 → 握把 703、`split=43.3%` 存 localStorage、左欄／工作列左半右緣同為 700（切點對齊）；mousedown 雙擊 → 58%、localStorage 清空、無遮罩殘留。左欄 43% 時工作列折成兩行 75px（`wrap-reverse`，規格內）。
- **跳回原文**：在 SI＋PDF 模式點氣泡「跳回原文」→ 自動切回正文＋文字版、`data-cr-offset=14895` 那段閃、1.8s 熄。文字版卡片：serif 14.5px、自己捲動、`data-cr-offset` 錨點 11 個健在。
  - 既有限制（**非本單造成**）：這篇論文抽字幾乎沒有雙換行，11 個段落各 2,000–6,400px 高；跳回用 `block:'center'` 會把巨型段落的**中點**捲進畫面，引用那幾行不一定在視窗內。工單 14 以來就這樣；改法＝段落高過視窗時改 `block:'start'`＋依字元偏移比例微調——另開小單。
- **深色**：`data-theme=dark` 下選中膠囊／送出鈕＝`#DA8666` 底、`#1B1815` 字（token 正確）；`color-mix` 分隔線瀏覽器支援。

**未驗**：行動版（≤767px）；`Aa` 字級三檔輪替與「貼上原文提問」只確認鈕在、沒逐一按；上傳成功／失敗後的提示列沒實跑（需真檔案）。
**Claude Design 稿 vs 實作**：全部照稿，除工單 §三 三處更正＋附錄 A.5 八條偏離（我認可）。
