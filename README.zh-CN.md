# Search Toolkit

面向 AI Agent 的官方优先搜索工具集，提供持久化多 Key 轮询、MCP、CLI 与 Agent Skill。

## 核心原则

- 不把所有搜索服务压成一个失去特色的通用接口。
- Exa、Tavily、LinkUp、AnySearch、Firecrawl 优先透明代理官方 MCP，保留官方工具 schema。
- Querit、Serper、Brave Web/News/Images/LLM Context、You.com Search、Parallel Search、Jina、TinyFish、豆包与 xAI Responses 只做官方 API 薄适配。
- 每家 Provider 独立维护 Key 池；SQLite 游标可跨进程、跨重启持续轮询。
- 真实 Key 只保存在仓库外的文本 JSON，不写进代码、Skill、README 或 Codex 配置。
- 豆包默认 `manualOnly`，不会被 `search_auto` 或自动兜底消耗。

## 能力路由

| 需求 | 首选 |
| --- | --- |
| 普通质量优先 Web 搜索 | `search_auto`，由 Parallel、You.com、Brave、Exa、Querit、Tavily 按能力路由 |
| 精确字符串、代码、语义搜索、网页正文 | Exa 官方 MCP |
| 当前新闻与快速变化事实 | Brave News、You.com、Tavily、Serper News |
| 保留原图、缩略图、尺寸与来源页的全球质量优先文本搜图 | `search_images`：Brave Images → Serper Images |
| 官网、Google 精准结果、新闻与图片 | Serper |
| 独立 Web / News 索引与 LLM-ready grounding chunks | Brave Web、News、LLM Context |
| 一次返回 Web + News，可选 query-aware highlights | You.com Search |
| 自然语言目标、多查询语义检索与高密度 excerpts | Parallel Search |
| 带来源答案和研究任务 | LinkUp 官方 MCP |
| 手动通用/垂直搜索、并行批量查询与 URL 提取 | AnySearch 官方 MCP |
| 搜索、抓取、爬取、站点 Map、结构化提取 | Firecrawl 官方 MCP |
| 紧凑搜索 | Jina Search |
| 紧凑的独立搜索 | TinyFish Search |
| 中文本地搜索且明确同意消耗次数 | 豆包 |
| Web + X 原生搜索与模型综合 | Grok / xAI Responses |

## 安装和构建

```powershell
cd E:/Script/Services/search-toolkit
npm install
npm run build
npm test
npm run smoke:mcp
```

要求 Node.js 22+；推荐 Node.js 24。

## 独立配置

真实配置默认位于：

```text
%USERPROFILE%/.config/search-toolkit/providers.json
```

一次性从 Kelivo 导出：

```powershell
npm run import:kelivo
```

该路径刻意避开 Windows MSIX 对 `AppData/Local` 的虚拟化，Codex、Claude Code 与裸 CLI 会读取同一个物理文件。导出后运行时不再读取 Kelivo。

## 使用

```powershell
node dist/src/cli.js tools
node dist/src/cli.js status
node dist/src/cli.js call querit_search '{"query":"今天的 AI Agent 新闻","limit":5}'
node dist/src/cli.js probe querit "轮询验证"
```

MCP 会按 Provider 工具策略暴露官方上游能力；Firecrawl 默认从 27 个工具收窄为 7 个核心检索/获取工具，完整目录需要显式 `toolPolicy.allow: ["*"]`。此外提供：

- `search_auto`：提供 `balanced` / `max` 两档质量优先路由，只考虑 `automatic: true` 且不是 `manualOnly` 的 Provider；识别到 Provider 可用性故障时最多尝试一个同类检索兜底，豆包因此不会被自动调用。
- `search_images`：全球质量优先按 Brave Images → Serper Images 做文本搜图，自动路由不使用国家范围缩窄结果；需要国家筛选时才直调 Provider。它不会自动收到聊天附件，也不等同于反向搜图。
- `search_pool_status`：查看脱敏 Key 池和轮询状态。
- `search_rotation_probe`：实际请求并证明 Key 轮询顺序，会消耗 Provider 配额。

每次成功的 Provider 调用都会返回可审计的 `{provider, tool, upstreamTool}`：REST 直调写入结构化结果，上游 MCP 直调在 `content` 首块返回模型可见的 `searchToolkitRoute`，`search_auto` 会把两种路径归一成单个路由块而不重复，并在 `structuredContent.searchAuto` 中补充 mode、quality、候选序号与受限尝试记录。

## 安全边界

- 仓库不包含真实 Key。
- Git 忽略 `providers.json`、`.env`、`state.db` 和日志。
- 工具输出只显示 Key 掩码。
- `400/404/422` 不会导致错误禁用其他 Key。
- `401/403` 禁用当前 Key；`429/402` 冷却当前 Key；网络错误或 `5xx` 最多换下一把重试一次。
- 创建、更新、运行任务和提交反馈不标成只读；删除工具标成 destructive。Codex 建议使用 `default_tools_approval_mode = "writes"`。

## License

MIT
