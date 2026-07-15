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

## 11. 整合面：與 research-gateway 合併

> **整合對象與方案已定**（2026-07-02）：對象是 research-gateway（+ 其背後的 Ombre :8001）。
> 兩邊共同的契約——傳輸方式、tag 規範、dimension 映射、同步方向、ID 對應——
> **唯一依據是 gateway 側的 [CO-READING-INTEGRATION.md](../research-gateway/docs/CO-READING-INTEGRATION.md)**，
> gateway 手冊（HANDBOOK §6.5）也指向同一份。本節只保留 co-reading 側的資產說明與改動點；
> 若本節與契約文檔衝突，以契約文檔為準。

### 11.1 記憶資產對應

| Co-Reading 概念 | 在外部記憶庫的可能映射 |
|----------------|---------------------|
| `insights`（六維洞察） | 長期語義記憶條目 |
| `insights.source_paper_id` + `source_context` | 來源溯源 |
| `papers.summary_*` | 文獻摘要記憶（粗粒度） |
| `messages` | 過程性對話，**通常不直接同步**，只透過 `extractInsights` 蒸餾後輸出 |
| `tree_nodes` + `paper_tags` | 領域/標籤層級結構 |

### 11.2 已定方向：單向匯出（outbox）

三個定案（詳見契約文檔 §一）：

1. **單向匯出**：co-reading → gateway → Ombre。原本評估過的雙向同步、讀時聯合兩案
   已寫入契約文檔的觸發條件，單向跑穩前不做。
2. **傳輸走 gateway 的 `POST /memory/insights`**，不直連 Ombre（:8001 只在 VPS 內網）。
   請求體格式、tag 規範（`source:co-reading` / `paper:<id>` / `dim:<dimension>` / `tree:<path>`）、
   六維 dimension → Ombre 類型的映射表，全部見契約文檔 §二–§四。
3. **outbox 模式**：先寫本地成功，再 fire-and-forget 同步；失敗靠 `synced_at IS NULL` 補傳，
   `external_id` 冪等鍵防重複。AI 提取流程永遠不等外部網路。

### 11.3 co-reading 側改動點（對應契約文檔 §八）

1. `settings` 表加 `gateway_url` / `gateway_token`（Settings 頁可配）
2. 新增 `src/gateway.js`：封裝 POST + 啟動時補傳 `synced_at IS NULL` 的條目
3. [src/db.js](src/db.js)：`insights` 加 `external_ombre_id TEXT UNIQUE`、`synced_at INTEGER`
   （記得走 idempotent migration，見 §6.1）
4. 在 [memory.js extractInsights](src/memory.js:158) 寫入本地成功後 fire-and-forget 同步
5. （後續，讀方向）[search.js searchInsights](src/search.js:7) 命中不足時補查 gateway——
   契約文檔已明確**先不做**，等本地 FTS5 不夠用再說

### 11.4 跨系統 ID 策略
- 本地 insights 永遠以 nanoid（21 字，URL-safe）為主 PK
- `external_ombre_id TEXT UNIQUE` 對應 Ombre 側 ID（由 gateway 端點回傳）
- 同步 conflict 時以 `updated_at` 較新者勝（last-write-wins）——單向匯出下幾乎不會觸發

### 11.5 注意事項（已升格為契約條款，見契約文檔 §五）
- **不要把 messages 全量同步到外部**：原始對話可能含敏感推測或半成品，蒸餾後的 insights 才是正式記憶
- **source_context 是來源證據**：同步時必帶，否則洞察脫離上下文後可信度下降
- **dimension 是 co-reading 特定的 ontology**：同步時原 dimension 進 `dim:` tag 保留，
  Ombre 側粗類型映射只在 gateway 端點裡做，調整映射不需要動 co-reading

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

## 14. 已知問題追蹤（依重要程度）

> 2026-07 debug session 整理。含已修復項目（供未來回溯改動原因）與待決策項目（含已否決的方案與理由，避免重複評估）。

### 14.1 已修復

| 問題 | 根因 | 修法 | 位置 |
|------|------|------|------|
| 開啟論文後閒置一段時間會跳回首頁 | `App.jsx` 的 `page`/`paperId` 只存在 React state，沒有任何持久化；一旦發生整頁 reload（瀏覽器分頁休眠、renderer 重載等，觸發源未完全定位），state 歸零回到預設的 `library` | `navigate()` 時把 `{page, paperId}` 寫入 `sessionStorage`，`App` mount 時讀回還原 | [App.jsx](frontend/src/App.jsx) |
| 無全螢幕功能 | 未實作 | 用標準 Fullscreen API（`requestFullscreen`/`exitFullscreen`），header 加切換按鈕，`fullscreenchange` 事件同步圖示狀態。Electron 預設會把 HTML5 fullscreen 映射成原生視窗全螢幕，不需要額外 IPC/preload | [App.jsx](frontend/src/App.jsx) |

### 14.2 P1 — 待決策（已知問題，尚未修，需要使用者決定是否投入）

**PDF 原文選取只能靠系統剪貼簿，無法自動抓取選取文字**
- 現象：[ChatPanel.jsx:471-488](frontend/src/components/ChatPanel.jsx#L471-488) 的「貼上原文提問」讀的是 `navigator.clipboard.readText()`，從第一版就是如此，不是退化。
- 根因：[FullTextView.jsx:8-13](frontend/src/components/FullTextView.jsx#L8-13) 用 `<iframe src=".../pdf">` 直接嵌入，瀏覽器對 `application/pdf` 會用 Chromium 內建 PDF viewer 渲染——即使同源，外層 JS 也拿不到裡面的文字選取（`document.getSelection()` 讀不到），只能退而求其次讀剪貼簿，導致「忘記先 Cmd+C」時貼到的是舊剪貼簿內容。
- 可行修法：把 PDF 渲染從原生 iframe viewer 換成 `pdf.js`/`react-pdf` 自繪文字層，選取事件就在自己的 DOM 裡，可直接 `window.getSelection()` 抓取。
- 取捨：會失去原生 viewer 的縮放/搜尋/列印等免費功能，需自己補（可先不做，工作量中等，抓幾小時量級）。
- 狀態：使用者已了解取捨，暫緩決定。

### 14.3 P2 — 已確認、影響小（低優先）

**PDF 抽取：作者/機構編號上標被拆成獨立行**
- 現象：實測 [src/pdf.js](src/pdf.js)（`pdf-parse`）對三篇 Nature 系列論文的抽取結果，作者名後的機構編號上標（如 `Horacio Cabral <newline> 1,5`）被拆到獨立一行，跟人名斷開。
- 根因：`pdf-parse`／`pdfjs` 預設文字抽取用 Y 座標跳動判斷換行，上標的垂直偏移被誤判成換行，沒有專門的上標偵測。
- 影響評估：**只出現在論文最前面的作者資訊區塊**，不影響正文。對 AI 通讀（`analyzePaper(paper.full_text)`，見 [papers.js:82](src/routes/papers.js#L82)）幾乎沒有影響，LLM 對這類 metadata 雜訊容忍度高；主要只影響人眼直接讀 raw 抽取文字時的觀感。
- 可行修法：不用 `pdf-parse`，改直接用 `pdfjs-dist` 拿每個文字區塊的座標＋字體大小，用「小字體＋垂直偏移＋緊跟在文字後」的特徵判斷是上標，接回原句而非另起一行。
- 狀態：優先度低，暫不修。

### 14.4 P3 — 理論風險、尚未實測到，待觀察

以下是 naive PDF 文字抽取的已知失敗模式，**目前手上三篇論文皆未觸發**，記錄下來是為了「哪天真的遇到再回來對照」，不建議預先加工：

| 風險 | 說明 | 實測結果 |
|------|------|---------|
| 雙欄內文交錯亂序 | 若 content stream 順序沒有照欄位分組，正文段落可能被拼接錯，直接影響 AI 通讀理解品質（比上標問題嚴重，因為會動到正文） | 已用 [w6zqpypAHSY6FLM2s5KXX.pdf](data/pdfs/w6zqpypAHSY6FLM2s5KXX.pdf) 隔了約 2500 字的兩段落抽取結果人工核對，段落完全連貫、無交錯——Nature 排版的 content stream 本身就是按欄位順序寫入，pdfjs 預設抽取剛好是對的 |
| Preview 版水印文字混入內文 | 出版社水印通常是旋轉貼圖/文字，若被當成一般文字抽取，可能夾雜進段落中間，污染 AI 通讀輸入 | 目前 library 三篇都是正式排版無水印版本，**沒有樣本可測**；水印通常是旋轉貼上去的，理論上可用 PDF 座標矩陣的旋轉分量偵測並過濾，但沒有實際檔案前無法驗證做法是否有效 |
| 非制式排版 PDF（單欄 preprint、轉檔工具產出）格式差異 | 上標偵測/雙欄判斷若寫死假設（例如「一定是兩欄」），套到單欄 preprint 反而可能把好好的文字切壞；不同引用格式（行內 `[12]` vs 真上標）失敗模式也不同 | 未實測，需要拿到實際檔案才能驗證 |
| 字型 subset 編碼錯誤 | 部分 PDF 產生工具的字型沒有正確 ToUnicode 對應表，會直接導致字元抽取錯誤/亂碼，這是完全不同類型的失敗（編碼問題，不是版面判斷問題），上標/欄位修法救不了 | 未實測 |
| Grobid（學術 PDF 專用結構化解析）評估 | 品質遠高於自寫規則，但官方建議至少 4GB RAM 給 JVM，完整版（含 DeLFT 深度學習模型）Docker image 磁碟佔用 5-6GB，且需常駐背景服務 | **已評估並否決**——對單用戶本地閱讀工具代價不成比例，除非未來需求變成「準確結構化引用/圖表資料庫」等級才值得重新評估 |

> 設計原則（供未來接手者參考）：規則式 PDF 抽取沒有「完美解」，只有「常見情況抓對、不確定時不要更糟」。任何修法都應該基於幾何量測（字體大小分佈、x 座標分群、旋轉角度）動態判斷，不要寫死特定出版社/排版模板；判斷信心不足時保留原始抽取結果，不要為了「智慧修正」把本來還能讀的文字弄得更亂。原生 PDF iframe（[FullTextView.jsx](frontend/src/components/FullTextView.jsx)）永遠是備援閱讀路徑，抽取文字只是加分的乾淨閱讀模式，不是唯一入口。

---

## 15. 參考檔案索引

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
