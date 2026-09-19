# 工單 22：精煉失敗時，把 gateway 的 `code` 翻成她看得懂的一句話

**日期**：2026-09-19　**狀態**：她說「2 和 3 可以開始了」，直接做
**基線**：`main` @ `1a8d361`（已 push）　**分支**：`feat/wo22-refine-error-copy`
**姊妹單**：gateway `workorder-refine-error-transparency-20260919.md`（回應加 `error.code`／`error.detail`；本單照那個形狀寫，gateway 沒上新版時**退回現在的行為**）
**性質**：文案與對照表，零邏輯改動。

## 一、現況
- `src/carryover.js` `requestRefine`：`!res.ok` → `log('WARN', '精煉失敗 … HTTP <status> <body 前 160 字>')`，回 `{ ok:false, reason:'http <status>' }`；`catch` → `reason: e.message`。
- `src/routes/papers.js:395` `POST /:id/refine`：`!result.ok` → `502 { error: '精煉失敗：<reason>' }`。
- 面板與研究進度頁直接顯示這個 `error` 字串。9/19 她看到的就是「精煉失敗：http 502」。

## 二、設計
### C1 `src/carryover.js` 新純函數 `describeRefineFailure({ status, body })`
`body` 是 gateway 回的 JSON（可能沒有 `error.code`）。對照表（**繁體、她家用「你」**）：

| `error.code` | 一句話 |
|---|---|
| `provider_payment` | 上游拒絕：帳戶餘額不足（去充值或換供應商） |
| `provider_auth` | 上游拒絕：金鑰無效或過期 |
| `provider_not_found` | 上游找不到這個模型（檢查 REFINE_MODEL） |
| `provider_missing_session` | 上游缺 session 標頭（gateway 版本太舊） |
| `provider_bad_request` | 上游拒絕這個請求（參數或格式） |
| `provider_rate_limited` | 上游限流，等一下再按 |
| `provider_server_error` | 上游暫時故障，等一下再按 |
| `provider_unreachable` | 連不上上游（VPS 到供應商的網路） |
| `provider_empty`／`provider_invalid_stream`／`output_parse`／`output_schema` | 模型這次沒給合格的答案，再按一次通常就好 |
| `timeout` | 精煉逾時（對話太長或上游太慢），再按一次 |
| `config` | gateway 沒設定精煉模型 |
| `input` | 沒有新對話可精煉 |
| 沒有 `code`（舊 gateway）| 退回現況：`http <status>`；若 `error.type` 有值就加括號 `（refine_upstream）` |

回 `{ reason: '<一句話>', code: '<code 或 null>', detail: '<gateway detail 或 null>' }`。

### C2 接線
- `requestRefine` 的 `!res.ok` 分支：`res.json()` 解析（失敗就 `{}`），呼叫 C1；`log('WARN', '精煉失敗 <paperId>: HTTP <status> code=<code> detail=<detail>')`（**不再把 body 前 160 字印進日誌**——裡面可能有上游原文）；回 `{ ok:false, reason, code, detail }`。
- `POST /:id/refine` 失敗：`502 { error: '精煉失敗：<reason>', code, detail }`。狀態碼維持 502（前端不看碼）。
- 前端不改（面板與進度頁本來就顯示 `error`）。

## 三、紅線
不動精煉邏輯、鍵解析、游標、面板行為；不碰 `data/`；不部署不 push；`git add` 逐檔。她正跑 `npm run dev`，改 `src/` 前確認 `data/app.log` 最近一分鐘沒有「精煉」INFO。

## 四、驗證
`npm test` 全綠（基線 553）；新測試 `test/refine-error-copy.test.js`：每個 code 一句對；沒 code 退回 `http 502`；假 gateway 回 402 含 code → route 回 `精煉失敗：上游拒絕：帳戶餘額不足…`；日誌不含 body 原文。

## 五、交付
一個 commit＋報告 `docs/work/report-22-refine-error-copy-20260919.md`；偏離寫附錄 A；十行內回覆。commit 結尾 `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`。

## 附錄 A：實作時的偏離／補洞（2026-09-19）

1. **表上沒有的 `code`**（§二 C1 對照表沒列，但姊妹單 E1 有 `internal`）：照「沒有 code」那格處理——`http <status>`，`error.type` 有值就加括號；但 `code` 原樣回進回應與日誌。不為未知碼編文案。
2. **回應不是 JSON**（上游回 HTML／空 body，`res.json()` 會拋）：當 `{}` 處理，退回 `http <status>`。工單沒寫這格，但改讀 `json()` 後它是新的失敗面。
3. `requestRefine` 的 `@returns` jsdoc 補上 `code`／`detail`（工單只寫了分支行為）。
