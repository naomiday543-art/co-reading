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
