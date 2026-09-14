# 工單 13：讓模型讀到全文——上限放寬、參考文獻區塊切除、頁級抽字品質

> 日期：2026-09-14
>
> 上位文件：她 9/14 的問題與我的回答（記憶 `coreading-fulltext-quality-questions-20260914`）；報告 11 §3（3.85 字/token）。
>
> 優先級：**P1**（她原話：「全文上下文這個我覺得很重要」；八篇裡四篇超過 10 萬字被截尾，最大 146,545 字）
>
> Repo：`~/research-stack/co-reading`；Base：`main` @ 本工單 commit 的父 commit（含工單 12，`PAPER_FULLTEXT_LIMIT` 常數已在 `src/ai.js`）
>
> 建議分支：`feat/fulltext-limit-quality`
>
> 生產權限：**無**。不 push、不 build 安裝包、不動 `data/`／`.env`。**不打真上游**（mock fetch）。她的 dev server 可能在跑——worktree 實作、`PORT=3457`＋臨時 data dir 自驗。**與工單 14 並行**：14 動 `chatAboutPaper` 的變動區、`FullTextView`、`ChatPanel`、`api.js`、`routes/chat.js`；本工單**不要碰那些區域**（`src/ai.js` 只動 `PAPER_FULLTEXT_LIMIT`／`buildPaperBlock`／`buildAnalyzeUserContent`／新增的品質區塊函式；前端只動 `SummaryView.jsx`／`PaperDetail.jsx` 的頂部提示與 `api.js` 以外的地方）。

## 1. 使用者拍板（2026-09-14）

- 「全文上下文很重要」→ 放寬上限。
- 「外部檢索不做」（她的領域外面查不到）——**範圍外**。
- 「橫著放的大表能不能讀到」→ 靠視覺局部渲染，**另開工單 15**（poppler 已裝、`analyze_vision_mode` 目前 off）；本工單只做「偵測並標示」，不渲染。
- 「參考文獻就不用讀了」→ 切。
- 「PDF 抽字品質、能不能攔答非所問」→ 頁級品質分數＋告訴模型哪幾頁不可靠＋憲章「讀不到就說讀不到」。
- 她說「現在開吧」。

## 2. 現況（已查，別重查）

- `src/pdf.js`：`pageTextRenderer` 逐頁抽 `getTextContent`，同 y 併行、換 y 換行；`inspectPDF` 回 `{ text, pageTexts, ... }`——**逐頁文字在抽取當下已經有**，但存進 `papers.full_text` 的是 pdf-parse 的 `data.text`（各頁以 `\n\n` 相接，**沒有換頁符**，`char(12)` 計數 0）。`selectVisualPageNumbers` 用 caption 正則挑頁。
- `src/ai.js`：`PAPER_FULLTEXT_LIMIT`（工單 12 抽出的常數，值 100000）用於 `buildAnalyzeUserContent`（通讀 user content）與 `buildPaperBlock`（討論 system）；超過就 `slice` ＋「[全文已截斷]」。
- `src/routes/papers.js`：工單 12 加了 `GET /:id` 回 `full_text_truncated`／`full_text_chars`；前端 `SummaryView`／`PaperDetail` 有一行截斷提示。
- 換算：3.85 字/token（報告 11）。OpenCode 的 `/models` 不回窗口大小（9/14 查過），**不憑印象假設窗口**。
- References 位置（`instr` 第一次出現／全文比例）：0.41、0.57、0.60、0.67、0.79、0.85、0.86、0.92——**第一次出現常在正文裡**（Nanoplastic 那篇 0.41 是正文提到 references）。她 `1XLeFeTWvPJO58Tvqyq7g`（Cell Press 格式）`REFERENCES` 在 0.60，**之後還有 STAR★METHODS 與 Key Resources Table**（尾 1500 字是引子序列表）——切「References 到文末」會砍掉方法。
- 憲章：`src/constitution.js` 三級載入（`data/CONSTITUTION.md` 覆蓋 → 內建 → 保險絲）；工單 05 定的規則在內建檔。

## 3. 設計（已定案，照做）

### 3.1 上限放寬

- `PAPER_FULLTEXT_LIMIT` 改成 `resolvePaperFulltextLimit()`：env `PAPER_FULLTEXT_LIMIT_CHARS`，**預設 250_000**，clamp [20_000, 2_000_000]，空／非數字退預設。通讀與討論共用同一個值。
- 截斷提示保留；`full_text_chars`／`full_text_truncated` 語義不變（以新上限計）。
- 上游若回 4xx 且訊息含 `context`／`length`／`too long`／`maximum`（大小寫不拘）：通讀線錯誤訊息改成「論文太長，超過模型窗口（送出約 N 字≈M token）。把 `.env` 的 PAPER_FULLTEXT_LIMIT_CHARS 調低再重新通讀」；討論線同理（走工單 12 的 `describe*` 家族，加一個 kind `ctx_overflow`，**不重試**）。這一條在 `src/ai.js` 的錯誤分類函式加分支即可，不動 `chatAboutPaper` 主體（工單 14 在動它）。

### 3.2 參考文獻**區塊**切除（不是切尾）

- 抽取時（`src/pdf.js`，新函式 `locateReferencesBlock(pageTexts)` 或在 full_text 上做，二選一但要能回 `[start, end)` 字元偏移）：
  1. 候選標題：獨立成行、去空白後全文匹配 `^(references?|bibliography|literature cited|参考文献|參考文獻|reference list)\s*$`（大小寫不拘），且位置在全文 **≥ 50%**。取**最後一個**候選。
  2. 區塊終點：從候選往後找下一個「像章節標題」的獨立行（`^(star\W*methods|methods|materials and methods|supplement(ary|al)( information| materials)?|appendix|acknowledg(e)?ments?|author contributions|key resources table|支持信息|致谢|附录)\b`），有就切到那裡，沒有就到文末。
  3. **證據門檻**：區塊內每千字至少 6 個「引用特徵」（`\(?(19|20)\d{2}\)?[a-z]?[.;,]`、`et al\.`、`doi`、`https?://`、`\d+\.\s+[A-Z][a-z]+,` 行首編號作者），不達門檻就**不切**並記 `references_cut=false, reason=low_density`。
  4. 只在**送模型的文字**上切（`buildAnalyzeUserContent`／`buildPaperBlock`），**`papers.full_text` 原文不動**（閱讀模式與工單 14 的選段偏移都以原文為準）。切掉處放一行「[參考文獻 N 字已略去]」。
- 存結果：`papers` 加欄 `text_meta TEXT DEFAULT ''`（JSON：`{references:{start,end,chars,cut:true|false,reason}, pages:[…見 3.3…], version:1}`），migration 照 `src/db.js` 既有寫法（`ALTER TABLE … ADD COLUMN` 包 try）；上傳時計算；**既有論文**：`POST /api/papers/:id/text-meta/rebuild`（或在 GET 時 lazy 計算並回寫，二選一，寫進附錄）。
- 統計要看得到：`[TEXTMETA] paper=… refs_cut=true start=… chars=… pages=… bad_pages=…` 一行日誌。

### 3.3 頁級抽字品質

- `inspectPDF` 已有 `pageTexts`；上傳時每頁算：`chars`、`lines`、`single_char_line_ratio`（長度 ≤2 的行佔比）、`nonword_ratio`（非字母／數字／中文／常見標點的比例）、`avg_line_len`、`rotated_hint`（**用 pdf.js 的 `item.transform`**：若一頁內多數 text item 的 transform[0]≈0 且 transform[1]≠0，表示文字被旋轉 90°——這就是橫向大表的指紋；同時把 `pageData.rotate` 記下）。
- 判「差」：`chars < 200`（非最後一頁）或 `single_char_line_ratio > 0.4` 或 `nonword_ratio > 0.3` 或 `rotated_hint=true`。存進 `text_meta.pages[]`（每頁 `{n, chars, quality:'ok'|'poor'|'rotated', reasons:[…]}`），`text_meta.bad_pages=[…]`。
- 給模型：在通讀 user content 與討論的**論文區塊**（穩定前綴，`buildPaperBlock` 內、方向區塊之前）加一段固定格式的小註（只有 bad_pages 非空時才加）：「抽字品質提示：第 3、7 頁文字疑似旋轉（可能是橫向表格）、第 12 頁抽字不完整。這些頁的內容你可能讀不到或讀到亂碼；涉及時明說「這部分我從抽取文字裡讀不到」，不要推測。」**這段落在穩定前綴裡，會改變 cache 前綴一次（每篇一次），可接受。**
- 給她：`GET /api/papers/:id` 回 `text_meta`；`SummaryView` 頂部（截斷提示旁）一行：「第 3、7 頁疑似橫向表格、第 12 頁抽字不完整」，點開可看每頁的數字（簡單 `<details>` 即可）。
- 憲章：內建 `CONSTITUTION.md` 在第 7 條旁加一條「**讀不到就說讀不到**：對抽字品質提示點名的頁、或文中明顯缺漏的表格與圖，直接說明你看不到，不要用常識補一個答案」。`test/constitution.test.js` 有釘既有條文，只加不改。

### 3.4 給工單 15 留的接口

- `text_meta.pages[].quality === 'rotated'` 與 `bad_pages` 就是工單 15「只渲染這幾頁」的輸入；本工單不呼叫 `renderVisualPages`、不改 `selectVisualPageNumbers`。

## 4. 紅線

- 不 push、不 build 安裝包、不動 `data/`、`.env`、`dist/`、`release/`；不打真上游；worktree 實作、`PORT=3457`。
- **`papers.full_text` 原文不改、不重寫既有列**——只加 `text_meta` 欄。
- 不動 `chatAboutPaper` 主體、`routes/chat.js`、`FullTextView.jsx`、`ChatPanel.jsx`、`frontend/src/api.js` 的 chat 部分（工單 14 正在動）。`buildPaperBlock` 可動。
- 不做視覺渲染（工單 15）；不做外部檢索。
- 憲章只加一條，不改既有條文。

## 5. 驗證計畫（mock，實作者做；我複跑）

1. 上限：249,999 字不截、250,001 字截且提示；env `=abc`／`=0`／`=1e9` 各落合法值。
2. References：用 fixture 造四種：(a) 標準期刊（References 在 85%，到文末）→ 切；(b) Cell Press（REFERENCES 60% 後接 STAR★METHODS）→ 只切到 STAR 前，方法保留；(c) 正文提到 "References" 在 41% 且真標題在 80% → 取後者；(d) 標題有但區塊沒引用特徵 → 不切、reason=low_density。
3. 品質：fixture pageTexts 含一頁 transform 旋轉、一頁單字行 50%、一頁 <200 字 → `bad_pages` 正確；沒有壞頁時提示段完全不出現（穩定前綴逐字等於現在）。
4. `text_meta` migration 對既有 DB 冪等（跑兩次不炸）；既有論文 rebuild 端點或 lazy 路徑能填值。
5. 上游 400 含 "context length" → 訊息含「PAPER_FULLTEXT_LIMIT_CHARS」，不重試。
6. `npm test` 全綠（現 252/252）、`npm run build` 過（不 commit dist/）、`git diff --check` 乾淨。

## 6. 交付

分支 `feat/fulltext-limit-quality`，分階段 commit（3.1／3.2／3.3／憲章／測試），每顆帶測試數字；報告 `docs/work/report-13-fulltext-limit-quality-20260914.md`（harness 拒寫就放最後 commit message）：changed-file list、沒改什麼、targeted 與 full 測試數字、真實 smoke「未做」、偏離逐條、**對她八篇真 DB 的唯讀副本跑一次 `locateReferencesBlock` 與頁級品質，把八篇的結果表（切了幾字、壞頁哪些）放進報告**（副本：cp `data/co-reading.db` + `-wal` + `-shm` 到臨時目錄，只讀）。最終回覆十行內。

## 7. needs-decision

無。預設 25 萬字、切區塊不切尾、只標不渲染，都已定。
