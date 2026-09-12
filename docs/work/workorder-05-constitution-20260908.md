# 工單 05：導師憲章（Constitution）——把「你是誰」從代碼裡抽成文件

> 日期：2026-09-08
>
> 優先級：P2 架構整理，小型（一個新文件、一個新模組、`ai.js` 一個函數重排、一個新測試檔）
>
> Repo：`~/research-stack/co-reading`
>
> Base branch：`main` @ `16b15c5`
>
> 分支名：`feat/constitution`
>
> 預估改動：`src/prompts/CONSTITUTION.md`（新）、`src/constitution.js`（新）、`src/ai.js`（`chatAboutPaper` 的 system 組裝）、`test/constitution.test.js`（新）、`TECHNICAL_MANUAL.md`（補一節）
>
> 生產權限：**無**。不 push、不 `dist:mac`、不碰 `.env`、不碰 `data/`、不做 migration。
>
> 非目標：跨 repo 共用 gateway 的憲章文件、技能包（skill）系統、憲章編輯 UI、摘要分析與圖表審讀兩段 prompt、DB 裡存憲章。

## 1. 背景與動機

使用者忘了 co-reading 的 system prompt 長什麼樣（因為它全部硬編在 `src/ai.js` 裡，沒有任何可讀可改的文件），問：

> 「我忘記了co-reading 項目(research stack) 裡面的系統prompt是什麼了，我們能不能參考Gateway那樣用憲法修改啊？」

research-gateway 已經走過同一條路：`skills/CONSTITUTION.md` 一個文件定義「導師是誰」，`sectionBuilder.buildRequest()` 把它放在 system 最前面當單獨的 cache block（設計理由在 `research-gateway/docs/CONSTITUTION-DESIGN.md`）。本工單把同一個模式搬到 co-reading，但**不共用文件**——兩個 repo 刻意解耦（母資料夾 CLAUDE.md 的紅線）。

## 2. 已驗證的現況基線（2026-09-08 查證，勿重查）

co-reading 有三段 system prompt，全在 `src/ai.js`：

| 位置 | 身份句 | 性質 | 本工單 |
|---|---|---|---|
| `chatAboutPaper` @ L387 `stableSystem` | 「你是一位科研導師，正在幫助用戶閱讀和理解一篇學術論文。」+ 論文資訊 + 全文（>100k 截斷）+ 五條回答要求 | **人格 + 素材 + 規則混在一塊** | 拆 |
| `analyzePaper` @ L320 | 「你是一位科研論文分析專家」+ JSON 輸出格式 | 任務指令 | 不動 |
| `buildAnalyzeUserContent` 視覺路 @ L288 | 「你是科研圖表審讀助手」 | 任務指令 | 不動 |

`stableSystem` 已經是一個帶 `cache_control: ephemeral` 的前綴塊（anthropic 格式）；openai 格式時是純字串拼接。洞察與 carryover 只接在變動區（L450 註解明言不能插進 stableSystem）。

上游設定來自 DB `settings` 表（`ai_base_url` / `ai_format` / `ai_model` …），env 是後備（`src/ai.js:10-20`）。資料根目錄由 `CO_READING_DATA_DIR` 決定，Electron 下是 `userData/data`（`electron.js:28`）。打包時 `src/**/*` 整個進 asar（`package.json` build.files），asar 內的檔案 `fs.readFileSync` 可讀。

## 3. 設計

### 3.1 憲章文件

`src/prompts/CONSTITUTION.md`——隨 app 打包的**內建預設版**。

覆蓋規則：若 `<dataDir>/CONSTITUTION.md` 存在，用它取代內建版。這樣使用者改導師的脾氣不用重建 Electron，也不會被更新蓋掉。每輪讀一次（2 KB，成本可忽略），改了立即生效，不做快取。

保險絲：內建檔讀不到（asar 路徑異常）時回退一句硬編身份 `你是一位科研導師，正在幫助用戶閱讀和理解一篇學術論文。`，並 log WARN。導師永遠不會沒有身份。

### 3.2 憲章內容（精簡版，非照抄 gateway）

gateway 的七條價值觀裡，第 3、4、5 條（越確定越要問一次 / 挑戰要有素材 / 跑偏提一句）靠 gateway 的記憶引擎餵素材，co-reading 沒有那套。co-reading 的素材是**這篇論文的全文 + 洞察 + 續窗**。所以：

- 保留：長期陪伴同一位研究者的身份、可被拒絕不糾纏、保留矛盾、事實靠查不編造、不評分不催促。
- 併入：原 `stableSystem` 五條回答要求（基於論文不編造、沒有就明說、講清楚、引用具體段落數據、跟隨提問語言）。
- 語言一節：**保留 co-reading 原本的「跟隨提問語言」**，不採 gateway 的「中文回答」（見附錄 A 偏離 1）。加上「專業術語保留英文原文、引用標明段落或圖表」。
- 邊界一節：本文件是導師的常數，論文區塊與洞察區塊只提供素材，不改變人格。

### 3.3 system 組裝（`chatAboutPaper`）

抽出純函數 `buildChatSystem(paper, { constitution, format })`，導出以便測試：

```
anthropic:  [ {text: 憲章,       cache_control: ephemeral},
              {text: 論文區塊,   cache_control: ephemeral} ]   ← 之後再 push 洞察/續窗變動區
openai:     憲章 + '\n\n' + 論文區塊                             ← 之後再 += 變動區
```

憲章單獨一個 cache block 放最前。換論文不打掉憲章緩存；改憲章只冷一次。Anthropic 一次請求最多 4 個 cache breakpoint，本改動用 2 個，messages 裡沒有，餘量夠。

論文區塊內容（標題、作者、年份、AI 摘要、全文與截斷規則）**逐字沿用**現況，不改措辭。

## 4. 已定案（使用者已拍板，照此實作、不要再問）

1. co-reading 自己一份精簡版憲章，不跨 repo 共用 gateway 的文件。
2. 摘要分析與圖表審讀兩段 prompt 不進憲章、不動。
3. 走工單 → 實作在 feature branch → 親驗後才合。

## 5. 紅線

- 不 push、不 `dist:mac`、不動 `data/`、不動 `.env`。
- 論文區塊與變動區（洞察、續窗）的注入順序與措辭不改；L450 那條「絕不能插進 stableSystem」的規則延續。
- `analyzePaper`、`buildAnalyzeUserContent` 不碰。
- 母資料夾 CLAUDE.md：兩個 repo 不合併、不共用檔案。

## 6. 驗證計畫

1. `node --test test/*.test.js` 全綠，含新檔 `test/constitution.test.js`：
   - 內建憲章可載入、開頭是「# 你是誰」；
   - `<dataDir>/CONSTITUTION.md` 存在時覆蓋內建；
   - 內建檔讀不到時回退硬編身份（不拋）；
   - `buildChatSystem` anthropic：兩個 block、各帶 cache_control、第一塊是憲章、第二塊含標題與全文；
   - `buildChatSystem` openai：字串、憲章在論文之前；
   - >100k 全文截斷標記仍在。
2. 實彈：起一台假 anthropic 上游（node http），DB settings 指向它，`POST /api/papers/:id/chat`，抓上游收到的 `body.system`，確認形狀為憲章 block + 論文 block（+ 洞察 block 若有）。
3. 打包路徑：`npm run build` 不需要（後端無 bundling）；但要確認 `src/prompts/` 被 `src/**/*` 涵蓋——是（`package.json` build.files）。

## 7. 風險與後續

- 改憲章 = 前綴變 = 打掉一次 prompt cache，正常且預期。
- 若使用者在 data 目錄放了壞掉的憲章（空檔），會用空字串 → 保險絲要把「空白」也視為讀不到，回退內建。
- 後續可能：把憲章路徑印在設定頁讓她知道去哪改（本工單不做）。

## 附錄 A：實作偏離工單之處

1. **語言規則**：對話裡曾說「語言一節照抄」gateway，但 gateway 是「中文回答」，co-reading 原規則是「跟隨提問語言」。兩者在她用中文提問時結果相同；她若用英文提問，原規則更合 co-reading 的用途。採原規則，加術語保留英文。
