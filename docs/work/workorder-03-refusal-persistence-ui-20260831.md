# 工單 03：Policy refusal 保存隔離、SSE 與 UI

> 優先級：P1 行為修補
>
> 前置：工單 02 的 structured outcome contract 已完成並有測試
>
> 主要改動：`src/db.js`、`src/routes/chat.js`、`src/memory.js`、`src/carryover.js`、
> `frontend/src/api.js`、`frontend/src/components/ChatPanel.jsx`、相關 tests
>
> 目標：拒絕可見、可重載，但絕不冒充正常研究回答或記憶來源

## 1. 產品語義

當 provider 明確回報 `policy_refusal`：

- 使用者應看到「模型因政策拒絕」，而不是模糊的網路錯誤；
- 不發出普通 `done` success；
- 不把內容當作正常 assistant answer 注入後續 prompt；
- 不讓它進 insight extraction、carryover/refinement 或 Research Memory；
- 不做背景自動 fallback；
- 使用者原本的 user message 保留；
- reload 後仍看得到拒絕狀態，避免看起來像模型無故消失。

因此「完全不落盤」不足以滿足可追溯性；「照舊存 assistant」又會污染 history。採用最小的 typed
message outcome，而不是新建一套 memory architecture。

## 2. 最小資料模型

在 `messages` 做 idempotent migration：

```text
outcome          TEXT NOT NULL DEFAULT 'success'
provider_reason  TEXT
```

允許值第一階段只有：

```text
success
policy_refusal
```

舊資料 migration 後全部是 `success`，不重寫 content/role/seq。`provider_reason` 只放短 reason 枚舉，
不放 raw response、prompt、token、帳戶或 credential。

Refusal row 可保留 `role='assistant'` 以維持現有 UI/排序相容，但**任何研究語義查詢都必須同時看
`outcome`**。如果執行者選擇新 role，必須逐一證明所有 history/branch/version/memory 查詢不會把它
錯當 user 或 assistant；不得只改一個 query。

## 3. 三條聊天路徑的明確行為

### 3.1 Normal send

1. user message 照舊先保存；
2. provider final outcome 是 success：照舊存 assistant success + SSE `done`；
3. outcome 是 policy_refusal：存一條 `outcome='policy_refusal'` 的特殊 row；
4. SSE 發 `type='refusal'`，帶 `message_id`、顯示文字與安全的短 reason；
5. 不發普通 `done`。

### 3.2 Continue

- success 照舊新增 assistant success；
- refusal 新增特殊 refusal row；
- `getHistory()` 必須排除舊 refusal rows，避免再次餵給 provider；
- next `seq` 保持唯一且單調。

### 3.3 Regenerate

Regenerate 不能因一次拒絕覆蓋原本有效回答：

- success：維持現有 `regen_versions` 行為；
- refusal：原 `content`、`regen_idx`、success versions 不變；
- 將拒絕 attempt 以帶 `outcome='policy_refusal'` 的 version metadata 保存，或採另一個同等可審計且
  不進 history 的最小表示；
- SSE 發 `refusal`；UI 保留原回答並顯示「這次重新生成被拒絕」；
- 不把 refusal version 設為目前 active answer。

若使用 `regen_versions`，舊 version object 沒有 outcome 時視為 success；branch serialization/restoration
必須保留新欄位，不能切換分支後丟失或把拒絕變成功。

## 4. 必須清查的所有資料消費者

不能只改 INSERT。開工時以 `rg "FROM messages|INSERT INTO messages|UPDATE messages" src test` 重新列清單，
至少處理目前這些位置：

| 消費者 | 要求 |
|---|---|
| `getHistory()` / normal send history | 只送 user + outcome=success assistant；排除 refusal |
| regenerate 的 last AI 選擇 | 只選可 regenerate 的 success assistant，不把 refusal 當原回答 |
| continue | history 排除 refusal |
| GET chat | 回傳 `outcome`/安全 reason，供 UI 特殊渲染 |
| edit branch tail JSON | 保存 outcome/provider_reason；舊 branch 缺欄位時 default success |
| branch restore INSERT | 還原 outcome，不得一律變 success |
| `src/memory.js::extractInsights` | SQL 層排除 refusal，不能只靠 prompt 告訴模型忽略 |
| `src/carryover.js` | refinement transcript 排除 refusal；last_seq/idempotency 語義要有測試 |
| `src/routes/papers.js` refine count | refusal 不得讓「對話足夠」門檻虛增 |
| 任何未來 transcript exporter | 預設排除，除非明確是 audit view |

user message 不排除。這表示「問題曾被問過」仍保留，但拒絕內容不會成為研究知識。

## 5. SSE 與前端

### 5.1 Protocol

在既有 `delta/done/error` 外新增：

```json
{
  "type": "refusal",
  "message_id": "...",
  "message": "使用者可見但不含敏感 provider raw body 的說明",
  "reason": "policy_refusal"
}
```

前端 `readSSEStream()` 新增 `onRefusal`，未知 event 仍不得 throw。不要把 refusal 復用成 `error`，因為 UI、
重試與 telemetry 需要區分；也不要同時呼叫 `onDone`。

### 5.2 UI

- 收到 refusal 時清除普通 streaming bubble；
- reload messages 後以明確但不驚嚇的特殊卡片顯示；
- 文案說明「模型拒絕了這次回答」，不是「研究內容有害」或「使用者做錯」；
- 保留原 user message；
- regenerate refusal 保留原有效回答；
- 不在本工單新增「自動換模型」按鈕；未來第二意見必須是使用者可見、手動觸發。

## 6. 空輸出與其他錯誤

- success + 空 content 不得寫空 assistant success；應走 `empty_response` error；
- partial delta 後 transport/malformed error 不保存成 success；UI 清理 streaming state；
- 429/5xx 顯示 provider error，不存 policy refusal；
- policy refusal 即使帶文字也不進研究 history；
- route log 只記 paper id、outcome class、字數等 content-free metadata，不記 refusal body。

## 7. 必測矩陣

### 7.1 Route × outcome

| Route | success | policy refusal | transport/malformed |
|---|---|---|---|
| normal send | user + assistant success；done | user + typed refusal；refusal event；無 done | user 保留；無 assistant success |
| continue | 新 assistant success | typed refusal；history 不污染 | 無 success row |
| regenerate | 更新 active success/version | 原 success 不變；refusal attempt 不 active | 原 success 不變 |

### 7.2 Persistence/downstream

- migration 對 fresh DB 與舊 DB 都可重跑；
- 舊 message/outcome 缺省為 success；
- GET chat round-trip outcome；
- reload 後 refusal UI 仍可見；
- next chat request body 不含 refusal content；
- `extractInsights` transcript 不含 refusal；
- carryover/refine transcript 不含 refusal，但 user question 是否包含必須符合已定語義；
- branch save/restore 不改 outcome；
- version switching 不把 refusal attempt 變 active success；
- 日誌不含 fixture refusal text/raw body。

### 7.3 Frontend

- `onRefusal` 只觸發一次；
- 不觸發 `onDone`；
- streaming state 必定回到 false；
- normal error/refusal 使用不同畫面狀態；
- existing success delta/done regression 不變。

## 8. Test teardown gate

目前正式 `npm test` 曾重現 `test/chat.test.js` pending、全套 33 pass/1 cancelled。這張工單會增加 route/server
測試，因此交付前必須：

1. 確保每個測試關閉自己啟動的 server、reader、response body 與 DB；
2. 若 cancellation 來自既有測試，做最小 teardown 修復並獨立標示 changed lines；
3. 不得用 `--test-force-exit`、縮短 timeout 或忽略 cancelled 來製造綠色；
4. 完整 `npm test` 必須 0 fail、0 cancelled 才能通過整組最終 gate。

## 9. 交付標準（DoD）

- refusal 狀態可 reload、可識別；
- 不進普通 history、insights、carryover/refinement；
- normal/continue/regenerate 全部按矩陣工作；
- regeneration refusal 不覆蓋有效答案；
- SSE/UI 明確區分 refusal 與 error；
- 無背景自動 fallback；
- schema migration idempotent，測試不碰真 DB；
- targeted backend/frontend tests 全綠；
- `npm test` 0 fail、0 cancelled；若 frontend 有獨立 test/build，亦需跑其既有正式命令；
- `git diff --check` 全綠；
- 不改 production、`.env`、模型預設、Research Gateway 或 AGY。

## 10. 回滾

- 程式回滾可停止讀寫新 outcome；DB 新欄位保留無害，舊版會忽略；不得為回滾 drop table/column；
- 所有舊 success row 保持不變；
- 若回滾 UI/SSE，backend contract 也要一起回到相容版本，避免前端永遠等待 done；
- 不刪除已保存的 refusal audit row。若舊版會把它重新注入 history，回滾前必須先保留 outcome filter，
  或整組一起退到已證明不污染的版本。
