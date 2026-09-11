# 工單 06：閱讀模式 + 聊天字級（優化總方案批次一）

> 日期：2026-09-11
>
> 上位文件：`docs/work/optimization-plan-20260910.md` §4.1、§4.2、§5 批次一。本工單只做這兩條。
>
> 優先級：P1 體驗，小型，純前端（0 後端、0 schema、0 API）
>
> Repo：`~/research-stack/co-reading`；Base：`main` @ 本工單 commit 的父提交（開工前 `git log -1 main` 確認）
>
> 建議分支：`feat/reading-mode`
>
> 預估改動：`frontend/src/store.js`、`frontend/src/App.jsx`、`frontend/src/pages/PaperDetail.jsx`、`frontend/src/components/ChatPanel.jsx`、`frontend/index.html`（CSS）、測試視情況
>
> 生產權限：**無**。不 push、不 build、不動 `data/`。**使用者的 dev server（:3456 / :5173，`node --watch`）正在跑，實作必須在 worktree 裡做，自驗用 `npx vite --port 5174`。**

## 1. 背景與動機

使用者原話（2026-09-10）：

> 「页面的文献还是有点小，看的时候不方便。我现在还是开的两个窗口，看到有问题才打开 coreading」
> 「讨论的部分能够调整字体大小，现在有点太小了」

她的實際用法是**讀為主、問為輔**——co-reading 是「有問題時才打開的顧問」。現在的論文頁把「看論文」和「聊論文」左右平分，跟這個用法不符，所以她開兩個視窗。

## 2. 現況（已查代碼，別重查）

- `frontend/src/pages/PaperDetail.jsx`（390 行）：`split` state L14 預設 50、拖動夾在 30–70（L120）、**不持久化**；`leftTab` L15 `'summary' | 'fulltext'`；左欄 L179 `width: ${split}%`，拖動 handle L349，右欄 L354 `width: ${100 - split}%` 內含 `<ChatPanel paperId paper onSaveInsight>` L355。
- `frontend/src/components/ChatPanel.jsx`（521 行）：外層 L246 `flex flex-col h-full`；訊息列表 L256；訊息氣泡用 Tailwind `text-sm`（14px）散在 L259/L277/L433；Markdown 內容容器 `.prose-chat` L322/L435；輸入框 L462 `textarea … text-sm`；輸入列右側工具區 L501 `flex items-center gap-2`。
- `frontend/src/App.jsx`：L157 `{page !== 'settings' && <Sidebar …>}`；L158 `<main className="cr-main flex-1 overflow-y-auto p-6 bg-bg">`；sidebar 開合是 store 的 `sidebarOpen` / `toggleSidebar`（`Sidebar.jsx:76-77` 寬度 0 即收）。
- `frontend/src/store.js`：zustand，無持久化中介層；`App.jsx` 對 theme 用的是手寫 `localStorage` 讀寫（`co-reading:theme`），本工單照同一慣例。
- `frontend/index.html`：`.prose-chat` 規則 L133-138（無字級）；`body font-size: 14px` L106；mobile 規則 L146-153（`.cr-sidebar` 隱藏、`.cr-detail-split` 直排）。

## 3. 已定案語義（純技術取捨已拍，照做）

### 3.1 閱讀模式

- **狀態全域一個**（不按論文），存 `localStorage['co-reading:reading-mode']`（`'1'|'0'`），刷新保持；放 store：`readingMode`、`setReadingMode`。
- **進入**：`PaperDetail` 頂列加一顆按鈕「閱讀模式」（icon：展開四角），切換 `readingMode`。進入時若 `leftTab === 'summary'` 自動切到 `'fulltext'`（閱讀模式就是看 PDF）；離開時**不**切回。
- **版面（`readingMode && page === 'detail'`）**：
  - `App.jsx`：sidebar 強制收（不動 `sidebarOpen` 的值，只是不渲染或寬度 0）；`main` 的 `p-6` 去掉（加 class `cr-main--reading` 由 CSS 設 `padding: 0`）。
  - `PaperDetail.jsx`：左欄 `width: 100%`、拖動 handle 不渲染、右欄不渲染為欄；改渲染為**浮動抽屜**：右下角一顆圓形浮動按鈕（聊天 icon；有未讀 AI 回覆時帶小點），點開→從右側滑入的抽屜（`position: fixed; right:0; top:<header 高>; bottom:0`）蓋在 PDF 上，內含同一個 `<ChatPanel>` 實例（**不可 unmount 重建**——串流中的回覆不能因開關抽屜而中斷；用 CSS 顯隱，不用條件渲染）。
  - 抽屜寬度預設 `420px`，左緣可拖（範圍 320–720），存 `localStorage['co-reading:chat-drawer-width']`。
  - 抽屜開合狀態不持久化（每次進論文預設收起）。
  - `Esc` 關抽屜；抽屜開著時再按一次浮動按鈕也關。
- **離開**：同一顆按鈕再按一次；回到 Library 時 `readingMode` 值保留但不影響 Library（Library 不讀它，sidebar 照常）。
- 手機（<768px）：閱讀模式仍可用；抽屜寬度改為 `100vw`。

### 3.2 聊天字級

- 三檔 `'sm' | 'md' | 'lg'` = `14 / 16 / 18px`，預設 `'sm'`（=現況，不改變既有使用者觀感），存 `localStorage['co-reading:chat-font']`；放 store：`chatFontSize`、`setChatFontSize`。
- 實作用 CSS 變數：`ChatPanel` 外層 `style={{ '--chat-fs': '16px' }}`；`index.html` 加 `.chat-bubble-ai, .chat-bubble-user, .prose-chat, .cr-chat-input { font-size: var(--chat-fs, 14px); }`，並把 L259/L277/L433/L462 的 `text-sm` 拿掉（否則 Tailwind 的 `text-sm` 會蓋過變數）。行高跟著字級：`line-height: 1.7` 已在 body，不必另設。
- 切換控件放 `ChatPanel.jsx` L501 那個工具區：一顆「Aa」按鈕，點一下循環 sm→md→lg→sm，`title` 顯示目前檔位。**不做**下拉選單。
- 字級對抽屜與非閱讀模式都生效（同一個 ChatPanel）。

## 4. 實作範圍

允許：
- `store.js` 加兩組 state + 初始化時讀 localStorage；
- `App.jsx` 讀 `readingMode` 決定 sidebar 與 main class（只在 `page === 'detail'` 時）；
- `PaperDetail.jsx` 加按鈕、條件版面、抽屜容器與拖寬；
- `ChatPanel.jsx` 加 Aa 按鈕、外層 CSS 變數、拿掉四處 `text-sm`；
- `index.html` 加上述 CSS 規則（含 `.cr-main--reading`、抽屜與浮動按鈕樣式、mobile 覆寫）；
- 若 repo 有前端測試慣例就補，沒有就不強加（現有 `test/` 全是後端 node:test）。

禁止：
- 動任何 `src/`（後端）、`data/`、`.env`；
- 動 `SummaryView`/`FullTextView`/`InsightsPanel` 內部；
- 引入 npm 套件或 CDN；
- 改 `split` 的預設值或範圍（非閱讀模式行為零改變）；
- 把 `ChatPanel` 改成條件渲染（見 §3.1 不可 unmount）。

## 5. 紅線

- **非閱讀模式下，論文頁的外觀與行為必須與現在完全一致**——這是最容易被順手改壞的地方。
- 抽屜開關期間串流中的 AI 回覆不得中斷、不得重複請求。
- `localStorage` 讀寫全部 try/catch（隱私模式會拋）。
- 使用者 dev server 在跑：**worktree 實作，`vite --port 5174` 自驗**，不碰 5173/3456。

## 6. 驗證計畫（實作者自驗；我之後用真實資料再驗一次）

用真實 DB（`CO_READING_DATA_DIR=/Users/laine/research-stack/co-reading/data`，唯讀行為）：

| 案例 | 步驟 | 預期 |
|---|---|---|
| R1 進入 | 開膽固醇那篇（`jGPpnDhR…`）→ 點閱讀模式 | sidebar 收、main 無 padding、左欄 100%、tab 自動到全文、右下浮鈕出現、無拖動 handle |
| R2 抽屜 | 點浮鈕 | 抽屜從右滑入 420px、蓋在 PDF 上、內容是聊天 |
| R3 不斷流 | 抽屜內送一句、回覆串流中關抽屜再開 | 回覆繼續、不重送（network 只一個 POST） |
| R4 拖寬 | 拖抽屜左緣到 600 → 刷新 → 再開 | 仍 600 |
| R5 刷新 | 閱讀模式下刷新 | 仍閱讀模式、抽屜收起 |
| R6 離開 | 再點按鈕 | 回到左右分欄、`split` 是原值、sidebar 回來、handle 回來 |
| R7 Library | 閱讀模式下回 Library | sidebar 正常、padding 正常 |
| R8 Esc | 抽屜開→Esc | 關 |
| F1 字級 | 點 Aa 三次 | 14→16→18→14，訊息與輸入框同步、`title` 對 |
| F2 持久 | 設 lg → 刷新 | 仍 lg |
| F3 兩處生效 | 非閱讀模式設 lg → 進閱讀模式開抽屜 | 抽屜內也 lg |
| M1 手機 | `375px` 寬 | 抽屜 100vw；非閱讀模式行為同現況 |
| Z1 零回歸 | 非閱讀模式截圖對照 main | 像素級一致（至少：分欄比例、handle、padding、字級 14） |

## 7. 交付標準

- `npm test` 全綠（後端測試不該受影響，但要跑）；`git diff --check` 乾淨；
- `git diff main --name-only` 只含 §4 允許清單；
- 報告落盤 `docs/work/report-06-reading-mode-font-20260911.md`：changed-file list、每個案例的實測結果（R1–Z1）、偏離工單處；
- 分階段 commit：store+App 一個、PaperDetail 抽屜一個、ChatPanel 字級一個、CSS 可併入對應 commit；
- 最終回覆十行內。

## 8. 回滾

純前端、無持久資料變更；撤四個檔案即回滾。`localStorage` 殘留鍵無害。

## 9. 範圍外（另開單）

- 抽屜內的洞察表單、相關洞察列表是否要跟進抽屜（現在只搬 ChatPanel）；
- 閱讀模式下的全文 tab 內建 PDF 檢視器工具列（縮放、跳頁）；
- 批次二起的所有項目（§4.0/4.4/4.5）。

## 附錄：實作偏離記錄

（實作者填寫）
