════════════════════════════════════════════════════════════════════════
報告 12：討論線串流韌性——[CHAT] 日誌、看得見的思考、前端三件、閒置逾時
════════════════════════════════════════════════════════════════════════

日期：2026-09-14
上位文件：docs/work/workorder-12-chat-stream-resilience-20260914.md（設計已定案）
　　　　　docs/work/report-11-chat-latency-diagnosis-20260914.md（診斷數字）
Repo：~/research-stack/co-reading（worktree）；Base：main @ 905e330
分支：fix/chat-stream-resilience（6 顆 commit，未 push、未合併、未部署）
測試：npm test 252/252（改動前 228/228，新增 24）；git diff --check 乾淨；
　　　npm run build 通過（303 modules，dist/ 未 commit）

── 1. 一句話 ───────────────────────────────────────────────────────────

討論線從「裸的」變成「有錶、有閘、有煞車」：45 秒閒置逾時＋首字前自動重試一次把
無界停滯砍掉；[CHAT] 日誌讓「又慢了」第一次變成可查；等待期的三個點換成
「正在思考…（已想 8 秒 · 420 字）」；失敗／中止不再抹掉已經上屏的半截。
四件全做完（A／B／C-便宜版／H），加順手的 §3.5 全文截斷提示。通讀線一個字沒動。

── 2. commit 清單 ──────────────────────────────────────────────────────

  8f54f27  feat(chat): A＋B——[CHAT] 日誌、串流 stats、閒置逾時 45s＋首字前才重試
  df6e48a  feat(chat): C＋H 後端半——thinking SSE、中止即收上游、error 帶 partial/hint、重新生成放寬
  bb7add0  feat(chat): H 前端三件——看得見的等待、停止按鈕、失敗不抹半截
  0a8cbfb  feat(papers): §3.5 全文截斷提示
  c1a7fc5  test(chat): 工單 12 §5 的 24 顆釘子——全 mock 上游，228 → 252
  （本顆）  docs(work): 報告 12

A 與 B 合成一顆：兩者都落在 chatAboutPaper 同一圈重試迴圈裡，硬拆會出現一顆
「日誌印了但沒有東西可印」的中間態。

── 3. changed files ────────────────────────────────────────────────────

  src/ai.js                              +344  buildBody 的 streamUsage；ChatAbortedError；
                                               makeRequest 外部 signal；sseEvents stats 多回填
                                               maxGapMs/firstByteAt；stream* 收 opts；三顆
                                               resolveChat*；describeChatError；chatAboutPaper
                                               重試迴圈＋[CHAT] 日誌；PAPER_FULLTEXT_LIMIT
  src/routes/chat.js                           三入口串流段收攏成 runChatStream；thinking SSE；
                                               AbortController；error 帶 partial/hint；
                                               regenerate 400 分支放寬；runContinue 抽出
  src/routes/papers.js                         GET /:id 多回 full_text_chars /
                                               full_text_truncated / full_text_limit
  frontend/src/api.js                          readSSEStream 認 thinking/thinking_done；
                                               onError(msg, data)；三個 stream 函式收 signal
  frontend/src/store.js                        新增純函式 thinkingLabel()＋THINKING_LABEL_DELAY_MS
  frontend/src/components/ChatPanel.jsx        runStream 共用殼、等待提示、停止按鈕、
                                               失敗不抹半截、卸載時 abort
  frontend/src/pages/PaperDetail.jsx           摘要頁上方的截斷提示一行
  test/chat-stream-resilience.test.js     新檔  24 顆釘子

── 4. 明確沒改什麼 ─────────────────────────────────────────────────────

- 通讀線：analyzePaper／collectStream／resolveAnalyzeIdleTimeoutMs／
  isRetryableAnalyzeError 的行為與參數一字未改。describeAnalyzeError 的**輸出**一字未改
  （內部改成呼叫共用的 describeUpstreamError('通讀模型')）。test/analyze-*.test.js 全綠，
  含那條「聊天線不傳 options ＝ 舊路徑」。
- buildBody 對其他三條線：通讀／提取（memory.js）／對比（compare.js）送出的 body 逐字不變
  ——stream_options 只在呼叫端顯式傳 streamUsage 時才出現，另有一顆測試釘死。
- 截斷邏輯：100,000 字上限、[全文已截斷] 標記、> 的邊界，全部原樣；只是把魔術數字提成常數。
- D（論文瘦身）與 E（歷史裁剪）：沒做（報告 11 已證明不提速）。
- prompt／憲章／人格：沒碰。reasoning 沒有任何一條路徑通往 messages.content、DB 或下一輪
  prompt（測試釘了三處：正文、SSE 事件欄位、DB 內容）。
- sseEvents 之外的傳輸層：沒重構。sseEvents 只加了兩個回填欄位。
- 沒 push、沒 build 安裝包、沒動 data/／.env／release/／dist/、沒打真上游。

── 5. 測試數字 ─────────────────────────────────────────────────────────

  test/chat-stream-resilience.test.js（targeted）   24/24
  npm test（full）                                  252/252，0 fail（改動前 228/228）
  npm run build                                     通過，303 modules；dist/ 未 commit
  git diff --check                                  乾淨

真實 smoke：未做，使用者禁止打真上游。
替代驗證是一支在 scratchpad 的活體腳本（PORT=3457 ＋ 臨時 CO_READING_DATA_DIR ＋
本機假上游，不進 repo、不碰她的 :3456）：

  [CHAT] start paper=smoke1 model=deepseek-v4-flash sys_chars=101066 hist=0條 scope=paper:smoke1
  [UPSTREAM] stream_options = {"include_usage":true}
  [SSE] {"type":"thinking","chars":3}
  [SSE] {"type":"thinking","chars":18}
  [SSE] {"type":"thinking_done","chars":24,"seconds":1}
  [CHAT] ok paper=smoke1 ttfb=0.0s ttft=1.0s elapsed=1.2s chunks=24 chars_out=15
         reasoning_chars=24 max_gap=122ms finish=stop cache_hit=26624/26853
         usage={"prompt_tokens":26853,"completion_tokens":41,
                "prompt_tokens_details":{"cached_tokens":26624}}
  [SSE] 事件計數 {"thinking":2,"thinking_done":1,"delta":15,"done":1}
  [PAPER] truncated=true chars=146272 limit=100000

cache_hit=26624/26853 就是工單 §5.6 要的形狀；8 顆 reasoning chunk 約 1 秒只放行
2 發 thinking（節流生效）。

── 6. 觀察哨與回滾 ─────────────────────────────────────────────────────

  grep '\[CHAT\]' data/app.log          起止各一行；失敗看 kind= 與 max_gap=
  grep '\[CHAT\] retry' data/app.log    有沒有在自動重試（＝上游在停滯）
  grep '\[CHAT\] fail' data/app.log     kind=idle 就是 45s 停滯，kind=timeout 是撞滿 300s

旋鈕（全部熱插拔，改 .env 重啟即生效；每次呼叫都重讀 env）：

  CHAT_IDLE_TIMEOUT_MS   預設 45000   誤殺就調大（clamp [5s, 天花板]；0／非數字退回預設）
  CHAT_RETRIES           預設 1       0 ＝完全不重試
  CHAT_STREAM_USAGE      預設 開      false ⇒ body 不送 stream_options，cache_hit=none

整條回滾：git checkout main（分支未合併，生產不受影響）。

── 7. 附錄 A：工單 §3.2 那個二選一——選了「放寬」────────────────────────

工單留給實作者：routes/chat.js L48–51 的 400（「最後一條不是 AI 回覆，請改用『繼續』」）
是放寬還是只改 hint 文案。選了放寬（工單推薦的那個），但加了一道邊界：

- 最後一條是 user、**而且**前面存在過 assistant ⇒ 這是孤兒 user 尾巴（上一輪串流失敗／
  被中止留下的），「重新生成」直接等價於「繼續」：接在後面生成一條新的 assistant，
  **不覆蓋**舊的那條回答。
- 完全沒有 AI 回覆過的那種仍然回 400（訊息不變）。那不是孤兒尾巴，是這篇論文還沒開始討論，
  放寬它等於讓「重新生成」變成另一顆「送出」，語意會糊掉。既有測試
  （test/chat.test.js「returns 400 when no AI messages exist」）也釘著這條。

理由：她失敗之後手上有兩顆按鈕，讓她自己看懂一句 400 再去換一顆，是多一步。
error 事件的 hint 因此寫成「你的問題已保存——按『重新生成』或『繼續』都能讓 AI 接著回答」
（兩條路現在都通）。

── 8. 附錄 B：偏離工單之處（逐條）──────────────────────────────────────

1. stream_options 的預設方向。工單 §3.1 寫「buildBody openai 分支加 stream_options，
   CHAT_STREAM_USAGE=false 可關（預設開）」。照字面做會讓通讀／提取／對比三條線的 body
   一起變——與 §4 紅線「通讀線行為不變」衝突。實作改成 buildBody 新增 streamUsage 參數
   （預設不送），由 chatAboutPaper 依 resolveChatStreamUsage() 顯式打開。
   對討論線而言行為與工單一致（預設開、env 可關），對其他三條線是零改動。
2. A 與 B 合成一顆 commit（理由見 §2）。其餘四階段照工單 §6 分。
3. runChatStream / runContinue 抽出。工單沒要求，但三個入口（送出／重新生成／繼續）原本是
   三份幾乎相同的串流段；C 與 H② 要在三處都生效，不抽就是三份各改一遍。抽出範圍嚴格限定在
   routes/chat.js 的串流段，DB 寫入邏輯留在各自入口。同理前端的 runStream。
4. 新增 ChatAbortedError。工單 §3.4② 只說「req.on('close') 要能中止上游」，沒指定錯誤形狀。
   底層 abort 與逾時長得一樣（都是 AbortError），不分家會讓她按「停止」之後看到一句
   「AI 請求超時」紅框。新增這顆型別把「取消」與「故障」分開：不重試、不寫 DB、不印紅框，
   只留半截標「（已停止，未保存）」。
5. thinkingLabel 放在 frontend/src/store.js，不是 ChatPanel.jsx。JSX 進不了 node:test，
   放 store 才釘得死（test/compare-frontend.test.js 同一個先例）。
6. res.on('close') 不是 req.on('close')（工單 §3.4② 的字面）。實作踩過：Express 讀完 body
   之後 req 立刻 'close'（Node ≥16 的 IncomingMessage 語意），掛在那邊會在打上游**之前**
   就把自己 abort 掉——test/constitution.test.js 與 test/directions-injection.test.js
   兩支 live 測試當場抓到 captured.length = 0。這一條值得記進手冊：
   **Express 裡偵測「客戶端跑了」一律掛 res，不掛 req。**
7. PAPER_FULLTEXT_LIMIT 常數。工單 §3.5 只說路由回旗標；直接在路由裡再寫一個 100000
   會與 buildPaperBlock 各自漂移，所以提成常數共用。截斷行為零改動。
8. worktree base 是 cca8041 不是 905e330（建 worktree 時的 ref 較舊），實作完成後
   git rebase main 到 905e330，無衝突，rebase 後 252/252 複跑過。
9. 報告寫在 commit message 而不是 docs/work/（harness 拒寫，同報告 11）。

── 9. 交接：她回來要做的 ───────────────────────────────────────────────

1. 親手在 :3456 打一發真的（她的 dev server／真上游），看三件事：等待期有沒有出現
   「正在思考…（已想 N 秒 · M 字）」、data/app.log 有沒有 [CHAT] ok 那行、
   cache_hit 是不是像診斷那樣 99% 左右。
2. 故意在串流中途按「停止」，確認半截留著標「（已停止，未保存）」、討論沒有多出一條 assistant。
3. 一週觀察哨：grep '\[CHAT\] retry' data/app.log。如果幾乎天天有，代表 OpenCode Go 的停滯
   比診斷那天更頻繁，下一刀該往「換上游／中轉站」而不是繼續調閾值；一週零次就不用動閾值。
4. 45s 有沒有誤殺長思考：看 [CHAT] fail … kind=idle 而 reasoning_chars 還在長的那種。
   有的話把 env 調到 90000 即可，不用改代碼。

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>


── 附錄 C（Elias 親驗，2026-09-14 13:05）──────────────────────────────

- `npm test` 親跑：252/252，0 fail（改前 228）。`npm run build` 親跑通過（dist/ 未 commit）。
- 紅線點名：`git diff main..HEAD --name-only` 只有 8 檔（src/ai.js、src/routes/chat.js、src/routes/papers.js、frontend/src/{api.js,store.js,components/ChatPanel.jsx,pages/PaperDetail.jsx}、test/chat-stream-resilience.test.js）；未動 data/、.env、dist/、通讀線測試全綠。
- 抽查：reasoning 只累計 `reasoningChars`，SSE `thinking` 只帶字數；assistant INSERT 只寫 `fullContent`（正文 delta）⇒ 思考內容不進 DB／messages。中止監聽掛 `res.on('close')` → AbortController → `combineSignals`。重試門檻 `fullResponse.length > 0` 就不重試。
- 真 socket 實彈（本機假上游，走完整 `POST /api/papers/:id/chat` 路由，PORT=3457、臨時 data dir，`CHAT_IDLE_TIMEOUT_MS=5000`）：
  - 先停滯後成功：5.0s idle → `[CHAT] retry 1/1` → 第二發成功；前端收到 thinking(1) thinking(3) thinking_done delta done；DB 存到 assistant。
  - 吐正文後停滯：不重試（attempts=1），`error` 事件帶繁體訊息、`partial=2`、hint；DB 無 assistant 列。
  - 客戶端中止：上游 `req.on('close')` 觸發＝真的收線；log「討論中止: 已生成 2 字，未保存」。
- 小瑕疵（不擋合入）：idle 觸發時 `[CHAT] fail … max_gap=0ms`——停滯那一段沒算進 max_gap，讀日誌時以 kind=idle 為準。
- 真上游 smoke：未做（使用者禁止）；觀察哨 `grep '\[CHAT\]' data/app.log`。
