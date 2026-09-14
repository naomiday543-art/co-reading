════════════════════════════════════════════════════════════════════════
報告 13：讓模型讀到全文——上限放寬、參考文獻區塊切除、頁級抽字品質
════════════════════════════════════════════════════════════════════════

日期：2026-09-14
上位文件：docs/work/workorder-13-fulltext-limit-references-quality-20260914.md
　　　　　docs/work/report-11-chat-latency-diagnosis-20260914.md（3.85 字/token）
Repo：~/research-stack/co-reading（worktree）；Base：main @ 35c3a8e（含工單 12）
分支：feat/fulltext-limit-quality（6 顆 commit，未 push、未合併、未部署）
測試：npm test 294/294（改動前 252/252，新增 42）；npm run build 通過（304 modules，
　　　dist/ 未 commit）；git diff --check 乾淨

── 1. 一句話 ───────────────────────────────────────────────────────────

模型從「只讀得到前 10 萬字、其中一到四成是參考文獻」變成「讀得到整篇正文、參考文獻
被換成一行、抽字抽壞的頁被指名道姓」。她八篇**沒有一篇再被截斷**；最長那篇
（146,545 字）送進模型的正文從 100,000 字變成 84,996 字**而且是完整的正文**
——因為 61,568 字的參考文獻讓出了位置。

── 2. commit 清單 ──────────────────────────────────────────────────────

  9eb36b4  feat(ai): §3.1 全文上限放寬到 250,000 字＋ctx_overflow 錯誤分類（252/252）
  a9bd96d  feat(pdf): §3.2 參考文獻區塊切除——只切送模型那份，原文一字不動（252/252）
  b5c746b  feat(pdf): §3.3 頁級抽字品質——壞頁進 text_meta、進 prompt、進摘要頁（252/252）
  ae29007  feat(constitution): 第 8 條「讀不到就說讀不到」（253/253）
  e74a5bc  test: 工單 13 §5 的 41 顆釘子——全 mock 上游，253 → 294
  （本顆）  docs: 報告 13 ＋ 手冊／SPEC 同步

── 3. changed files ────────────────────────────────────────────────────

  src/pdf.js                          +200  locateReferencesBlock（含尾端密度回退）、
                                            countCitationFeatures、describePageQuality、
                                            describePages、buildTextMeta、parseTextMeta、
                                            extractPDFDetailed；pageTextRenderer 多收旋轉統計；
                                            inspectPDF 多回 pages[]
  src/ai.js                           +130  resolvePaperFulltextLimit／clipFullText／
                                            resolveCutReferences／stripReferences／
                                            prepareFullTextForModel／buildQualityNote／
                                            CHARS_PER_TOKEN；analyzeErrorKind 多 ctx_overflow；
                                            describeUpstreamError 多一個分支與 retryVerb；
                                            makeRequest 4xx 時量 promptChars；
                                            buildPaperBlock／buildAnalyzeUserContent 改走新路
  src/db.js                            +8   papers.text_meta 的 idempotent ALTER
  src/routes/papers.js                +60   saveTextMeta／ensureTextMeta；上傳時算；
                                            GET /:id lazy 補算並回傳；
                                            POST /:id/text-meta/rebuild；triggerAnalyze 帶 textMeta
  src/prompts/CONSTITUTION.md          +4   第 8 條
  frontend/src/textQuality.js    新檔  +55  describeTextQuality／renderPageList／
                                            renderPageReasons（純函式）
  frontend/src/pages/PaperDetail.jsx   +27  TextQualityNotice（一行＋<details> 明細）
  .env.example                        +11   PAPER_FULLTEXT_LIMIT_CHARS、CUT_REFERENCES
  test/constitution.test.js           +14   K2（第 8 條）；截斷那顆改成相對上限
  test/chat-stream-resilience.test.js  ~8   §5.8 改成相對上限
  test/fulltext-limit-quality.test.js 新檔 +560  41 顆釘子
  TECHNICAL_MANUAL.md / SPEC.md       ~40   papers.text_meta、pdf.js、ai.js、API、env、9.2

── 4. 明確沒改什麼 ─────────────────────────────────────────────────────

- **papers.full_text 原文一個字沒動**，也沒有重寫任何既有列的正文。切除只發生在
  buildPaperBlock / buildAnalyzeUserContent 的輸出上。閱讀模式看到的、工單 14 的
  選段偏移算的，都還是原文（smoke 實測：GET 回來的 full_text 與 DB 原值逐字相同）。
- 工單 14 的地盤：chatAboutPaper 主體、routes/chat.js、FullTextView.jsx、
  ChatPanel.jsx、frontend/src/api.js、messages 表、frontend/src/store.js
  ——**一個字沒碰**（品質提示的純函式刻意另開 frontend/src/textQuality.js）。
- 視覺渲染（工單 15）：沒做。renderVisualPages / selectVisualPageNumbers 沒改。
  text_meta.pages[].quality === 'rotated' 與 bad_pages 就是留給它的輸入。
- 外部檢索：沒做（範圍外）。
- 通讀／討論的重試、逾時、串流、[CHAT]／[ANALYZE] 日誌：行為沒改。
  describeAnalyzeError 對既有錯誤類別的輸出逐字不變（既有測試全綠）。
- 沒有壞頁時，論文區塊（穩定前綴）**逐字等於工單 13 之前**——一顆釘子直接比對整段字串。
- 沒 push、沒 build 安裝包、沒動 data/ ／.env／release/／dist/、沒打真上游。

── 5. 她八篇的實跑結果（唯讀副本）────────────────────────────────────────

做法：cp data/co-reading.db{,-wal,-shm} 與 data/pdfs/*.pdf 到 scratchpad，
在副本上跑 locateReferencesBlock ＋ describePages（她的 :3456 完全沒被碰到）。
上限 250,000 字。

| 論文（截短） | 全文字數 | 參考文獻 | 送模型字數 | 壞頁 |
|---|---|---|---|---|
| Controlling the biodistribution…（Nat Rev） | 146,545 | 切 61,568 字（@56.8%，密度 14.6） | 84,996 | 無（19 頁） |
| Cholesterol modulates…（Nat Nano） | 95,783 | 切 840 字（@70.0%，密度 15.5） | 94,959 | 第 16、19、22、24、26、29 頁（34 頁） |
| The protein corona…（Nat Rev） | 126,664 | 切 39,609 字（@67.1%，密度 13.5） | 87,074 | 無（17 頁） |
| NIST PolymerPyrolysisSearch（ES&T） | 45,264 | 切 6,454 字（@85.7%，密度 7.0） | 38,828 | 無（11 頁） |
| Nanoplastic Shape Effects（ES&T） | 59,615 | 切 12,326 字（@79.3%，密度 6.0） | 47,308 | 無（11 頁） |
| Multimodal imaging…（Nat Commun） | 100,122 | 切 6,256 字（@91.9%，密度 17.3） | 93,884 | 第 27、28、29 頁（29 頁） |
| Intratumoral Mycobacterium…（Nat Commun） | 64,930 | 切 9,459 字（@84.7%，密度 16.2） | 55,489 | 無（12 頁） |
| Polystyrene microplastic…（Immunity） | 146,272 | 切 29,202 字（@60.2%，密度 6.8） | 117,089 | 無（49 頁） |

八篇全部切得成（沒有一篇落到 low_density），**八篇都不再被截斷**。
舊上限下有四篇被截尾（146,545／126,664／146,272／100,122），最多的那篇有
46,545 字模型從沒看過。

三個要看懂的地方：

1. **Cholesterol 那篇只切了 840 字**，不是壞掉。它是 Nature 版式：主參考文獻表在
   **40.6%** 的位置（正文之後、Methods 之前），50% 的位置門檻擋掉了它；70.0% 那個
   是 Methods 的補充文獻表（refs 41–45），只有 840 字。這是工單 §3.2 定案規則的
   直接後果，**刻意保守**——位置門檻擋的是「正文中間提到 references」的誤切，代價
   就是 Nature 這種版式只吃得到尾巴。要吃到那 28,000 字得把門檻放寬到 40%，風險是
   誤切正文。**建議不動**；她真在意那一篇的話，這是一個獨立決策。
2. **Immunity 那篇（工單 §2 點名的陷阱）**：REFERENCES 在 60.2%，之後依序是
   29,113 字參考文獻 → Highlights → 約 18,000 字圖注 → KEY RESOURCES TABLE(92.4%)
   → 引子序列表。照工單原文「切到下一個章節標題」會把圖注與 Highlights 一起吃掉；
   尾端密度回退把終點拉回 80.2%（最後一條文獻的行尾），**圖注、Highlights、
   KEY RESOURCES TABLE 全部留著**（smoke 實測三者都在送出的 prompt 裡）。
3. **壞頁那兩篇**：Cholesterol 的 6 頁與 Multimodal 的 3 頁，都是「整頁只有圖、
   抽不到字」（前者是 Extended Data 圖版，每頁只抽到 109 字；後者是最後三頁，
   0／3／3 字）。**八篇一個旋轉頁都沒有**——她問的「橫著放的大表」這批論文裡沒有；
   旋轉偵測器在這批上零誤報（Immunity 每頁側邊有 4 個旋轉的 "Author Manuscript"
   浮水印，119 個 item 裡的 4 個，沒被誤判），fixture 測試證明它抓得到真的旋轉頁。

── 6. 活體 smoke（假上游，PORT=3457，臨時 data dir）────────────────────

真實 smoke（打真上游）：**未做**，使用者禁止。替代驗證是一支 scratchpad 腳本：
真 express ＋ 真 SQLite ＋ 本機假上游，用她那兩篇的**真實全文與真實 PDF**（副本），
臨時 CO_READING_DATA_DIR，不碰她的 :3456。

  [TEXTMETA] paper=1XLeFeTWvPJO58Tvqyq7g refs_cut=true reason=ok start=88072
             chars=29202 density=6.81/1000 pages=49 bad_pages=none
  [CHAT] start paper=1XLeFeTWvPJO58Tvqyq7g model=fake-chat sys_chars=119360 hist=0條
  [smoke] GET full_text 原文長度 = 146272（＝ DB 原值 146272：逐字相同 ✓）
  [smoke] 參考文獻標記 = [參考文獻 29,202 字已略去]
  [smoke] 參考文獻條目還在嗎 = 不在 ✓
  [smoke] KEY RESOURCES TABLE 還在嗎 = 在 ✓
  [smoke] Highlights 還在嗎 = 在 ✓
  [smoke] 憲章第 8 條 = 在 ✓

  [TEXTMETA] paper=lkd5HG0US4vI5M-5C8Qee refs_cut=true reason=ok start=92018
             chars=6256 density=17.26/1000 pages=29 bad_pages=27,28,29
  [smoke] 品質提示 = 抽字品質提示：第 27、28、29 頁抽字不完整。這些頁的內容你可能
          讀不到或讀到亂碼；涉及時明說「這部分我從抽取文字裡讀不到」，不要推測。

── 7. 測試數字 ─────────────────────────────────────────────────────────

  test/fulltext-limit-quality.test.js（targeted）   41/41
  test/constitution.test.js（targeted）             10/10
  npm test（full）                                  294/294，0 fail（改動前 252/252）
  npm run build                                     通過，304 modules；dist/ 未 commit
  git diff --check                                  乾淨

工單 §5 逐條對照：
  1 上限（249,999／250,001／abc／0／1e9）        ✔ §5.1 五顆
  2 References 四種版式 (a)(b)(c)(d)             ✔ §5.2（另加位置門檻、中文標題、
                                                    尾端回退、空全文四顆）
  3 品質 fixture ＋「沒壞頁時提示完全不出現」     ✔ §5.3（穩定前綴逐字比對）
  4 migration 冪等 ＋ 既有論文補算                ✔ §5.4（造存量庫跑兩次；真 express
                                                    驗 lazy 補算與 rebuild）
  5 400 context length → 帶旋鈕、不重試           ✔ §5.5（含 mock 上游實彈：只打一發）
  6 npm test 全綠／build 過／diff --check 乾淨    ✔

── 8. 偏離工單之處（逐條）──────────────────────────────────────────────

1. **§3.2 多做了「尾端密度回退」**（唯一一個行為上的增補）。工單寫「終點＝下一個
   章節標題，沒有就到文末」；她的 Immunity 那篇在 References 與 KEY RESOURCES TABLE
   之間夾了 18,000 字圖注，照原文會被一起切掉。回退規則：從尾端以 1000 字為格往回，
   引用密度低於門檻一半（3/1000）的格一律退回，再往前補完被格線切斷的那一條文獻。
   **只會讓區塊變小，不會變大**，所以不可能切到工單規則不打算切的東西。
2. **§3.2 的終點規則收緊成「整行就是標題」**。工單給的正則是 ^(…)\b，鬆到會把
   參考文獻條目本身當標題（她 lkd5HG 那篇有一條 "methods and applications.
   J. Photochem. Photobiol. B 98, 77–86"，^methods\b 命中，區塊會在第三條就斷掉）。
   改成整行匹配（後面最多跟冒號／句點）。認不出終點時退到文末，再由第 1 點收尾。
3. **多一顆 CUT_REFERENCES 開關**（預設開）。工單沒要求，但這是會改變送模型內容的
   功能，照這個 repo 的規矩要有一個關得掉的旋鈕。
4. **品質提示放在 PaperDetail.jsx 而不是 SummaryView.jsx**。工單寫「SummaryView
   頂部（截斷提示旁）」，而那句截斷提示（工單 12 §3.5）實際住在 PaperDetail。
   放在它正下方＝工單要的位置；SummaryView 維持純摘要渲染，一個字沒改。
5. **test/constitution.test.js 的 !text.includes('8. **') 改成 '9. **'**。
   那條斷言是工單 07 寫的「本工單只加第 7 條」，本工單要加第 8 條就必然撞它。
   憲章條文本身只加不改（1–7 條逐字未動），斷言換成同樣意思的新守門。
6. **test/chat-stream-resilience.test.js §5.8 改成相對上限**。它原本釘死 100,000，
   而那顆釘子的用意是「旗標跟著同一顆上限走」，不是那個數字。
7. **analyzePaper 多收一個 textMeta option**，buildAnalyzeUserContent 多收一個參數。
   工單沒明講通讀線怎麼拿到 text_meta；不傳也能跑（stripReferences 會當場重算），
   傳了省一次計算。
8. **extractPDF 沒有改簽名**，另開 extractPDFDetailed（回 {text, pageMeta}）。
   上傳路徑改用後者；extractPDF 留著給任何只要全文的呼叫端。
9. 順手同步了 TECHNICAL_MANUAL.md 與 SPEC.md（見本顆 commit 的 diff）。

工單 §7 needs-decision 是「無」，實作中也沒有新的需要她拍板的事。唯一值得她知道的
判斷題是 §5 的第 1 點（Cholesterol 那篇的 50% 門檻），預設維持保守，不動。

── 9. 觀察哨與回滾 ─────────────────────────────────────────────────────

  grep '\[TEXTMETA\]' data/app.log     每篇一行：切了沒／為什麼沒切／幾頁／壞哪幾頁
  grep 'refs_cut=false' data/app.log   有沒有論文切不掉（low_density 是預期內的保守）
  grep '論文太長' data/app.log          ctx_overflow 真的發生時的樣子

旋鈕（改 .env 重啟即生效；每次呼叫都重讀 env）：

  PAPER_FULLTEXT_LIMIT_CHARS  預設 250000  窗口小的線調低；clamp [20000, 2000000]
  CUT_REFERENCES              預設 true    懷疑切錯就 false（原文本來就沒動，關掉即復原）

整條回滾：git checkout main（分支未合併，生產不受影響）。
單獨回滾參考文獻切除：CUT_REFERENCES=false，不必改代碼。
papers.text_meta 留著也無害（純推導資料，舊代碼不讀它）。

── 10. 給工單 15 的接口 ────────────────────────────────────────────────

  text_meta.bad_pages                     要渲染哪幾頁
  text_meta.pages[].quality === 'rotated' 橫向大表的候選（本工單只標不渲染）
  text_meta.pages[].reasons               'rotated'／'too_short'／'fragmented'／'garbled'

她八篇目前的 bad_pages 全是 too_short（整頁只有圖），正好就是工單 15 該渲染的那一類。

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>


── 附錄 C（Elias 親驗，2026-09-14 14:20）──────────────────────────────

- `npm test` 親跑 294/294（改前 252）；改動 13 檔；與工單 14 分支重疊 4 檔（src/ai.js、src/db.js、PaperDetail.jsx、TECHNICAL_MANUAL.md），合併時由 14 rebase 處理。
- 憲章 diff 只有 `+` 第 8 條「讀不到就說讀不到」，既有條文未動；品質提示函式只在有壞頁時回非空（穩定前綴零回歸）。
- 親手對她 DB 唯讀副本跑 `locateReferencesBlock`：
  - Immunity（`1XLeFe…`）：start 88,072「REFERENCES\n1. Geissmann…」→ end 117,274 落在最後一條文獻「Codo et al.」行尾，之後「Page 32 … Author Manuscript」與圖注、KEY RESOURCES TABLE 保留 ✓（尾端密度回退是對的）。
  - Cholesterol（Nature 版式）：主文獻表在 40.6%，被工單 §3.2「≥50%」門檻擋掉，只切到 70% 的 840 字補充文獻。**這是我定的規則的保守面，不是實作錯**；後續可放寬為「≥35% 且區塊終點是章節標題（Methods／Acknowledgements）且密度達標」。
- 真上游 smoke：未做（使用者禁止）。
