# 工單 16：參考文獻區塊——吃到 Nature 版式（門檻 50%→35%、多區塊、版本升級自動重算）

> 日期：2026-09-14
>
> 上位文件：工單 13 §3.2 與報告 13 §5「三個要看懂的地方」第 1 點（Cholesterol／Nature 版式主文獻表在 40.6%，被 ≥50% 門檻擋掉，只切到 70% 的 840 字補充文獻）。
>
> 優先級：P2（不壞，只是 Nature 版式每輪多讀 2–3 萬字參考文獻）
>
> Repo：`~/research-stack/co-reading`；Base：`main` @ 本工單 commit 的父 commit（含工單 13／14 合入，`951029b`）
>
> 建議分支：`fix/references-nature-layout`
>
> 生產權限：**無**。不 push、不 build 安裝包、不動 `data/`／`.env`；不打真上游；worktree 實作、`PORT=3457`；她的真 DB 只能三檔一起 cp 到臨時目錄唯讀。

## 1. 使用者拍板（2026-09-14）

我說明：放寬後全自動、不需手動補；舊論文靠版本號升級在下次打開時自動重算。她說「好，做吧」。

## 2. 現況（已查，別重查）

- `src/pdf.js locateReferencesBlock(fullText)`（工單 13）：候選＝**≥50%** 位置、獨立成行的 References／Bibliography／参考文献…標題，取**最後一個**；終點＝下一個「整行就是章節標題」的行（STAR★METHODS／Methods／Supplementary／Appendix／Acknowledgments／Key Resources Table…），沒有就到文末；**尾端密度回退**（Immunity 那篇的圖注就是靠它保住的）；引用密度 `MIN_CITATION_DENSITY=6`／千字不過就 `reason=low_density` 不切。回傳 `{cut,start,end,chars,reason,heading,density}`。
- `buildTextMeta` → `papers.text_meta` JSON，`TEXT_META_VERSION=1`；`routes/papers.js` 對舊論文 lazy 補算（只補參考文獻那半；頁級品質走 `POST /:id/text-meta/rebuild`）。**要確認 lazy 路徑是否比對版本號**——若只看「有沒有」，升版本不會觸發重算，本工單要把它改成「沒有或版本落後就重算參考文獻那半（頁級品質沿用舊值）」。
- 送模型的文字在 `buildAnalyzeUserContent`／`buildPaperBlock` 依 `text_meta.references` 切，切掉處放「[參考文獻 N 字已略去]」；`CUT_REFERENCES=false` 全關。
- 她八篇實跑（報告 13 §5）：七篇切對；Cholesterol（Nature）主文獻表在 **40.6%**（正文之後、Methods 之前，約 28,000 字），70.0% 另有 840 字補充文獻（refs 41–45，之後是 Acknowledgements）。另一篇 Nanoplastic 在 41% 正文提到 references（**不是標題**，是句子裡的字，獨立行規則已擋）。

## 3. 設計（已定案，照做）

### 3.1 候選門檻 50% → 35%，但低於 50% 的候選要多兩個條件

- 候選位置 **≥35%**。
- 位置在 **[35%, 50%)** 的候選，除了密度門檻，還必須：(a) 區塊終點是**明確的章節標題**（不是文末、也不是尾端密度回退出來的點）；(b) 區塊長度 ≥ 2,000 字。兩條不齊就當它不是文獻表（防正文誤切）。
- 位置 **≥50%** 的候選維持工單 13 的行為（終點可以是文末或尾端回退）。

### 3.2 多區塊：所有通過的候選都切

- 不再只取最後一個候選：由後往前掃所有候選，每個各算區塊、各過門檻，通過的都收進 `references.blocks[]`（依 start 排序、不重疊；重疊時保留較早開始的那個）。
- `text_meta.references` 形狀：`{ cut, blocks:[{start,end,chars,heading,density,reason}], chars_total, reason, start, end, chars }`——**`start/end/chars` 保留為最大那一塊**（向後相容 UI 與既有測試），`chars_total` 是全部區塊合計。
- 送模型的文字對每個區塊各放一行「[參考文獻 N 字已略去]」；`[TEXTMETA]` 日誌改印 `refs_cut=true blocks=2 chars_total=28,840`。
- 前端截斷／品質提示那行若有顯示「已略去 N 字」，改用 `chars_total`。

### 3.3 版本升級自動重算

- `TEXT_META_VERSION` 1 → 2。lazy 路徑：`text_meta` 缺、或 `version < TEXT_META_VERSION` → 重算**參考文獻那半**並回寫（頁級 `pages`／`bad_pages` 沿用舊值不重解析 PDF；沒有舊值就留空）。`POST /:id/text-meta/rebuild` 不變。
- 她那篇 Cholesterol 下次打開就會切到 40.6% 那塊，不用她動手。

## 4. 紅線

- 不 push、不 build 安裝包、不動 `data/`／`.env`／`dist/`／`release/`；不打真上游；worktree；`papers.full_text` 原文不動。
- 不動工單 14 的區域、不動 `chatAboutPaper`、不動視覺線。
- 工單 13 的既有測試（`test/fulltext-limit-quality.test.js`）除了「形狀多了 blocks」之外全部保持綠；Immunity 那條「尾端密度回退保圖注」的行為不變。

## 5. 驗證（mock；實作者做，我複跑）

1. Nature fixture：正文 → 40% `References`（密度夠，終點 `Methods` 標題）→ Methods → 70% `References`（840 字，終點 `Acknowledgements`）→ 兩塊都切，`blocks.length===2`，`chars_total` 正確，`start/end` 指最大那塊。
2. 37% 有獨立行 `References` 但區塊一路到文末（無終點標題）→ **不切**（reason 說明）。
3. 37% 候選、終點是標題但區塊只有 900 字 → 不切。
4. 41% 正文句子裡出現 "references"（非獨立行）→ 不是候選。
5. 工單 13 的四個 fixture（標準期刊／Cell Press STAR／正文提到＋真標題在 80%／low_density）結果不變。
6. 版本升級：`text_meta.version=1` 的舊列在 GET 時被重算成 version 2，`pages` 沿用；`version=2` 不重算。
7. 對她 DB 唯讀副本重跑八篇，表放進報告：Cholesterol 應切 ≈28,000＋840；其餘七篇結果與報告 13 相同（或說明差異）。
8. `npm test` 全綠（現 332/332）、`npm run build` 過、`git diff --check` 乾淨。

## 6. 交付

分支 `fix/references-nature-layout`，分階段 commit 帶測試數字；報告 `docs/work/report-16-references-nature-layout-20260914.md`（harness 拒寫就放最後 commit message）含八篇對照表；最終回覆十行內。

## 7. needs-decision

無。
