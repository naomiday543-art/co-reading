# 交付報告：工單 23——研究進度圖節點展開／收縮

**日期**：2026-09-19　**分支**：`feat/wo23-progress-collapse`（基線 `main` @ `cb61701`）
**commit**：`b5fa450`（D1 引擎＋測試）、`2e26e7d`（D2 卡片＋D3 頁面＋D4 Escape）
**狀態**：未合、未 push、未部署。

---

## 一、動了哪幾個檔

| 檔 | 做了什麼 |
|---|---|
| `frontend/src/lib/progressLayout.js` | `layoutProgress` 多吃 `collapsed`；在「結構樹建完」與「算座標」之間插一段修剪；新增 `collapsibleIds()` |
| `frontend/src/components/ProgressGraph.jsx` | 小三角 `CollapseToggle`、紅／灰點 `HiddenDots`、收起卡的文案、改接／合併過的橫線 title |
| `frontend/src/pages/Progress.jsx` | `collapsed` 狀態、`localStorage` 記憶、工具列「全部收起」／「全部展開」 |
| `frontend/src/components/ProvenanceModal.jsx` | Escape 關閉（D4） |
| `test/progress-layout.test.js` | 新增「工單 23 §四：收合」10 顆 |
| `docs/work/report-23-…md`（本檔）、`workorder-23-…md` 附錄 A | 交付文件 |

## 二、沒改什麼

- **`src/` 零改動**（後端一個字沒動），`data/` 沒碰，她的 `npm run dev` 不會因為這單重啟。
- **`dist/` 沒覆蓋**：build 進暫存目錄，`dist/` 仍是 19:35 那份。
- 沒裝任何套件（`package.json`／`package-lock.json` 沒動）；沒 push、沒部署。
- **佈局引擎既有的兩趟走規則一條沒改**：挑結構父（第一條 outgoing）、多父／成環降級、保底父、懸空邊巡查、`contradicts` 永不進樹、`showSuperseded` 兩態——全部原封不動，收合是加在它們**之後**的一段修剪。
- `CarryoverPanel.jsx` 沒動（它 import 的 `ProvenanceModal` 多了 Escape，等於順帶也能按 Escape 關，其餘行為不變）。
- 圖仍唯讀（紅線 1）：收合只是視圖狀態，不進資料庫、不發任何寫入請求。

## 三、數字

- **`npm test`：578 → 588，588 pass / 0 fail**（134 → 135 suites）。新增的 10 顆對應 §四 ①–⑧，外加「陣列輸入等同 Set」與 `collapsibleIds`。
- **`npx vite build --outDir <暫存>/dist-wo23`：綠**，351 modules，`index.js` 514.66 kB（gzip 158.43 kB），0.6s。（chunk >500kB 的警告是既有的，與本單無關。）
- **紅線 2 有實據**：把 `cb61701` 的引擎抓出來與新版逐位比對，`fixture 預設`／`fixture 走過的路`／`空輸入` 三組 × `不給 collapsed`／`空 Set`／`空陣列`／`收根＋不存在的 id＋葉子` 四種，**輸出 JSON 完全相同**（`JSON.stringify` 相等）。
- **靜態渲染實測**（react-dom `renderToStaticMarkup`，跑在暫存區）：全展開時只有 `▾`、沒有任何「條 claims」或「藏著」；收起 pPvc＋pFlu 後 `▸`、「9 條 claims」、「8 條 claims」、`title="藏著 1 條矛盾"`、`title="展開"`、以及改接過的橫線 title「（接到收起的節點）矛盾（跨篇）」全都在。

## 四、fixture 收起前後對照（`test/fixtures/progress-direction.js`，3 篇＋討論、33 claims、14 關係）

| 情況 | nodes | treeEdges | overlayEdges | bounds |
|---|---|---|---|---|
| 全展開（基線，與工單 21 相同） | 38 | 37 | 2 | 1308 × **2251** |
| 收起 `paper:pRau` | 37 | 36 | 2 | 1308 × 2165 |
| 收起 `paper:pPvc` | 29 | 28 | 2 | 1308 × 1635 |
| 收起三篇＋討論（＝「全部收起」） | 13 | 12 | **1** | 1308 × **535** |

**她要的那件事**：全部收起後高度 2251 → 535（縮到 24%），「適應視窗」就縮得動了。寬度沒變（1308），因為最深的那條鏈是「研究問題 c1 → c2 → c3 → c5」——研究問題掛在方向根、不在論文底下，收論文不會讓圖變窄。

**橫線怎麼處理的**（兩條 contradicts）：

| | 收起 `paper:pPvc` | 收起三篇＋討論 |
|---|---|---|
| `r13` c13⇄c2（跨篇） | 改接：`paper:pPvc → claim:c2`，`retargeted:true`；pPvc 卡 `hiddenOverlays.contradicts=1` | 同左（c2 在研究問題底下，沒被藏） |
| `r14` c23⇄c22（同篇 pFlu） | 照畫（兩端都可見） | 兩端同藏 ⇒ **不畫**，pFlu 卡 `hiddenOverlays.contradicts=1`＋右上紅點 |

收起卡帶的計數：`paper:pRau` `hiddenClaims=1`、`pPvc` 9、`pFlu` 8、`group:discussion` 7。**矛盾一條都沒有靜靜消失**——不是改接到收起的卡上，就是卡片右上有紅點與「藏著 N 條矛盾」（紅線 3）。

## 五、她親驗時值得點的幾下

1. nano plastics 方向按「全部收起」→ 圖應該只剩方向＋幾張收起卡，再按「適應視窗」看縮放真的動了。
2. py-GCMS 方向收起 PE/PVC 那篇 → 跨篇的紅虛線改接到收起卡（hover 看到「（接到收起的節點）矛盾（跨篇）」），那張卡右上有紅點。
3. 收一收之後重新整理頁面 → 收合狀態還在；切到別的方向再切回來 → 各記各的。
4. 點小三角**不會**跳出溯源視窗；點卡片本體才會；溯源開著按 Escape 會關。

## 六、已知限制

- 收合狀態存在瀏覽器（一個方向一格）。換裝置／清網站資料就回到全展開——它是視圖偏好，刻意不進資料庫。
- 改接過的橫線 `crossPaper` 沿用原本兩條 claim 的判定，不因為改接到論文節點而重算（「這兩篇在打架」的粗線才不會在收起後變細）。
- 「全部收起」只收論文與「討論（跨篇）」這一層；研究問題那一串掛在方向根底下，要收得自己點它的三角（這是工單 D3 的定義）。
