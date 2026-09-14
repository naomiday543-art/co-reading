# 工單 01：Vision capability 設定硬化

> 優先級：P0 小修補
>
> Repo：`/Users/laine/research-stack/co-reading`
>
> 預估改動：`src/ai.js`、`src/server.js`、`.env.example`、測試檔
>
> 非目標：完整 capability registry、多模型 UI、provider 切換、production 設定變更

## 1. 問題

`fa57ad2` 的判斷方向正確，但設定邊界尚未閉合：

1. `resolveConfig(prefix)` 會讀 `${prefix}_vision_capable`，PUT `/api/settings` 卻不接受該鍵；
2. parser 以「不在 false 清單裡」代表 true，拼字錯誤會 fail-open；
3. 現有測試直接呼叫 `isVisionEnabled()`，沒有走 DB/env → resolveConfig →
   getChatConfig/getAnalyzeConfig 的真實路徑。

結果是：env 手動設定通常有效，但設定頁/API 可能讓使用者以為已保存；而一個 typo 可能把
text-only provider 宣告成 vision-capable。

## 2. 必讀檔案

開工前按順序讀：

1. `src/ai.js`：`resolveConfig`、`getChatConfig`、`getAnalyzeConfig`、`isVisionEnabled`；
2. `src/server.js`：GET/PUT `/api/settings`；
3. `src/db.js`：`getSetting`／`setSetting`／`getSettings` 與 test DB escape hatch；
4. `.env.example` 的 AI/ANALYZE/VISION 說明；
5. `test/ai-provider.test.js` 與現有 server/settings 測試形狀；
6. 上位設計 §4.1：`../../../research-gateway/docs/BIOMEDICAL-MULTIMODEL-ROUTING-DESIGN.md`。

## 3. 已定案語義

### 3.1 合法輸入

內部型別只有：

```text
true | false | undefined
```

外部字串至少接受：

```text
true side:  true, 1, on, yes
false side: false, 0, off, no
unset:      undefined, null, 空字串或只有空白
```

大小寫與首尾空白可正規化。**任何其他非空值都是 invalid**，不得默認為 true。

建議做一個可 export、可單測的純函式，例如：

```js
parseOptionalBoolean(raw, settingName)
```

invalid 的建議行為是拋出帶設定名但不帶 secret 的 configuration error，使請求早失敗；若執行者
選擇 `undefined`，必須解釋為何不會讓名字猜測重新 fail-open。不得選擇 invalid → true。

### 3.2 優先序保持不變

```text
visionMode=on/off > explicit visionCapable > legacy name guess
```

因此：

- `visionMode=on` + `visionCapable=false` 仍為 true；
- `visionMode=off` + `visionCapable=true` 仍為 false；
- 實際要阻止 AGY/text-only 誤判時，應使用 `visionMode=auto`（或未設）+
  `visionCapable=false`。

不要在這張工單悄悄顛倒優先序；若產品想讓 capability 成為不可覆蓋硬限制，需另行決策。

### 3.3 設定寫入

PUT `/api/settings` 白名單至少新增：

```text
ai_vision_capable
analyze_vision_capable
```

若 Settings UI 尚未有欄位，本工單不強迫新增完整 UI；但 API round-trip 必須工作，文件不得再
聲稱一個實際無法保存的 DB setting。GET 已回傳全部 settings，確認不需重做 endpoint。

### 3.4 fallback 語義

`getAnalyzeConfig()` 保持目前設計：

```text
ANALYZE 明確設定 > AI 明確設定 > undefined/name guess
```

特別測 `false`：不得因 JavaScript falsy 而錯誤 fallback 到 AI 的 true；這裡必須使用 `??`，不能用 `||`。

## 4. 實作範圍

允許：

- 抽出嚴格 optional boolean parser；
- 補兩個 settings whitelist key；
- 視需要更新 `.env.example`，清楚標示 `auto + false` 的關係；
- 補 config resolution 與 settings round-trip 測試；
- 為可測性做很小的 export/依賴注入。

禁止：

- 移除 legacy model-name guess（完整移除屬 Phase 2）；
- 新增 AGY/Gemini provider；
- 更換預設模型；
- 讀寫真 `.env` 或 production DB；
- 順手重構整份 `ai.js`。

## 5. 必測矩陣

### 5.1 Parser unit

| raw | 預期 |
|---|---|
| `true`, `TRUE`, ` yes `, `1`, `on` | `true` |
| `false`, `FALSE`, ` no `, `0`, `off` | `false` |
| `undefined`, `null`, `''`, `'   '` | `undefined` |
| `fasle`, `enabled`, `2`, `{}` | configuration error；至少不得為 true |

### 5.2 Resolution unit/integration

- DB `analyze_vision_capable='false'` 壓過 env `ANALYZE_VISION_CAPABLE=true`；
- DB 未設時讀 env；
- analyze 未設時 fallback 到 AI 的 false；
- analyze 明確 false 壓過 AI true；
- 空 DB value 是否允許 env fallback，行為要明確且有測試；
- `visionMode=on/off` 優先序保持不變；
- `gemini-3.7-flash-low + auto + false` 得到 false；
- 未宣告時保留原名字猜測行為，證明向後兼容。

### 5.3 Settings endpoint

用 temp DB 啟動 server：

1. PUT 兩個 capability key；
2. GET 可讀回；
3. `getChatConfig/getAnalyzeConfig` 得到正確 boolean；
4. 未列入白名單的任意 key 仍不得寫入；
5. 測試結束必須關閉 HTTP server 與 DB handle，不得增加 teardown hang。

## 6. 交付標準（DoD）

- 白名單兩鍵可 round-trip；
- typo 不會啟用 vision；
- `false` 不會被 `||` 吃掉；
- 不改既有 vision mode 優先序；
- 新增測試覆蓋 parser、DB/env precedence、settings endpoint；
- `test/ai-provider.test.js` 與新增 targeted tests 全綠；
- `git diff --check` 全綠；
- 正式 `npm test` 精確回報 pass/fail/cancelled，不得只報 targeted；
- 無 production、`.env`、真 DB、research-gateway 改動。

## 7. 回滾

這張工單不做資料遷移。回滾只需撤回 parser、白名單與對應文件/測試改動；既有 settings 表中
若已保存新鍵，舊版只會忽略，不影響其他設定。不得為回滾刪除整張 settings 表。
