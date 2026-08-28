# Co-Reading

<p align="center">
  <img src="build/icon.png" alt="Co-Reading icon" width="144" height="144">
</p>

AI 論文共讀系統：上傳 PDF、通讀正文與圖表、生成結構化摘要、圍繞全文討論、自動提取洞察，並建立跨論文知識網絡。

支援 Anthropic Messages API 與 OpenAI Chat Completions-compatible API；內建 Anthropic、OpenAI、DeepSeek、OpenCode Go 與自定義供應商預設。

> **按原樣提供，不承諾支援。** Provided as-is, no support guaranteed.

## 安裝

### GitHub Release 桌面版

在 GitHub Releases 下載對應平台的安裝檔：

- macOS：`.dmg`
- Windows：`.exe`

目前安裝包未做 Apple notarization 或 Windows code signing，系統可能顯示未驗證開發者／SmartScreen 提示。請只從本專案的 GitHub Releases 下載。

應用資料（論文、資料庫、API 設定）保存在本機，不會打包進 Release。API Key 會保存在本機 SQLite 設定表中，請勿共享資料庫檔案。

### 從源碼執行

需要 Node.js 22（與 GitHub Actions 建置環境一致）。

## 快速開始

```bash
npm install
cp .env.example .env   # 填入 API key
npm run dev            # 前後端同時啟動
```

前端 `http://localhost:5173/`，後端 `http://localhost:3456`。

其他常用命令：

```bash
npm test       # 後端測試
npm run build  # 前端 production build
npm start      # 啟動後端；先執行 npm run build 才能提供前端頁面
npm run electron
```

## 模型配置

最簡單的方式是在應用的「設定」頁選擇供應商並填入 API Key。也可以使用 `.env`：

```env
AI_BASE_URL=https://api.anthropic.com/v1
AI_API_KEY=sk-xxx
AI_MODEL=claude-sonnet-4-6
AI_FORMAT=anthropic

# 通讀模型（可選；留空時繼承主模型）
ANALYZE_BASE_URL=https://api.deepseek.com/v1
ANALYZE_API_KEY=sk-xxx
ANALYZE_MODEL=deepseek-chat
ANALYZE_FORMAT=openai

# 視覺通讀（auto / on / off）
ANALYZE_VISION_MODE=auto
# ANALYZE_VISION_MODEL=your-vision-model

PORT=3456
```

`AI_*` 用於論文討論，`ANALYZE_*` 用於首次通讀。兩組配置可以使用不同模型、API Key 和 API 格式；未填的通讀字段會繼承主模型配置。

`openai` 在這裡指 OpenAI Chat Completions-compatible 的 `/chat/completions` 格式，不是 Responses API。

### OpenCode Go

推薦用視覺模型讀圖，再由主模型綜合正文與視覺證據：

```env
AI_BASE_URL=https://opencode.ai/zen/go/v1
AI_API_KEY=opencode_xxx
AI_FORMAT=openai
AI_MODEL=deepseek-v4-pro

ANALYZE_BASE_URL=https://opencode.ai/zen/go/v1
ANALYZE_API_KEY=opencode_xxx
ANALYZE_FORMAT=openai
ANALYZE_MODEL=deepseek-v4-pro
ANALYZE_VISION_MODE=on
ANALYZE_VISION_MODEL=deepseek-v4-flash-vision-exp
```

HTTP 請求中的模型名稱直接填 `deepseek-v4-pro` 等原始 model ID，不要加 `opencode-go/` 前綴。模型可用性與配額以 OpenCode Go 帳戶顯示為準。

### 圖表與 PDF 視覺通讀

設定頁提供「圖表／識圖」模式與獨立識圖模型：

- Anthropic format：把原始 PDF 作為 `document` block 送入 Messages API，正文、圖、表與版面一起分析。
- OpenAI-compatible format：先按頁提取文字，優先選取帶 `Figure`／`Table` caption 的頁面（找不到時均勻抽樣），最多選 8 頁；再用 `pdftoppm` 轉成 PNG，交給識圖模型產生帶頁碼的證據筆記，最後由通讀模型綜合正文與視覺筆記。
- 文字與圖片不是按像素切割。頁碼與 caption 是兩條處理管線的對齊邊界，最終模型負責交叉驗證。
- 圖像渲染不可用或上游拒絕圖片時會記錄 warning 並降級成純文字通讀，不會令整篇論文卡死；若最終通讀 API 本身失敗，論文會標記為分析失敗並保留錯誤信息。

OpenAI-compatible 的 PDF 頁面渲染需要系統可執行 `pdftoppm`（Poppler）：

```bash
# macOS
brew install poppler

# Debian / Ubuntu
sudo apt-get install poppler-utils

pdftoppm -v
```

若執行檔不在 `PATH`，可設定 `PDFTOPPM_PATH=/absolute/path/to/pdftoppm`。桌面版未內建 Poppler；沒有 Poppler 時仍可使用純文字通讀。Anthropic 原生 PDF 模式不依賴 Poppler。

### 已知限制

- 掃描版 PDF 若沒有文字層，目前不會自動 OCR；視覺模式只能覆蓋被選取的頁面。
- OpenAI-compatible 視覺通讀最多處理 8 個頁面，可能漏掉沒有 caption、跨頁或附錄中的圖表。
- 視覺模型的結果屬模型推斷，重要數值、坐標和統計結論仍應回看原始 PDF。
- 超過原生 PDF 請求大小限制時，Anthropic 模式會改走頁面渲染路徑；若 Poppler 也不可用，則降級為純文字。

## 功能

### 論文管理
- **PDF 上傳**：拖拽上傳，自動提取全文（pdf-parse）。掃描版 PDF 會標記為無法提取
- **AI 通讀**：上傳後自動非同步生成結構化摘要（背景、方法、結果、結論、局限），可把 PDF 圖表納入證據
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
│   ├── pdf.js                    # PDF 文本提取、圖表頁選取與 PNG 渲染
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

## 發布

GitHub Actions 會先執行完整測試，再分別建立 macOS 與 Windows 安裝包。推送 `v*` tag 後，工作流會建立 GitHub Release 並附上 `.dmg`、`.exe` 與自動生成的 release notes。

```bash
npm test
npm run build
git tag v1.1.1
git push origin v1.1.1
```

建立 tag 前應先把發布提交合併到 `main`，並確認 `package.json` 的版本與 tag 一致。提交、推送與建立 Release 不會由應用程式自動執行。

## License

[MIT](LICENSE)
