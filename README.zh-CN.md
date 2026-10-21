# Search Toolkit

给 AI Agent 用的网页搜索、图片搜索和网页读取工具。它按实测质量在多家 Provider 之间路由，每家维护持久化的多 Key 轮询。可以作为 MCP 服务（STDIO 或 Streamable HTTP）、CLI 或 Agent Skill 使用。

[English](README.md)

## Agent 能用到什么

三个工具覆盖几乎所有查询。每个工具自己选 Provider，失败时自动换下一家，并写明最后是谁给的结果。

| 工具 | 用途 | 路由 |
| --- | --- | --- |
| `search_auto` | 网页搜索 | 七种模式，每种都有按真实查询实测出的 Provider 顺序（见下表）。中文查询自动切换到中文市场参数。 |
| `search_images` | 按文字或按图片找图 | 文字：Brave Images → Serper Images → Parallel Images。图片 URL：走 Google Lens 以图搜图，用来认出图里是什么，或者查这张图出现在哪些网页。 |
| `fetch_auto` | 读取 1 到 5 个已知 URL | Exa → Tavily → Parallel Extract → You.com Contents → Firecrawl → LinkUp → AnySearch。遇到验证壳页面、几乎没有内容或被网站拒绝时，换下一个阅读器。 |

`search_auto` 各模式在 balanced 档的顺序：

| 模式 | 适用 | 英文查询 | 中文查询 |
| --- | --- | --- | --- |
| `general` | 日常查询 | Parallel → Serper → Exa Lite → You.com → Octen → Brave → Tavily | Brave → Serper → You.com → Parallel → Tavily |
| `exact` | 带引号的原文、报错信息 | Parallel → Brave → Serper → You.com → Tavily | Brave → Serper → You.com → Parallel |
| `official` | 厂商、产品、政府官网 | Exa Lite → Brave → Serper → You.com | Exa Lite → Serper → Parallel → Brave |
| `current` | 新闻 | You.com → Exa 新闻 → Octen → Serper News → Brave News → Tavily 新闻 | Exa 新闻 → You.com → Octen → Serper News → Brave News → Tavily 新闻 |
| `scholar` | 论文、预印本、综述 | Exa Lite → Parallel → You.com → Serper Scholar | 同左 |
| `code` | 代码仓库、示例、API 用法 | Exa Lite（GitHub 分类）→ Parallel → Serper → Exa Lite | 同左 |
| `context` | 限定 token 预算的 grounding 片段 | Brave LLM Context → Parallel → You.com → Tavily | 同左 |

`quality: max` 用于范围大或需要多跳的问题：英文 general 改由带 highlights 的 Exa Auto 打头，其他模式里的 Exa Lite 换成 Exa Auto，Parallel、You.com、Brave、Tavily 也切到更深的档位。所有模式都支持 `includeDomains`、`excludeDomains`、`freshness`、`maxCharsPerResult`，会换算成各家自己的参数。`crossCheck: true` 同时查两个独立索引，并标出每条结果是哪家找到的。

### 顺序是怎么定的

`npm run eval:search` 会把 `evals/search-queries.json` 里的中英文查询（覆盖网页、新闻、论文、代码）在每个 Provider 变体上跑一遍，不用模型打分，只统计前三条里有没有权威来源、权威来源占比、语言是否一致、日期、时效、重复和延迟。它会消耗真实额度。2026 年 10 月的评测、上线路由的端到端复测，以及和 Artificial Analysis Search Index 的对照，都在 [docs/search-eval-2026-10.md](docs/search-eval-2026-10.md)。

## Provider

| 需求 | Provider 或工具 |
| --- | --- |
| 语义检索、官网、论文、代码仓库、网页正文 | Exa 官方 MCP |
| Google 精简结果、新闻、图片、Scholar 论文和 Google Lens | Serper（`serper_search`、`serper_news`、`serper_images`、`serper_scholar`、`serper_lens`） |
| 独立的网页和新闻索引（`extraSnippets`、`goggles`），以及给模型用的 grounding 片段 | Brave Web、News、Images、LLM Context |
| 一次返回网页和新闻、实时 `knowledge` 卡片、`full_page` 正文、URL 提取 | You.com Search 与 Contents |
| 自然语言目标检索、批量 URL 提取、语义搜图 | Parallel Search、Extract、Images |
| 速度快、每条结果附较长相关摘录的搜索 | Octen Search |
| 托管的提取、站点地图、爬取和研究任务 | Tavily 官方 MCP |
| 搜索、抓取、爬取、站点地图、结构化提取 | Firecrawl 官方 MCP |
| 带来源的答案和研究任务 | LinkUp 官方 MCP |
| 手动通用或垂直搜索、并行批量查询、URL 提取 | AnySearch 官方 MCP |
| 网页加 X 原生搜索、模型综合、图片和视频理解 | Grok / xAI Responses |
| 紧凑搜索，只能手动调用 | Querit、TinyFish Search、Jina Search |
| 中文本地搜索，需要明确同意消耗次数，只能手动调用 | 豆包 |

远程 MCP（Exa、Tavily、LinkUp、AnySearch）和 STDIO 的 Firecrawl 按官方工具名和 schema 透明代理，其余都是对官方 REST API 的薄适配。

## 安装

```powershell
git clone https://github.com/TheWiseWolfHolo/search-toolkit
cd search-toolkit
npm install
npm run build
```

需要 Node.js 22 或更新版本，推荐 24。Key 健康、结果缓存和 Provider 健康度都存在一个 SQLite 文件里，用的是内置的 `node:sqlite`。

## 配置

把 `config.example.json` 复制到仓库外的私有位置，再填上真实 Key。Windows 默认路径是 `%USERPROFILE%/.config/search-toolkit/providers.json`（避开了 `AppData/Local`，MSIX 打包的应用和普通进程读到的是同一个文件），其他系统是 `~/.config/search-toolkit/providers.json`。也可以用 `SEARCH_TOOLKIT_CONFIG` 或 `--config` 指定。

每个 Provider 用 `auto` 声明它在没被点名时能承担哪些任务：

```json
"brave": {
  "enabled": true,
  "auto": ["search", "images"],
  "keys": ["key-1", "key-2"],
  "integration": { "kind": "rest", "adapter": "brave" }
}
```

`auto` 的取值是 `search`、`images`、`fetch`。空数组表示只能手动调用：它的工具仍可直接调用，但 `search_auto`、`search_images`、`fetch_auto` 不会选它，也不会拿它兜底。豆包默认就是这样。

可选的顶层设置：

- `profile`：`full`（默认）、`curated` 或 `lean`，见[上下文成本](#上下文成本)。`--profile` 和 `SEARCH_TOOLKIT_PROFILE` 优先于配置文件。
- `cache`：`enabled`（默认 `true`）、`searchTtlSeconds`（900）、`newsTtlSeconds`（300，用于 `mode: current`）、`fetchTtlSeconds`（1800），见[缓存](#缓存)。
- `shaping`：`maxDescriptionChars`（默认 700）和 `maxParamDescriptionChars`（默认 220），`0` 表示保持上游原文。
- 每个 Provider 可设 `toolPolicy.allow`、`toolPolicy.deny` 和 `toolPolicy.descriptions`（按上游工具名替换描述）。Firecrawl 默认只暴露 7 个检索工具，设 `toolPolicy.allow: ["*"]` 才会暴露完整目录。

v1 配置（`automatic` / `manualOnly`）仍能加载。升级方法：

```powershell
node dist/src/cli.js migrate-config           # 只预览改动
node dist/src/cli.js migrate-config --write   # 先备份，再写入 v2
```

## CLI

```powershell
node dist/src/cli.js search "MCP 会话管理" --quality max --domains modelcontextprotocol.io,github.com --cross
node dist/src/cli.js search "台风 预警" --mode current
node dist/src/cli.js images "黄山 云海"
node dist/src/cli.js images https://example.com/photo.jpg   # 以图搜图
node dist/src/cli.js fetch https://example.com/article --section "Rate Limits" --max-chars 8000
node dist/src/cli.js fetch https://example.com/a https://example.com/b --max-chars 6000
node dist/src/cli.js call serper_scholar '{"query":"retrieval augmented generation survey","limit":5}'
node dist/src/cli.js tools --profile curated  # 只列名称；--json 输出完整 schema
node dist/src/cli.js status --verbose         # 脱敏的 Key 健康、冷却和最近错误
node dist/src/cli.js reset brave              # 手动清除 Key 冷却（可指定槽位）
node dist/src/cli.js cache-clear
```

`search`、`images`、`fetch`、`call` 输出的就是模型会读到的内容。`--json` 输出完整结构化结果，`--no-cache` 跳过缓存。

## MCP

先构建，再把 STDIO 服务注册到客户端。Claude Code：

```powershell
claude mcp add searchToolkit --scope user -- node C:/path/to/search-toolkit/dist/src/mcp-server.js --config C:/Users/you/.config/search-toolkit/providers.json
```

Codex（`~/.codex/config.toml`）：

```toml
[mcp_servers.searchToolkit]
command = "C:/path/to/node.exe"
args = ["C:/path/to/search-toolkit/dist/src/mcp-server.js", "--config", "C:/Users/you/.config/search-toolkit/providers.json", "--profile", "lean"]
startup_timeout_sec = 30
tool_timeout_sec = 120
default_tools_approval_mode = "writes"
```

除了三个统一工具，服务还提供 `search_pool_status`（脱敏的 Key 诊断）和 `search_rotation_probe`（真实请求验证轮询，会消耗额度）。Provider 工具按 profile 直接暴露，或者通过 `provider_tools` / `provider_call` 网关调用。会创建、更新、启动任务或提交反馈的工具不标只读，删除类工具标为 destructive。

### 模型读到什么

每个结果先是一行紧凑的路由块，然后是可读文本：

```text
{"searchToolkitRoute":{"provider":"parallel","tool":"parallel_search"},"searchToolkitAuto":{"mode":"general","quality":"balanced"}}

1. 页面标题 (2026-10-15)
   https://example.com/page
   摘录，过长时保留提到查询词的句子……
```

只有发生降级时才会出现 `attempts`（形如 `["parallel_search:429", "you_search:success"]`），只有复用缓存时才会出现 `"cached":"4m"`。摘录有长度上限，会去掉复制按钮、锚点、表格分隔线、图片和链接语法这类页面残渣，过长时保留提到查询词的句子。图片结果会列出原图、缩略图、来源页面和发布方。

通过 MCP 只发送 `content` 和 `_meta`。Claude Code 等客户端在两者都有时会把 `structuredContent` 交给模型而丢掉 `content`，可读正文就会变成原始 JSON；上游声明的 `outputSchema` 也因此去掉。完整的结构化结果可以用 CLI 的 `--json` 查看。

### 缓存

`search_auto`、`search_images`、`fetch_auto` 的成功结果会在共享状态库里保留一小段时间。窗口内另一轮对话、另一个 agent 或另一个客户端重复同样的搜索或抓取，不再调用 Provider。抓过的页面还能直接服务同一文档后续的 `offset` 和 `section` 读取。失败和内容过少的抓取不会缓存。关闭方法是设 `cache.enabled: false`、`SEARCH_TOOLKIT_CACHE=off`，或在 CLI 加 `--no-cache`。

### 结果去重与 Provider 健康度

同一份结果里，重复的 URL（包括文档的 `.md` / `.html` 镜像）和同一页面的其他版本（同一站点，标题去掉 `x.y.z` 版本号后相同）只留排名最靠前的一条。为了去重后条数不缩水，会向 Provider 多要两条。自动路由里连续失败两次的 Provider 会排到健康的 Provider 后面，成功一次或安静半小时后恢复；`search_pool_status` 里的 `recentFailure` 就是这个分数。

### 上下文成本

客户端每加载一个工具 schema 都要占上下文。描述会在句子边界裁剪，参数描述有长度上限，类型、枚举、默认值和 required 保持上游原样。示例配置里的 Provider 全部启用时：

| Profile | 暴露内容 | 工具数 | schema token |
| --- | --- | --- | --- |
| `full`（默认） | 统一工具和所有 Provider 工具 | 49 | 约 20,000 |
| `curated` | 统一工具、网关和专长工具（`exa_web_search_advanced_exa`、`brave_llm_context`、`parallel_extract`、`you_contents`、`serper_scholar`、`firecrawl_*`、`tavily_tavily_research`、`linkup_linkup_research`、`grok_*`、`doubao_search`、`anysearch_batch_search`） | 22 | 约 9,400 |
| `lean` | 统一工具、状态、探针和网关 | 7 | 约 2,100 |

`npm run measure -- --profile lean` 可测量启动耗时和工具清单体积。

### 启动

各 Provider 并发发现，上游工具目录缓存在状态库旁边，所以之后的启动半秒内就绪，只有第一次调用某个上游工具时才连接它（包括启动 Firecrawl 子进程）。目录超过 12 小时会在后台刷新，有变化时发送 `notifications/tools/list_changed`。

## Streamable HTTP

移动端或远程客户端可以通过有状态的 Streamable HTTP 使用同一套工具。服务器只保存客户端 token 的 SHA-256：

```powershell
$env:SEARCH_TOOLKIT_HTTP_TOKENS = '[{"hash":"<owner token SHA-256>"},{"hash":"<guest token SHA-256>","tools":["search_auto","search_images"],"requestsPerMinute":30,"maxSessions":8}]'
$env:SEARCH_TOOLKIT_HTTP_ALLOWED_HOSTS = 'search-mcp.example.com'
node dist/src/http-server.js --config C:/Users/you/.config/search-toolkit/providers.json
```

客户端连接 `/mcp`，带上 `Authorization: Bearer <client-token>`。没有 `tools` 的是 owner token。分享出去的 token 应该设工具白名单和 `requestsPerMinute` 限流，需要时再加 `maxSessions`。公网部署要放在 HTTPS 后面，Provider Key 始终留在服务器上。

## Key 轮询

每次请求从该 Provider 的 Key 池里取一把健康的 Key。游标跨重启持久化，并通过 SQLite 在多个并发进程间共享。健康状态按 Key 指纹记录，调换或删减 Key 不会把历史记到别的 Key 上。

| 结果 | 对 Key 的处理 | 重试 |
| --- | --- | --- |
| 成功 | 清零失败计数 | |
| `401` / `403` | 停用 1 小时，再犯依次 6 小时、24 小时 | 最多换 3 把 |
| `402` | 停用 30 分钟，再犯依次 6 小时、24 小时 | 最多换 3 把 |
| `429` | 停用 1、5、15 分钟，或按 `Retry-After` | 最多换 3 把 |
| `5xx` 或连接断开 | 不停用 | 再换 1 把 |
| 超时 | 不停用 | 不换 Key，自动路由直接去下一家 |
| `400` / `404` / `422`、上游工具自己的错误、被读取网页自己的状态码 | 不停用 | 不重试 |

停用都会到期，不是永久的。只有明确指向 Key 的错误文本（无效 Key、额度、余额、限流）才算 Key 故障，网站对阅读器返回 403 不算。Key 全部停用时立即失败，并说明最早什么时候恢复；`reset <provider>` 可以手动解除。`providers.json`、真实 Key 和状态库都被 Git 忽略，输出里只显示 Key 掩码。

## Skill

`skills/search-toolkit/` 是一个 Agent Skill，复制或链接到 agent 的 skill 目录即可。`SKILL.md` 放每次搜索都需要的路由规则，`references/provider-routing.md` 放各 Provider 的定位、模式细节和结果读法。

## 开发

```powershell
npm test
npm run smoke:mcp
npm run measure
npm run eval:search -- --variants auto          # 会消耗额度
npm run smoke:http -- https://search-mcp.example.com/mcp C:/private/client-token.txt
npm pack --dry-run
```

## License

MIT
