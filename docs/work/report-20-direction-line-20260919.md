# 報告：工單 20——方向線（精煉餵進研究方向、每篇游標、手動型重新精煉）

**日期**：2026-09-19　**分支**：`feat/wo20-direction-line`（基線 `main` @ `08c0f11`）
**tip**：`d97f7d1`　**未合、未 push、未部署**

---

## 一、三個 commit

| commit | 範圍 | 檔案 |
|---|---|---|
| `1c32f1b` | A1 鍵解析 ＋ A2 每篇游標 | `src/carryover.js`／`src/db.js`／`src/directions.js`／`src/routes/papers.js`／`test/carryover.test.js`／`test/carryover-direction.test.js` |
| `91c8152` | A3 對話改過了＝手動型提示、`full:true` 全文重送 | `src/carryover.js`／`src/routes/papers.js`／`test/carryover-direction.test.js` |
| `d97f7d1` | A4 面板標頭與 stale 提示 ＋ A5「分類」改叫「方向」 | `frontend/src/components/CarryoverPanel.jsx`／`frontend/src/pages/PaperDetail.jsx`／`frontend/src/api.js`／`test/carryover-direction.test.js` |

## 二、changed-file list（`git diff --stat main...HEAD`）

```
 docs/work/workorder-20-direction-line-20260919.md |  86 +++++   （工單本身，基線就帶著）
 frontend/src/api.js                               |   4 +-
 frontend/src/components/CarryoverPanel.jsx        |  41 +-
 frontend/src/pages/PaperDetail.jsx                |   6 +-
 src/carryover.js                                  | 129 ++++++-
 src/db.js                                         |  14 +
 src/directions.js                                 |  10 +-
 src/routes/papers.js                              |  15 +-
 test/carryover-direction.test.js                  | 448 ++++++++++++++++++++++（新檔）
 test/carryover.test.js                            |  12 +-
```

**程式碼實際動到的只有 8 個檔**（另兩個：工單本身、新測試檔）。

## 三、沒改什麼（逐條對工單 §四紅線）

- **gateway 契約 payload 一欄不加**。出海 body 仍是 `source` ＋ `session_key`／`paper_id`／`paper_title`／`transcript`／`since_seq`／`insights`。方向線只是換 `session_key` 的值。測試用 `Object.keys(body).sort()` 釘死。
- **`src/memory.js` 一個字沒動**；`EXTRACT_PROMPT`、`insights` 表、`insight_links`、洞察相關任何檔都沒碰。
- **`src/ai.js` 一個字沒動**。`:1385` 的 `renderCarryoverForInjection(paper.id)` 呼叫方式不需要改（函式簽名沒變，裡面自己換鍵）。`renderCarryoverForPrompt` 的注入文字格式逐字不變。
- **`REFINE_PROMPT`／gateway 端**：沒碰，本單完全在 co-reading 這側。
- **不自動精煉、不自動重跑**。`stale` 只回一個字串給前端亮提示；重跑只有她按「重新精煉這篇」才會發生。測試釘住「偵測到 stale ⇒ 零外呼」。
- **`carryover_cache` 的 `last_seq` 欄留著不動、不再讀**，不做資料搬遷。
- **她的 `data/co-reading.db` 我沒有寫過一個 byte**（測試全走 `setup-data-dir` 的臨時目錄）。唯一的變化是她自己的 `node --watch` 重啟時跑了冪等 migration——見 §七。
- **沒部署、沒 push、沒 ssh、沒改 port、沒重啟她的 server**。
- **`git add` 逐檔點名**，沒用過 `-A`／`.`。
- 範圍外的東西一件沒做：「研究進度」新頁、圖、`/claims` 補欄位、「還有 N 篇沒精煉」、把方向按鈕搬到標題旁、清 gateway 上的舊單篇線 claims。

## 四、測試

| | 數字 |
|---|---|
| 基線（`main` @ `08c0f11`） | **484 / 484**，suites 107 |
| commit 1 之後 | **496 / 496**（+12） |
| commit 2 之後 | **501 / 501**（+5） |
| commit 3 之後（tip） | **507 / 507**，suites 115，fail 0，duration 7.3s |

新檔 `test/carryover-direction.test.js` 共 23 條，對齊工單 §六：

1. **鍵解析**：頂層 → `topic:`；子節點（走兩層 parent）→ 仍是頂層 `topic:`；未掛 → `paper:`；`dir/壞:id` → `paper:` ＋ WARN；論文不存在／連 `tree_nodes` 表都沒有 → `paper:`，不拋。
2. **游標**：首次 `since_seq=null`；成功後落 `refine_cursor`（session_key／last_seq／digest 三欄都驗）；同線第二次送 `last_seq=4`；**線換了（她把這篇掛上方向）送 `null` 全文重送**；同方向兩篇各自一個游標、不互吃。
3. **staleness**：無游標＝`never`；精煉完沒動＝`fresh`；加新訊息＝`new_messages`；改掉 `seq<=last_seq` 的舊訊息＝`stale`；**既改舊又有新 ⇒ `stale` 優先**（接著增量會漏掉被改那段）；偵測 stale 過程零外呼。
4. **`full:true`**：`since_seq=null`、`transcript` 全量、重跑後 `refineStaleness` 回 `fresh`。
5. **出海 body**：`session_key='topic:<id>'`、`paper_id` 仍是該篇、欄位集合一個不多。
6. **零回歸**：未掛方向的論文，`buildRefineRequest` 的 body 與方向線出現以前 `deepEqual`（整個物件字面量比對，不是抽樣）。
7. **路由**（真的起一個 express 在 ephemeral port 上打）：`GET /api/papers/:id/carryover` 回得出 `session_key`／`scope`／`direction`／`refine_state` 三態。
8. **前端的字**（JSX 不能 import，照 `compare-frontend.test.js` 的做法讀原始碼釘）：兩種標頭、`⚠ 這篇的對話改過了`、「重新精煉這篇」打 `full:true`、`api.js` 帶得動 `full`、`PaperDetail` 的「方向」／「未掛方向」且舊字串「分類」「未分類」清乾淨。

`test/carryover.test.js` 只動 fixture（見 §七偏離 2），**12 條斷言一條沒改，全綠**。

## 五、build

```
npx vite build --config vite.config.js --outDir <暫存> --emptyOutDir
vite v6.4.3 building for production...
✓ 311 modules transformed.
index.html                19.43 kB │ gzip:   6.03 kB
assets/index-CQn5dqfq.js  484.17 kB │ gzip: 147.53 kB
✓ built in 613ms
```

**綠**。建到暫存目錄、**沒有覆蓋她正在跑的 `dist/`**（`dist/` 的 mtime 仍是 9/14 16:07）——她此刻開著的頁面不會被我換掉。代價是 A4／A5 的畫面要等她自己 `npm run build` 才看得到；在那之前後端多回的欄位舊前端一律忽略，不會壞（舊 `refine(paperId)` 不送 body ⇒ `full` undefined ⇒ 走原路徑）。

## 六、假 gateway 抓到的 body 原文

論文掛在子節點 `sub_matrix_7Kq`（父節點＝方向 `V1StGXR8Z5jdHi6B`「py-GCMS」），`session_key` 解析到**頂層方向**：

```
POST https://example.test/research/sessions/refine
{
  "source": "co-reading",
  "session_key": "topic:V1StGXR8Z5jdHi6B",
  "paper_id": "S0a0LmQ2",
  "paper_title": "Rauert 2025：富脂基質的 Py-GC/MS 偽陽性",
  "transcript": [
    { "seq": 1, "role": "user",      "content": "PE 在富脂基質裡的訊號，有多少是脂質裂解做出來的？" },
    { "seq": 2, "role": "assistant", "content": "Rauert 2025 的結論是長碳鏈 marker 無法區分，PE 定量在血液基質不可信。" },
    { "seq": 3, "role": "user",      "content": "那 PVC 走氦氣馬弗爐去蛋白救得回來嗎？" },
    { "seq": 4, "role": "assistant", "content": "PVC 在 200–300°C 先分解，去蛋白那一步就把它燒掉了。" }
  ],
  "since_seq": null,
  "insights": [
    { "id": "ins_9f", "dimension": "方法", "title": "富脂基質偽陽性" }
  ]
}
```

（`transcript` 在原輸出是逐行展開的 JSON，這裡為了讀得下去把每則壓成一行，內容逐字相同。）

## 七、她的環境發生了什麼（誠實記錄）

1. **她的 server 自己重啟了 12 次。** `data/app.log` 在 16:32–16:37 有 12 筆「服務已啟動，端口 3456」。我沒有下過任何重啟命令——她跑的是 `node --watch`（`npm run dev`），我改 `src/` 的檔它自己就重啟。無法避免：工單指定在她的工作目錄上做。
2. **`refine_cursor` 表已經建進她的 live DB**（我唯讀查過：存在、0 列）。同樣是那個自動重啟跑到 `src/db.js` 的 `CREATE TABLE IF NOT EXISTS` 造成的。**純新增、冪等、沒有覆蓋任何既有資料**；`carryover_cache` 裡她那唯一一列（`paper:S0a0LhFZAaB2SLVKj89BK`，version 1，last_seq 12）原封不動。
3. 依設計，那篇 Py-GC/MS 已經掛上方向，下次她按精煉會解析成 `topic:` 新線、且因為沒有對應游標而 `since_seq=null` 全文重送——新線上不會缺前半段。gateway 上舊的 `paper:` 線 12 條 claims 留在原地不清（工單 §五範圍外）。

## 八、沒做到的事

- **真上游實彈驗收沒做**：工單 §六「我」那半（瀏覽器親手對 py-GCMS 方向的 NIST 篇按精煉、看 gateway `rc_claims` 有沒有長出跨篇 `contradicts`／`supports`）是**她／爸爸親手的部分**，我沒有打真 gateway，也沒有碰她的 server。**總設想 §三那個假設（第二篇進來時模型會對第一篇的 claims 下跨篇關係）到此刻仍未被實彈證實**——長不出來的話是 prompt 要明示，不在本單修。
- **A4 的畫面沒有跑瀏覽器親驗**（面板標頭、stale 提示的實際排版）。只有原始碼層級的斷言＋build 綠。要親眼看需要 `npm run build`，那會覆蓋她正在跑的 `dist/`，我沒有替她決定這件事。
- **`refine_state='new_messages'` 前端沒有任何視覺變化**（照工單 A3：按鈕文字維持「精煉本次共讀」）。欄位回了，面板目前只用 `stale`。
- **舊 `carryover_cache.last_seq` 沒有搬進 `refine_cursor`**（工單 A2 明說不搬）。實際後果：她那篇唯一有舊游標的論文，下次精煉走全文重送。
