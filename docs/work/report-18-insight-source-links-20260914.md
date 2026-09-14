docs(work): 報告 18——洞察來源浮現卡＋自動聯想（436/436；harness 拒寫 .md，報告放這裡）

工單 18 §5 要求報告落 `docs/work/report-18-insight-source-links-20260914.md`；這次的
harness 禁止 subagent 寫報告檔，照工單「harness 拒寫就放最後 commit message」辦。

分支 feat/insight-source-links（base main @ b5b5278）。npm test 383 → 436 全綠，
npm run build 過。未 push、未部署。

═══ 一、她 15 條洞察在唯讀副本上的結果（§2 B1 驗收基準）═══

三檔一起 cp（co-reading.db ＋ -wal ＋ -shm）到臨時目錄跑，沒有寫回 data/。
副本裡實際 15 條（工單寫 14，9/14 之後她又多存一條），訊息 65 則。

── 1.1 連線結果表（relink-all，門檻 0.35、每條上限 5）──

| 洞察 | 連到 | 分數 |
|---|---|---|
| #10 高胆固醇环境下，蛋白冠中载脂蛋白富集、补体蛋白减少，作者认为这并非矛盾… | #6 高胆固醇环境下，蛋白冠中载脂蛋白富集、补体蛋白减少，导致免疫激活路径从补体依赖转… | 0.622 |
| #9 载脂蛋白负责运输脂类，促进纳米颗粒被肝细胞摄取；补体蛋白是先天免疫系… | #5 载脂蛋白负责运输脂类，促进细胞（尤其是肝细胞）摄取纳米颗粒；补体蛋白是先天免疫系… | 0.580 |

總共就這兩條，其餘 13 條一條連線都沒有。

── 1.2 這是不是工單說的那兩對？是 ──

工單 §2 B1 要「工單 08 的 #4↔#8、#5↔#9 應在最高分」。工單 08 那組編號是 13 條時排的，
今天 15 條編號往後挪。用工單 08 同一把尺（src/dedup.js 的 bigram-Jaccard）在副本上
重算全部 105 組配對驗明正身：

| 今天的編號 | bigram-Jaccard | 工單 08 記的值 |
|---|---|---|
| #5 ↔ #9  | 0.737 | 0.74（當時叫 #4↔#8） |
| #6 ↔ #10 | 0.574 | 0.57（當時叫 #5↔#9） |
| #2 ↔ #6  | 0.453 | 「其餘兩兩 <0.45」 |
| #2 ↔ #10 | 0.427 | 同上 |
| 其餘全部  | <0.28 | 同上 |

數字對得上（0.737/0.574 ↔ 0.74/0.57）⇒ FTS 連上的正是工單 08 那兩對，而且是唯二。

── 1.3 門檻站得對不對 ──

不設門檻時分數前三名是 0.622、0.580、然後直接掉到 #2↔#10 的 0.291。0.35 正好落在
0.29 與 0.58 中間那道空谷裡，不是勉強卡住。#2↔#10 的 Jaccard 也只有 0.427，屬於
工單 08 說的「同主題不同陳述」，本來就不該算同一個想法。

── 1.4 回填筆數（backfill-sources）──

{"scanned":4, "filled":4, "ambiguous":0, "missed":0}   ← 4 筆全中（工單預期「最多 4 條」）

| 洞察 | 回填到的訊息 | seq | 開頭 |
|---|---|---|---|
| #1  | TDE69VnE3CY8pphcTpG5m | 2 | 您好！这是一个非常好的问题。您敏锐地抓住了这项研究的核心发现之一… |
| #2  | _lVqoa3VCdXi-t5zC-fRR | 8 | 这是一个非常关键的问题，理解这两种蛋白质的区别… |
| #6  | _lVqoa3VCdXi-t5zC-fRR | 8 | （同上——這三條洞察確實出自同一則回覆） |
| #10 | _lVqoa3VCdXi-t5zC-fRR | 8 | （同上） |

其餘 11 條 source_context 是空的，不在候選集裡（§3：只在唯一命中時寫，絕不猜）。

⚠ 實作時發現的坑：她那 4 條的 source_context 全部帶提取線加的 `[assistant] ` 角色標記，
拿原字串當探針比訊息原文會永遠撲空（回填 0 筆）。所以 backfillProbe() 先剝標記、
取第一段前 60 字再比。

── 1.5 冪等複跑 ──

relink-all 兩次一致: true ／ backfill 第二次 filled = 0

═══ 二、做了什麼（照工單 §2 編號）═══

A1（0502e2e）insights.source_message_id TEXT DEFAULT ''，冪等 migration。刻意不是外鍵：
訊息會因編輯／重生被截掉，洞察是長期資產不該跟著消失，讀不到就退回 source_context。
存前驗「訊息存在＋同篇」，不合格存空、不 400。提取線同一輪關鍵詞回找順手記下最匹配的
assistant 訊息。POST /api/insights/backfill-sources 冪等，印 [INSIGHT] backfill=…。
「存為洞察」改帶那一則＋它前面最近的一則 user；表單隱藏欄位原樣帶回（編輯不洗掉出處）。

A2（dd751bf）GET /:id 多帶 source_message{id,content,seq} 與 source_question{id,content}
（同篇 seq 較小、最近的一則 user，不是 seq−1），一次拿齊。InsightPopover：桌機置中
popover／窄螢幕貼底抽屜，Esc 關；來源三態（一問一答／只有 context／沒有記錄來源對話）。
「去對話」＝ store 的 messageJump 一次性訊號 → ChatPanel effect scrollIntoView ＋
cr-msg-flash 閃 1.75s → 清訊號；熄燈另外一顆 effect（跟 FullTextView 同一個坑：綁在一起
cleanup 會把 timer 清掉，高亮永不滅）。跨頁先發訊號再換頁 ⇒ 要等 messages 非空才判定；
閱讀模式下有待跳訊號自動把討論抽屜打開。

B1（bc6b4e3）insight_links(a,b,score,reason,method,created_at)，a<b 無向，兩個外鍵 CASCADE。
分數：title+content 前 400 字切成重疊 5 字窗（步長 3、最多 80）OR 起來查 {title content}；
bm25 沒有絕對刻度，拿「自己查自己」當分母 ⇒ score = rank_other / rank_self，天然 0–1。
MATCH 只查 title／content——source_context 是整段對話摘錄，她有三條洞察共用同一段
（見 1.4），拿它算相似度會把「同一次對話」誤判成「同一個想法」。切詞不做去標點正規化：
trigram 逐字比對，PY-GCMS 正規化成 PYGCMS 反而比不中。relinkAll 砍掉重練＋雙向 MAX
合併 ⇒ 順序無關、冪等；reason 先撈起來重建後貼回。computeInsightLinks 單向（存的當下
只跑一個查詢不卡她），不對稱漏掉的那條下次 relink 補回，已寫在註解。

B2（c5e55b0）預設關；INSIGHT_LINK_REASON 不設／空／false 全是關。實作全程只 mock，
沒打過真上游。開啟時走討論線 getChatConfig，串流／逾時／abort 合成／錯誤分類全部沿用
ai.js 的 makeRequest／collectStream／describeAnalyzeError（makeRequest 因此 export，
行為一字未改）。一次最多 20 對，失敗留空不重試。

B3（6babc86）GET /api/insights 多帶 link_count：一趟 SQL（LEFT JOIN a/b UNION ALL 計數
子查詢），順手把來源論文標題也 JOIN 進來（本來每條一次 paperStmt.get，是 N+1）。
GET /:id/links 也是一趟。卡片右上角「相關 N」（N=0 不顯示）；浮現卡底部列相關洞察，
分數三檔文字（很像 ≥0.55／有關 ≥0.42／略有關），點一條換卡、「←」回上一張、最多 10 層。

═══ 三、驗證（工單 §4 逐條）═══

1 合法／不存在／跨篇 source_message_id 三態 ✅（後兩者洞察仍存成、欄位空）
2 GET /:id 一問一答；沒來源時兩者 null ✅
3 backfill 唯一寫／兩則不寫／無命中不寫 ＋ 冪等 ✅（第二次 filled=0）
4 fixture 五條（兩對相似＋一條孤立）→ 恰兩列、孤立 0；門檻 0.95 清空；DELETE CASCADE ✅
5 relink-all 冪等（逐列相同）；link_count 一趟 SQL（db.prepare spy 釘住）✅
6 B2 關閉零 fetch；開啟次數＝新連線數且 ≤20；失敗留空不重試 ✅
7 前端純函式三態／三檔／堆疊上限 10；npm run build 過 ✅
8 npm test 436/436（383→436，+53）；git diff --check 乾淨 ✅
外加她真 DB 唯讀副本實彈（見一）：backfill 4 筆、連線 2 條、兩者複跑一致。

═══ 四、紅線遵守 ═══

未 push、未 build 安裝包、未動 .env／release/；dist/ 只本機 build 驗證、未 commit。
絕不打真上游（B2 只對本機假 server）。worktree 內作業，沒碰她的主工作樹。
不動討論線 prompt／chatAboutPaper／穩定前綴；ownInsights／related 注入那段一字未改。
出海 payload（gateway.js buildInsightPayload）未加新欄位。FTS 表與既有 triggers 未改。

⚠ 一件要跟她講的：驗證資料隔離時我用 sqlite3 CLI 開了一次 data/co-reading.db（唯讀查詢
PRAGMA table_info），SQLite 關閉時把 WAL checkpoint 進主檔了——.db 1462272 → 1515520
bytes、-wal 歸 0。沒有任何資料或 schema 變動（複查：15 條洞察、65 則訊息、11 欄、
沒有 insight_links、integrity_check = ok），checkpoint 是 SQLite 日常行為，但紅線寫了
「不動 data/」就照實說。

═══ 五、偏離工單之處（三件）═══

1 回填探針先剝角色標記。工單 §2 A1 寫「找 content 包含 source_context 前 60 字者」；
  照字面做 0 筆命中（她的 context 全帶 [assistant] 前綴）。改成剝標記後取前 60 字 ⇒ 4/4。
2 連線查詢加了欄位限定 {title content}。工單只說「對 insights_fts 做 trigram 查詢」，
  沒說查哪幾欄；排除 source_context 是刻意的，理由見二·B1。
3 GET /api/insights 順手修掉來源論文標題的 N+1。工單只要求 link_count 別 N+1；
  既然同一趟 SQL 已經在 JOIN，把本來每條一次的 paperStmt.get 併進去。回應形狀不變。

另一個工單沒規定、我自己決定的取捨：computeInsightLinks 單向、relinkAll 雙向，
換來「存洞察不卡」。

═══ 六、留給她的開關 ═══

INSIGHT_LINK_MIN_SCORE  預設 0.35（clamp [0.05,0.95]）——她真資料上 0.29↔0.58 是空谷
INSIGHT_LINK_MAX        預設 5（上界 50）
INSIGHT_LINK_REASON     預設關——打開才會問模型「為什麼相關」（要花 token）

一次性維護：
  curl -X POST http://127.0.0.1:3456/api/insights/backfill-sources
  curl -X POST http://127.0.0.1:3456/api/insights/relink-all
觀察哨：grep '\[INSIGHT\]' data/app.log（backfill= ／ relink total=…links=… ／ link reason asked=…）

═══ 七、下一步（等她拍板）═══

浮現卡的手感我沒在瀏覽器上親手點過（純函式與路由都有測試蓋住，互動是照工單 14 既有
模式做的）。她要的話開 PORT=3457 帶她走一遍。上線後第一件事是跑一次 backfill-sources
＋ relink-all（都冪等），她那 4 條就能一鍵跳回原文、兩對近重複就會互相看得見——
工單 08 留的「兩對近重複要她自己處理」現在在浮現卡上一眼就看得到。

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>


── 附錄 C（Elias 親驗，2026-09-14 晚）─────────────────────────────────

- `npm test` 親跑 436/436（改前 383）；`npm run build` 親跑通過；紅線：`gateway.js` 未動、`ai.js` 只多 export `makeRequest`（行為未改）、FTS 表與 triggers 未動。
- 瀏覽器親手（worktree build，:3457，臨時 DB 種 1 篇論文、6 則問答、3 條洞察、手塞 1 條連線）：洞察面板卡片顯示「相關 1」（無連線的那條不顯示）→ 點卡片浮出：維度／標題／內容／來源論文、「出自的對話」一問一答、去對話／去論文／編輯／刪除、底部「相關洞察(1)」帶「很像」→ 按「去對話」切到論文頁、討論面板滾到第 3 個回答、氣泡帶 `cr-msg-flash` ✓。
- **已知限制（不擋合入）**：FTS bm25 的分數口味保守——我種的一對「改寫但沒有整段重疊」的洞察在 0.01 門檻下也拿不到候選（raw ≈ −1e-6），而她真資料的兩對近重複連對了（0.622／0.580）。⇒ v1 的「自動聯想」抓的是近重複與強重疊，不是語義相近；要抓改寫得換 embedding（喚醒＝她說「該連的沒連上」）。
- agent 自報：唯讀開她 `data/co-reading.db` 時 SQLite 關閉做了 WAL checkpoint（.db 1,462,272→1,515,520、-wal 歸 0），資料與 schema 零變動、integrity ok；她 dev server 當時停著。照實記。
- 真上游：未打（B2 只 mock，預設關）。
