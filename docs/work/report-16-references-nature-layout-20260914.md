════════════════════════════════════════════════════════════════════
報告 16：參考文獻區塊——吃到 Nature 版式（門檻 50%→35%、多區塊、版本升級自動重算）
════════════════════════════════════════════════════════════════════

日期：2026-09-14
上位文件：docs/work/workorder-16-references-threshold-nature-20260914.md
　　　　　docs/work/report-13-fulltext-limit-quality-20260914.md §5 第 1 點
Repo：~/research-stack/co-reading（worktree）；Base：main @ 060d987（含工單 13／14）
分支：fix/references-nature-layout（5 顆 commit，未 push、未合併、未部署）
測試：npm test 349/349（改動前 332/332，新增 17）；npm run build 通過（305 modules，
　　　dist/ 未 commit）；git diff --check 乾淨

── 1. 一句話 ──────────────────────────────────────────────────────

Nature 版式的主文獻表（在 Methods 之前）現在切得到了，而且一篇可以切不只一塊；
她那篇 Cholesterol 從「只切 840 字」變成「切 8,193 ＋ 840 字」，Methods 一個字沒少。
舊論文不用她動手——TEXT_META_VERSION 1→2，下次打開時自動重算。

但有一個數字要先講清楚：工單 §5.7 期望 Cholesterol「切約 28,000 字」，實測是
8,193 字。28,000 是從「40.6% → 70.0%」的位置差推出來的估計值；真實版面是
References(40.6%) → Methods(49.2%)，主文獻表只有 8,193 字（refs 1–40），
40.6%→70.0% 中間那 20,000 字是 Methods 正文本體。要真的切到 28,000 字，就得把整個
Methods 一起吃掉——那正是本工單兩道閂要擋的事。詳見 §5 與 §8-1。

── 2. commit 清單 ─────────────────────────────────────────────────

  4964595  feat(pdf): §3.1／§3.2 候選門檻 50%→35%＋多區塊（332/332）
  f511d4c  feat(ai): §3.2 送模型的文字對每個區塊各放一行標記（332/332）
  44561fd  feat(routes): §3.3 版本落後就自動重算參考文獻那半（332/332）
  d09e038  test: §5 的 17 顆釘子——門檻、多區塊、版本升級（332 → 349）
  （本顆）  docs: 報告 16 ＋ 手冊／SPEC／.env.example 同步

── 3. changed files ───────────────────────────────────────────────

  src/pdf.js                     +90/−30  MIN_HEADING_RATIO 0.5→0.35；新增
                                          SAFE_HEADING_RATIO／EARLY_MIN_BLOCK_CHARS／
                                          evaluateCandidate()；locateReferencesBlock 改回
                                          blocks[]＋chars_total；TEXT_META_VERSION 1→2；
                                          buildTextMeta 多寫 blocks[]／chars_total
  src/ai.js                      +40/−20  recordedReferenceBlocks／referenceBlocksUsable；
                                          stripReferences 改吃區塊清單、由後往前切、
                                          多回 blocks 計數；prepareFullTextForModel 多回
                                          refsBlocks
  src/routes/papers.js           +14/−6   ensureTextMeta 比對版本號（缺或落後就重算參考
                                          文獻那半，pages 沿用舊值）；[TEXTMETA] 多印
                                          v=／blocks=／chars_total=
  test/fulltext-limit-quality.test.js +215  17 顆新釘子；既有釘子只動一顆（見 §8-5）
  TECHNICAL_MANUAL.md / SPEC.md / .env.example  ~35  text_meta 形狀、門檻規則、版本升級

── 4. 明確沒改什麼 ────────────────────────────────────────────────

- papers.full_text 原文一個字沒動，也沒有重寫任何既有列的正文。切除只發生在
  buildPaperBlock／buildAnalyzeUserContent 的輸出上（活體 smoke 兩篇實測：GET 回來的
  full_text 與 DB 原值逐字相同）。
- ≥50% 的候選行為逐字不變：終點仍可以是文末、仍走尾端密度回退。她那篇 Immunity 的
  圖注／Highlights／KEY RESOURCES TABLE 照樣保住（smoke 實測都在 prompt 裡）。
- 工單 14 的地盤：chatAboutPaper、routes/chat.js、FullTextView.jsx、ChatPanel.jsx、
  frontend/src/api.js、messages 表、store.js——一個字沒碰。
- 視覺線（工單 15）：renderVisualPages／selectVisualPageNumbers／describePages／
  頁級品質判準，一個字沒碰。
- 上限（PAPER_FULLTEXT_LIMIT_CHARS）、ctx_overflow 分類、憲章、重試／逾時／串流、
  POST /:id/text-meta/rebuild 的行為：沒改。
- 前端：沒改。工單 §3.2 說「截斷／品質提示那行若有顯示『已略去 N 字』就改用
  chars_total」——查過 frontend/ 全域沒有任何地方顯示這個數字（截斷提示講的是
  full_text_chars／limit，品質提示講的是壞頁），所以沒有要改的地方。
- 沒 push、沒 build 安裝包、沒動 data/／.env／release/／dist/、沒打真上游、
  沒碰她的 :3456（自驗一律 PORT=3457 ＋ 臨時 CO_READING_DATA_DIR）。

── 5. 她八篇的實跑結果（唯讀副本，與報告 13 對照）─────────────────

做法：cp data/co-reading.db{,-wal,-shm} 到 scratchpad，在副本上跑新的
locateReferencesBlock ＋ prepareFullTextForModel。她的 :3456 完全沒被碰到。
上限 250,000 字（八篇都沒被截斷，與報告 13 相同）。

| 論文（截短） | 全文 | 報告 13 切了 | 本工單切了 | 送模型 | 差異 |
|---|---|---|---|---|---|
| Controlling the biodistribution…（Nat Rev） | 146,545 | 61,568 @56.8% | 1 塊 61,568 @56.8% d=14.60 | 84,996 | 相同 |
| Polystyrene microplastic…（Immunity） | 146,272 | 29,202 @60.2% | 1 塊 29,202 @60.2% d=6.81 | 117,089 | 相同 |
| The protein corona…（Nat Rev） | 126,664 | 39,609 @67.1% | 1 塊 39,609 @67.1% d=13.46 | 87,074 | 相同 |
| Multimodal imaging…（Nat Commun） | 100,122 | 6,256 @91.9% | 1 塊 6,256 @91.9% d=17.26 | 93,884 | 相同 |
| Cholesterol modulates…（Nat Nano） | 95,783 | 840 @70.0% | 2 塊 9,033＝8,193 @40.6% d=12.57 ＋ 840 @70.0% d=15.48 | 86,784（原 94,959） | 多切 8,193 |
| Intratumoral Mycobacterium…（Nat Commun） | 64,930 | 9,459 @84.7% | 1 塊 9,459 @84.7% d=16.18 | 55,489 | 相同 |
| Nanoplastic Shape Effects（ES&T） | 59,615 | 12,326 @79.3% | 1 塊 12,326 @79.3% d=6.00 | 47,308 | 相同 |
| NIST PolymerPyrolysisSearch（ES&T） | 45,264 | 6,454 @85.7% | 1 塊 6,454 @85.7% d=6.97 | 38,828 | 相同 |

七篇逐字相同（start／end／chars／density 全對得上報告 13 §5 的表），只有 Cholesterol
變了——這正是本工單要動的那一篇。

Cholesterol 的真實版面（我在唯讀副本上逐段看過）：

      0 ─ 38,888   正文（Abstract／Results／Discussion）
 38,888 @40.6%     "References"  ← 主文獻表 refs 1–40，8,193 字，密度 12.57
 47,081 @49.2%     "Methods"     ← 區塊終點（明確章節標題，尾端回退沒動過它）
 47,081 ─ 67,003   Methods 正文（Reagents and materials… 約 20,000 字）
 67,003 @70.0%     "References"  ← Methods 補充文獻表 refs 41–45，840 字
 67,843 @70.8%     "Acknowledgements"
 67,843 ─ 95,783   致謝／作者貢獻／Reporting summary

為什麼不是 28,000 字：工單 §5.7 的期望值是拿 40.6% 與 70.0% 相減估的
（0.294 × 95,783 ≈ 28,160）。但那 28,000 字裡有 20,000 字是 Methods 正文本體，不是
文獻。切 8,193 才是對的；切 28,000 就會把整個 Methods 送進黑洞——她問方法學的問題時
模型會一問三不知。這是預期值的算術問題，不是實作偏離；規則本身照工單 §3.1／§3.2
逐條實作。

實測切除邊界（Cholesterol，唯讀副本）：

  …data and code availability are available at https://doi.org/10.1038/s41565-023-01455-7.
  [參考文獻 8,193 字已略去]
  Methods
  Reagents and materials
  Cholesterol (C8667), dithiothreitol (D0632)…        ← Methods 完整保留 ✓

  …are available from the corresponding authors upon reasonable request.
  [參考文獻 840 字已略去]
  Acknowledgements
  The work was supported by grants from…               ← 致謝完整保留 ✓

（第一塊順帶切掉的還有夾在 refs 40 與 Methods 之間的版權宣告與跑馬標題
「© The Author(s)… / Nature Nanotechnology / Article https://doi.org/…」——出版社
版面家具，不是內容。）

── 6. 活體 smoke（假上游，PORT=3457，臨時 data dir）────────────────

真實上游 smoke：未做，使用者禁止。替代驗證＝真 express ＋ 真 SQLite ＋ 臨時
CO_READING_DATA_DIR，用她兩篇的真實全文（唯讀副本）。Cholesterol 那列刻意先寫入一顆
工單 13 時代的 v1 text_meta（只切到 70% 那塊、帶 bad_pages=[16]）驗版本升級路徑；
Immunity 那列完全沒有 text_meta，驗新算路徑。

  [TEXTMETA] paper=jGPpnDhRFDqlh8q-Nte1c v=2 refs_cut=true blocks=2 chars_total=9,033
             reason=ok start=38888 chars=8193 density=12.57/1000 pages=1 bad_pages=16
  [smoke] text_meta.version = 2（存進去是 1）        ← 版本升級自動觸發 ✓
  [smoke] blocks = 2 chars_total = 9033 | 相容欄位 start=38888 chars=8193
  [smoke] pages 沿用 = [16] bad_pages=[16]           ← 頁級品質沒被清掉 ✓
  [smoke] GET full_text 逐字等於 DB 原值 = true
  [smoke] 標記 = [參考文獻 8,193 字已略去] [參考文獻 840 字已略去]
  [smoke] Methods 正文還在 = true ／ Acknowledgements 還在 = true
  [smoke] 主文獻表 1. Quesada 不見了 = true ／ 補充文獻 41. Ashkarran 不見了 = true

  [TEXTMETA] paper=1XLeFeTWvPJO58Tvqyq7g v=2 refs_cut=true blocks=1 chars_total=29,202
             reason=ok start=88072 chars=29202 density=6.81/1000 pages=0 bad_pages=none
  [smoke] KEY RESOURCES TABLE 還在 = true ／ Highlights 還在 = true  ← 尾端回退沒壞 ✓

順帶對帳：她那顆生產 DB（唯讀副本）目前還沒有 text_meta 欄位——工單 13 已經合進 main，
但她的服務還沒跑過新代碼。所以實際上線時八篇走的是「沒有 meta → 直接算成 v2」，
版本升級那條路要等她之後再升規則時才會用到（本工單的測試與 smoke 都已經釘住它）。

── 7. 測試數字 ────────────────────────────────────────────────────

  test/fulltext-limit-quality.test.js（targeted）   58/58（原 41）
  npm test（full）                                  349/349，0 fail（改動前 332/332）
  npm run build                                     通過，305 modules；dist/ 未 commit
  git diff --check                                  乾淨

工單 §5 逐條對照：
  1 Nature fixture 兩塊都切、blocks.length===2、chars_total、start/end 指最大塊  ✔ 2 顆
  2 37% 候選一路到文末 → 不切（reason=early_open_end）                          ✔ 2 顆
    （另加對照組：同一塊補上終點標題就切得掉，證明擋的是終點不明不是位置）
  3 37% 候選終點是標題但只有 900 字 → 不切（reason=early_too_short）            ✔ 1 顆
  4 41% 正文句子裡的 references（非獨立行）不是候選                             ✔ 1 顆
  5 工單 13 的四個 fixture 結果不變                                             ✔ 既有 8 顆全綠
  6 version=1 的列 GET 時重算成 2 且 pages 沿用；version=2 不重算                ✔ 3 顆
    （另加：沒有 version 欄位的殘留也會被重算）
  7 她八篇唯讀副本對照表                                                        ✔ §5
  8 npm test 全綠／build 過／diff --check 乾淨                                  ✔ §7

另加的釘子（工單沒列但守的是同一條線）：密度門檻沒被放寬（終點與長度都過、只差密度）、
兩道閂的觸發順序、候選重疊時保留較早開始的那塊、≥50% 尾端回退照舊保圖注、
buildTextMeta 的 blocks[]／chars_total 形狀、存下來的 blocks 直接用、v1 單塊 meta
向後相容、任一塊對不上標題就整份重算。

── 8. 偏離工單之處（逐條）─────────────────────────────────────────

1. Cholesterol 的期望值 28,000 → 實測 8,193（§5 已詳述）。不是規則沒照做，是工單
   §5.7 的估計值把 Methods 正文算進去了。要拿到 28,000 只能取消「終點＝下一個章節
   標題」這條工單 13 的核心規則，那會砍掉整個 Methods——沒有做，也不建議做。
2. §3.1 的「終點不是尾端密度回退出來的點」實作成嚴格比對（end === rawEnd）：低位置
   候選只要尾端回退動過一個字，就整塊不切。她八篇裡 Cholesterol 那塊回退完全沒動
   （最後 1,000 字全是文獻），所以過得去；但這是一道窄門——將來某篇 Nature 如果在
   最後一條文獻與 Methods 之間夾了超過 1,000 字的版面家具，就會退回「不切」
   （＝今天的行為，fail-safe，不會誤切正文）。照工單字面實作，記在這裡讓妳知道線在哪。
3. 兩道閂的檢查順序是「終點 → 長度 → 密度」，所以一個又稀又沒終點的候選回報的是
   early_open_end 而不是 low_density（稀疏區塊會先被尾端回退動到終點）。結果都是不切，
   只是日誌上的理由字串不同。有一顆釘子直接釘住這個順序，免得以後誤判成 bug。
4. stripReferences 多回一個 blocks 計數、prepareFullTextForModel 多回 refsBlocks。
   工單沒要求，但 [TEXTMETA] 日誌要印 blocks=，而且切了幾塊是排錯時第一個要看的數字。
5. 既有測試動了一顆：lazy 補算那顆的 assert.equal(body.text_meta.version, 1) 改成
   TEXT_META_VERSION。版本號升級必然撞它；改成跟著常數走，以後升級不用再改測試。
   其餘工單 13 的釘子一顆沒動（含 Immunity 尾端回退那顆）。
6. 順手同步 TECHNICAL_MANUAL.md（text_meta 形狀、locateReferencesBlock 規則、
   TEXT_META_VERSION 的意義）、SPEC.md（一篇可能不只一塊）、.env.example
   （CUT_REFERENCES 的說明與新日誌欄位）。

工單 §7 needs-decision 是「無」，實作中也沒有新的需要她拍板的事。唯一值得她知道的是
§8-1 的 8,193 vs 28,000，以及 §8-2 那道窄門。

── 9. 觀察哨與回滾 ────────────────────────────────────────────────

  grep '\[TEXTMETA\]' data/app.log     每篇一行
  grep 'blocks=2' data/app.log         哪幾篇是 Nature 版式（切到兩塊）
  grep 'reason=early_' data/app.log    低位置候選被兩道閂擋下來的（預期內的保守）
  grep 'refs_cut=false' data/app.log   整篇切不掉的

  上線後第一件事：打開 Cholesterol（jGPpnDhRFDqlh8q-Nte1c），日誌應該出現
  v=2 refs_cut=true blocks=2 chars_total=9,033；然後問它一個 Methods 裡的細節
  （例如「膽固醇是哪家買的、貨號多少」，正確答案是 Sigma-Aldrich C8667），
  答得出來就證明 Methods 沒被誤切。

旋鈕（改 .env 重啟即生效；每次呼叫都重讀 env）：
  CUT_REFERENCES=false   懷疑切錯就關掉（原文本來就沒動，關掉即復原）

整條回滾：git checkout main（分支未合併，生產不受影響）。已經寫成 v2 的 text_meta
留著也無害——它是純推導資料；真要回到工單 13 的切法，實務上直接用
CUT_REFERENCES=false 比改版本號快。

npm test 349/349

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>


── 附錄 C（Elias 親驗，2026-09-14 15:20）──────────────────────────────

- `npm test` 親跑 349/349（改前 332）。改動：src/pdf.js、src/ai.js、src/routes/papers.js、測試、.env.example、SPEC、手冊。
- 親手對她 DB 唯讀副本跑 `locateReferencesBlock`：
  - Cholesterol（Nature）：2 塊 9,033 字。塊一 38,888–47,081（8,193 字，@40.6%）從「References\n1. Quesada-Gonzalez」切到「Methods」標題前一字；塊二 67,003–67,843（840 字，@70.0%）切到「Acknowledgements」前。**工單 §5 寫的「約 28,000」是我用位置差估錯的**——40.6%→70.0% 中間 20,000 字是 Methods 正文，實作照兩道閂沒吃掉它，是對的。
  - Immunity：單塊 88,072–117,274（29,202 字）與報告 13 逐字相同，尾端回退保住圖注。
  - Nanoplastic：單塊 @79.3% 到文末，與報告 13 相同。
- 版本升級：agent 活體 smoke 已證 v1→v2 自動重算、`pages` 沿用；我未重跑（純路徑邏輯，17 顆釘子含此項）。
- 真上游 smoke：未做（使用者禁止）。
