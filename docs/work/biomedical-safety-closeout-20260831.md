# Co-Reading 生醫模型安全收尾：小工單總覽

> 日期：2026-08-31
>
> 性質：實作工單，不是新的多模型架構設計
>
> 上位設計：`../../../research-gateway/docs/BIOMEDICAL-MULTIMODEL-ROUTING-DESIGN.md`
>
> 建議執行分支：`feat/carryover-client` 的後續短分支；開工前重新確認實際 branch/HEAD
>
> 生產權限：**無**。本組工單不部署、不改 `.env`、不碰真實 DB、不切換模型預設。

> **狀態（2026-09-14 補記）**：這組三張工單寫於 2026-08-31，一直沒進 git。
> 工單 01（視覺能力設定三態 `*_VISION_CAPABLE`）已在 `src/ai.js resolveConfig` 實作；
> **工單 02（provider 拒絕的結構化 outcome）與 03（拒絕狀態持久化 UI）從未實作**。
> 她 9/14 拍板：保留文件不做——現在討論／通讀走 DeepSeek（OpenCode Go），生醫內容幾乎不拒；
> 喚醒條件＝換回會拒生醫內容的模型、或日誌出現拒絕形狀的回覆。

## 1. 目的

這組工單只補三個已確認的小洞：

1. 視覺能力設定必須真的能保存，而且拼錯不能反向啟用能力；
2. provider 的「成功／政策拒絕」必須成為結構化結果，不能靠中文或英文關鍵字猜；
3. 政策拒絕可以讓使用者看見並留有狀態，但不得進入正常 assistant history、記憶提取、
   carryover/refinement 或 regeneration success version。

這不是 Phase 1–5 的全面多模型路由工程。完成本組工單後，Research Stack 仍維持既定邊界：

- Antigravity `agy` 不接入 co-reading inference；
- Claude 不被移除，也不在本工單更換任何 production default；
- PDF／圖表仍只交給實際支援 image/document content part 的 provider；
- research-gateway 的 memory/carryover 契約不因本工單改寫。

## 2. 已驗證的現況基線

以下是 2026-08-31 直接對 source 與測試取得的基線；執行者仍須在開工時重查 commit，
但不必重新辯論架構方向。

| 項目 | 現況 |
|---|---|
| Vision 止血 | co-reading commit `fa57ad2` 已加入三態 `visionCapable` 判斷 |
| 判斷優先序 | `visionMode(on/off)` > `visionCapable` > model/baseUrl 名字猜測 |
| env | `.env.example` 已示範 `ANALYZE_VISION_CAPABLE=false` |
| DB 設定讀取 | `src/ai.js` 會讀 `ai_vision_capable` / `analyze_vision_capable` |
| DB 設定寫入 | `src/server.js` 的 PUT 白名單尚未允許上述兩鍵，設定 API 會靜默忽略 |
| 解析缺口 | 除 `0/false/off/no` 外的任意非空值目前都會被當成 `true`；例如 `fasle` 會 fail-open |
| Streaming | `streamAnthropic` / `streamOpenAI` 目前只 yield 文字，丟棄 final outcome metadata |
| 保存 | route 只要 stream 正常結束就把 `fullContent` 寫成普通 assistant turn |
| 下游污染面 | history、`extractInsights`、carryover/refinement 都直接讀 `messages`，尚無 outcome filter |
| targeted test | `test/ai-provider.test.js` 7/7 pass |
| 正式 `npm test` | 本次重跑為 33 pass、1 cancelled；`test/chat.test.js` 有 pending HTTP/server teardown |

「33 pass、1 cancelled」不是本組功能造成的已知 regression，但在它被修復或獨立證明為
基線問題以前，不得宣稱整個 co-reading suite 全綠。

## 3. 工單拆分與依賴

| 順序 | 工單 | 可否獨立交付 | 前置 |
|---:|---|---|---|
| 1 | `workorder-01-vision-capability-config-hardening-20260831.md` | 是 | `fa57ad2` 已在基底 |
| 2 | `workorder-02-provider-refusal-outcome-20260831.md` | 是，但只建立 backend outcome contract | 工單 1 非程式依賴，可平行 review；實作仍建議依序 |
| 3 | `workorder-03-refusal-persistence-ui-20260831.md` | 否 | 工單 2 outcome contract 完成 |

每張工單各自完成 targeted tests；三張都完成後再做一次整體驗收。不要由不同執行者同時修改
`src/ai.js`，也不要同時修改 `src/routes/chat.js` 與同一批 chat tests，以免共享 working tree
互相覆蓋。

## 4. 全組紅線

1. 不加入 AGY provider、不把任何 AGY/Gemini credential 搬進 co-reading。
2. 不更換 `AI_*`、`ANALYZE_*`、`ANALYZE_VISION_*` 的 production 值。
3. 不以「抱歉」「無法協助」「I can't」等輸出文字判斷 policy refusal；正常學術回答也可能含這些詞。
4. 不把 transport error、429、5xx、malformed stream、空輸出混成 policy refusal。
5. 不讓 refusal content 進入下一輪模型 history、insight extraction、ResearchCarryover/refinement。
6. 不刪除使用者訊息；模型拒絕後，使用者原問題仍是對話事實。
7. 不為了通過測試而把 server teardown、未處理 promise 或 stream error 靜默吞掉。
8. 測試只使用 temp DB／注入的 fake response；不得讀寫 `data/co-reading.db`。
9. 不 commit、不 push、不 deploy，除非使用者另行授權。

## 5. 整體完成定義

全部條件同時成立才可說本組工單完成：

- 設定 API 能保存 `ai_vision_capable` 與 `analyze_vision_capable`；重讀後型別語義正確；
- 只接受文件列出的合法三態值；非法非空值不會啟用 vision；
- `visionMode=on/off` 的既有最高優先序有測試，不被誤改；
- Anthropic/OpenAI-compatible 的 supported structured refusal fixture 能產出
  `outcome=policy_refusal`；普通成功、transport error、rate limit、malformed stream 各自保持不同；
- send／continue／regenerate 三條 route 都不會把 refusal 當正常 success；
- refusal 重新載入後仍能在 UI 以特殊狀態顯示，但不會被注入 history／memory／carryover；
- 原有 success 對話、版本切換、edit branch、SSE delta/done 行為不變；
- targeted tests 全綠；`git diff --check` 全綠；
- `npm test` 不得有 fail/cancelled。若 teardown cancellation 確認與功能無關，必須另外修復或以
  獨立工單和可重現證據列為 blocker，不能把 targeted green 冒充 full-suite green；
- 文件只更新實際已完成的狀態，不預先把 Phase 1–5 標成完成。

## 6. 最終交付回報格式

執行窗口最後只需回報：

1. branch 與起訖 commit；
2. 實際 changed files；
3. 三張工單各自 DoD 是否通過；
4. targeted 與 full-suite 的精確 pass/fail/cancelled 數；
5. 是否做過真實 provider E2E；沒有就明寫「未做」，不得拿 fixture 冒充；
6. production／`.env`／真實 DB 均未變；
7. 剩餘 blocker 與回滾方式。
