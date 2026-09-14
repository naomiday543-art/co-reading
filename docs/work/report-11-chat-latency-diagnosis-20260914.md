diag(chat): 報告 11——討論頁提問後回覆為什麼慢（診斷，未修）

註：本報告原本要落在 docs/work/report-11-chat-latency-diagnosis-20260914.md，
harness 拒絕 subagent 寫報告檔，依派工指示全文放進 commit message。
本次 commit 只加兩支量測腳本（scripts/diag/），沒有動任何生產代碼。

════════════════════════════════════════════════════════════════════════
報告 11：討論頁提問後回覆為什麼慢——診斷
════════════════════════════════════════════════════════════════════════

日期：2026-09-14
性質：診斷，不是修復。沒有動 main、沒有 push、沒有部署、沒有改生產代碼。
Repo：~/research-stack/co-reading（worktree，base main @ cca8041）
分支：diag/chat-latency
上位文件：工單 10 / 報告 10（docs/work/workorder-10-analyze-stream-stall-20260913.md）
　　　　　那份 §2 非目標明寫「不動聊天線（有逐字 UI，停滯她自己看得到）」。
　　　　　本報告 §8-B 證明那個前提只對了一半，並把它列成需要她拍板的一條。

── 1. 結論（一句話）────────────────────────────────────────────────────

真兇是 OpenCode Go 串流中途的「無界停滯」，加上首字前必有的 10–17 秒推理鏈
被 streamOpenAI 整段丟掉——論文全文那 26k token 不是主因（prompt cache 實測
99.1% 命中，冷熱只差約 5 秒）。

拆開她 9/14 那發 152 秒：

  本地同步工作（FTS/續窗/憲章/方向/歷史）      0.104 ms     ← 實測，可忽略
  上游 TTFB（等標頭）                          2.1 – 10.3 s ← 實測三發
  推理鏈 reasoning_content（畫面上是三個點）    8 – 12 s     ← 實測，production 丟掉
  正文 decode 2,304 字 ÷ 89–94 字/s            ≈ 26 s       ← 實測速率
  ────────────────────────────────────────────────────────
  預期合計                                      ≈ 36 – 48 s
  實際                                          152 s
  缺口                                          ≈ 104 – 116 s ← 串流中途停滯

實彈證據：三發探針裡有一發，在串流中途出現單一 31.2 秒的 chunk 間隔
（max_gap_ms: 31243）。討論線既沒有閒置逾時、也沒有任何計時日誌，所以這種停滯
是無界（最多吃滿 300s）又完全不可見的。這就是 9/13 通讀那顆病，藥只發給了通讀線。

── 2. 三個關鍵數字 ─────────────────────────────────────────────────────

  ① 打上游前的本地同步工作合計 0.104 ms（一輪，20 次平均）——不是這裡慢。
  ② prompt cache 99.1% 命中（cached_tokens 26,624 / prompt_tokens 26,853）
     ——冷前綴 vs 熱前綴的首字差距只有約 5 秒。砍論文區塊省錢，不省時間。
  ③ 串流中途單一停滯 31.2 秒（實測一發），而討論線的閒置逾時＝無，
     總逾時＝300s（src/ai.js:187）。

── 3. Q1：一輪討論的請求有多大 ─────────────────────────────────────────

換算比例（實測，不是估的）

- 通讀那發：chars_in=146,272 → buildAnalyzeUserContent 截到 100,000 字
  （src/ai.js:657）→ prompt_tokens=25,643 ⇒ 3.90 字/token。
- 討論探針：system 102,393 字 + user 20 字 → prompt_tokens=26,853 ⇒ 3.81 字/token。

兩條路互相印證。下面一律用 3.90。

單輪 system 組成（她那篇 146,272 字的 1XLeFeTWvPJO58Tvqyq7g）

  區塊                                   來源                          字數      ≈token
  憲章                                   src/prompts/CONSTITUTION.md      948        243
  論文區塊（含全文，截到 100,000 字）     buildPaperBlock ai.js:818-838 102,052     26,167
  研究方向                               directions.js                    182         47
  洞察（自身 5 條＋跨論文 3 條）          ai.js:875-907                      0          0
  研究續窗                               carryover.js                       0          0
  ────────────────────────────────────────────────────────────────────────────
  system 合計                                                         102,393     26,255

實測 prompt_tokens=26,853（含 user 訊息與 wire overhead），估得很準。
（洞察 0 是因為她這篇還沒提洞察；續窗 0 是因為「帶上」關著且 carryover_cache 表是空的
 ⇒ renderCarryoverForInjection 第一行就 return ''，零外呼。）

全庫八篇的單輪規模（含現有歷史）

  paper                  full_text   system字/tok      歷史         單輪總計
  5oLN2tFeRdZJ9dkg6yKXB    146,545   103,186 / 26,458   0條/    0字   26,458 tok
  1XLeFeTWvPJO58Tvqyq7g    146,272   102,393 / 26,255   2條/2,324字   26,851 tok
  bnzXPgLPGgCb9V7TK_8Gw    126,664   101,887 / 26,125   2條/1,356字   26,473 tok
  lkd5HG0US4vI5M-5C8Qee    100,122   102,260 / 26,221   0條/    0字   26,221 tok
  jGPpnDhRFDqlh8q-Nte1c     95,783    98,084 / 25,150  41條/67,905字  42,561 tok ← 最重
  oHw4mU6IYUQHu-yX5Fs0D     64,930    68,611 / 17,593   0條/    0字   17,593 tok
  2EV2zbm0KuKt7cpL6Ei59     59,615    63,101 / 16,180   6條/4,517字   17,338 tok
  w2jwAudUG6kO5G9jUp6Wm     45,264    47,363 / 12,144   4條/5,286字   13,500 tok

歷史幾輪後會到多少：她最長那篇 41 條（約 20 個來回）＝ 67,905 字 ⇒ +17,411 token，
平均約 870 token／輪。照這個速度：
  論文 26k token 打底 + 10 輪 ≈ 35k ｜ 20 輪 ≈ 43k ｜ 40 輪 ≈ 61k
但這個成長在錢上比看起來便宜得多——見 §5-3：舊歷史跟 system 一樣是穩定前綴，
一樣吃 prompt cache（實測熱前綴下只有最新那一問的 229 token 沒命中）。

副發現（不在題目裡但她應該知道）：她那篇 146,272 字的論文被 buildPaperBlock
（ai.js:819-821）截到 100,000 字，後面 46,272 字 AI 根本沒看到，只在 prompt 裡留
一句 [全文已截斷]。UI 上沒有任何提示。她若問到論文後半段（討論／結論章節），
AI 會拿前半段硬答。

── 4. Q2：時間花在哪 ───────────────────────────────────────────────────

4.1 (a) 打上游前的本地同步工作

量法：把 data/co-reading.db + -wal + -shm 三個一起 cp 到 scratchpad，
CO_READING_DATA_DIR 指到副本再開；原檔全程沒有被開啟寫入。
腳本：scripts/diag/local-timing.mjs（20 次平均）。

  loadConstitution()（每輪讀檔 948 字）             0.026 ms
  buildDirectionsContext()（樹查詢 + 遞迴計數）      0.028 ms
  own insights SELECT (LIMIT 5)                    0.008 ms
  searchInsights() FTS5 trigram                    0.037 ms
  renderCarryoverForInjection()                    0.005 ms
  getHistory() 全量歷史 SELECT                      0.006 ms
  SELECT * FROM papers WHERE id=?（含 146k 字全文）  0.176 ms
  buildPaperBlock()（拼接 + 截斷 → 102,052 字）       0.000 ms
  buildChatSystem()                                0.052 ms
  ────────────────────────────────────────────────────────
  整條「打上游之前」的路徑合計                        0.104 ms

結論：本地同步工作佔一輪 152 秒的 0.00007%。這條線一個字都不用改。

4.2 (b) 上游 TTFT vs 吐字時間

三發真上游探針：

                       TTFB    首個「正文」字   結束     正文字數   最大 chunk 間隔
  ① 熱前綴・短問題     10.26s      16.64s      17.51s      115       0.91s
  ② 冷前綴・長答案      2.68s      14.97s      60.67s    1,361      31.24s ←←←
  ③ 熱前綴・長答案      2.06s      10.02s      27.53s    1,553       0.86s

- TTFB（等標頭）2.1–10.3 秒，跟前綴冷熱無關（冷的那發反而最快）⇒ 這是
  OpenCode Go 的路由／排隊抖動，不是 prefill。
- TTFB → 首個正文字，還要 8–12 秒：這段上游一直在送 reasoning_content
  （實測 164–193 個 chunk、845–1,001 字），但 streamOpenAI（src/ai.js:440-445）
  只 yield delta.content，reasoning 整段被丟掉。畫面上這 8–12 秒＝三個點在跳。
- 正文 decode 速率 89–94 字/秒（③：1,553 ÷ 17.47s = 88.9；
  ②扣掉那顆 31.2s 停滯後 1,361 ÷ 14.42s = 94.4）。很穩。
- ②那顆 31.2 秒的間隔就是病灶：發生在正文吐到一半（14.97s 之後、60.63s 之前），
  上游沒斷線、沒報錯，就是不送字。②的 60.67 秒裡有 51% 是這一顆停滯。

把她 152 秒補完：2,304 字 ÷ 90 ≈ 26 秒 decode，加 TTFB 與推理 ≈ 36–48 秒，
剩下 104–116 秒只能是同型停滯（一顆 31 秒的三四倍，或幾顆疊加）。

── 5. Q3：真上游探針（3 發，全部成功，零 5xx）──────────────────────────

腳本：scripts/diag/upstream-probe.mjs
（讀她 DB 的唯讀副本取設定與論文；不經過 :3456；不寫她任何檔案；
 log 落在 scratchpad probe-{1,2,3}-*.log）

三發都用她的真設定：https://opencode.ai/zen/go/v1 / deepseek-v4-flash /
openai 格式 / x-opencode-session（paper:1XLeFeTWvPJO58Tvqyq7g 派生），
stream:true + stream_options:{include_usage:true}
（production 沒送這顆，所以她的討論線從來拿不到 usage）。

  #  前綴                 prompt_tok  cached_tok  命中率  TTFB   首正文字  結束    正文    reasoning  最大間隔  finish
  ① full 短問題          熱   26,853     26,624   99.1%  10.26s  16.64s  17.51s   115字     440字    0.91s   stop
  ② cold-long 前綴加nonce 冷  26,874          —      0%   2.68s  14.97s  60.67s 1,361字   1,001字   31.24s   stop
  ③ warm-long 同①前綴    熱   26,862     26,624   99.1%   2.06s  10.02s  27.53s 1,553字     845字    0.86s   stop

三件事被這張表釘死：

5-1. prompt cache 本來就在命中，而且命中得很好。①是我第一發打過去的，前綴就已經
     99.1% 熱（她 11:48 那發把它烘起來了，中間隔了十幾分鐘還在）。②我在 system
     最前面塞了一顆 nonce 強制打冷，prompt_tokens_details 回空物件。
     ⇒ OpenCode Go 沒有打掉 DeepSeek 的自動前綴快取，而且原樣回報 cached_tokens。
5-2. 冷 vs 熱在牆鐘上只差約 5 秒（②首字 14.97s vs ③首字 10.02s，同一個長問題）。
     ⇒ 26k token 的 prefill 不是她等 152 秒的原因。砍論文區塊是省錢，不是提速。
5-3. 命中的顆粒度：26,624 = 416 × 64，沒命中的 229 token 就是最新那一問＋尾巴。
     ⇒ 穩定前綴（憲章＋論文＋方向＋舊歷史）整段吃 cache，只有每輪變動的那一小塊是新的。

探針沒打到的：連續兩發完全相同的請求（本來排第二發）——因為第一發回來就已經
99.1% 命中，那個問題當場被回答了，第二發改成更有價值的「冷前綴對照」。

── 6. Q4：前端有沒有「看起來慢」的成分 ─────────────────────────────────

delta 是逐字上屏的（不是攢到 done 才畫）：
ChatPanel.jsx:86 onDelta: (chunk) => setStreamingContent(prev => prev + chunk)，
ChatPanel.jsx:439-443 每次 state 變動就重跑 ReactMarkdown。這條沒有問題。

有「思考中」狀態，但它是三個沒有文字的點（ChatPanel.jsx:445-451，
streamingContent 還是空字串時畫三顆 typing-dot）。問題是：

- 因為 reasoning 被丟掉（§4.2），這三個點正常情況下最短也要跳 10 秒
  （實測首個正文字 10.02s / 14.97s / 16.64s），她那發 152 秒的前段更久。
- 沒有秒數、沒有「正在思考」、沒有 token 數——看起來跟當掉一模一樣。
- 沒有中止按鈕：api.js:117-123 的 fetch 不帶 AbortController，
  readSSEStream（api.js:91-115）也沒有任何逾時。她只能關頁面。
- 失敗時半截答案會被整段抹掉：ChatPanel.jsx:92-97 的 onError 先 setError(msg)
  再 setStreamingContent('')。已經上屏的字全沒了。

── 7. Q5：300s 總逾時對討論線的含義 ────────────────────────────────────

7.1 她若真的等到 300s，會看到什麼

代碼路徑（全部在 main @ cca8041）：

1) src/ai.js:187 REQUEST_TIMEOUT_MS = 300_000；ai.js:202
   signal: AbortSignal.timeout(timeoutMs) 同時蓋住等標頭與讀 body。
2) chatAboutPaper（ai.js:949-955）走 streamOpenAI(response) → ai.js:441
   sseEvents(response)——沒有傳第二個參數。
3) ⇒ ai.js:319 guarded = false ⇒ ai.js:332 chunk = await reader.read()
   在任何 try/catch 之外。
4) ⇒ 300s 打到時丟出的是原生 DOMException，訊息
   「The operation was aborted due to timeout」（英文）。

這就是 9/13 通讀那顆病，一字不差。工單 10 只把藥（StreamTimeoutError /
StreamIdleError / idleTimeoutMs）發給了通讀線；sseEvents 的預設路徑
（＝討論線走的那條）刻意保持原樣，所以討論線的漏洞原封不動還在。

然後：
- routes/chat.js:170-171：log「討論回覆失敗: <id> — The operation was aborted
  due to timeout」，SSE 送 {type:'error', message}。
- api.js:111 → ChatPanel.jsx:92-97：紅框印那句英文，已經上屏的半截答案被清空。
- routes/chat.js:163-166 的 INSERT（assistant 訊息）只在成功路徑 ⇒ 答案不進 DB，全丟。
- 但她的問題在 routes/chat.js:135-137 開串流之前就寫進 DB 了 ⇒ 留下一條孤兒 user
  尾巴 ⇒ 她再按「重新生成」會被 routes/chat.js:48-51 擋成 400「最後一條不是 AI
  回覆，請改用『繼續』」。她得先看懂這句話才救得回來。

7.2 中途 VPN 抖了會看到什麼

分兩種，差別很大：
- 連線真的斷掉（RST／socket hang up——她走 Shadowrocket，長連線被踢是老毛病）：
  reader.read() 立刻 reject（TypeError: terminated / fetch failed）⇒ 走 §7.1 同一條路：
  半截被抹、沒存檔、紅框印一句英文。快，但一樣什麼都不剩。
- 連線沒斷、只是靜默停滯（②那發 31.2 秒的形狀，只是更長）：socket 活著、沒有 byte、
  沒有錯誤 ⇒ 什麼事都不會發生，一路等到 300 秒，然後才走上面那條路。
  這 300 秒裡她看到的是一個不動的半截答案（或三個點）。

⇒ 300s 對討論線的實際含義是：「停滯的代價上限是五分鐘，而且到期時把已經生成的字
全部丟掉」。通讀線在工單 10 之後是 60 秒閒置逾時 + 自動重試一次；討論線還是裸的。

── 8. 修法選項（先給推薦與理由，不替她決定）────────────────────────────

推薦順序：A → C-便宜版 + H → B（需拍板）→ G（她自己試）；D 與 E 建議不做。

理由：現在整條討論線零可觀測——沒有 TTFT、沒有 elapsed、沒有 usage、沒有 cache hit、
沒有 chunk 間隔。我今天這三發探針是繞過她的 server 打的；下一次她說「又慢了」，
日誌裡還是只有兩行「討論消息／討論回覆」。A 先做，後面每一刀才有靶。
C＋H 是體感最大、改動最小、零風險的一組（把「畫面死了 10–17 秒」變成「看得到它在想」）。
B 才是真正砍掉那 100 秒，但它要推翻工單 10 的一條非目標，所以要她拍板。

A. 討論線加 [CHAT] 日誌（推薦，先做）
   省多少：0 秒。但這是唯一能讓「又慢了」變成可查的東西。格式跟工單 10 的
     [ANALYZE] 對齊，觀察哨 grep '\[CHAT\]' data/app.log：
     [CHAT] paper=<id> model=<m> sys_chars=<n> hist=<n>條 ttfb=<s> ttft=<s>
            elapsed=<s> chunks=<n> chars_out=<n> max_gap=<ms> finish=<r> usage={...}
   代價：① streamOpenAI／streamAnthropic（ai.js:432-445）現在只 yield 正文，
     usage 與 reasoning 都丟掉，要改成能回填一個 stats 容器（照 sseEvents 既有的
     stats 參數形狀做，ai.js:311-318 已經有了）；② buildBody（ai.js:162-169）要在
     openai 分支加 stream_options:{include_usage:true}——不是所有供應商都認這顆，
     要能用 env 關掉（她只有 OpenCode Go 一家，實測認）。
   改哪些檔：src/ai.js（buildBody / streamOpenAI / streamAnthropic / chatAboutPaper）、
     test/。前端不動。

B. 討論線加閒置逾時（＋條件式自動重試）（真正砍那 100 秒，需要她拍板）
   省多少：把「無界停滯」壓成有上限。實測一顆 31.2 秒的停滯，她 152 秒那發缺口
     104–116 秒 ⇒ 閾值訂 45 秒的話，最壞情況從 300 秒降到「首字前 ~15s + 45s」。
   代價與風險：
     - 工單 10 §2 非目標明寫「不動聊天線」，理由是「有逐字 UI，停滯她自己看得到」。
       本報告 §4.2/§6 證明那個前提只對了一半：停滯看得到（答案不動），但首字前那
       10–17 秒看不到，而且看得到也沒有上限、沒有救援。這條是推翻它，要她點頭。
     - 閾值不能照抄通讀的 60 秒往下壓太狠：討論線首字前有 8–12 秒在送 reasoning，
       但 reasoning 本身是逐 chunk 送的（實測 raw chunk 最大間隔 0.86–0.91 秒），
       所以 30–45 秒是安全的；env 給她自己調。
     - 自動重試會把已經上屏的半截丟掉重來。保守做法：只在「一個正文字都還沒收到」時
       才重試，已經開始吐字之後只報錯不重試（＋H 保住半截）。
   改哪些檔：src/ai.js（chatAboutPaper 傳 { idleTimeoutMs, totalTimeoutMs, stats }
     給 sseEvents——參數與錯誤型別工單 10 已經寫好了，直接用）、
     src/routes/chat.js（錯誤訊息）、test/。

C. 把 reasoning 變成看得見的東西（體感最大的一刀）
   省多少：0 秒真實耗時，但把「畫面完全靜止 10–17 秒」變成 0–2 秒。
   兩個版本：
     - 便宜版（推薦）：streamOpenAI 多 yield 一種事件，routes/chat.js 送
       {type:'thinking', chars:N}，前端把三個點換成「正在思考…（已想 8 秒 / 420 字）」。
       不顯示思考內容、不進 DB、不進下一輪 prompt，零污染風險。
     - 完整版：把 reasoning_content 逐字送到一個可摺疊的「思考」區。
       紅線：絕不能寫進 messages.content，否則污染歷史與後續 prompt（也會把 cache
       前綴撐大）。
   改哪些檔：便宜版 src/ai.js、src/routes/chat.js、frontend/src/api.js、
     frontend/src/components/ChatPanel.jsx。

D. 論文區塊瘦身（100k → 50k，或「摘要＋按需段落」）——建議不做（為了提速的話）
   省多少：時間幾乎不省。實測 99.1% cache 命中，冷熱只差約 5 秒，而且只影響
     「換論文後的第一發」。省的是錢：cache miss 那一發從 26k → 13k token。
   代價：她那篇 146,272 字已經被截掉 46,272 字了，再砍一半＝AI 只看得到前 1/3。
     「摘要＋按需段落」要做檢索與段落選取，是一個完整工單的量，而且會讓每輪的
     system 都不一樣 ⇒ 把現在 99.1% 的 cache 命中打掉（反效果）。
   改哪些檔：src/ai.js:818-838。
   真正值得做的相關小事：UI 上讓她知道全文被截斷了（現在她完全不知道）。

E. 歷史裁剪——建議不做
   省多少：幾乎不省，時間和錢都是。實測熱前綴下只有 229 token 沒命中；舊歷史跟
     system 一樣落在穩定前綴裡，整段吃 cache。
   代價：一裁就把裁切點之後的前綴全部弄冷（下一輪反而更貴），還丟上下文。
   例外：等她某篇聊到 60k+ token（現在最重的 jGPpnDhRFDqlh8q 是 42.6k）再來談，
     而且那時該做的是摘要式壓縮而不是直接砍。

F. prompt cache：現況已經很好，不用動（這條是回答，不是修法）
   - DeepSeek 端對重複前綴自動命中，OpenCode Go 沒有打掉它，而且原樣回報
     prompt_tokens_details.cached_tokens（實測 ①③ 99.1%）。
   - x-opencode-session 用 paper:<id> 派生（src/opencodeSession.js）是對的——
     同一篇論文的 26k 全文前綴黏在同一個後端節點。
   - 查過但不建議做的一刀：通讀線 scope 是 'analyze'、討論線是 paper:<id>，
     所以剛通讀完的熱前綴給不了討論線。但就算把 scope 對齊也沒用——兩邊的 prompt
     前綴根本不同（通讀把全文放 user content，討論放 system），前綴不同就不會命中。
     列出來是為了讓她知道這條查過了。
   - 唯一真正會冷的時機：換論文第一發、改憲章、改研究方向。都是低頻。

G. 換更快的模型／關掉推理（她自己在設定頁就能試）
   省多少：首字前那 8–12 秒基本上就是 deepseek-v4-flash 的推理鏈（實測每發
     845–1,001 字 reasoning）。換非推理模型或關掉推理，首字可以從 10–17 秒降到
     2–3 秒。但這不影響那 100 秒的停滯（那是傳輸層的病）。
   代價：討論品質。她 9/12 才把討論模型換成 v4-flash，這是她的取捨不是我的。
   改哪些檔：不用改代碼——DB settings.ai_model，設定頁就能改。若要「保留模型但
     關推理」則需在 buildBody 加參數（供應商是否支援未驗）。

H. 前端三件小事（跟 C 一起做，改動最小）
   ① 等待提示帶秒數（ChatPanel.jsx:445-451）；
   ② 加中止按鈕（api.js:117-123 帶 AbortController）；
   ③ 失敗時不要清空半截答案（ChatPanel.jsx:92-97 的 onError 拿掉
      setStreamingContent('')，改成把半截留在畫面上並標「（未完成，未保存）」）。
   附帶：§7.1 那條孤兒 user 尾巴——錯誤文案至少要告訴她「請按『繼續』」，
     否則「重新生成」會被 400 擋住而她不知道為什麼。
   省多少：0 秒，體感大。代價：小。
   改哪些檔：frontend/src/api.js、frontend/src/components/ChatPanel.jsx、
     src/routes/chat.js（錯誤文案）。

── 9. 探針與量測腳本 ───────────────────────────────────────────────────

- scripts/diag/local-timing.mjs —— 本地同步工作計時 + prompt 規模換算。
  只讀 DB 副本，零外呼、零額度。
  用法：CO_READING_DATA_DIR=<副本目錄>/ node scripts/diag/local-timing.mjs [paperId]
- scripts/diag/upstream-probe.mjs —— 真上游探針（full / warm-long / cold-long）。
  會燒她的額度（每發約 27k input token），跑之前先想清楚要量什麼。
  用法：CO_READING_DATA_DIR=<副本目錄>/ node scripts/diag/upstream-probe.mjs <shot> [paperId]
- 本次的 DB 副本與三份原始 log 在 scratchpad
  （dbcopy/、probe-1-full.log、probe-2-cold-long.log、probe-3-warm-long.log），不進 repo。

── 10. 沒做的事（守住診斷邊界）───────────────────────────────────────

- 沒有動 main、沒有 push、沒有部署、沒有改任何生產代碼。
- 沒有寫她的 DB（全程只開 scratchpad 的副本）、沒有寫 data/app.log、
  沒有經過她的 :3456 server（她的 dev server 正在跑，node --watch）。
- 探針只打了 3 發，全部 HTTP 200、零 5xx ⇒ 沒有觸發 OpenCode Go 的 10 分鐘冷卻。

── 11. 附錄：診斷期間她自己又問了一句（12:04:49 → 12:05:04）────────────

  12:04:49 討論消息: oHw4mU6IYUQHu-yX5Fs0D, user (10 字)   ← 該篇第一輪，前綴必冷
  12:05:04 討論回覆: oHw4mU6IYUQHu-yX5Fs0D, assistant (905 字)

15 秒，905 字，system 17,593 token，冷前綴。這一發把結論再釘一次：

- 冷 cache + 17.6k token 的第一輪，15 秒就回來了 ⇒ prompt 大小／冷快取不是病因。
- 15 秒裡有 ~10 秒是 TTFB + reasoning（她只看到三個點），真正吐字約 5 秒。
  ⇒ 就算一切順利，她每問一句都要先盯著三個點十秒；這就是 §8-C 那一刀的價值。
- 同一天、同一設定、同一條線：順的時候 15 秒，撞到停滯就是 152 秒。
  差別不在 prompt，在傳輸層有沒有卡住——而現在沒有任何東西量得到它。

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>


── 附錄 B（Elias 親驗，2026-09-14 12:30）──────────────────────────────

- app.log 親核：11:48:31 → 11:51:03 討論回覆 2,304 字 = 152s；12:04:49 → 12:05:04 討論回覆 905 字 = 15s（冷前綴、另一篇）。與報告一致。
- 三份探針原始 log 親讀（scratchpad probe-{1,2,3}）：TTFB 10.26/2.68/2.06s、首正文字 16.64/14.97/10.02s、max_gap 913/31243/857ms、prompt_tokens 26,853/26,874/26,862。與 §5 表一致。
- 探針腳本 `scripts/diag/upstream-probe.mjs` 從 DB 副本讀 key，未硬編；報告與 log 未印 key。
- 分支 diag/chat-latency 只含 scripts/diag/ 兩個腳本＋本報告；main 未動、她的 data/ 未動。
- 待她拍板：§8-B（討論線閒置逾時，推翻工單 10「不動聊天線」非目標）。我的推薦＝A＋C便宜版＋H＋B（45s、只在首個正文字之前才自動重試）合成一張工單 12。
