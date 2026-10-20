# Search Toolkit

面向 AI Agent 的官方优先搜索工具集，提供持久化多 Key 轮询、STDIO / Streamable HTTP MCP、CLI 与 Agent Skill。

## 核心原则

- 不把所有搜索服务压成一个失去特色的通用接口。
- Exa、Tavily、LinkUp、AnySearch、Firecrawl 优先透明代理官方 MCP，保留官方工具 schema。
- Querit、Serper（Web/News/Images/Scholar）、Brave Web/News/Images/LLM Context、You.com Search/Contents、Parallel Search/Extract/Images、Octen、Jina、TinyFish、豆包与 xAI Responses 只做官方 API 薄适配。
- 每家 Provider 独立维护 Key 池；SQLite 游标可跨进程、跨重启持续轮询，健康状态按 Key 指纹记录，调换 Key 顺序不会错位。
- 真实 Key 只保存在仓库外的文本 JSON，不写进代码、Skill、README 或 Codex 配置。
- 豆包 `auto` 为空，只能被直接调用，不会被 `search_auto` 或任何自动兜底消耗。

## 能力路由

| 需求 | 首选 |
| --- | --- |
| 普通质量优先 Web 搜索 | `search_auto`：general、exact、current、official、scholar、code、context 七种模式，各自按实测排序；中文查询走带中文参数的 Brave 和 Serper |
| 精确字符串、代码、语义搜索、网页正文 | Exa 官方 MCP |
| 当前新闻与快速变化事实 | Brave News、You.com、Tavily、Serper News |
| 独立来源互相印证 | `search_auto` + `crossCheck: true` |
| 读取 1 个或最多 5 个已知 URL | `fetch_auto`：Exa → Tavily → Parallel Extract → You.com Contents → Firecrawl → LinkUp → AnySearch |
| 保留原图、缩略图、尺寸与来源页的全球质量优先文本搜图 | `search_images`：Brave Images → Parallel Images → Serper Images |
| 官网、Google 精准结果、新闻、图片与 Google Scholar 学术论文 | Serper（`serper_search`、`serper_news`、`serper_images`、`serper_scholar`） |
| 独立 Web / News 索引（支持 `extraSnippets`、`goggles`）与 LLM-ready grounding chunks | Brave Web、News、LLM Context |
| 一次返回 Web + News、实时 `knowledge` 卡片、`full_page` 正文与 URL 提取 | You.com Search & Contents（`you_search`、`you_contents`） |
| 自然语言目标检索、批量目标驱动 URL 提取与语义搜图 | Parallel Search、Extract 与 Images（`parallel_search`、`parallel_extract`、`parallel_image_search`） |
| 带来源答案和研究任务 | LinkUp 官方 MCP |
| 手动通用/垂直搜索、并行批量查询与 URL 提取 | AnySearch 官方 MCP |
| 搜索、抓取、爬取、站点 Map、结构化提取 | Firecrawl 官方 MCP |
| 紧凑搜索（手动） | Querit、TinyFish Search、Jina Search |
| 中文本地搜索且明确同意消耗次数 | 豆包 |
| Web + X 原生搜索、图片/视频理解与模型综合 | Grok / xAI Responses |

## 安装和构建

```powershell
git clone https://github.com/TheWiseWolfHolo/search-toolkit
cd search-toolkit
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

该路径刻意避开 Windows MSIX 对 `AppData/Local` 的虚拟化，Codex、Claude Code 与裸 CLI 会读取同一个物理文件。可复制 `config.example.json` 作为起点。

每个 Provider 用 `auto` 声明它可以在不被点名时承担哪些任务：

```json
"brave": {
  "enabled": true,
  "auto": ["search", "images"],
  "keys": ["..."],
  "integration": { "kind": "rest", "adapter": "brave" }
}
```

`auto` 的取值是 `search`、`images`、`fetch`。空数组表示只能手动调用：不会被 `search_auto`、`search_images`、`fetch_auto` 选中，也不会作为兜底。

可选的顶层设置：

- `profile`：`full`（默认）、`curated` 或 `lean`；命令行 `--profile` 和环境变量 `SEARCH_TOOLKIT_PROFILE` 优先于配置文件。
- `shaping`：`maxDescriptionChars`（默认 700）与 `maxParamDescriptionChars`（默认 220），`0` 表示保持上游原文。
- 每个 Provider 的 `toolPolicy.allow`、`toolPolicy.deny`，以及 `toolPolicy.descriptions`（按上游工具名替换描述）。

v1 配置（`automatic` / `manualOnly`）仍可加载。升级方法：

```powershell
node dist/src/cli.js migrate-config           # 只预览改动
node dist/src/cli.js migrate-config --write   # 先备份，再写入 v2
```

迁移还会删掉没有任何适配器读取的 `options`，目前只有 Grok 会读取 `model`、`reasoningEffort`、`systemPrompt`、`customUrl`。

## 使用

```powershell
node dist/src/cli.js search "MCP 会话管理" --quality max --domains modelcontextprotocol.io,github.com --cross
node dist/src/cli.js fetch https://example.com/article --section "Rate Limits" --max-chars 8000
node dist/src/cli.js fetch https://example.com/a https://example.com/b --max-chars 6000
node dist/src/cli.js tools --profile curated  # 只列名称；--json 输出完整 schema
node dist/src/cli.js call querit_search '{"query":"今天的 AI Agent 新闻","limit":5}'
node dist/src/cli.js status                   # 脱敏 Key 健康、冷却和警告
node dist/src/cli.js reset brave              # 手动清除 Key 冷却（可指定槽位）
node dist/src/cli.js probe querit "轮询验证"
```

`search`、`fetch`、`call` 默认输出模型会读到的内容：一行路由信息加结果文本；加 `--json` 输出完整结构化结果。

MCP 会按 Provider 工具策略暴露官方上游能力；Firecrawl 默认从 27 个工具收窄为 7 个核心检索/获取工具，完整目录需要显式 `toolPolicy.allow: ["*"]`。此外提供：

- `search_auto`：提供 `balanced` / `max` 两档质量优先路由，支持 `includeDomains`、`excludeDomains`、全模式 `freshness` 与 `maxCharsPerResult`；优先选择当前有健康可用 Key 的 Provider，自动对规范化 URL（含 `.md` / `.html` 文档镜像后缀）去重并限制单条摘录长度，避免常规搜索输出过大被宿主落盘。`crossCheck: true` 并行查询两个独立搜索源（支持 REST 与归一化后的 Exa / Tavily MCP），按规范化 URL 去重合并并标注每条结果由哪些 Provider 找到。
- `fetch_auto`：用 Exa、Tavily、Parallel Extract、You.com Contents、Firecrawl、LinkUp、AnySearch（`auto` 含 `fetch` 的那些）读取单个 `url` 或并发读取最多 5 个 `urls`。读到几乎无内容、Cloudflare/JS 验证壳页面，或者网站对它返回 403/429/5xx 时，自动换下一个阅读器，最多尝试三个；页面不存在（404/410）时直接报错；支持 `maxChars`、`offset` 分页续读与 `section` Markdown 标题段落提取；`quality: max` 优先 Firecrawl 以应对重度 JavaScript 页面。
- `search_images`：全球质量优先按 Brave Images → Parallel Images → Serper Images 做文本搜图，不等同于反向搜图，也不会自动收到聊天附件。
- `search_pool_status`：查看脱敏 Key 池、冷却和轮询状态。
- `search_rotation_probe`：实际请求并证明 Key 轮询顺序，会消耗 Provider 配额。

### 路由依据

各模式的 Provider 顺序来自实测。`npm run eval:search` 会把 `evals/search-queries.json` 里的中英文查询（覆盖网页、新闻、论文、代码）在每个 Provider 变体上跑一遍，不用模型打分，只统计权威来源命中、语言一致、日期、时效、重复和延迟。它会消耗真实额度。2026 年 10 月那次评测是现在排序的依据，摘要见 [docs/search-eval-2026-10.md](docs/search-eval-2026-10.md)。

### 模型读到什么

每个结果以一个路由块开头：`{"searchToolkitRoute": {provider, tool}}`（统一工具另带 `searchToolkitAuto`，记录 mode 和 quality；只有发生降级时才附 `attempts`，形如 `["parallel_search:429", "you_search:success"]`），后面是紧凑文本：带发布日期的编号结果、受控长度摘录（去掉复制按钮、锚点、表格分隔线这类页面残渣；摘录过长时优先保留含查询词的句子，不只截开头），以及交叉验证时找到该结果的 Provider。Exa、Tavily 等上游 MCP 搜索工具也会自动归一化为相同的编号格式。通过 MCP 只发送 `content` 和 `_meta`：Claude Code 等客户端在两者都有时会把 `structuredContent` 交给模型、丢掉 `content`，可读正文就变成了原始 JSON。上游声明的 `outputSchema` 也因此去掉。完整的结构化结果仍可用 CLI 的 `--json` 查看。Brave LLM Context 按来源渲染 grounding，Grok 的回答附引用列表。

### 缓存

`search_auto`、`search_images`、`fetch_auto` 的成功结果会在共享状态库里保留一小段时间。窗口内另一轮对话、另一个 agent 或另一个客户端重复同样的搜索或抓取，直接复用，不再调用 Provider。复用的结果会在路由块里写明，例如 `"cached":"4m"`。抓过的页面还能直接服务同一文档后续的 `offset` 和 `section` 读取。失败和内容过少的抓取不会缓存。默认窗口是普通搜索 15 分钟、`mode: current` 5 分钟、抓取 30 分钟，可在配置的 `cache` 里调整或用 `enabled: false` 关闭；也可以设 `SEARCH_TOOLKIT_CACHE=off`，或在 CLI 加 `--no-cache`；`search-toolkit cache-clear` 清空缓存。

### 同站重复与 Provider 健康度

同一份结果里，同一页面的其他版本或镜像（同一站点，标题去掉 `x.y.z` 版本号后相同）只留排名最靠前的一条。为了去重后条数不缩水，会向 Provider 多要两条。自动路由里连续失败两次的 Provider 会暂时排到健康的 Provider 后面，成功一次或安静半小时后恢复原位。`search_pool_status` 里的 `recentFailure` 就是这个分数。

### 上下文成本

客户端每加载一个工具 schema 都要占用上下文。默认会在段落或句子边界裁剪描述并限制参数描述长度，类型、枚举、默认值与 required 保持上游原样：

- `full`（默认）：暴露全部统一工具与每个已启用 Provider 的工具（约 42 个）。
- `curated`：暴露统一工具、`provider_tools`/`provider_call` 网关，以及高价值专长工具（`exa_web_search_advanced_exa`、`brave_llm_context`、`parallel_extract`、`you_contents`、`serper_scholar`、`firecrawl_*`、`tavily_tavily_research`、`linkup_linkup_research`、`grok_*`、`doubao_search`、`anysearch_batch_search`），隐藏与 `search_auto`/`fetch_auto` 重复的基础单源工具。
- `lean`：只暴露 `search_auto`、`search_images`、`fetch_auto`、`search_pool_status`、`search_rotation_probe` 和 `provider_tools`/`provider_call` 网关（共 7 个工具）。

`npm run measure` 可测量任意 profile 的启动耗时与工具清单体积。

### 启动

各 Provider 并发发现，上游工具目录缓存在状态库旁。之后的启动立即就绪，只有真正调用某个上游工具时才连接它（包括启动 Firecrawl 子进程）。缓存超过 12 小时会在后台刷新，有变化时发送 `notifications/tools/list_changed`。

## Streamable HTTP

移动端或远程客户端可启动同一核心的 Streamable HTTP transport：

```powershell
$env:SEARCH_TOOLKIT_HTTP_TOKENS = '[{"hash":"<owner token SHA-256>"},{"hash":"<guest token SHA-256>","tools":["search_auto","search_images"],"requestsPerMinute":30,"maxSessions":8}]'
$env:SEARCH_TOOLKIT_HTTP_ALLOWED_HOSTS = 'search-mcp.example.com'
node dist/src/http-server.js --config C:/Users/you/.config/search-toolkit/providers.json
```

客户端连接 `/mcp` 并发送 `Authorization: Bearer <client-token>`。不设置 `tools` 的是 owner token；分享给他人的 token 应设置明确工具白名单、`requestsPerMinute` 限流，并可用 `maxSessions` 限制活跃会话数。owner token 不设置 `maxSessions` 时不受会话数限制。STDIO 与 HTTP 共用 Provider 配置、轮询状态和路由逻辑，HTTP 只额外施加传输层访问策略。公网部署应放在 HTTPS 后，Provider Key 始终留在服务器。

## Key 轮询与安全边界

- 每次请求从该 Provider 的健康 Key 中选一把；游标跨进程、跨重启持久化。
- 成功会清零 Key 的失败计数。
- `401/403`：封这把 Key 1 小时，重复出错依次延长到 6、24 小时。不是永久禁用，到期会重新试用。
- `402`：封 30 分钟，再到 6、24 小时。
- `429`：封 1、5、15 分钟；Provider 给了 `Retry-After` 就按它的时间。
- `401/402/403/429`：在同一池内最多换 3 把健康 Key。
- `5xx` 或连接断开：再换 1 把 Key 试一次，不封 Key。
- 超时不换 Key 重试，自动路由直接去试下一家 Provider。
- `400/404/422`、上游 MCP 工具自己返回的错误，以及被读取网页自己的状态码（例如网站对 Parallel Extract 返回 403），都不算到 Key 头上，也不重试。只有明确指向 Key 的错误文本（无效 Key、额度、限流）才算 Key 故障。
- `search-toolkit status --verbose` 会显示每把 Key 最近一次的错误和时间。
- Key 池全部被封时快速失败，并说明最早什么时候恢复；`search-toolkit reset <provider>` 可手动解封。
- 仓库不包含真实 Key；Git 忽略 `providers.json`、`.env`、`state.db` 和日志；工具输出只显示 Key 掩码。
- 创建、更新、运行任务和提交反馈不标成只读；删除工具标成 destructive。Codex 建议使用 `default_tools_approval_mode = "writes"`。

## License

MIT
