# Co-Reading

AI 論文共讀系統。上傳 PDF → AI 通讀生成結構化摘要 → 討論論文 → 自動提取洞察 → 建立跨論文知識網絡。

## 快速開始

```bash
npm install
cp .env.example .env   # 填入 API key
npm run dev            # 前後端同時啟動
```

前端 `http://localhost:5173/`，後端 `http://localhost:3456`。

## .env 配置

```env
AI_BASE_URL=https://api.anthropic.com/v1
AI_API_KEY=sk-xxx
AI_MODEL=claude-sonnet-4-6
AI_FORMAT=anthropic

# 通讀用的模型（可選，省錢）
ANALYZE_BASE_URL=https://api.deepseek.com/v1
ANALYZE_API_KEY=sk-xxx
ANALYZE_MODEL=deepseek-chat
ANALYZE_FORMAT=openai

PORT=3456
```

支援 `anthropic` 和 `openai` 兩種 API 格式。討論模型和通讀模型可分別配置。通讀模型未填時自動 fallback 到主模型。

## 功能

### 論文管理
- **PDF 上傳**：拖拽上傳，自動提取全文（pdf-parse）。掃描版 PDF 會標記為無法提取
- **AI 通讀**：上傳後自動非同步生成結構化摘要（背景、方法、結果、結論、局限）
- **知識樹**：巢狀分類目錄，論文可歸入任意節點
- **標籤**：全局標籤系統，跨論文共享

### 論文討論
- **全文上下文**：每輪討論 AI 都帶著論文全文回答
- **Streaming**：SSE 流式回覆，即時顯示
- **Prompt Cache**：Anthropic 格式下論文全文掛 `cache_control: ephemeral`，第二輪起大幅節省 token
- **洞察注入**：討論時自動注入本篇近期洞察 + 跨論文相關洞察（FTS5 檢索匹配）

### 洞察系統
- **6 維度分類**：概念、延伸、你的研究、闪回、共振、悬题
- **AI 提取**：討論後點「提取洞察」，AI 自動從對話中提取 fact / hypothesis / progress（progress 不入洞察，只記錄）
- **跨論文搜索**：FTS5 trigram tokenizer 支援中英混排全文檢索
- **相關洞察**：查看與當前論文相關的所有洞察

### 其他
- **筆記**：Markdown 編輯器，每篇論文獨立筆記
- **原文閱讀**：FullTextView 逐段閱讀 + 標註
- **逐節進度**：論文章節級閱讀進度追蹤
- **設定頁**：Web UI 修改 API 配置，即時測試連通性

## 專案結構

```
co-reading/
├── package.json
├── vite.config.js
├── .env.example
├── .env
├── src/                          # 後端 (Express 5)
│   ├── server.js                 # 主入口
│   ├── db.js                     # SQLite (WAL, FK, FTS5)
│   ├── ai.js                     # AI API 調用 (Anthropic/OpenAI, streaming, cache)
│   ├── memory.js                 # 記憶提取 (AI → insights 表)
│   ├── search.js                 # FTS5 公用搜索
│   ├── pdf.js                    # PDF 文本提取
│   ├── logger.js                 # 日誌
│   └── routes/
│       ├── papers.js             # 論文 CRUD + 上傳 + 通讀 + 提取洞察
│       ├── chat.js               # 論文討論 (SSE)
│       ├── insights.js           # 洞察 CRUD + 關聯查詢
│       ├── tags.js               # 標籤 CRUD
│       └── tree.js               # 知識樹 CRUD
├── frontend/                     # 前端 (React 19 + Vite)
│   ├── index.html                # Tailwind CDN + 調色盤 + 全局樣式
│   └── src/
│       ├── main.jsx
│       ├── App.jsx
│       ├── store.js              # zustand 全局狀態
│       ├── api.js                # fetch 封裝 + SSE streaming
│       ├── pages/
│       │   ├── Library.jsx       # 主頁：文獻列表
│       │   ├── PaperDetail.jsx   # 論文詳情：摘要 + 討論 + 筆記
│       │   └── Settings.jsx      # API 配置
│       └── components/
│           ├── Sidebar.jsx       # 左側知識樹 + 洞察面板
│           ├── ChatPanel.jsx     # AI 討論面板 + 提取洞察
│           ├── SummaryView.jsx   # 結構化摘要展示
│           ├── InsightsPanel.jsx # 全局洞察瀏覽
│           ├── InsightCard.jsx   # 單條洞察卡片
│           ├── InsightForm.jsx   # 手動創建/編輯洞察
│           ├── FullTextView.jsx  # 原文閱讀器 + 標註
│           ├── PaperCard.jsx     # 論文卡片
│           ├── TagBadge.jsx      # 標籤徽章
│           ├── TreeNode.jsx      # 知識樹節點
│           └── UploadZone.jsx    # PDF 拖拽上傳
├── data/                         # SQLite + PDF 存儲 (gitignore)
│   ├── co-reading.db
│   └── pdfs/
└── dist/                         # 前端 build 產物
```

## 數據庫

SQLite (`data/co-reading.db`)，7 張核心表 + 1 個 FTS5 虛擬表：

| 表 | 說明 |
|----|------|
| `papers` | 論文（全文、摘要、狀態、筆記） |
| `messages` | 討論歷史 |
| `tags` + `paper_tags` | 標籤系統 |
| `tree_nodes` | 知識樹 |
| `insights` + `insights_fts` | 洞察 + trigram 全文索引 |
| `annotations` | 原文標註 |
| `section_progress` | 逐節閱讀進度 |
| `settings` | API 配置 (key-value) |

## 技術棧

| 層 | 選擇 |
|----|------|
| 前端 | React 19 + Vite 6 |
| 狀態 | zustand 5 |
| CSS | Tailwind CSS (CDN) |
| Markdown | react-markdown + remark-gfm |
| 後端 | Express 5 |
| 數據庫 | better-sqlite3 (WAL, FTS5 trigram) |
| PDF | pdf-parse |
| AI | Anthropic / OpenAI-compatible (雙格式) |
| ID | nanoid |
