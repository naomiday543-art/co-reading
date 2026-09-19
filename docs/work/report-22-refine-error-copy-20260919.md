# 報告：工單 22——精煉失敗文案（gateway `code` → 她看得懂的一句話）

**日期**：2026-09-19　**分支**：`feat/wo22-refine-error-copy`（基線 `main` @ `1a8d361`）
**狀態**：完工，未部署未 push。測試 578/578 綠（基線 553，新增 25）。

## 一、做了什麼

| 項 | 檔 | 內容 |
|---|---|---|
| C1 | `src/carryover.js` | 新增純函數 `describeRefineFailure({ status, body })` ＋對照表 `REFINE_FAILURE_COPY`（15 個 code，繁體、用「你」）。不外呼、不寫庫、不 log。 |
| C2a | `src/carryover.js` `requestRefine` | `!res.ok` 分支改讀 `res.json()`（拋就當 `{}`），呼叫 C1；WARN 改印 `code=… detail=…`，**不再印 body 前 160 字**；回 `{ ok:false, reason, code, detail }`。 |
| C2b | `src/routes/papers.js` `POST /:id/refine` | 502 body 從 `{ error }` 變 `{ error, code, detail }`。狀態碼與 `error` 的組法（`精煉失敗：<reason>`）不變。 |
| 測試 | `test/refine-error-copy.test.js` | 25 條：每個 code 一句對、文案體檢（無「妳」／無 snake_case）、沒 code 退回、未知 code、body 壞形狀、requestRefine 接線、日誌不漏 body、路由 502 形狀。 |

前端一個字沒改——面板與研究進度頁本來就直接顯示 `error`。

## 二、她會看到什麼（gateway 姊妹單上線後）

| gateway 回的 `code` | 她看到的那一行 |
|---|---|
| `provider_payment` | 精煉失敗：上游拒絕：帳戶餘額不足（去充值或換供應商） |
| `provider_auth` | 精煉失敗：上游拒絕：金鑰無效或過期 |
| `provider_not_found` | 精煉失敗：上游找不到這個模型（檢查 REFINE_MODEL） |
| `provider_missing_session` | 精煉失敗：上游缺 session 標頭（gateway 版本太舊） |
| `provider_bad_request` | 精煉失敗：上游拒絕這個請求（參數或格式） |
| `provider_rate_limited` | 精煉失敗：上游限流，等一下再按 |
| `provider_server_error` | 精煉失敗：上游暫時故障，等一下再按 |
| `provider_unreachable` | 精煉失敗：連不上上游（VPS 到供應商的網路） |
| `provider_empty`／`provider_invalid_stream`／`output_parse`／`output_schema` | 精煉失敗：模型這次沒給合格的答案，再按一次通常就好 |
| `timeout` | 精煉失敗：精煉逾時（對話太長或上游太慢），再按一次 |
| `config` | 精煉失敗：gateway 沒設定精煉模型 |
| `input` | 精煉失敗：沒有新對話可精煉 |

502 回應樣本（gateway 回 402/`provider_payment`）：

```json
{
  "error": "精煉失敗：上游拒絕：帳戶餘額不足（去充值或換供應商）",
  "code": "provider_payment",
  "detail": "HTTP 402"
}
```

日誌那一行（親跑，不是想像）：

```
[2026-09-19 19:49:19] [WARN] 精煉失敗 wo22-p: HTTP 502 code=provider_payment detail=HTTP 402
```

## 三、⚠ 這單自己不會讓她少看到「http 502」

`code` 是 gateway 給的。**姊妹單 `refine-error-transparency` 沒上生產之前**，生產 gateway 回的 body 沒有 `error.code`，這裡照設計退回現況——她按精煉仍然看到「精煉失敗：http 502」。
兩單要一起上才有效；co-reading 這邊先上也零風險（舊 gateway 路徑逐字等同改前，測試釘住了）。

## 四、驗證

- `npm test` → **578 pass / 0 fail**（134 suites，7.3s）。基線 553。
- 新檔單跑 25/25 綠。
- 零回歸釘子：`test/carryover.test.js` 原本那兩條（`http 500`、`ECONNREFUSED`）未改一字，仍綠——舊 gateway 與網路異常兩條路徑行為不變。
- 沒碰 `data/`、沒重啟她的 server（她的 `node --watch` 自己在 19:47:59 重啟並乾淨起來）、沒部署沒 push。

## 五、判斷（細節見工單附錄 A）

1. 表上沒有的 code（例如姊妹單的 `internal`）→ 退回 `http <status>（type）`，但 `code` 原樣回去。寧可誠實說不知道，不編一句安撫的話。
2. `res.json()` 會拋（上游回 HTML／空 body）→ 當 `{}`，退回 `http <status>`，不炸。
