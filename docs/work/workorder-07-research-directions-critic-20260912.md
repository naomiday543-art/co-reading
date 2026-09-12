# 工單 07：研究方向 × 知識樹合流 + 憲章「不當辯護人」（優化總方案批次二）

> 日期：2026-09-12
>
> 上位文件：`docs/work/optimization-plan-20260910.md` §3.4、§3.5、§4.0、§4.4、§5 批次二。**本工單不做 §4.5（六維度直出／去重），那是批次三。**
>
> 優先級：P1，中型（一個 migration、兩個 API 欄位、三處 prompt 注入點、一段憲章、一個引導 UI）
>
> Repo：`~/research-stack/co-reading`；Base：`main` @ `62b0691`（已含工單 05 憲章、工單 06 閱讀模式）
>
> 建議分支：`feat/research-directions`
>
> 生產權限：**無**。不 push、不 build、不動 `data/`（migration 只在測試臨時 DB 上跑；她的真 DB 由我合併後親手驗）。使用者 dev server 可能在跑（:3456 / :5173），**worktree 實作，自驗用 `PORT=3457` + `vite --port 5174`**。

## 1. 背景與動機

使用者原話（2026-09-10）：

> 「AI 通读完文章之后，就有点为这篇文章 defense 的感觉」
> 「好像只能提取到洞察，而没有归类到别的分类诶？」
> 「那是不是一開始設定引導的時候就應該加一個詢問 user 研究領域方面的？並且同一個 user 很有可能涉獵不同方面的」

根因（方案 §0）：**系統認識論文，不認識讀論文的人。** AI 不知道她研究什麼，所以判不了「延伸」「你的研究」，也沒有立場替她指出「這個局限對你的題目意味著什麼」。方案 §4.0 的解法：研究方向不另建表，**知識樹的頂層節點就是研究方向**，加一段描述，讓論文掛在方向底下、讓 AI 讀得到。

真實現況（2026-09-12）：`tree_nodes` 已有兩個頂層節點 **「nano plastics」「py-GCMS」**，各掛 1 篇論文——她已經在用樹當方向了，只差描述和 AI 看得到。

## 2. 現況（已查代碼，別重查）

- `tree_nodes` schema：`id, parent_id, name, sort_order, created_at`。**沒有 `description`。**
- `src/db.js:165-202`：idempotent migration 慣例——`PRAGMA table_info` 查欄位、缺就 `ALTER TABLE ADD COLUMN`。照抄。
- `src/routes/tree.js`：GET `/tree`（L8）、POST（L31）、PATCH `/tree/:id`（L49）、DELETE（L69）。PATCH 目前只收 `name`/`parent_id`/`sort_order`。
- `src/routes/papers.js:30`：upload 收 `tree_node_id`；L138-156 list 依 `tree_node_id` 篩。
- `src/ai.js`：
  - `loadConstitution()`（`src/constitution.js`）→ `buildChatSystem(paper, { constitution, format })` L534：憲章獨立 cache block，後接 `buildPaperBlock(paper)` L508。
  - `chatAboutPaper` L547 起：洞察區塊 L556-583（本篇洞察 + FTS 相關洞察）、carryover L585-590，接在 system 之後的變動區。
- `src/memory.js:159 extractInsights(paperId)`：只讀 messages 組 transcript，system 是 `EXTRACT_PROMPT`；**完全不知道論文屬於哪個方向**。
- `src/prompts/CONSTITUTION.md`：六條價值觀；第 2 條「保留矛盾」只講論文 vs 洞察、兩篇論文互打；**沒有一條說這篇論文本身可被質疑**。
- `frontend/src/components/UploadZone.jsx:17`：上傳時帶 `selectedTreeNode`（側欄當前選的節點），無其他選擇 UI。
- `frontend/src/components/TreeNode.jsx`：只有 `name` 的 inline rename。
- `frontend/src/pages/Settings.jsx`：只有 API 設定區塊（L158 起）。
- `frontend/src/store.js`：`tree`、`selectedTreeNode`；zustand 無持久化。

## 3. 已定案語義（純技術取捨已拍，照做；有「她的味道」的已由她 9/10 拍板）

### 3.1 資料：`tree_nodes.description`

- migration：`ALTER TABLE tree_nodes ADD COLUMN description TEXT NOT NULL DEFAULT ''`，idempotent，照 `db.js` 慣例。
- **研究方向 = `parent_id IS NULL` 的節點**。子節點是方向底下的子題，不當方向。
- GET `/tree` 每個節點回 `description`；PATCH `/tree/:id` 接受 `description`（字串，trim，上限 2000 字，超過 400）；POST `/tree` 也接受可選 `description`。
- 新增只讀 helper `src/directions.js`：
  - `listDirections()` → `[{ id, name, description, paperCount }]`（頂層節點，依 `sort_order`）
  - `directionOfPaper(paperId)` → 沿 `tree_node_id` 往上找到頂層節點，或 `null`
  - `renderDirectionsBlock(paperId)` → 字串或 `''`（見 3.2）
- **不把樹結構或描述出海到 gateway**（手冊 §3.3 定案，gateway 只收 `tree:<path>` tag，本工單不動 `src/gateway.js`）。

### 3.2 AI 注入：研究方向區塊

`renderDirectionsBlock(paperId)` 輸出（**沒有任何方向時回空字串，三個注入點都不加**）：

```
【她的研究方向】
這篇論文屬於：nano plastics — <描述>
她另外還有的方向：py-GCMS — <描述>
判斷「延伸」「你的研究」時以這裡為準：跟這篇所屬方向直接相關的是「你的研究」；
從這篇跳到她另一個方向的是「延伸」。
```

- 論文未掛任何方向：第二行改為「這篇論文尚未歸入任何方向」，仍列出所有方向。
- 描述為空的方向只印名字。
- 三個注入點：
  1. **討論 system**（`buildChatSystem`）：接在 `paperBlock` 之後、同一個 stable system 字串內（Anthropic 格式下不另加 cache_control，跟 paperBlock 同一塊）。方向很少變，冷一次可接受。
  2. **提取 system**（`memory.js extractInsights`）：`EXTRACT_PROMPT` 之後 append 同一段。**本工單不改 EXTRACT_PROMPT 的 type/dimension 邏輯**（批次三）。
  3. **通讀**：不注入（摘要不需要）。
- 討論用的區塊要能從 log 看到：`[DIRECTIONS] paper=<id> direction=<name|none> total=<n>` 一行 INFO。

### 3.3 憲章：不當辯護人（方案 §4.4，措辭已定，逐字放進去）

在 `src/prompts/CONSTITUTION.md`「價值觀」第 6 條之後新增第 7 條：

```
7. **你不是這篇論文的辯護人。**
   作者的每個選擇都可以被質疑。她提出質疑時，先判斷她的質疑成不成立，再說作者的理由。
   論文有能從文本本身推出的明顯局限而她沒問，主動指出——
   證據與結論之間的跨度、作者自承但輕描淡寫的局限、對照／樣本／統計的通則、
   測的與聲稱的不一致、前後矛盾。
   **批判要有據**：需要領域現狀的判斷，只從她的洞察區塊與研究方向區塊引用；
   沒有可引的就標明「這是我的印象，可能過時」，不得把訓練印象當事實。
   回答時分兩層：先「論文說的」（準確轉述、引出處），後「我的評估」（明確標記）。
   純理解型的問題（「X 是什麼」「作者怎麼做的」）不需要評估段，別硬加。
```

- 同步更新「你是誰」段：把「洞察、上一段研究續窗」改為「洞察、研究方向、上一段研究續窗」。
- `SPEC.md` §六 那五條「回答要求」是文檔，加一行註明「導師人格與批判規則以 `src/prompts/CONSTITUTION.md` 為準」，不重寫。
- 若使用者 `data/CONSTITUTION.md` 覆蓋檔存在，內建的改動不會生效——**本工單不碰她的 data/**；合併後由我告知她。

### 3.4 前端：引導與設定

- **設定頁新增「研究方向」區塊**（放 API 區塊之上）：列出所有頂層節點，每個一行 name + 多行 description textarea（placeholder：「這個方向在做什麼、關心什麼問題？寫給 AI 看的」），失焦即 PATCH；「＋ 新增方向」→ POST 頂層節點。刪除走既有 TreeNode 的刪除（不在這裡重做）。
- **首次引導**：Library 頂部（活動面板之上）一張可關閉的提示卡，條件 = `listDirections()` 為空 **或** 所有方向的 description 都為空；文案「告訴 AI 你在做哪幾個方向，它才能替你連到自己的題目 →」，按鈕跳設定頁的研究方向區塊；關閉存 `localStorage['co-reading:directions-hint-dismissed']`。**可完全跳過**（她拍板）。
- **上傳時選方向**：`UploadZone` 在有 ≥1 個方向時顯示一個小 select「這篇屬於：」（選項 = 頂層節點 + 「先不歸類」），預設 = 側欄當前選的節點若為頂層節點，否則「先不歸類」。選了就以它為 `tree_node_id` 上傳。**沒有方向時不顯示 select，行為同現況。**
- `TreeNode.jsx` 頂層節點 hover 顯示 description 前 60 字當 `title`（小改，不做 inline 編輯）。

## 4. 實作範圍

允許：`src/db.js`（migration）、`src/routes/tree.js`、`src/directions.js`（新）、`src/ai.js`（`buildChatSystem` 加一段、log 一行）、`src/memory.js`（system append）、`src/prompts/CONSTITUTION.md`、`SPEC.md`（一行）、`frontend/src/pages/Settings.jsx`、`frontend/src/pages/Library.jsx`（提示卡）、`frontend/src/components/UploadZone.jsx`、`frontend/src/components/TreeNode.jsx`（title）、`frontend/src/api.js`（treeApi.update 已能傳任意欄位，若需要加 `listDirections` 可加）、`test/` 新增。

禁止：改 `EXTRACT_PROMPT` 的 type/dimension 語義、改 `TYPE_TO_DIMENSION`、動 `src/gateway.js`／出海契約、動 `data/`／`.env`、改憲章第 1–6 條的措辭、新增 npm 套件、動 `analyzePaper`。

## 5. 紅線

- **沒有方向時，討論／提取 prompt 必須與現在逐字相同**（測試用 snapshot 斷言）——這是零回歸線。
- 憲章第 7 條逐字照 §3.3，不潤飾、不擴寫。
- migration 必須 idempotent（跑兩次不炸），且在**空 DB**與**已有 tree_nodes 資料的 DB** 上都要測。
- 注入的描述文字**原樣**放進 prompt，不做任何 AI 改寫。
- 使用者 dev server 若在跑，不碰 3456／5173。

## 6. 必測矩陣

| 案例 | 預期 |
|---|---|
| M1 migration 空 DB | 有 `description` 欄，預設 `''` |
| M2 migration 兩次 | 不拋錯 |
| M3 既有資料 | 先建舊 schema 節點再 migrate，資料保留 |
| T1 PATCH description | round-trip；>2000 字 → 400；非字串 → 400 |
| T2 GET /tree | 每節點含 `description` |
| D1 `directionOfPaper` | 掛在子節點的論文回其頂層祖先 |
| D2 `renderDirectionsBlock` 無方向 | `''` |
| D3 有方向、論文掛其一 | 文字含「屬於：<name> — <desc>」與「另外還有」 |
| D4 有方向、論文未掛 | 含「尚未歸入」且仍列全部 |
| C1 `buildChatSystem` 無方向 | 與 main 完全相同（snapshot） |
| C2 有方向 | 含【她的研究方向】且在 paperBlock 之後 |
| E1 extract system 無方向 | 等於 `EXTRACT_PROMPT` |
| E2 有方向 | 以 `EXTRACT_PROMPT` 開頭、含區塊 |
| K1 憲章 | 內建檔含「你不是這篇論文的辯護人」「我的評估」「可能過時」；`loadConstitution()` 讀到 |
| U1 upload 帶 tree_node_id | 論文 `tree_node_id` 正確（既有行為） |
| 前端（實彈） | 設定頁能改描述並存；Library 提示卡出現／關閉／刷新不再出現；上傳 select 出現與否隨方向數；TreeNode title |

## 7. 交付標準

- `npm test` 全綠（開工前 92），`git diff --check` 乾淨，`git diff main --name-only` 只含 §4；
- 報告 `docs/work/report-07-research-directions-critic-20260912.md`（harness 拒寫就放最後 commit message）：changed-file list、測試數字、矩陣逐項、偏離；
- 分階段 commit：migration+routes+directions.js → ai.js/memory.js 注入 → 憲章+SPEC → 前端；
- 最終回覆十行內。

## 8. 回滾

migration 加的是 `NOT NULL DEFAULT ''` 欄位，舊代碼會忽略它，**不需要**降級 migration。撤代碼即回滾。

## 9. 範圍外

- 六維度直出、提取去重（批次三，工單 08）
- 多篇對比（批次四）
- 方向描述出海到 gateway、樹的可視化

## 附錄：實作偏離記錄

（實作者填寫）
