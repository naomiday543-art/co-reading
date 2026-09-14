# 工單 02：Provider structured outcome／policy refusal 分類

> 優先級：P1 介面修補
>
> Repo：`/Users/laine/research-stack/co-reading`
>
> 主要改動：`src/ai.js` 與 parser tests
>
> 本工單交付邊界：建立可靠 outcome contract；**不在本張改 DB/UI 保存行為**

## 1. 問題

目前兩個 streaming parser 只 yield 文字：

- Anthropic 只取 `content_block_delta.delta.text`；
- OpenAI-compatible 只取 `choices[0].delta.content`；
- stream 結束原因、provider refusal 欄位與 content-filter reason 全被丟棄；
- `chatAboutPaper()` 只回傳全文字串，route 無法區分成功與政策拒絕。

因此任何「HTTP 200 + 正常結束的拒絕」都會被上層當 success。工單 03 無法安全修保存，除非本張
先建立結構化結果。

## 2. 核心原則

1. **只信結構化訊號。** 不掃描回答文字中的「抱歉」「不能」「I cannot」等關鍵字。
2. **拒絕不是 transport error。** 使用者需要看到不同 UI，重試/failover 規則也不同。
3. **未知不是拒絕。** 不認識的 finish reason、malformed frame、空 stream 應分別是
   `provider_error` / `malformed_stream` / `empty_response`，不能猜成 policy。
4. **不做安全繞過。** `policy_refusal` 不在背景自動換模型；工單只分類，不新增 fallback。
5. **provider-specific mapping 必須有 fixture。** 不得憑印象寫一串 reason 名稱後沒有測試。

## 3. 建議 outcome contract

`chatAboutPaper()` 最終至少回傳：

```js
{
  content: '...',
  outcome: 'success' | 'policy_refusal',
  providerReason: string | null,
}
```

錯誤仍以 typed error/exception 表示，至少能區分：

```text
transport_error
rate_limit
provider_error
malformed_stream
empty_response
```

可以採用 class、`code` 欄位或 discriminated union；不要讓 route 解析 `err.message` 文字猜類型。
`providerReason` 只保存枚舉/短 reason，不保存完整 raw body、prompt、response 或帳戶資料。

## 4. Structured signal mapping

### 4.1 Anthropic format

執行時根據目前支援的 Anthropic Messages streaming wire format建立 fixture，至少處理：

- 正常 text delta + final success stop reason；
- provider 明確的 refusal stop reason/event；
- HTTP 非 2xx policy/error body（由 request error path 分類，不偽裝成成功 stream）；
- error event；
- stream 在 final metadata 前中斷。

不要把一般 `end_turn` + 一段語氣保守的文字判為拒絕。

### 4.2 OpenAI-compatible format

只映射本專案實際承諾支援且 fixture 證明的結構化欄位，例如 provider 的 `refusal` 欄位或
明確 content-filter finish reason。因「OpenAI-compatible」供應商差異很大：

- 已知、測過的 refusal signal → `policy_refusal`；
- 已知正常 finish reason → `success`；
- 未知 finish reason → typed provider error/unknown outcome，不能自動列為 policy；
- HTTP 429/5xx 維持 rate-limit/provider error；
- `[DONE]` 不是單獨的 success 證據，仍要驗證是否收到可接受內容或 final metadata。

### 4.3 部分文字後才拒絕

stream 可能先送 delta，最後才給 refusal/filtered outcome。parser 必須允許上層即時顯示文字，
但最後結果仍以 final structured signal 為準。工單 03 會在收到 final refusal 後清掉普通 streaming bubble，
改成特殊 refusal 狀態。

## 5. 實作形狀

推薦把 parser 從「只 yield string」改成「yield typed event」，例如：

```js
{ type: 'delta', text: '...' }
{ type: 'final', outcome: 'success', providerReason: 'end_turn' }
{ type: 'final', outcome: 'policy_refusal', providerReason: 'refusal' }
```

`chatAboutPaper()` 消費事件：delta 繼續呼叫 `onChunk`，final 建立結果。也可以用 parser state object，
但最終 outcome 不能只藏在 log 裡。

必須處理 decoder flush 與最後一個沒有換行的 buffer；目前 parser 只按 `\n` 拆行並忽略尾 buffer，
修改時不要讓最後的 structured outcome 被遺失。malformed JSON 不得無限「skip」到最後再當 success。

## 6. 非目標／紅線

- 不做任何關鍵字 refusal classifier；
- 不建立模型自動 failover；
- 不修改 `messages` schema；
- 不修改 frontend；
- 不改 Research Gateway 或 AGY；
- 不記錄 raw SSE/body；
- 不把 provider 的所有 safety 類型永久硬編成跨供應商共同真相。

## 7. 必測矩陣

每一列使用最小 SSE fixture，測 parser 與 `chatAboutPaper` 最終 contract：

| Case | delta | final signal | 預期 |
|---|---|---|---|
| Anthropic normal | 有 | success reason | success + 完整 content |
| Anthropic refusal | 可有 | structured refusal | policy_refusal |
| OpenAI normal | 有 | normal finish | success |
| OpenAI refusal/filter | 可有 | supported structured signal | policy_refusal |
| 文字含「抱歉」但 final normal | 有 | normal finish | success |
| HTTP 429 | 無 | HTTP error | rate_limit，不是 refusal |
| HTTP 500 | 無 | HTTP error | provider_error，不是 refusal |
| malformed JSON frame | 任意 | 無可靠 final | malformed_stream |
| stream EOF before final | 可有 | 無 | malformed/empty，不是 success |
| `[DONE]` only | 無 | 無內容/metadata | empty_response |
| unknown finish reason | 可有 | unknown | typed unknown/provider error |
| split UTF-8 + split JSON lines | 有中文 | success | 中文不破字、內容完整 |

另測 onChunk 拋錯、reader 拋錯與 cancellation 不會被改標成 policy refusal。

## 8. 交付標準（DoD）

- route 未改之前，`chatAboutPaper()` 已能回傳 success/refusal 結構化 outcome；
- transport/rate-limit/provider/malformed/empty 各自不被混成 refusal；
- 無關鍵字猜測；
- 正常中文 stream 不截斷、不重複 delta；
- fixtures 不含真 credential、帳戶、真 prompt 或 production response；
- targeted parser tests 全綠；
- 舊的正常聊天 callback 行為有 regression test；
- `git diff --check` 全綠；
- 正式 `npm test` 精確回報；
- 不宣稱做過真實 provider E2E，除非確實以獲授權帳戶完成且未記錄內容。

## 9. 回滾

本張不做 schema/UI 變更。回滾為撤回 typed parser/outcome contract 並恢復舊 parser；若工單 03 已建立在
新 contract 上，兩張必須一起回滾，不能只退工單 02 留下 route 讀取不存在的 outcome。
