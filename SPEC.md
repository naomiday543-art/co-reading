# Co-Reading: AI 論文共讀系統 — 設計規格書

> 本文件是完整的實現規格。開發者照此文件實現，不需要額外溝通。

---

## 一、產品定位

一個**本地運行**的論文閱讀工具。用戶上傳 PDF → AI 通讀生成結構化摘要 → 跟 AI 討論論文 → 建立知識樹管理文獻。

目標用戶：科研人員（導師和學生），在自己電腦上跑，不需要服務器。

---

## 二、技術棧

| 層 | 選擇 | 理由 |
|---|---|---|
| 前端 | React 19 + Vite | 現代、快、生態好 |
| CSS | Tailwind CSS | 快速搭建，響應式 |
| 狀態管理 | zustand | 極輕量 |
| 後端 | Express 5 | 穩定、生態大 |
| 數據庫 | better-sqlite3 | 嵌入式，零配置，單文件 |
| PDF 解析 | pdf-parse | 純 Node.js，不需要額外依賴 |
| Markdown 渲染 | react-markdown + remark-gfm | 筆記和摘要渲染 |
| AI | 通過 OpenAI-compatible API 調用（支持 Anthropic / DeepSeek / OpenAI） |
| ID | nanoid | 短隨機 ID |
| 語言 | JavaScript (ESM)，不用 TypeScript |

### 項目結構

```
co-reading/
├── package.json
├── vite.config.js
├── .env.example          # API 配置模板
├── .env                  # 用戶填的（gitignore）
├── src/
│   ├── server.js         # Express 主入口
│   ├── db.js             # SQLite 初始化 + 查詢
│   ├── pdf.js            # PDF 文本提取
│   ├── ai.js             # AI API 調用（通讀 + 討論）
│   └── routes/
│       ├── papers.js     # 論文 CRUD + 上傳
│       ├── chat.js       # 論文討論（streaming SSE）
│       ├── tags.js       # 標籤 CRUD
│       └── tree.js       # 知識樹 CRUD
├── frontend/
│   ├── index.html
│   ├── src/
│   │   ├── main.jsx
│   │   ├── App.jsx
│   │   ├── store.js          # zustand store
│   │   ├── api.js            # fetch 封裝
│   │   ├── pages/
│   │   │   ├── Library.jsx       # 主頁：文獻列表 + 知識樹
│   │   │   ├── PaperDetail.jsx   # 論文詳情：摘要 + 討論
│   │   │   └── Settings.jsx      # 設定：API key
│   │   └── components/
│   │       ├── Sidebar.jsx       # 左側知識樹
│   │       ├── PaperCard.jsx     # 論文卡片
│   │       ├── ChatPanel.jsx     # AI 討論面板
│   │       ├── SummaryView.jsx   # 結構化摘要展示
│   │       ├── TagBadge.jsx      # 標籤徽章
│   │       ├── TreeNode.jsx      # 知識樹節點
│   │       └── UploadZone.jsx    # PDF 拖拽上傳
│   └── ...
├── data/                 # SQLite 文件 + 上傳的 PDF（gitignore）
│   ├── co-reading.db
│   └── pdfs/
└── README.md
```

### 啟動方式

```bash
# 首次
git clone <repo>
cd co-reading
npm install
cp .env.example .env     # 填入 API key
npm run dev              # 前後端同時啟動

# 之後
cd co-reading && npm run dev
```

`npm run dev` 必須一條命令同時啟動前端（Vite dev server）和後端（Express），使用 concurrently。

```json
{
  "scripts": {
    "dev": "concurrently \"node --watch src/server.js\" \"cd frontend && npx vite\"",
    "build": "cd frontend && npx vite build",
    "start": "node src/server.js"
  }
}
```

生產模式（`npm start`）Express 同時 serve `frontend/dist/` 靜態文件，端口 `3456`。

---

## 三、.env 配置

```env
# AI API 配置
AI_BASE_URL=https://api.anthropic.com/v1    # 或 https://api.deepseek.com/v1
AI_API_KEY=sk-xxx
AI_MODEL=claude-sonnet-4-6                  # 或 deepseek-chat
AI_FORMAT=anthropic                          # anthropic | openai

# 通讀用的模型（可選，默認用上面的）
ANALYZE_BASE_URL=https://api.deepseek.com/v1
ANALYZE_API_KEY=sk-xxx
ANALYZE_MODEL=deepseek-chat
ANALYZE_FORMAT=openai

# 服務端口
PORT=3456
```

支持兩套 API 配置：主模型用於討論（可以用 Claude），通讀用便宜模型（DeepSeek）省錢。如果 `ANALYZE_*` 沒填，就用主模型。

`AI_FORMAT` 決定 API 調用格式：
- `anthropic`: `POST /messages`，用 `x-api-key` header，body 格式 `{model, max_tokens, system, messages}`
- `openai`: `POST /chat/completions`，用 `Authorization: Bearer` header，body 格式 `{model, messages, stream}`

---

## 四、數據模型（SQLite）

```sql
-- 知識樹節點（分類文件夾）
CREATE TABLE IF NOT EXISTS tree_nodes (
  id          TEXT PRIMARY KEY,
  parent_id   TEXT REFERENCES tree_nodes(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
);

-- 論文
CREATE TABLE IF NOT EXISTS papers (
  id              TEXT PRIMARY KEY,
  title           TEXT NOT NULL DEFAULT '',
  authors         TEXT NOT NULL DEFAULT '',       -- 逗號分隔
  year            INTEGER,
  doi             TEXT,
  pdf_filename    TEXT,                           -- data/pdfs/ 下的文件名
  full_text       TEXT NOT NULL DEFAULT '',       -- 提取的全文

  -- AI 結構化摘要
  summary_bg          TEXT NOT NULL DEFAULT '',   -- 背景
  summary_methods     TEXT NOT NULL DEFAULT '',   -- 方法
  summary_results     TEXT NOT NULL DEFAULT '',   -- 結果
  summary_conclusions TEXT NOT NULL DEFAULT '',   -- 結論
  summary_limitations TEXT NOT NULL DEFAULT '',   -- 局限

  -- 狀態
  status          TEXT NOT NULL DEFAULT 'unread', -- unread | reading | done
  notes           TEXT NOT NULL DEFAULT '',       -- 用戶筆記（Markdown）

  -- 知識樹歸屬
  tree_node_id    TEXT REFERENCES tree_nodes(id) ON DELETE SET NULL,

  analyze_status  TEXT NOT NULL DEFAULT 'pending', -- pending | analyzing | done | error
  analyze_error   TEXT NOT NULL DEFAULT '',

  created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
  updated_at      INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
);

-- 論文討論歷史
CREATE TABLE IF NOT EXISTS messages (
  id          TEXT PRIMARY KEY,
  paper_id    TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  role        TEXT NOT NULL,                      -- user | assistant
  content     TEXT NOT NULL,
  created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
);
CREATE INDEX IF NOT EXISTS idx_msg_paper ON messages(paper_id, created_at);

-- 標籤
CREATE TABLE IF NOT EXISTS tags (
  id    TEXT PRIMARY KEY,
  name  TEXT NOT NULL UNIQUE,
  color TEXT NOT NULL DEFAULT '#6366f1'
);

-- 論文-標籤關聯
CREATE TABLE IF NOT EXISTS paper_tags (
  paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  tag_id   TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (paper_id, tag_id)
);
```

啟動時自動建表（`db.js` 裡用 `CREATE TABLE IF NOT EXISTS`）。

---

## 五、API 端點

後端端口 `3456`，前端 dev 模式用 Vite proxy 轉發 `/api/*`。

### 5.1 論文

```
POST   /api/papers/upload
  Content-Type: multipart/form-data
  Body: file (PDF), tree_node_id? (string)
  行為: 存 PDF 到 data/pdfs/，pdf-parse 提取全文，建立記錄
  返回: { id, title, status: 'unread', analyze_status: 'pending' }

GET    /api/papers
  Query: ?status=&tag=&tree_node_id=&q=
  返回: [{ id, title, authors, year, status, analyze_status, tags: [...], tree_node_id, created_at }]

GET    /api/papers/:id
  返回: 完整論文記錄 + tags 數組 + tree_node（含 name）

PATCH  /api/papers/:id
  Body: { title?, authors?, year?, doi?, status?, notes?, tree_node_id? }
  返回: 更新後的論文記錄

DELETE /api/papers/:id
  行為: 刪除記錄 + PDF 文件 + 關聯的 messages
  返回: { ok: true }

POST   /api/papers/:id/analyze
  行為: 
    1. 設 analyze_status = 'analyzing'
    2. 用論文 full_text 調 AI 生成結構化摘要
    3. 存入 summary_* 欄位，設 analyze_status = 'done'
    4. 嘗試從摘要中提取標題/作者/年份，回填空欄位
  如果 full_text 超過 100000 字符，截斷到前 100000（附截斷提示）
  出錯: 設 analyze_status = 'error'，analyze_error = 錯誤信息
  返回: { ok: true, analyze_status }
  （不阻塞，立即返回，後台處理。前端輪詢 GET /api/papers/:id 檢查狀態）
```

### 5.2 論文討論（Streaming）

```
POST   /api/papers/:id/chat
  Body: { message: string }
  Content-Type: application/json
  返回: SSE stream（text/event-stream）

  SSE 格式:
    data: {"type":"delta","content":"..."}
    data: {"type":"done","message_id":"..."}
    data: {"type":"error","message":"..."}

  行為:
    1. 存 user message 到 messages 表
    2. 構建上下文:
       - system: "你是科研導師，正在幫用戶閱讀和討論論文。"
       - 注入論文全文（作為第一條 user message 的前綴，或 system message 的一部分）
       - 注入 AI 摘要（如果有）
       - 加載該論文的討論歷史（最近 50 條）
    3. 調 AI（stream 模式）
    4. 邊收 stream 邊 SSE 推給前端
    5. stream 結束後存 assistant message 到 messages 表

GET    /api/papers/:id/chat
  返回: [{ id, role, content, created_at }]（按時間升序）
```

### 5.3 標籤

```
GET    /api/tags
  返回: [{ id, name, color }]

POST   /api/tags
  Body: { name, color? }
  返回: { id, name, color }

DELETE /api/tags/:id
  返回: { ok: true }

POST   /api/papers/:id/tags
  Body: { tag_id }
  返回: { ok: true }

DELETE /api/papers/:paperId/tags/:tagId
  返回: { ok: true }
```

### 5.4 知識樹

```
GET    /api/tree
  返回: 完整樹結構（嵌套）
  [{ id, name, parent_id, sort_order, children: [...], paper_count: N }]

POST   /api/tree
  Body: { name, parent_id? }
  返回: { id, name, parent_id }

PATCH  /api/tree/:id
  Body: { name?, parent_id?, sort_order? }
  返回: 更新後的節點

DELETE /api/tree/:id
  行為: 刪除節點（子節點歸到父節點，論文的 tree_node_id 設 null）
  返回: { ok: true }
```

### 5.5 設定

```
GET    /api/settings
  返回: { configured: boolean }（API key 是否已配置）

POST   /api/settings/test
  Body: { base_url, api_key, model, format }
  行為: 用提供的配置發一個簡單請求測試連通性
  返回: { ok: true } 或 { ok: false, error: "..." }
```

---

## 六、AI 調用規格

### 6.1 通讀全文（analyze）

```
System:
你是一位科研論文分析專家。請通讀以下論文全文，生成結構化摘要。

嚴格輸出以下 JSON 格式（不要包含 ```json 標記）：
{
  "title": "論文標題（從內容中提取）",
  "authors": "作者列表，逗號分隔",
  "year": 2024,
  "background": "研究背景與動機（2-4 句）",
  "methods": "研究方法（2-4 句）",
  "results": "主要結果（2-4 句）",
  "conclusions": "結論（2-4 句）",
  "limitations": "局限性（1-3 句）"
}

User:
<全文文本>
```

溫度 0.2，max_tokens 2000。

### 6.2 論文討論

```
System:
你是一位科研導師，正在幫助用戶閱讀和理解一篇學術論文。

以下是這篇論文的信息：
標題：{title}
作者：{authors}
年份：{year}

AI 摘要：
- 背景：{summary_bg}
- 方法：{summary_methods}
- 結果：{summary_results}
- 結論：{summary_conclusions}
- 局限：{summary_limitations}

以下是論文全文（供你參考回答問題，不需要重複全文內容）：
{full_text}

回答要求：
1. 基於論文內容準確回答，不要編造論文中沒有的信息
2. 如果論文中沒有相關內容，明確告知用戶
3. 用清晰、易懂的語言解釋
4. 適當引用論文中的具體段落或數據
5. 使用用戶提問時所用的語言回答

Messages:
[歷史對話 + 當前 user message]
```

溫度 0.3，max_tokens 4096，stream: true。

---

## 七、前端頁面設計

### 7.1 整體佈局

```
┌─────────────────────────────────────────────────────────────┐
│  Co-Reading                              [設定 ⚙️]          │
├────────────┬────────────────────────────────────────────────┤
│            │                                                │
│  知識樹     │              主區域                             │
│  ────────  │              （根據路由切換）                     │
│            │                                                │
│  📁 全部論文 │                                                │
│  📁 方法學   │                                                │
│    📄 RCT   │                                                │
│    📄 Meta  │                                                │
│  📁 SGLT2   │                                                │
│    📄 機制   │                                                │
│    📄 臨床   │                                                │
│  📁 未分類   │                                                │
│            │                                                │
│  [+ 新資料夾]│                                                │
│            │                                                │
│────────────│                                                │
│  🏷️ 標籤    │                                                │
│  [方法學]   │                                                │
│  [SGLT2]   │                                                │
│  [CKD]     │                                                │
│            │                                                │
├────────────┴────────────────────────────────────────────────┤
│  將 PDF 拖拽到此處上傳，或 [點擊選擇文件]                        │
└─────────────────────────────────────────────────────────────┘
```

左側固定寬度 240px，可折疊。

### 7.2 主頁 — 文獻列表（Library.jsx）

點擊左側知識樹節點 → 主區域顯示該分類下的論文列表。點「全部論文」顯示所有。

```
┌────────────────────────────────────────────────────────────┐
│  SGLT2 > 機制  (3 篇)                    [排序 ▾] [搜索 🔍] │
├────────────────────────────────────────────────────────────┤
│                                                            │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ 📄 DAPA-CKD Trial Results                           │  │
│  │ Heerspink et al. 2020  DOI: 10.1056/NEJMoa2024816  │  │
│  │ [SGLT2] [CKD] [臨床試驗]               狀態: ✅ 已讀  │  │
│  │ AI 摘要: 達格列淨在慢性腎病患者中顯著降低腎臟複合...    │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                            │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ 📄 SGLT2 Inhibitors and Kidney Protection            │  │
│  │ Wanner et al. 2022                                   │  │
│  │ [SGLT2] [機制]                        狀態: 📖 閱讀中  │  │
│  │ AI 通讀中... ████████░░ 80%                           │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                            │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ 📄 Canagliflozin and Renal Outcomes                  │  │
│  │ Perkovic et al. 2019                                 │  │
│  │ [SGLT2]                               狀態: 📥 待讀   │  │
│  │ [開始 AI 通讀]                                        │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                            │
└────────────────────────────────────────────────────────────┘
```

每張卡片可點擊進入論文詳情頁。

### 7.3 論文詳情頁（PaperDetail.jsx）

這是核心頁面，左右分欄。

```
┌────────────────────────────────────────────────────────────┐
│  ← 返回列表   DAPA-CKD Trial Results      [已讀 ▾] [🗑️]   │
├─────────────────────────┬──────────────────────────────────┤
│                         │                                  │
│  📋 結構化摘要            │  💬 跟 AI 討論這篇論文             │
│  ─────────────          │  ─────────────                   │
│                         │                                  │
│  背景                    │  ┌────────────────────────────┐ │
│  SGLT2 抑制劑最初...     │  │ AI: 你好！我已經讀完了這篇  │ │
│                         │  │ 論文。這是一項關於達格列淨... │ │
│  方法                    │  │ 有什麼想討論的嗎？          │ │
│  多中心 RCT，4304 名...  │  └────────────────────────────┘ │
│                         │                                  │
│  結果                    │  ┌────────────────────────────┐ │
│  主要終點降低 39%...     │  │ 你: primary endpoint       │ │
│                         │  │ 具體是什麼？               │ │
│  結論                    │  └────────────────────────────┘ │
│  達格列淨顯著降低...     │                                  │
│                         │  ┌────────────────────────────┐ │
│  局限                    │  │ AI: DAPA-CKD 的主要終點是  │ │
│  未納入 1 型糖尿病...    │  │ 一個複合終點，包括：       │ │
│                         │  │ 1. eGFR 持續下降 ≥50%     │ │
│  ─────────────          │  │ 2. 終末期腎病             │ │
│                         │  │ 3. 腎臟或心血管死亡        │ │
│  📝 我的筆記             │  └────────────────────────────┘ │
│  ─────────────          │                                  │
│  (Markdown 文本框)      │                                  │
│  這篇是 SGLT2 在 CKD   │  ──────────────────────────────  │
│  中的里程碑...           │  ┌──────────────────────┐       │
│                         │  │ 輸入你的問題...        │ [發送] │
│  ─────────────          │  └──────────────────────┘       │
│  🏷️ Tags                │                                  │
│  [SGLT2] [CKD] [RCT]   │                                  │
│  [+ 新增 tag]           │                                  │
│                         │                                  │
│  ─────────────          │                                  │
│  📁 分類: SGLT2 > 臨床   │                                  │
│  [移動到...]            │                                  │
│                         │                                  │
├─────────────────────────┴──────────────────────────────────┤
│  論文元信息: Heerspink et al. 2020 | DOI: 10.1056/...      │
└────────────────────────────────────────────────────────────┘
```

左右欄 50/50 分割，中間可拖動調整比例。

### 7.4 設定頁（Settings.jsx）

設計原則：**普通用戶只需要填一個 API Key**，其餘高級選項折疊隱藏。

```
┌────────────────────────────────────────────────────────────┐
│  ⚙️ 設定                                                    │
├────────────────────────────────────────────────────────────┤
│                                                            │
│  🔑 API Key                                                │
│  ──────────────────────────────────────────────────────   │
│  填入你的 Claude API Key 即可開始使用。                       │
│  可在 console.anthropic.com 申請。                          │
│                                                            │
│  AI 服務商:
  ┌──────────────────────────────────────────────────────┐  │
│  │  ○ Anthropic (Claude)   ○ OpenAI   ○ DeepSeek       │  │
│  │  ○ 其他（自定義）                                    │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                            │
│  API Key:                                                  │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ [在此貼入你的 API Key                               ] │  │
│  └──────────────────────────────────────────────────────┘  │
│  選 Anthropic → 提示去 console.anthropic.com 申請           │
│  選 OpenAI   → 提示去 platform.openai.com 申請              │
│  選 DeepSeek → 提示去 platform.deepseek.com 申請            │
│                                                            │
│  [測試連接]  ← 點擊驗證 key 是否有效                         │
│  ✅ 連接正常 / ❌ Key 無效，請重新確認                        │
│                                                            │
│  [保存]                                                     │
│                                                            │
│  ▸ 進階設定（使用其他 AI 服務）                              │
│    ← 點擊展開，顯示 Base URL / 模型 / API 格式等選項         │
│                                                            │
│  ══════════════════════════════════════════════════════   │
│                                                            │
│  📋 運行日誌  ...                                           │
│                                                            │
└────────────────────────────────────────────────────────────┘
```

**進階設定（折疊區域，默認收起）：**

```
▾ 進階設定（使用其他 AI 服務）

  💬 討論用模型
  API 格式:  [Anthropic ▾]
  Base URL:  [https://api.anthropic.com/v1         ]
  API Key:   [自動使用上方填入的 key               ]
  Model:     [claude-sonnet-4-6                    ]

  📄 通讀用模型（可選，不填則與討論用相同）
  API 格式:  [OpenAI ▾]
  Base URL:  [https://api.deepseek.com/v1          ]
  API Key:   [sk-••••••••••••                      ]
  Model:     [deepseek-chat                        ]
                                        [測試連接]
```

**邏輯：**
- 簡易模式：選 AI 服務商 → 填 API Key → 保存，其餘自動配好
- 進階模式：展開後可以手動覆蓋 Base URL、模型名（給用私有部署或其他服務的用戶）
- 「通讀用模型」的 API Key 欄位如果留空，自動使用主模型的 key

**各服務商預設值（選擇後自動填入）：**

| 服務商 | Base URL | 格式 | 默認模型 |
|--------|----------|------|---------|
| Anthropic (Claude) | `https://api.anthropic.com/v1` | anthropic | `claude-sonnet-4-6` |
| OpenAI | `https://api.openai.com/v1` | openai | `gpt-4o` |
| DeepSeek | `https://api.deepseek.com/v1` | openai | `deepseek-chat` |
| 其他（自定義） | 手動填 | openai | 手動填 |

設定存入 SQLite settings 表，不需要重啟服務：

```sql
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);
```

API 配置優先級：settings 表 > .env 文件 > 默認值。

---

## 八、交互細節

### 8.1 PDF 上傳流程

1. 用戶拖拽 PDF 到底部上傳區（或點擊選擇文件）
2. 支持一次上傳多個 PDF
3. 每個 PDF：
   - 前端顯示上傳進度
   - 上傳完成 → 卡片出現在列表中（狀態：待讀）
   - 自動觸發 AI 通讀（`POST /api/papers/:id/analyze`）
   - 通讀進行中 → 卡片顯示 "AI 通讀中..."
   - 通讀完成 → 摘要可見，卡片顯示標題（從 AI 結果回填）
4. 通讀失敗 → 顯示錯誤，可以 [重試]

### 8.2 討論交互

1. 進入論文詳情頁時，如果有 AI 摘要，自動顯示一條歡迎消息（不存入 DB，每次進入前端生成）：
   "我已經讀完了這篇論文。{title} 主要研究了 {summary_conclusions 前50字}... 有什麼想討論的嗎？"
2. 用戶輸入問題 → 發送按鈕（或 Enter 發送，Shift+Enter 換行）
3. AI 回覆以 streaming 方式逐字顯示
4. streaming 過程中顯示 "正在思考..." 動畫
5. 用戶可以在 AI 回覆過程中繼續輸入（但發送按鈕在 streaming 結束前禁用）

### 8.3 知識樹交互

1. 左側顯示樹結構，支持：
   - 點擊展開/折疊
   - 右鍵菜單：重命名、刪除、新建子分類
   - 拖拽論文卡片到樹節點改分類
2. 頂層固定節點「全部論文」（不可刪除，顯示所有論文）
3. 「未分類」自動收集沒有 tree_node_id 的論文
4. 每個節點右側顯示論文數量

### 8.4 標籤交互

1. 論文詳情頁底部可添加/移除標籤
2. 輸入標籤名 → 自動補全已有標籤 / 新建
3. 左側導航標籤區域：點擊標籤 → 主區域篩選顯示含該標籤的論文

---

## 九、視覺風格

- 整體色調：白色背景 + 灰色邊框 + 紫色強調色（#6366f1 indigo-500）
- 字體：系統字體棧（`-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif`）
- 卡片：圓角 8px，淺灰邊框，hover 時輕微陰影
- 討論氣泡：用戶消息右對齊藍色背景，AI 消息左對齊灰色背景
- 左側導航：淺灰底色（#f9fafb），選中項深色背景
- 響應式：最小寬度 768px，左側導航在小屏可折疊
- 深色模式：不需要（Phase 1 不做）

---

## 十、完成標準（Acceptance Criteria）

### Must Have（不達標不算完成）

- [ ] `npm install && npm run dev` 一條命令啟動，瀏覽器打開 `localhost:3456` 可用
- [ ] 拖拽上傳 PDF → 自動提取全文 → 自動觸發 AI 通讀 → 顯示結構化摘要（背景/方法/結果/結論/局限）
- [ ] 點擊論文卡片進入詳情頁 → 左側摘要 + 右側 AI 討論
- [ ] AI 討論 streaming 逐字顯示，上下文包含論文全文 + 歷史對話
- [ ] 刷新頁面後數據不丟失（SQLite 持久化）
- [ ] 知識樹：建立/重命名/刪除資料夾，論文歸入分類
- [ ] 標籤：新增/刪除/關聯到論文
- [ ] 設定頁可配置 AI API（不需要改 .env 重啟）
- [ ] 同時支持 Anthropic 和 OpenAI 格式的 API

### Should Have（有了更好）

- [ ] 拖拽論文卡片到知識樹節點改分類
- [ ] 標籤自動補全
- [ ] 搜索論文（按標題/作者/摘要全文搜索）
- [ ] 論文列表支持按時間/標題排序
- [ ] AI 通讀失敗可重試
- [ ] 上傳區域支持一次多個 PDF
- [ ] 討論區 Markdown 渲染（代碼塊、公式、列表）

### Nice to Have（加分項，不強求）

- [ ] AI 通讀完成後自動建議 tags
- [ ] 知識樹節點拖拽排序
- [ ] 論文元信息手動編輯（標題、作者、年份、DOI）
- [ ] 左側面板可折疊
- [ ] 討論區支持 LaTeX 公式渲染（KaTeX）

---

## 十、運行日誌（Must Have）

後端將關鍵事件寫入日誌文件，設定頁提供查看入口，方便排查 bug。

### 後端日誌

所有日誌寫入 `data/app.log`，同時輸出到 console。每條日誌格式：

```
[2026-06-05 10:23:45] [INFO]  PDF 上傳成功: paper_abc123 (dapa-ckd.pdf, 2.3MB)
[2026-06-05 10:23:46] [INFO]  開始 AI 通讀: paper_abc123
[2026-06-05 10:24:12] [INFO]  AI 通讀完成: paper_abc123 (用時 26s)
[2026-06-05 10:25:01] [INFO]  討論消息: paper_abc123, user (42 字)
[2026-06-05 10:25:08] [INFO]  討論回覆: paper_abc123, assistant (318 字)
[2026-06-05 10:30:00] [ERROR] AI 通讀失敗: paper_xyz456 — API error 429: rate limit
```

記錄的事件：PDF 上傳、AI 通讀開始/完成/失敗、討論消息收發、API 調用錯誤、服務啟動。

日誌文件保留最近 1000 條，超出後自動截斷舊條目。

### 端點

```
GET /api/logs?lines=100
返回: { logs: ["...", "..."] }（最新 N 條，倒序）
```

### 前端（設定頁底部）

```
📋 運行日誌

[2026-06-05 10:24:12] [INFO]  AI 通讀完成: DAPA-CKD Trial (用時 26s)
[2026-06-05 10:23:46] [INFO]  開始 AI 通讀: DAPA-CKD Trial
[2026-06-05 10:23:45] [INFO]  PDF 上傳成功: dapa-ckd.pdf (2.3MB)

                                          [刷新]  [清空]
```

顯示最近 100 條，等寬字體，ERROR 行紅色高亮，INFO 行灰色。

---

## 十一、已知約束

1. **PDF 解析質量**: pdf-parse 對掃描版 PDF 無能為力（沒有 OCR）。如果全文提取結果為空或亂碼，前端提示用戶 "此 PDF 可能是掃描版，無法自動提取文本"。
2. **全文長度**: 有些論文全文超過 10 萬字符。調 AI 時如果超過 100K 字符，截斷到前 100K 並在末尾加 "[全文已截斷]"。
3. **並發**: 不考慮多用戶並發，單用戶場景。
4. **安全**: 本地使用，不需要鑑權。API key 存在 SQLite 裡（或 .env），不會暴露到外部。

---

## 十二、後續整合（不在本次範圍，僅供參考）

本項目後續會與 research-gateway（`eliasandkitten.top/research/`）整合：
- AI 調用改為走 research-gateway 的多 API 池
- 論文記憶接入 Ombre Brain
- 知識庫接入 research-gateway 的語義搜索
- 前端部署到 VPS

整合時的接口兼容性：所有 `/api/*` 端點保持不變，後端實現從本地 SQLite + 直接調 AI 改為走 research-gateway。前端不需要改。
