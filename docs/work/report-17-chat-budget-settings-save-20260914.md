════════════════════════════════════════════════════════════════════════
報告 17：討論線輸出預算被思考鏈吃光（空氣泡）＋設定頁進階區塊儲存失靈
════════════════════════════════════════════════════════════════════════

日期：2026-09-14
上位文件：docs/work/workorder-17-chat-budget-settings-save-20260914.md（設計已定案）
　　　　　docs/work/workorder-12-／report-12-chat-stream-resilience-20260914.md
　　　　　（[CHAT] 日誌＝抓到這顆病的眼睛）
　　　　　記憶 coreading-analyze-opencode-fix-20260909（9/9 通讀線同型修法，本單沿用其詞彙）
Repo：~/research-stack/co-reading（worktree）；Base：main @ cd4c678
分支：fix/chat-budget-settings-save（3 顆 commit ＋ 本顆報告，未 push、未合併、未部署）
測試：npm test 366/366（改動前 332/332，新增 34）；git diff --check 乾淨；
　　　npm run build 通過（305 modules，dist/ 未 commit）

── 1. 一句話 ───────────────────────────────────────────────────────────

兩顆都是「她做了對的事，系統靜靜把它吃掉」：討論線的輸出預算被推理模型的思考鏈燒光，
正文 0 字卻被當成功寫進 DB（空氣泡）；設定頁的進階值只在摺疊區展開時才寫得進去，
收起來按儲存就被 preset 蓋回（她的視覺模式 off 就是這樣變回 on 的）。
現在：預算 8192、燒光就用兩倍重打一次、兩發都空才報一句能照做的話，而且**空正文
永遠不進 DB**；進階設定有自己的開關（持久化）與自己的儲存鈕，摺疊只是版面。

── 2. commit 清單 ──────────────────────────────────────────────────────

  cdd1b1c  fix(chat): CHAT_MAX_TOKENS 8192 ＋空正文守門＋預算被思考吃光時兩倍重打一次
  ee43467  fix(chat): 路由永遠不把空正文寫成 assistant（含「重新生成」不被 0 字洗掉）＋ 16 顆釘子
  cf4e870  fix(settings): 進階區塊自己的儲存鈕＋持久化 advancedEnabled 取代摺疊狀態（18 顆釘子）
  （本顆）  docs(work): 報告 17

釘子沒有獨立成第四顆：ai.js 那層與路由那層的釘子住在同一個檔（同一組 mock 上游），
硬拆會出現一顆「釘子紅著」的中間 commit。改成跟著各自的階段進來（見 §8-①）。

── 3. changed files（相對 base cd4c678）────────────────────────────────

  src/ai.js                            +117  CHAT_MAX_TOKENS_CEILING／resolveChatMaxTokens()；
                                             ChatEmptyOutputError（extends StreamInterruptedError,
                                             kind='output'）；isBudgetExhausted()；
                                             chatAboutPaper 的空正文守門＋預算重打＋
                                             [CHAT] ok/fail 多印 max_tokens／reasoning_chars
  src/routes/chat.js                   +40   runChatStream 成功路徑加空正文守門（不回 ok）；
                                             chatErrorHint()＋BUDGET_HINT；空正文一律 partial=0
  src/server.js                        +3    PUT /api/settings 白名單加 advanced_enabled
  frontend/src/store.js                +96   advancedEnabled（localStorage 持久化）＋
                                             setAdvancedEnabled；buildSettingsPayload()；
                                             inferAdvancedEnabled()；publicSettingsSummary()；
                                             ADVANCED_ENABLED_KEY
  frontend/src/pages/Settings.jsx      +125  進階區塊：頂部「使用進階設定」開關、底部
                                             「儲存進階設定」鈕、標題旁「已啟用／未啟用」小標；
                                             saveSettings 改用 buildSettingsPayload；
                                             載入時 inferAdvancedEnabled(後端)；儲存後回讀並
                                             console.info（濾密鑰）；handleTest 同步改用
                                             advancedEnabled；儲存失敗不再假裝成功
  .env.example                         +15   新增「討論線（工單 12／17）」一節
  test/chat-output-budget.test.js      新檔  16 顆
  test/settings-advanced-save.test.js  新檔  18 顆

── 4. 明確沒改什麼 ─────────────────────────────────────────────────────

- 通讀線：analyzePaper／ANALYZE_MAX_TOKENS／resolveAnalyze*／completionMeta／
  extractAnalyzeJson／describeAnalyzeError 一字未動；analyze-*.test.js 全綠。
- 工單 12 的語意：CHAT_IDLE_TIMEOUT_MS 45s、CHAT_RETRIES 1、「已吐過正文就不重試」、
  thinking 節流、中止不寫 DB——全部照舊（唯一調整見 §8-⑤）。
- 穩定前綴：buildChatSystem／論文區塊／變動區的組法與順序一字未動，送出的 body 除了
  `max_tokens` 的數值以外逐字相同。
- preset 的值：`opencode_go.vision_mode:'on'` 等五組 provider 預設一個字沒改（§3 紅線），
  只是不再於「摺疊區關著」時偷偷寫回去。
- 工單 16 的區域：src/pdf.js、papers.js 的 text_meta、test/fulltext-limit-quality.test.js
  一行沒碰。data/、.env、release/、dist/ 沒動（dist/ 有 build 但不 commit）。
- 既有那幾列 0 字的 assistant：**不做資料修復**（工單 §2.1 明定）。她按「重新生成」
  就會覆蓋成新版本；若最後一條是 0 字 assistant，走的是正常 regen 路徑。

── 5. 兩顆病的根因與修法 ──────────────────────────────────────────────

§2.1 空氣泡
  根因：`chatAboutPaper` 的 `max_tokens: 4096` 是寫死的；deepseek-v4-flash 的思考鏈與正文
  共用同一個 completion 預算，9/14 15:17 那發思考 12,133 字（≈4,096 token）把預算用完，
  `finish_reason=length`、content 空字串，而函式照樣 return ''，路由照樣 INSERT。
  修法（全部沿用 9/9 通讀線的詞彙，沒有另造一套）：
    · 預算 4096 → `CHAT_MAX_TOKENS`（預設 8192，clamp [1024, 32768]，每次呼叫重讀 env）
    · 空正文守門：`fullResponse.trim()===''` 就不是成功
    · 預算真的燒完（finish=length／max_tokens，或 usage 的 completion 頂到預算）⇒
      **兩倍預算重打一次**（上限 32768、只一次、log `reason=budget`）
    · 仍空／或根本不是預算問題 ⇒ 丟 `kind='output'`，不進連線類重試名單
    · 路由永遠不 INSERT 空正文；「重新生成」也絕不用 0 字 UPDATE 掉舊答案
  兩顆計數器：連線類重試（工單 12）與預算重打各自上限 1、互不吃額度，最壞 3 發。

§2.2 進階設定存不進去
  根因：`saveSettings` 拿**摺疊狀態** `advancedOpen` 當「要不要寫進階值」的判斷，
  摺疊區沒展開時 analyze_api_key／base_url／model／format／vision_model／vision_mode
  六個欄位一律用 preset 預設覆蓋；而唯一的「儲存」鈕在進階區塊**之上**。
  修法：`advancedEnabled`（localStorage ＋ 後端 `advanced_enabled`）與 `advancedOpen`
  （純版面）分家；進階區塊內加開關與儲存鈕；payload 組裝抽成純函式；視覺模式寫她選的值；
  第一次載入用 `inferAdvancedEnabled` 推定（後端有鍵聽後端，沒鍵就看兩條線是否真的不同）。

── 6. 驗證 ────────────────────────────────────────────────────────────

targeted：
  node --test test/chat-output-budget.test.js        16/16
  node --test test/settings-advanced-save.test.js    18/18
full：
  npm test                                           366/366（改動前 332/332）
  npm run build                                      305 modules、595ms、通過
  git diff --check                                   乾淨

自驗 ①：真 server（PORT=3457、臨時 CO_READING_DATA_DIR、本機假上游，**沒碰她的 :3456**）
  PASS  設定 round-trip：advanced_enabled=true 存得進去（vision_mode=off 同時存活）
  PASS  兩發都空：收到 error 而不是空氣泡
  PASS  兩發都空：partial=0 且 hint 說得出下一步
  PASS  兩發都空：DB 沒有 0 字 assistant（只剩孤兒 user）
  PASS  兩發都空：第二發預算是第一發的兩倍（[8192, 16384]）
  PASS  預算重打後成功：有 done、沒有 error
  PASS  預算重打後成功：assistant 完整落庫
  PASS  重新生成撞空正文：舊答案原封不動
  PASS  重新生成撞空正文：hint 不謊稱「你的問題已保存」
  日誌長這樣（就是她下次要 grep 的形狀）：
    [CHAT] retry 1/1 paper=… reason=budget max_tokens=8192→16384 reasoning_chars=12 finish=length
    [CHAT] fail  paper=… kind=output chars_out=0 reasoning_chars=40 max_tokens=16384 finish=length
    [CHAT] ok    paper=… chars_out=14 … finish=未提供 max_tokens=16384

自驗 ②：瀏覽器實彈（同一個 3457 server 直接 serve dist/，臨時 data dir；她的資料沒被碰到）
  · 後端故意只給「analyze_model≠ai_model、沒有 advanced_enabled」的舊資料 ⇒ 進來就顯示
    「已啟用」（推定生效，沒把她既有的分開設定當成沒開）
  · 進階區填好兩條線、圖表／識圖選「關閉（純文字）」→ 按**進階區塊內**的「儲存進階設定」
    ⇒ 後端 analyze_vision_mode=off、advanced_enabled=true、analyze_model=deepseek-v4-pro
  · 🔴 關鍵回歸：把進階區**收起來**、再按最上面那顆「儲存」⇒ vision_mode 仍然是 off
    （舊版這一步會寫回 preset——就是她 13:40 踩到的那條路）
  · 取消勾選「使用進階設定」再儲存 ⇒ 全部回 preset、advanced_enabled=false；
    重新整理後標題旁顯示「未啟用」（持久化生效）
  · console 只有一行 `[settings] saved {…}`，裡面沒有任何 key／token

真實 smoke（打真上游）：**未做，使用者禁止**（§3 紅線）。全程 mock／本機假上游。

── 7. 觀察哨與回滾 ────────────────────────────────────────────────────

  觀察哨  grep 'reason=budget' data/app.log      預算真的常被吃光？調高 CHAT_MAX_TOKENS
  　　　　grep 'kind=output'   data/app.log      兩發都空的次數（＝她會看到錯誤的次數）
  旋鈕    CHAT_MAX_TOKENS=16384                  一次到位，不想每次被重打拖 20 秒就調它
  回滾    git revert cf4e870 ee43467 cdd1b1c     三顆互相獨立；只回滾 cf4e870 ＝ 前端回舊行為
  　　　　（沒有 .bak、沒有資料 migration——這一單一列資料都沒改）

── 8. 偏離工單之處（逐條）─────────────────────────────────────────────

① 交付節奏：工單 §5 寫「2.1 後端／2.1 路由／2.2 前端／測試」四顆，實作成三顆——
   釘子跟著各自的階段進來（理由見 §2）。每顆 commit message 都帶當下的測試數字。
② `.env.example` 補了一節（工單沒點名）。理由：錯誤訊息叫她「在 .env 調高
   CHAT_MAX_TOKENS」，而 .env.example 裡連討論線這一區都不存在，她會找不到。
   順手把工單 12 的三顆旋鈕也一併寫進註解。她的 .env 一個字沒動。
③ hint 文案比工單長一點：工單寫「按『重新生成』會用調高後的預算再試」，實作成
   「調高 .env 的 CHAT_MAX_TOKENS 或改用非推理模型後，按『重新生成』會用新的預算再試」，
   而且只有「這一輪真的寫了 user 訊息」的入口才加前綴「你的問題已保存——」。
   理由：重新生成／繼續沒有新寫 user 訊息，照抄原 hint 會對她說謊。
④ `inferAdvancedEnabled` 的「不同」判準收緊成「**兩邊都填了**而且不同」。
   理由：關著進階存檔時 analyze_vision_model 會被寫成 preset 的值（非空），
   若把「一邊空一邊有值」也算差異，關過進階的機器下次進來會被誤判成開著。
⑤ 「已吐過正文就不重試」的判斷從 `fullResponse.length > 0` 改成 `trim().length > 0`。
   理由：只有空白字元的回覆就是空正文那一型，partial 必須報 0，否則前端會去「保住半截」
   一團空白。對真正吐過字的那條路行為不變（工單 12 的釘子全綠）。
⑥ 另外動了兩處工單沒點名的小地方：`handleTest` 也從 advancedOpen 改成 advancedEnabled
   （否則收起摺疊區時「測試連接」測的是 preset，不是她真正在用的線）；儲存失敗時不再
   顯示「✓ 設定已儲存」，改顯示「✕ 儲存失敗：…」。
⑦ 本分支沒有 rebase 到最新的 main：我開工後工單 16 已合入（main 6fea354，349/349）。
   `git merge-tree main HEAD` 試合**無衝突**；合併後總數應為 383 上下（349 ＋ 34）。
⑧ 報告沒能落成 docs/work/report-17-*.md：harness 擋下 subagent 寫報告類 .md。
   全文即本 commit message（工單 §5 的備案）。

── 9. needs-decision ──────────────────────────────────────────────────

無。三個設計點（8192／兩倍重打一次／advancedEnabled）工單已定案，實作照做。
唯一可選項：要不要把 `CHAT_MAX_TOKENS` 直接設成 16384 省掉第一次重打的等待——
建議先觀察 `reason=budget` 的頻率再決定，不必現在拍。

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>


── 附錄 C（Elias 親驗，2026-09-14 16:10）──────────────────────────────

- `npm test` 親跑 366/366（改前 332）；`npm run build` 親跑通過；改動 8 檔，未碰工單 16 區域。
- 後端真 socket 實彈（假上游，完整 `POST /api/papers/:id/chat`）：
  - 第一發 reasoning-only、finish=length、正文空 → 自動用 16,384 重打（上游看到 max_tokens [8192,16384]）→ 第二發正文入庫 ✓
  - 兩發都空 → `error`「模型把輸出預算全花在思考上（思考 50 字、正文 0 字，預算 16,384 token）…」partial=0，DB 無 assistant ✓
  - finish=stop 正文空 → 1 次、`error`「模型回了空正文（finish=stop…）」，DB 無 assistant ✓
- 瀏覽器親手（worktree build，:3457，臨時 DB）：選 OpenCode Go（preset vision_mode='on'）→ 展開進階 → 勾「使用進階設定」→ 視覺改 off → **收起進階區** → 按最上面那顆「儲存」→ 狀態「設定已儲存」→ DB `analyze_vision_mode=off`、`advanced_enabled=true`（舊代碼這一步會寫回 on）✓
- 真上游 smoke：未做（使用者禁止）。
