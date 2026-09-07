# Co-Reading

<p align="center">
  <img src="build/icon.png" alt="Co-Reading 图标" width="144" height="144">
</p>

> 一个在自己电脑上运行的 AI 论文共读工具。

把 PDF 放进去，Co-Reading 会帮你提取正文、阅读图表、生成结构化摘要；你还可以围绕论文全文继续追问，把重要发现保存成洞察，并用知识树整理多篇文献。

[下载最新版](https://github.com/naomiday543-art/co-reading/releases/latest) · [查看所有版本](https://github.com/naomiday543-art/co-reading/releases)

> **按原样提供，不承诺支持。** Provided as-is, no support guaranteed.

## 它解决什么问题

普通 AI 聊天往往需要你反复上传论文、复制上下文，重要发现也容易散落在不同对话里。

Co-Reading 把一次论文阅读拆成一条可以长期保留的流程：

```text
上传 PDF
   ↓
提取正文并分析图表
   ↓
生成背景 / 方法 / 结果 / 结论 / 局限摘要
   ↓
围绕全文继续讨论
   ↓
保存洞察、笔记、标注和阅读进度
   ↓
在其他论文中重新找到相关洞察
```

它适合个人研究、文献阅读和课题整理，不是文献数据库，也不能替代你核对原始论文。

## 你可以用它做什么

### 阅读论文

- 拖入一个或多个 PDF。
- 自动提取可搜索的正文。
- 异步生成结构化摘要，不必一直停留在页面等待。
- 在支持的模型下，把图片、图表和页面布局一并纳入分析。
- 查看原文、添加标注，并记录每个章节的阅读进度。

### 和论文对话

- 每轮回答都可以使用当前论文全文作为上下文。
- SSE 流式显示回答。
- Anthropic 格式支持 prompt cache，减少重复发送全文的成本。
- 可以编辑一条消息并从那里建立新的对话分支。

### 积累研究洞察

- 从讨论中提取 fact、hypothesis 等重要内容。
- 按“概念、延伸、你的研究、闪回、共振、悬题”六个维度整理。
- 使用 FTS5 trigram 搜索中英文混排内容。
- 在阅读另一篇论文时找回相关洞察。

### 整理资料

- 用知识树建立多层分类。
- 用标签跨目录管理论文。
- 为每篇论文保存 Markdown 笔记。
- 所有论文、消息、洞察和设置保存在本机 SQLite。

## 安装

### 方式一：桌面版

从 [GitHub Releases](https://github.com/naomiday543-art/co-reading/releases/latest) 下载：

- macOS：`.dmg`
- Windows：`.exe`

当前安装包没有 Apple notarization 或 Windows code signing，系统可能显示“未验证的开发者”或 SmartScreen 提示。请只从本项目的 GitHub Releases 下载。

### 方式二：从源码运行

需要 Node.js 22。

```bash
npm install
cp .env.example .env
npm run dev
```

开发模式地址：

- 前端：`http://localhost:5173/`
- 后端：`http://localhost:3456`

常用命令：

```bash
npm test       # 运行后端测试
npm run build  # 构建前端
npm start      # 启动后端；需要先完成前端构建
npm run electron
```

## 第一次使用

1. 打开“设置”。
2. 选择 Anthropic、OpenAI、DeepSeek、OpenCode Go 或 Custom。
3. 填入自己的 API Key 和模型名称。
4. 点击连接测试。
5. 回到文库，上传一篇带文字层的 PDF。

Co-Reading 不提供模型订阅或共享额度。请求产生的费用、速率限制和内容政策由你选择的 AI 服务商决定。

## 数据和隐私

Co-Reading 是本地优先工具，但**不是完全离线工具**。

保存在本机：

- 上传的 PDF。
- 提取后的正文。
- 聊天记录、摘要、洞察、笔记和阅读进度。
- API 设置和 API Key。

会发送给你配置的 AI 服务商：

- 用于摘要和讨论的论文正文。
- 视觉通读时选中的 PDF 页面或原始 PDF。
- 你的问题和相关洞察上下文。

API Key 保存在本机 SQLite 设置表中，目前没有额外加密。不要分享 `data/co-reading.db`，也不要把默认服务直接暴露到公网。

建议定期备份整个 `data/` 目录；它包含数据库和上传的 PDF。`data/` 已被 Git 忽略，不会正常进入代码仓库。

## PDF 和图表是怎么处理的

### Anthropic 格式

如果上游支持原生 PDF document block，Co-Reading 会把原始 PDF 交给模型，让正文、图表和版面一起参与分析。

### OpenAI-compatible 格式

Co-Reading 会：

1. 按页提取文字。
2. 优先选择带有 `Figure` / `Table` caption 的页面；找不到时均匀抽样。
3. 最多选择 8 页并渲染成 PNG。
4. 由视觉模型生成带页码的证据笔记。
5. 再由通读模型综合正文和视觉笔记。

页面渲染需要 Poppler 的 `pdftoppm`：

```bash
# macOS
brew install poppler

# Debian / Ubuntu
sudo apt-get install poppler-utils
```

如果命令不在 `PATH`，可以设置：

```ini
PDFTOPPM_PATH=/absolute/path/to/pdftoppm
```

桌面安装包目前不内置 Poppler。没有 Poppler 时仍可使用纯文字通读；Anthropic 原生 PDF 路径不依赖 Poppler。

## 重要限制

- 扫描版 PDF 没有文字层时，目前不会自动 OCR。
- OpenAI-compatible 视觉通读最多选取 8 页，可能漏掉没有 caption、跨页或位于附录中的图表。
- 视觉模型可能误读坐标、单位、显著性或小字号文字；重要数字必须回看原始 PDF。
- 图像渲染不可用或上游不接受图片时，会降级为纯文字通读。
- 不同“兼容 OpenAI”的服务对图片、模型名和 streaming 的支持并不完全相同。
- 当前应用面向单机个人使用，没有多用户权限系统，也不应直接作为公共服务部署。

## 模型配置

最简单的方式是在应用设置页完成配置：

- `AI_*`：用于论文讨论。
- `ANALYZE_*`：用于首次通读；留空时继承 `AI_*`。
- 通读模型和讨论模型可以来自不同服务商。
- `openai` 表示 Chat Completions-compatible `/chat/completions`，不是 Responses API。

<details>
<summary>查看 .env 配置示例</summary>

```ini
AI_BASE_URL=https://api.anthropic.com/v1
AI_API_KEY=replace-with-your-key
AI_MODEL=replace-with-your-model
AI_FORMAT=anthropic

# 可选：单独配置通读模型
ANALYZE_BASE_URL=https://api.example.com/v1
ANALYZE_API_KEY=replace-with-your-key
ANALYZE_MODEL=replace-with-your-model
ANALYZE_FORMAT=openai

# auto / on / off
ANALYZE_VISION_MODE=auto
ANALYZE_VISION_MODEL=replace-with-your-vision-model

PORT=3456
```

`AI_BASE_URL` 和 `ANALYZE_BASE_URL` 只填写到 `/v1` 或服务商要求的 API 根路径，不要手动追加 `/chat/completions`。

</details>


## 给开发者

<details>
<summary>技术栈和目录</summary>

| 层 | 技术 |
|---|---|
| 桌面 | Electron 35 |
| 前端 | React 19、Vite 6、zustand 5 |
| 后端 | Express 5 |
| 数据库 | better-sqlite3、WAL、FTS5 trigram |
| PDF | pdf-parse、可选 Poppler |
| AI | Anthropic Messages / OpenAI Chat Completions-compatible |

```text
co-reading/
├── electron.js
├── src/                   后端、数据库、AI 和 PDF 处理
│   └── routes/            论文、聊天、洞察、标签、知识树 API
├── frontend/              React 前端
├── test/                  后端测试
├── build/                 桌面图标
├── data/                  SQLite 和 PDF；不进入 Git
└── dist/                  前端构建产物
```

</details>

GitHub Actions 会在发布前运行测试，并为 macOS 和 Windows 构建安装包。推送 `v*` tag 后会建立 GitHub Release。

## 当前状态

当前稳定版本：**v1.1.1**。

`main` 已包含本 README 描述的 PDF 管理、结构化通读、图表分析、全文讨论、洞察、知识树和桌面打包。实验性 Research Carryover/refinement 功能仍在独立分支中，不属于 v1.1.1 的稳定承诺。

## License

[MIT](LICENSE)
