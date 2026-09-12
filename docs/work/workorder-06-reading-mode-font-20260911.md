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

> 實作於 2026-09-11，分支 `feat/reading-mode`，base `main` @ `a601efa`。
> 三個 commit：`5c79468`（store+App）→ `8a2590c`（PaperDetail 抽屜）→ `a755288`（ChatPanel 字級）。
> `npm test` 84/84；`git diff --check` 乾淨；`git diff main --name-only` 只含 §4 允許的五個檔案。
> R1–Z1 十三案全過。完整報告在 commit `docs(work): 工單 06 附錄` 的 message 裡
> （harness 擋掉了 `docs/work/report-06-*.md` 的寫入，照交接約定改落 commit message）。

### ① 閱讀模式開關放頂列**左**邊（「返回列表」右邊），不是右側

§3.1 只說「頂列加一顆按鈕」。先放右側（刪除鍵旁）實測**被抽屜蓋住**——抽屜 `top` 貼 header
下緣（§3.1 指定），會蓋掉頂列右半邊：按鈕 `left:1025`、抽屜左緣 `1020`，`elementFromPoint`
命中抽屜。抽屜一開就離不開閱讀模式了。改放左邊後 `left:97`，命中按鈕本身。

### ② `leftTab` 初值跟著 `readingMode`

§3.1 只寫「進入時」自動切 fulltext。`leftTab` 是純本地 state，**閱讀模式下刷新**會回到
「AI 摘要」全寬，跟「閱讀模式就是看 PDF」矛盾。改成
`useState(() => useStore.getState().readingMode ? 'fulltext' : 'summary')`。
非閱讀模式初值不變（Z1 已驗仍是 AI 摘要）。

### ③ 🔴 `text-sm` 是 **12.25px** 不是 14px——§3.2「預設 sm ＝現況」這句不成立

`index.html` 是 `html { font-size: 14px }`，所以 **1rem = 14px**，Tailwind 的 `text-sm`
（`0.875rem/1.25rem`）實際是 **12.25px / 17.5px**（`p-6` 同理是 21px 不是 24px）。
照工單做完之後聊天氣泡與輸入框是 **14px / 21px**——**是變大，不是持平**，輸入框高 55 → 62。

方向跟她原話「讨论的部分…现在有点太小了」一致，所以照工單的 14/16/18 做了，沒有自作主張
把 sm 調成 12.25px 去湊「零回歸」。但這是刻意的視覺改變，驗收時要知道。
若要讓預設維持原樣：改 `store.js` 的 `CHAT_FONT_PX.sm` 一個值即可。

`line-height` 沒另設（照工單）。順帶更正 §3.2 的說明：全站實際行高是 **1.5** 不是 1.7——
Tailwind preflight 的 `html{line-height:1.5}` 排在 `index.html` 的 `<style>` 之後，
而 `body{line-height:inherit}`。量到 21px = 1.5 × 14。

### ④ 要拿掉的 `text-sm` 是**五處**不是四處

§2 列了 L259/L277/L433/L462，**漏了真正的訊息氣泡**（原 L315
`group p-3 text-sm max-w-[85%]`）。不拿掉它，CSS 變數只作用在歡迎語與串流氣泡，
真正的對話內容不會變大，這條需求等於白做。編輯中的 textarea（原 L280）也一併處理並加
`.cr-chat-input`，否則 18px 氣泡裡包一個 12.25px 編輯框。

### ⑤ Aa 按鈕的容器提出條件式

§3.2 說放「L501 那個工具區」，但那個 `<div className="flex items-center gap-2">` 整個包在
`{messages.length >= 2 && …}` 裡——放進去的話**新上傳、還沒聊過的論文找不到字級開關**。
容器提出條件，提取洞察按鈕保留原本的 `messages.length >= 2`，行為不變。

### ⑥ `onMessagesUpdated` 多帶一個參數

浮鈕未讀小點需要訊息條數，`onMessagesUpdated?.()` → `onMessagesUpdated?.(msgs.length)`。
向後相容，唯一呼叫端是 PaperDetail，不影響 ChatPanel 既有行為。

### ⑦ `--cr-drawer-top` 是量出來的，不是寫死

§3.1 寫 `top:<header 高>`。`PaperDetail` 進入閱讀模式時量一次 `header` 實際高度寫進 `:root`
並掛 `resize`；CSS 端 `top: var(--cr-drawer-top, 50px)`。實測 header = 50px。

### ⑧ R3 用本地 stub 串流驗，沒有真的呼叫 AI

§6 R3 寫「抽屜內送一句」。真送會寫進 `data/co-reading.db` 的 `messages` 表，違反
「零寫入、別動 data/」，且每輪帶全文成本不小。改成在瀏覽器把 `window.fetch` 針對
`POST …/chat` 換成可逐段餵的**真 SSE ReadableStream**——ChatPanel 與 `api.js` 的
`readSSEStream` 走完全相同的代碼路徑，只差字節從哪來，驗完立刻還原。

實測：串流中關抽屜 → 關著時餵的兩段不掉 → 重開後三段齊全 → 全程 **POST 只有 1 筆** →
ChatPanel 根 DOM 節點物件前後恆等（沒被 unmount）。
驗完 `data/co-reading.db` mtime 未變、`-wal` 0 bytes，確認零寫入。
順帶驗了未讀小點：抽屜關著收到回覆時浮鈕出現小點，打開後消失。

### 驗證環境的坑（給下一個人）

Browser pane 的 `document.visibilityState` 恆為 `hidden`：(a) CSS transition 時間軸凍在 0，
抽屜永遠量到「開著」——量之前要先 `document.getAnimations().forEach(a => a.finish())`
（跳過 `iterations === Infinity` 的，否則丟 InvalidStateError）；
(b) 鏈式 `setTimeout` 被 Chrome intensive throttling 壓到一分鐘一次，腳本會超時——
等 React flush 改用 MessageChannel（實測 8 次 tick ≈ 1ms）。兩者都是測試環境假象，不是產品 bug。
