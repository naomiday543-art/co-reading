# 工單：co-reading 界面改造——對齊 research-gateway 設計語言

日期：2026-07-16　狀態：實作中
設計依據：`~/research-stack/gateway-styles-and-brief/project/Co-Reading.dc.html`（Claude Design 交接包，瞳瞳已拍板視覺）

## 背景與動機
co-reading 現在是 Tailwind 預設灰，跟導師系統（research-gateway 前端，暖紙色＋赤陶橘）視覺割裂。她要兩系統統一。設計原型已產出並經她認可。

## 設計
- **Token 唯一來源**：`research-gateway/frontend/styles.css` 的 `:root` 與 `[data-theme="dark"]` 變數（交接包 `uploads/gateway-styles.css` 是同一份）。顏色一律走 CSS 變數，**不從原型截圖取色**。
- **字體**：Geist / Source Serif 4 / Geist Mono ＋ Noto 中文回退，自托管——從 `research-gateway/frontend/vendor/fonts/` 複製，不接 Google Fonts CDN。
- **頁面對應**：原型 HOME → `Library.jsx`＋`Sidebar.jsx`＋`UploadZone.jsx`；PAPER DETAIL → `PaperDetail.jsx`＋`InsightsPanel.jsx`；SETTINGS → `Settings.jsx`；MOBILE HOME（淺/深）→ 響應式收窄形態。
- **深色主題**：`data-theme` 掛 `<html>`，跟 gateway 同機制；加切換鈕（原型 header 有）、localStorage 持久化。
- **響應式**：原型是分屏畫的（0 條 media query），實作端自己補斷點，窄屏對齊 MOBILE HOME 版式（底部 tab bar、mini rail）。
- 洞察維度語義色：概念=`--fact` 綠、悬题=`--hyp` 琥珀、延伸=`--progress` 藍灰。

## 紅線（她的原話與鐵律）
- **只換皮，不動功能**：SSE 串流、regenerate/edit/branch、樹 CRUD、洞察 CRUD、上傳、導航記憶＋全螢幕（App.jsx 剛上的）全部保持原行為。
- 後端 `src/` 一行不動；`data/`、`.env` 不碰。
- 原型是 HTML 稿——照它的視覺輸出，**不照抄它的 DOM 結構**；React 組件架構維持現狀。
- feature branch 實作，不 push、不部署，等親手驗收。

## 範圍外
- Electron 打包驗證（改完另跑）；洞察圖/知識庫新頁（另有工單排隊）；gateway 側任何改動。

## 驗證計畫
- `npm test` 綠；:5173 逐頁人工過（統籌親手）：三頁桌面＋窄屏、淺深兩主題、上傳→通讀→討論→提取洞察全鏈路點一遍。

## 附錄：實作偏離記錄
（實作時如偏離工單在此追加）
