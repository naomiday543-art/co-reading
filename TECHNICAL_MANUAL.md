# Co-Reading 技術手冊

> 給未來要維護、擴展、或將本系統與外部「研究記憶庫」（如 research gateway）整合的工程師。
> 本手冊聚焦在數據模型、模組職責、API、與整合面，不重複 README 已有的「快速開始」內容。

---

## 1. 系統定位

Co-Reading 是一個**單用戶、本地優先**的論文共讀工作流。一個用戶上傳 PDF，AI 通讀生成結構化摘要，用戶與 AI 圍繞論文對話，討論中產生的「洞察」被結構化保存並支援跨論文檢索。

設計取向：
- **本地優先**：SQLite + 本地檔案系統，無需雲依賴
- **AI provider 解耦**：同時支援 Anthropic 與 OpenAI 兩種 wire format，可分別配置「討論模型」和「通讀模型」
- **記憶累積為核心資產**：messages 是短期過程，insights 是長期沉澱

---

## 2. 架構總覽

```
┌────────────────────────────────────────────────────────────────┐
│  Frontend (React 19 + Vite)                                    │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐             │
│  │ Library     │  │ PaperDetail │  │ Settings    │             │
│  └─────────────┘  └──────┬──────┘  └─────────────┘             │
│                          │ ChatPanel / SummaryView /           │
│                          │ InsightsPanel / FullTextView        │
│                          ▼                                     │
│         api.js (fetch + SSE)  store.js (zustand)               │
└─────────────────────────┬──────────────────────────────────────┘
                          │ HTTP / SSE
┌─────────────────────────▼──────────────────────────────────────┐
│  Backend (Express 5)                                           │
│  /api/papers   /api/papers/:id/chat   /api/insights ...        │
│       │             │                       │                  │
│       ▼             ▼                       ▼                  │
│   papers.js     chat.js                memory.js               │
│       │             │                       │                  │
│       └─────────────┼───────────────────────┘                  │
│                     ▼                                          │
│              ai.js (Anthropic / OpenAI)                        │
│                     │                                          │
│  ┌──────────────────┴─────────────────┐                        │
│  │ db.js (better-sqlite3, WAL, FTS5)  │  search.js (FTS5)      │
│  └────────────────────────────────────┘                        │
└────────────────────────────────────────────────────────────────┘
                          │
                ┌─────────▼─────────┐
                │ data/             │
                │   co-reading.db   │
                │   pdfs/*.pdf      │
                └───────────────────┘
```

---

## 3. 技術棧

| 層 | 選擇 | 為何 |
|----|------|------|
| 前端 | React 19 + Vite 6 + zustand 5 | 輕量、build 快、無 SSR 需求 |
| CSS | Tailwind CDN | 不引入 build 步驟，原型優先 |
| Markdown | react-markdown + remark-gfm | AI 回覆需要渲染表格、代碼塊 |
| 後端 | Express 5 (ESM) | 熟悉、生態成熟、SSE 友善 |
| 數據庫 | better-sqlite3 (sync) + WAL + FTS5 trigram | 單進程、零 ops；trigram 支援中英混排檢索 |
| PDF | pdf-parse | 純文本提取，掃描版會 fallback 為錯誤狀態 |
| AI | 自寫雙格式適配層（Anthropic + OpenAI） | 不依賴 SDK；同一介面切換 provider |
| ID | nanoid | URL-safe、長度可控 |
| 測試 | `node --test`（內建） | 零依賴 |

---

## 4. 目錄結構

```
co-reading/
├── src/                            # 後端
│   ├── server.js                   # Express 主入口，路由註冊
│   ├── db.js                       # SQLite 初始化 + idempotent migration
│   ├── ai.js                       # AI provider 適配 + 論文對話 prompt
│   ├── memory.js                   # 從對話提取結構化洞察
│   ├── search.js                   # FTS5 + LIKE fallback 檢索
│   ├── pdf.js                      # PDF 文本提取
│   ├── logger.js                   # 簡單 ring-buffer 日誌
│   └── routes/
│       ├── papers.js               # 論文 CRUD、上傳、通讀觸發、洞察提取
│       ├── chat.js                 # 討論 (SSE) + regenerate/continue/edit/branch-switch
│       ├── insights.js             # 洞察 CRUD + 相關洞察查詢
│       ├── tags.js                 # 標籤 CRUD
│       └── tree.js                 # 知識樹 CRUD
├── frontend/src/
│   ├── App.jsx, main.jsx
│   ├── api.js                      # fetch 封裝 + SSE reader
│   ├── store.js                    # zustand 全局狀態
│   ├── pages/
│   │   ├── Library.jsx
│   │   ├── PaperDetail.jsx
│   │   └── Settings.jsx
│   └── components/
│       ├── ChatPanel.jsx           # 含 regenerate / edit / branch UI
│       ├── SummaryView.jsx         # 結構化摘要展示
│       ├── InsightsPanel.jsx, InsightCard.jsx, InsightForm.jsx
│       ├── FullTextView.jsx        # 原文閱讀 + annotation
│       ├── Sidebar.jsx, TreeNode.jsx
│       ├── PaperCard.jsx, TagBadge.jsx
│       └── UploadZone.jsx
├── test/
│   └── chat.test.js                # node:test 測試
├── data/                           # gitignore
│   ├── co-reading.db
│   └── pdfs/
└── electron.js                     # Electron 包裝（可選）
```

---

## 5. 數據模型

所有表定義在 [src/db.js](src/db.js)。SQLite + `journal_mode=WAL` + `foreign_keys=ON`。

### 5.1 `papers` — 論文

| 欄位 | 類型 | 說明 |
|------|------|------|
| `id` | TEXT PK | nanoid |
| `title`, `authors`, `year`, `doi` | | 元數據（AI 通讀時自動填，可手動覆蓋） |
| `pdf_filename` | TEXT | 對應 `data/pdfs/<filename>` |
| `full_text` | TEXT | PDF 提取的純文本；空字串代表掃描版 |
| `summary_bg`, `summary_methods`, `summary_results`, `summary_conclusions`, `summary_limitations` | TEXT | AI 通讀結構化摘要 |
| `status` | TEXT | `unread` / `reading` / `done` |
| `notes` | TEXT | 用戶 Markdown 筆記 |
| `tree_node_id` | FK → tree_nodes | 所在知識樹節點，可為 NULL |
| `analyze_status` | TEXT | `pending` / `analyzing` / `done` / `error` |
| `analyze_error` | TEXT | 失敗訊息 |
| `created_at`, `updated_at` | INT | ms timestamp |

### 5.2 `messages` — 討論訊息

| 欄位 | 類型 | 說明 |
|------|------|------|
| `id` | TEXT PK | nanoid |
| `paper_id` | FK → papers (CASCADE) | |
| `role` | TEXT | `user` / `assistant` |
| `content` | TEXT | 當前展示的內容（重新生成後是最新版本） |
| `created_at` | INT | ms |
| `seq` | INT | 同 paper 內嚴格遞增，分支操作依賴此 |
| `regen_versions` | TEXT (JSON) | `[{id, content, ts}, ...]`，僅 assistant；無重新生成時為 NULL |
| `regen_idx` | INT | 當前展示是第幾版（0-based） |
| `edited` | INT | 0/1，僅 user |
| `edit_branches` | TEXT (JSON) | `[{id, original_content, tail_count, ts}, ...]`；指向 `message_branches.id` |

索引：
- `idx_msg_paper_seq UNIQUE (paper_id, seq)` — 保證順序唯一
- `idx_msg_paper (paper_id, created_at)` — 舊索引保留

### 5.3 `message_branches` — 編輯分支快照

| 欄位 | 類型 | 說明 |
|------|------|------|
| `id` | TEXT PK | |
| `paper_id` | FK → papers (CASCADE) | |
| `fork_message_id` | TEXT | 分叉點所在的 message id |
| `tail_json` | TEXT | 從分叉點開始的完整 messages 序列化（含 regen 字段） |
| `created_at` | INT | |

> 一個分支被「切換回去」後該行會被刪除（當前對話會被存成新分支取代）。

### 5.4 `insights` — 洞察（**長期記憶資產**）

| 欄位 | 類型 | 說明 |
|------|------|------|
| `id` | TEXT PK | |
| `dimension` | TEXT | 六維分類：`概念` / `延伸` / `你的研究` / `闪回` / `共振` / `悬题` |
| `title` | TEXT | 短摘（≤80 字） |
| `content` | TEXT | 完整內容 |
| `source_paper_id` | FK → papers (SET NULL) | 來源論文，論文刪除後 SET NULL 不丟洞察 |
| `source_context` | TEXT | 來源對話片段（提取時 keyword match 抽取） |
| `tags_json` | TEXT (JSON array) | `["tag1", "tag2"]` |
| `created_at`, `updated_at` | INT | |

對應的 FTS5 表 `insights_fts`：
```sql
CREATE VIRTUAL TABLE insights_fts USING fts5(
  title, content, source_context,
  tokenize='trigram'
);
```
透過三個 trigger（`insights_fts_ai/ad/au`）與主表同步。trigram tokenizer 支援中英混排。

### 5.5 其他表

| 表 | 用途 |
|----|------|
| `tags` + `paper_tags` | 全局標籤系統 |
| `tree_nodes` | 知識樹（巢狀分類） |
| `annotations` | 原文標註與評論 |
| `section_progress` | 逐節閱讀進度 |
| `settings` | API key 等 key-value 配置 |

---

## 6. 後端模組

### 6.1 `db.js`
- 單例 better-sqlite3 instance，整個應用共用
- 啟動時：CREATE TABLE IF NOT EXISTS + idempotent ALTER（用 `PRAGMA table_info` 檢測）
- 暴露 `getSetting / setSetting / getSettings` 給配置層
- **改 schema 必須是 idempotent**，因為這檔在每次啟動都跑

### 6.2 `ai.js`
- `getChatConfig()` / `getAnalyzeConfig()` — 從 settings 表或環境變量解析（DB > env）
- `buildHeaders / buildBody / buildEndpoint` — 雙 wire format 切換的核心
- `streamAnthropic / streamOpenAI` — async generator 統一 streaming 介面
- `analyzePaper(fullText)` — non-streaming，要求模型輸出嚴格 JSON 結構化摘要
- `chatAboutPaper(paper, history, userMessage, onChunk)` — 主對話入口
  - 系統 prompt 分兩段：stable（含全文）+ variable（注入的 insights）
  - Anthropic format 時對 stable 段加 `cache_control: ephemeral`，第二輪起 prompt cache 生效
  - `userMessage = null` 表示「不附加 user 消息」，用於 regenerate / continue
- `testConnection(config)` — Settings 頁面試 API 連通性

### 6.3 `memory.js` — 洞察提取（**整合面重點**）
- `extractInsights(paperId)`：
  1. 讀 `messages` 全部（ORDER BY seq）
  2. 拼成對話 transcript
  3. 用 `EXTRACT_PROMPT` 調 AI，要求輸出 `{entries: [{type, content}]}`
  4. `type` 三類：
     - `fact` → 寫入 insights，dimension = `概念`
     - `hypothesis` → 寫入 insights，dimension = `悬题`
     - `progress` → **不寫入**，只 log（屬於進度，不屬於知識）
  5. 為每條洞察用 keyword match 抽取 `source_context`（對話原文片段）
  6. 回傳 `{insights: [...], skipped: N}`

> 這個提取邏輯是 memory 與 research gateway 整合時最關鍵的入口。詳見第 10 節。

### 6.4 `search.js`
- `searchInsights(query, {excludePaperId, limit})`：≥3 字走 FTS5 trigram；2 字走 LIKE fallback
- `findRelatedInsights(paperId, max)`：用論文 title 檢索其他論文的洞察，不足時補上 tag-based 檢索
- 對話時被 `chatAboutPaper` 調用，注入跨論文相關洞察到 variable system prompt

### 6.5 `pdf.js`
- 用 `pdf-parse` 提取純文本
- 文本長度 < 100 字視為掃描版，throw `SCANNED_PDF` error code
- 上層 `papers.js` 捕獲後將論文標記為 error

### 6.6 `logger.js`
- 寫檔案 + ring buffer（記憶體保留最近 N 條）
- `getRecentLogs(lines)` 供 `GET /api/logs` 使用

---

## 7. 後端 API 參考

掛載順序見 [src/server.js](src/server.js)：`papers` → `chat` → `tags` → `tree` → `insights` 都以 `/api` 為前綴。

### 7.1 論文管理

| Method | Path | 說明 |
|--------|------|------|
| POST | `/api/papers/upload` | multipart，欄位名 `files`，可選 `tree_node_id`；上傳後非同步觸發通讀 |
| GET | `/api/papers` | 列表，支援 `?status`, `?tag`, `?tree_node_id` (`__none` 為未分類), `?q`, `?sort=title\|created\|updated` |
| GET | `/api/papers/:id` | 含 tags 與 tree_node |
| PATCH | `/api/papers/:id` | 部分更新（白名單：title, authors, year, doi, status, notes, tree_node_id） |
| DELETE | `/api/papers/:id` | 連帶刪除 PDF 檔案，message / annotation / section_progress 透過 FK CASCADE 一併刪 |
| GET | `/api/papers/:id/pdf` | 串流原始 PDF |
| POST | `/api/papers/:id/analyze` | 觸發（或重跑）通讀 |
| POST | `/api/papers/:id/extract-insights` | 從討論提取洞察 |

### 7.2 對話（SSE）

| Method | Path | Query | 說明 |
|--------|------|-------|------|
| POST | `/api/papers/:id/chat` | — | 正常發送：寫 user 消息 + 流式生成 assistant |
| POST | `/api/papers/:id/chat` | `?regenerate=true` | 在最後一條 assistant 上追加新版本；最後一條不是 assistant 時返回 400 |
| POST | `/api/papers/:id/chat` | `?continue=true` | 不寫 user，基於現有歷史生成新 assistant（編輯後自動觸發） |
| POST | `/api/papers/:id/chat/edit` | — | body: `{msg_id, content}`；保存 tail 為分支、截斷對話、更新 user 消息 |
| POST | `/api/papers/:id/chat/branch/switch` | — | body: `{fork_id, branch_id}`；事務內完成快照當前 tail + 還原目標分支 |
| GET | `/api/papers/:id/chat` | — | 回傳含 `regen_versions`, `regen_idx`, `edited`, `edit_branches` 的解析後 JSON |

**SSE 協議**（所有 streaming 端點共用）：
```
data: {"type":"delta","content":"..."}\n\n
data: {"type":"done","message_id":"..."}\n\n
data: {"type":"error","message":"..."}\n\n
```

### 7.3 洞察

| Method | Path | 說明 |
|--------|------|------|
| GET | `/api/insights` | `?dimension`, `?source_paper_id` |
| GET | `/api/insights/related` | `?paper_id`：合併自身洞察 + FTS5 相關洞察 |
| GET | `/api/insights/:id` | |
| POST | `/api/insights` | `{dimension, title, content, source_paper_id?, source_context?, tags?}` |
| PATCH | `/api/insights/:id` | 部分更新（含 dimension 校驗） |
| DELETE | `/api/insights/:id` | |

### 7.4 標籤 / 樹 / 設定 / 日誌

| Method | Path | 說明 |
|--------|------|------|
| GET/POST/DELETE | `/api/tags` | |
| POST/DELETE | `/api/papers/:id/tags` / `/api/papers/:id/tags/:tagId` | |
| GET/POST/PATCH/DELETE | `/api/tree` | |
| GET/PUT | `/api/settings` | 配置儲存於 `settings` 表 |
| POST | `/api/settings/test` | 試 API 連通性 |
| GET | `/api/logs?lines=N` | |

---

## 8. 前端結構

### 8.1 路由
- 單頁應用，路由由 `App.jsx` 簡單分發（無 react-router）
- 三個 page：`Library`（列表）/ `PaperDetail`（單篇）/ `Settings`

### 8.2 狀態
- `store.js`（zustand）：全局共用的論文列表、選中 paper id、tree 狀態
- 局部狀態用 `useState`，例如 ChatPanel 的 messages

### 8.3 ChatPanel 關鍵狀態（[ChatPanel.jsx](frontend/src/components/ChatPanel.jsx)）

| state | 用途 |
|-------|------|
| `messages` | 當前可見對話 |
| `streaming` / `streamingContent` | 流式回覆中的暫存內容 |
| `editingMsgId` / `editContent` | 編輯模式 |
| `showBranchesFor` | 哪條消息打開了編輯歷史下拉（單一） |

關鍵函數：
- `handleSend` — 正常發送
- `handleRegenerate` — 調 `regenerate=true` SSE
- `handleSaveEdit` — 先 `edit`，再 `continue=true` SSE
- `handleSwitchVersion(messageId, direction)` — 純前端切換 `regen_versions`，不持久化（重新 load 後會被覆蓋為後端最新版）
- `handleSwitchBranch(forkId, branchId)` — 呼叫 `/branch/switch` 後 `loadMessages`
- `switchVersion` 純函數抽出供測試（test/chat.test.js 覆蓋 6 個 case）

---

## 9. 關鍵流程

### 9.1 PDF 上傳 → 通讀
```
client POST /api/papers/upload (multipart)
  → multer 寫到 data/pdfs/<nanoid>.pdf
  → pdf-parse 提取 full_text
  → INSERT papers (status=unread, analyze_status=pending)
  → 非同步觸發 triggerAnalyze(id)：
      UPDATE analyze_status=analyzing
      → analyzePaper(full_text)  [non-streaming, JSON output]
      → UPDATE summary_* + analyze_status=done
  → 立即回覆 client（不等通讀完）
```

### 9.2 討論 + Prompt Cache
```
POST /api/papers/:id/chat {message}
  → INSERT user message
  → 取整段歷史（不含剛存的 user，避免 prompt 裡重複）
  → chatAboutPaper(paper, history, message):
      systemForRequest = [
        {text: stableSystem, cache_control: ephemeral},  // 全文+指令，命中 cache
        {text: insightText},                              // 注入的洞察，每輪變化
      ]
      → SSE 流式回覆
  → 流結束後 INSERT assistant message
```

第二輪起：Anthropic 端會命中 prompt cache，論文全文那段 token 費用大幅下降。

### 9.3 重新生成 / 編輯 / 分支切換
- 詳見第 5.2 / 5.3 節數據模型
- 寫操作（edit / branch-switch）全在 `db.transaction()` 內，AI 不參與，失敗只會 throw 不破壞數據
- regenerate 中 AI 失敗：`regen_versions` 不變，原內容保留

### 9.4 洞察提取與注入
```
[用戶手動] POST /api/papers/:id/extract-insights
  → memory.js extractInsights(paperId)
  → AI 輸出 {entries: [{type, content}]}
  → fact → INSERT insights(dimension=概念)
    hypothesis → INSERT insights(dimension=悬题)
    progress → 跳過，僅 log

[每輪討論] chatAboutPaper 自動：
  → 取自身洞察最近 5 條
  → searchInsights(userMessage, exclude=本論文) 取跨論文相關洞察
  → 拼成 variable 系統提示注入
```

---

## 10. 配置與部署

### 10.1 環境變量（`.env`）
```env
AI_BASE_URL=https://api.anthropic.com/v1
AI_API_KEY=sk-...
AI_MODEL=claude-sonnet-4-6
AI_FORMAT=anthropic

# 通讀模型（可選，省錢）
ANALYZE_BASE_URL=https://api.deepseek.com/v1
ANALYZE_API_KEY=sk-...
ANALYZE_MODEL=deepseek-chat
ANALYZE_FORMAT=openai

PORT=3456
```

### 10.2 設定優先級
DB `settings` 表 > 環境變量。Settings 頁面修改會即時生效，無需重啟。

### 10.3 部署形態
- **本地 dev**：`npm start`（concurrent 跑 `node server.js` + `vite`）
- **Production web**：`npm run build` 產出 `dist/`，server.js 自動 fallback 為 static + SPA
- **Electron 包裝**：`electron.js`、`npm run build:mac` / `npm run build`

---

## 11. 整合面：與外部記憶庫合併

> 本節為 future work 參考。若整合 research gateway 或 [[memory-universe]] 之類的外部記憶系統，這是切入點。

### 11.1 記憶資產對應

| Co-Reading 概念 | 在外部記憶庫的可能映射 |
|----------------|---------------------|
| `insights`（六維洞察） | 長期語義記憶條目 |
| `insights.source_paper_id` + `source_context` | 來源溯源 |
| `papers.summary_*` | 文獻摘要記憶（粗粒度） |
| `messages` | 過程性對話，**通常不直接同步**，只透過 `extractInsights` 蒸餾後輸出 |
| `tree_nodes` + `paper_tags` | 領域/標籤層級結構 |

### 11.2 同步方向選擇

**A. 單向匯出（co-reading → 記憶庫）**
- 最簡單。在 `extractInsights` 寫入本地後，多寫一份到外部 API
- 改動點：[src/memory.js:216](src/memory.js:216) INSERT 之後加 `await syncToGateway(insight)`
- 建議用 outbox pattern：先寫本地，再用獨立 worker 補同步（避免 AI 流程被外部依賴拖慢）

**B. 雙向同步**
- 需要解決衝突（更新時間、刪除傳播、ID 對應）
- 建議：新增 `insights.external_id` 與 `synced_at` 欄位，定時拉取 + diff
- 跨論文檢索（[search.js findRelatedInsights](src/search.js)）可改為「本地 FTS5 + 遠端 vector」混合排序

**C. 讀時聯合（co-reading 只查不存）**
- `chatAboutPaper` 注入 insights 那段（[ai.js:303](src/ai.js:303)）改為查詢外部記憶庫
- 適合外部已有龐大語料、co-reading 只是其中一個前端

### 11.3 建議的最小整合接口

如果外部記憶庫提供以下 4 個 endpoint，整合最順：

```
POST   /memory/insights              # 寫入一條
GET    /memory/insights?q=...&exclude_source=... # 全文檢索
POST   /memory/insights/:id/link     # 關聯到本地 source（paper_id, message_id 等）
DELETE /memory/insights/:id
```

對應的 co-reading 改動：
1. 在 `settings` 表加 `gateway_url` / `gateway_token`
2. 新增 `src/gateway.js` 封裝 4 個調用
3. 在 [memory.js extractInsights](src/memory.js:158) 結束處 fire-and-forget 同步
4. 在 [search.js searchInsights](src/search.js:7) 改為先查本地，命中數不足時補查 gateway

### 11.4 跨系統 ID 策略
- co-reading 用 nanoid（21 字），URL-safe
- 若 gateway 用自己的 ID 系統，建議：
  - 本地 insights 永遠以 nanoid 為主 PK
  - 加 `external_id TEXT UNIQUE` 對應 gateway ID
  - 同步 conflict 時以 `updated_at` 較新者勝（last-write-wins）

### 11.5 注意事項
- **不要把 messages 全量同步到外部**：原始對話可能含敏感推測或半成品，蒸餾後的 insights 才是正式記憶
- **source_context 是來源證據**：整合時保留這個欄位，否則洞察脫離上下文後可信度下降
- **dimension 是 co-reading 特定的 ontology**：六維分類（概念/延伸/你的研究/闪回/共振/悬题）外部系統未必對齊，建議在同步時保留原 dimension 並加 mapping 層

---

## 12. 測試

- `npm test` 跑 `node --test test/*.test.js`
- 當前覆蓋（[test/chat.test.js](test/chat.test.js)）：
  - chat/edit happy path + 非 user 400
  - branch/switch happy path + 404
  - regenerate 無 AI 消息 400
  - `switchVersion` 純函數 6 case
- 擴充建議：洞察提取的 happy path、跨論文檢索的 FTS5 fallback、settings 寫入後的 config 生效

---

## 13. 已知限制與待辦

| 項 | 說明 |
|----|------|
| 單用戶 | 沒有 auth，所有資源都屬於本地用戶 |
| 沒有 GC | `message_branches` 多次切換後會累積，無自動清理 |
| 編輯後 regenerate 版本不持久 | 前端切換 `regen_versions` 不寫回後端，重 load 即被覆蓋 |
| `tail_json` > 1MB 只 warn | 沒有上限保護，極長對話有潛在隱患 |
| FTS5 trigram 索引大小 | 中文 trigram 索引膨脹較快，洞察條目 ≥ 萬級時要評估 |
| Settings 無加密 | API key 明文存 SQLite，本地用無虞，雲端部署需審視 |

---

## 14. 參考檔案索引

| 主題 | 檔案 |
|------|------|
| Schema | [src/db.js](src/db.js) |
| 對話路由（含 regenerate/edit/branch） | [src/routes/chat.js](src/routes/chat.js) |
| AI 適配層 | [src/ai.js](src/ai.js) |
| 洞察提取 | [src/memory.js](src/memory.js) |
| 跨論文檢索 | [src/search.js](src/search.js) |
| ChatPanel | [frontend/src/components/ChatPanel.jsx](frontend/src/components/ChatPanel.jsx) |
| API 客戶端 | [frontend/src/api.js](frontend/src/api.js) |
| 測試 | [test/chat.test.js](test/chat.test.js) |
