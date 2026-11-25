# Search Toolkit

给 AI Agent 用的网页搜索、图片搜索和网页读取工具。它按实测质量在多家 Provider 之间路由，每家维护持久化的多 Key 轮询。可以作为 MCP 服务（STDIO 或 Streamable HTTP）、CLI 或 Agent Skill 使用。

[English](README.md) | [客户端接入](docs/agent-setup.md) | [运维手册](docs/operator-guide.md) | [安全模型](docs/security.md) | [检索评测](docs/search-eval-2026-10.md)

## Agent 能用到什么

三个工具覆盖几乎所有查询。每个工具自己选 Provider，失败时自动换下一家，并写明最后是谁给的结果。

| 工具 | 用途 | 路由 |
| --- | --- | --- |
| `search_auto` | 网页搜索 | 七种模式，每种都有基于真实查询评测的 Provider 顺序（见下表）；遇到可用性故障或空结果时最多尝试 3 家。简繁体中文查询自动切换到中文市场参数。 |
| `search_images` | 按文字或按图片找图 | 文字：Brave Images -> Serper Images -> Parallel Images（单次调用最多尝试 2 家；当 Brave 或 Serper 已停用或全池冷却时自动命中 Parallel）。图片 URL：走 Google Lens 以图搜图，用来认出图里是什么，或者查这张图出现在哪些网页。 |
| `fetch_auto` | 读取 1 到 5 个已知 URL | balanced：Direct Markdown（可选零成本探测，跳过时不占用 3 家尝试额度）-> Exa -> DeepSeek -> Vercel DeepSeek -> Tavily -> Parallel Extract -> TinyFish -> You.com Extract -> Octen -> Firecrawl -> LinkUp -> AnySearch；`quality: max` 由 Firecrawl -> TinyFish -> Tavily -> Parallel 打头。遇到验证壳页面、片段或站点拦截时自动换下一个阅读器。 |

`search_auto` 各模式在 balanced 档的顺序：

| 模式 | 适用 | 英文查询 | 中文查询 |
| --- | --- | --- | --- |
| `general` | 日常查询 | Parallel -> Serper -> Exa Lite -> You.com -> Octen -> Brave -> Tavily -> DeepSeek -> Vercel DeepSeek -> Vercel Parallel Fast | Brave -> Serper -> DeepSeek -> Vercel DeepSeek -> You.com -> Parallel -> Vercel Parallel Fast -> Tavily |
| `exact` | 带引号的原文、报错信息 | Parallel -> Brave -> Serper -> You.com -> Tavily -> DeepSeek -> Vercel DeepSeek | Brave -> Serper -> DeepSeek -> Vercel DeepSeek -> You.com -> Parallel |
| `official` | 厂商、产品、政府官网 | Exa Lite -> Brave -> Serper -> You.com -> DeepSeek -> Vercel DeepSeek -> Vercel Parallel Fast | Exa Lite -> Serper -> DeepSeek -> Vercel DeepSeek -> Parallel -> Brave |
| `current` | 新闻 | You.com（`preferNews`）-> Exa 新闻 -> Octen -> Serper News -> Brave News -> Tavily 新闻 -> DeepSeek -> Vercel DeepSeek | Exa 新闻 -> You.com（`preferNews`）-> Octen -> Serper News -> Brave News -> Tavily 新闻 -> DeepSeek -> Vercel DeepSeek |
| `scholar` | 论文、预印本、综述 | Exa Lite（`category: publication`）-> Parallel -> You.com -> Serper Scholar -> Vercel Parallel Fast | 同左 |
| `code` | 代码仓库、示例、API 用法 | Exa Lite（`includeDomains: github.com`）-> Parallel -> Serper -> DeepSeek -> Vercel DeepSeek -> Vercel Parallel Fast | 同左 |
| `context` | 限定 token 预算的 grounding 片段 | Brave LLM Context -> Parallel -> You.com -> Tavily -> DeepSeek -> Vercel DeepSeek | 同左 |

`quality: max` 用于范围大或需要多跳的问题：英文 general 改由带 highlights 的 Exa Auto 打头，`context` 模式把 Parallel Advanced 排在 Brave LLM Context 之前，其他模式里的 Exa Lite 换成 Exa Auto，DeepSeek 启用 `needContent: true`，Parallel、You.com、Brave、Tavily 也切到更深的档位。所有模式都支持 `includeDomains`、`excludeDomains`、`freshness`、`maxCharsPerResult`，会换算成各家自己的参数（Exa、Parallel 和 `site:` 路线都会保留 `github.com/org` 这类路径前缀，不会把带路径的排除规则放宽成整站排除；超长的运算符查询会自动跳过超出上限的 Provider：DeepSeek 128 字符、Serper 32 词、Brave 600/400 字符）。`crossCheck: true` 同时查两个独立索引，用 RRF 融合排序并标出每条结果是哪家找到的。

### 顺序是怎么定的

`npm run eval:search` 会把 `evals/search-queries.json` 里的中英文查询（覆盖网页、新闻、论文、代码和上下文）在每个 Provider 变体上跑一遍，不用模型打分，只统计前三条里有没有权威来源、权威来源占比、语言是否一致、日期、时效、重复和延迟。它会消耗真实额度。2026 年 10 月的评测、上线路由的端到端复测，以及和 Artificial Analysis Search Index 的对照，都在 [docs/search-eval-2026-10.md](docs/search-eval-2026-10.md)。

## Provider

| 需求 | Provider 或工具 |
| --- | --- |
| 语义检索、官网、论文、代码仓库、网页正文 | Exa 官方 MCP |
| Google 精简结果、新闻、图片、Scholar 论文和 Google Lens | Serper（`serper_search`、`serper_news`、`serper_images`、`serper_scholar`、`serper_lens`） |
| 独立的网页和新闻索引（`extraSnippets`、`goggles`），以及给模型用的 grounding 片段 | Brave Web、News、Images、LLM Context |
| 一次返回网页和新闻（`preferNews`）、实时 `knowledge` 卡片、`full_page` 正文、`/v1/extract` URL 提取 | You.com Search 与 Extract（`you_contents`） |
| 自然语言目标检索（`max_chars_total`）、批量 URL 提取（`links`）、语义搜图 | Parallel Search、Extract、Images |
| 速度快、每条结果附较长相关摘录（`/search-premier`、1,200 域名过滤）、URL 提取 | Octen Search 与 Extract |
| 中英双语搜索（摘要、rerank 分数、原生运算符，上限 128 字符）与 Markdown 抓取 | DeepSeek（`deepseek_search`、`deepseek_fetch`） |
| 托管 DeepSeek Search/Fetch（网关额度 $0.75/千次）与 Parallel Fast（默认 $0 宿主模型） | Vercel AI Gateway（`vercel_deepseek_search`、`vercel_deepseek_fetch`、`vercel_parallel_fast`） |
| 零费用本机 `Accept: text/markdown` 协商（Cloudflare、Vercel Docs、Mintlify），socket 级 IP 固定防 DNS 重绑定；可选、免 Key | Direct Markdown（`direct_markdown_fetch`） |
| 托管的提取、站点地图、爬取和研究任务 | Tavily 官方 MCP（Bearer 鉴权） |
| 搜索、抓取、爬取、站点地图、结构化提取（本地 `firecrawl-mcp@3.41.0` STDIO 或托管远程 MCP `https://mcp.firecrawl.dev/v2/mcp`；窄单实体查询可能触发 Ultrasearch 额外扣费） | Firecrawl 官方 MCP |
| 带来源的答案和研究任务 | LinkUp 官方 MCP |
| 手动通用或垂直搜索、并行批量查询、URL 提取 | AnySearch 官方 MCP |
| 网页加 X 原生搜索、模型综合、图片和视频理解；`depth` 最高支持 16 个研究 Agent | Grok / xAI Responses |
| 用 Chromium 渲染后读取网页（每天前 1,000 个 URL 免费）及网页/新闻/论文搜索 | TinyFish Fetch 与 Search |
| 垂直筛选搜索（`code`/`finance`）、URL 提取（`querit_contents`）、低延迟摘要搜索（`X-Respond-With: no-content`） | Querit、Jina Search |
| 中文本地搜索（默认带摘要、支持域名与时间过滤），只能手动调用 | 豆包 |

远程 MCP（Exa、Tavily、LinkUp、AnySearch，以及可选的托管 Firecrawl `https://mcp.firecrawl.dev/v2/mcp`）和 STDIO 的 Firecrawl 按官方工具名和 schema 透明代理；无鉴权 `remote_mcp`（`auth.kind: "none"`）和 `direct_markdown` 无需填写 Key。其余都是对官方 REST 或 Gateway 接口的薄适配。

## 安装

```powershell
git clone https://github.com/TheWiseWolfHolo/search-toolkit
cd search-toolkit
npm install
npm run build
```

需要 Node.js 22 或更新版本，推荐 24。Key 健康、结果缓存、工具目录缓存和 Provider 健康度都存在同一个 SQLite 文件里，用的是内置的 `node:sqlite`。

## 配置

把 `config.example.json` 复制到仓库外的私有位置，再填上真实 Key。Windows 默认路径是 `%USERPROFILE%/.config/search-toolkit/providers.json`（避开了 `AppData/Local`，MSIX 打包的应用和普通进程读到的是同一个文件），其他系统是 `~/.config/search-toolkit/providers.json`。也可以用 `SEARCH_TOOLKIT_CONFIG` 或 `--config` 指定。`statePath` 支持 `~/` 展开和相对配置文件目录的路径。

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
- 每个 Provider 可设 `strategy`、`defaultTier`、`paidTools` 和带备注的 Key；Key 既可写明文，也可写 `"env:VAR_NAME"` 或 `"file:/path/to/secret"`（支持 `~/` 展开），执行 `migrate-config` 时会保留引用而不落盘明文，见 [Key 轮询](#key-轮询) 与 [docs/operator-guide.md](docs/operator-guide.md)。
- 支持读取 `options` 的适配器：`grok`（`model`、`multiAgentModel`、`reasoningEffort`、`systemPrompt`、`customUrl`）、`deepseek`（`localization`）、`vercel_gateway`（`model`、`reasoning`、`enableParallelFast`、`localization`、`fallbackModels`、`authMethod`）、`direct_markdown`（`timeoutMs`）。
- 每个 Provider 可设 `toolPolicy.allow`、`toolPolicy.deny` 和 `toolPolicy.descriptions`（按上游工具名替换描述）。Firecrawl 默认只暴露 9 个检索工具，AnySearch 默认隐藏 `score` 反馈工具。设 `toolPolicy.allow: ["*"]` 才会暴露完整目录。

v1 配置（`automatic` / `manualOnly`）仍能加载。升级方法：

```powershell
node dist/src/cli.js migrate-config           # 只预览改动
node dist/src/cli.js migrate-config --write   # 先备份，再原子写入 v2
```

## CLI

```powershell
node dist/src/cli.js search "MCP 会话管理" --quality max --domains modelcontextprotocol.io,github.com --cross
node dist/src/cli.js search "台风 预警" --mode current
node dist/src/cli.js images "黄山 云海"
node dist/src/cli.js images --image-url https://example.com/photo.jpg   # 以图搜图
node dist/src/cli.js fetch https://example.com/article --section "Rate Limits" --max-chars 8000
node dist/src/cli.js fetch https://example.com/a https://example.com/b --max-chars 6000
node dist/src/cli.js call serper_scholar '{"query":"retrieval augmented generation survey","limit":5}'
node dist/src/cli.js call serper_scholar @args.json                     # 也支持 --input - 从 stdin 读取
node dist/src/cli.js tools --profile curated --provider exa             # --describe <tool> 或 --json 查 schema
node dist/src/cli.js status --verbose                                   # 脱敏的 Key 健康、冷却和最近错误
node dist/src/cli.js config                                             # 脱敏配置摘要（按套餐汇总数量）
node dist/src/cli.js reset brave                                        # 手动清除 Key 冷却和耗尽状态
node dist/src/cli.js quota                                              # 并发读取各家账单接口的剩余额度
node dist/src/cli.js probe brave "测试查询"                              # 逐槽位发起真实轮询验证
node dist/src/cli.js cache-clear
```

`search`、`images`、`fetch`、`call` 输出的就是模型会读到的内容。`--json` 可在各子命令下输出完整结构化 JSON，`--no-cache` 跳过缓存，失败时错误信息输出到 `stderr` 并返回非零退出码。

## MCP

先构建，再把 STDIO 服务或本地共享 Streamable HTTP 服务注册到客户端。Antigravity CLI、Claude Code、Codex、Cursor、Gemini CLI 的完整接入示例见 [docs/agent-setup.md](docs/agent-setup.md)。

Claude Code：

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

除了三个统一工具，服务还提供 `search_pool_status`（脱敏的 Key 诊断，owner 调用方支持 `refreshQuota: true` 触发实时余额刷新）和 `search_rotation_probe`（真实请求验证轮询，会消耗额度）。Provider 工具按 profile 直接暴露，或者通过 `provider_tools` / `provider_call` 网关调用。工具注解优先级见 [docs/security.md](docs/security.md)（删除类标为 destructive，创建/更新/执行类标为写入，检索/抓取/提取/状态查询类标为只读，爬取/Agent/研究任务标为非只读）。

### 模型读到什么

每个结果先是一行紧凑的路由块，然后是可读文本：

```text
{"searchToolkitRoute":{"provider":"parallel","tool":"parallel_search"},"searchToolkitAuto":{"mode":"general","quality":"balanced"}}

1. 页面标题 (2026-10-15)
   https://example.com/page
   摘录，过长时保留提到查询词的句子……
```

只有发生降级时才会出现 `attempts`（形如 `["parallel_search:429", "you_search:success"]`，零成本 `direct_markdown_fetch` 跳过不会计入），只有复用缓存时才会出现 `"cached":"4m"`。摘录有长度上限，会去掉页面残渣，过长时优先保留命中查询词的片段。图片结果会列出原图、缩略图、来源页面和发布方。

搜索遇到空列表会在尝试次数内换下一家（`search_auto` 最多 3 家，`search_images` 最多 2 家）。`crossCheck.status` 为 `complete` 时两家都有结果，为 `partial` 时只有一家有结果，为 `unavailable` 时未完成交叉搜索。`foundBy` 列出找到同一 URL 的 Provider。

`fetch_auto` 将读到足量正文的页面标为 `readable`，只有片段的页面标为 `partial`。批量结果的 `succeeded` 只统计前者，`failed` 列出读取失败的 URL。正文被裁剪时，可用 `nextOffset` 作为同一 URL 的续读位置。

通过 MCP 只发送 `content` 和 `_meta`。Claude Code 等客户端在两者都有时会把 `structuredContent` 交给模型而丢掉 `content`，可读正文就会变成原始 JSON；上游声明的 `outputSchema` 也因此去掉。完整的结构化结果可以用 CLI 的 `--json` 查看。

### 缓存

`search_auto`、`search_images`、`fetch_auto` 以及直接调用的 `grok_*`（含经 `provider_call` 调用，排除无搜索来源的模型记忆回退）的成功结果会在共享状态库里保留一小段时间（受最大行数与总字节数淘汰上限约束）。抓过的页面还能直接服务同一文档后续的 `offset` 和 `section` 读取。空搜索、未完整命中的交叉搜索，以及只有片段的读取会跳过缓存。关闭方法是设 `cache.enabled: false`、`SEARCH_TOOLKIT_CACHE=off`，或在 CLI 加 `--no-cache`。

### 结果去重与 Provider 健康度

同一份结果里，重复的 URL（包括文档的 `.md` / `.html` 镜像）和同一页面的近重复镜像只留排名最靠前的一条，同时合并更完整的正文和日期。为了去重后条数不缩水，会向 Provider 多要两条（Serper 在 `limit <= 10` 时上限压在 10 条，避免触发 2 倍额度扣费）。自动路由里连续失败两次的 Provider 会排到健康的 Provider 后面，成功一次或安静半小时后恢复；健康度按能力（`search`、`images`、`fetch`）独立统计，`search_pool_status` 里的 `recentFailure` 展示当前最高失败分。

### 上下文成本

客户端每加载一个工具 schema 都要占上下文。描述会在句子边界裁剪，参数描述有长度上限，类型、枚举、默认值和 required 保持上游原样。三种 Profile 对应范围：

| Profile | 暴露内容 |
| --- | --- |
| `full`（默认） | 统一工具、`search_pool_status`、`search_rotation_probe` 和所有已启用 Provider 工具（隐藏 `provider_tools` 和 `provider_call`） |
| `curated` | 统一工具、`search_pool_status`、`search_rotation_probe`、网关（`provider_tools`/`provider_call`）和 14 个专长工具（`anysearch_batch_search`、`brave_llm_context`、`deepseek_search`、`doubao_search`、`exa_web_search_advanced_exa`、`firecrawl_firecrawl_crawl`、`firecrawl_firecrawl_map`、`grok_web_x_search`、`grok_x_search`、`parallel_search`、`serper_scholar`、`vercel_deepseek_search`、`vercel_parallel_fast`、`you_search`） |
| `lean` | 统一工具、`search_pool_status`、`search_rotation_probe` 和网关（共 `7` 个工具，约 2,350 schema token） |

`npm run measure -- --profile lean` 可按当前启用配置测量启动耗时、工具数和 schema 体积。

### 启动

各 Provider 并发发现，上游工具目录缓存在 `state.db` 的 `tool_catalog` 表中（自动兼容迁移旧版 `tool-catalog.json`），所以之后的启动半秒内就绪，只有第一次调用某个上游工具时才连接它。空闲的本地 `stdio_mcp` 子进程会在 10 分钟无调用后自动关闭释放内存（可通过 `integration.idleTimeoutMs` 调整，设 `0` 关闭），下次调用时透明重连。目录超过 12 小时会在后台刷新，有变化时发送 `notifications/tools/list_changed`。

## Streamable HTTP

移动端、远程客户端或本机多客户端共享常驻可通过有状态或无状态 Streamable HTTP（`SEARCH_TOOLKIT_HTTP_STATELESS=1`）接入同一套工具。服务器只保存客户端 token 的 SHA-256：

```powershell
$env:SEARCH_TOOLKIT_HTTP_TOKENS = '[{"hash":"<owner token SHA-256>","role":"owner"},{"hash":"<guest token SHA-256>","role":"client","tools":["search_auto","search_images"],"allowedToolArguments":{"grok_*":{"depth":["fast","deep"]}},"requestsPerMinute":30,"maxSessions":8}]'
$env:SEARCH_TOOLKIT_HTTP_ALLOWED_HOSTS = 'search-mcp.example.com'
node dist/src/http-server.js --config C:/Users/you/.config/search-toolkit/providers.json
```

客户端连接 `/mcp`，带上 `Authorization: Bearer <client-token>`。推荐为每条 token 显式声明 `role: "owner" | "client"`（未写 `role` 的旧配置仅在 `tools`、`allowedArgumentValues`、`allowedToolArguments`、`requestsPerMinute`、`maxSessions` 全部未设置时才视作 owner）。分享出去的 token 应设 `role: "client"`、工具白名单、按工具粒度的 `allowedToolArguments`（支持精确工具名或 `"prefix_*"` 通配符，例如限制 `grok_*` 的 `depth` 而不误伤 `linkup_linkup_search`；旧版全局 `allowedArgumentValues` 仍兼容）、`requestsPerMinute` 限流，以及 `maxSessions` 或按 token 独立的 `profile`。工具白名单与参数约束在直接调用、`provider_call` 和 `search_rotation_probe` 中均生效，`provider_tools` 会隐藏未授权工具。

本地多客户端共享常驻时，可开启 `SEARCH_TOOLKIT_HTTP_STATELESS=1`（无状态、重启不报 404、`GET /mcp` 立即回 405）并用 `SEARCH_TOOLKIT_HTTP_TOKENS_FILE` 从文件读取 token 策略。仅当监听回环地址（`127.0.0.1`、`::1`、`localhost`）且 `SEARCH_TOOLKIT_HTTP_ALLOWED_HOSTS` 未设置或仅包含回环主机时，才会挂载仅限 owner token 调用的 `POST /admin/reload` 与 `POST /admin/shutdown`。公网部署要放在 HTTPS 后面，Provider Key 始终留在服务器上。

HTTP 入口使用 MCP SDK 1.32.2，JSON 请求上限为 100 KiB，工具参数中的数组元素与对象键总数上限为 10,000，计数发生在参数 Schema 验证之前。这两项 HTTP 限制不影响 STDIO。

## Key 轮询

每次请求从该 Provider 的 Key 池里按 `strategy` 取一把 Key：

| `strategy` | 取哪一把 | 适合 |
| --- | --- | --- |
| `round_robin`（默认） | 上次用过的下一把健康 Key | 每月免费额度、按 Key 限速的服务（Serper、Tavily、Exa） |
| `sticky` | 一直用同一把，出错才换到下一把健康的 | 上游 MCP，一把 Key 对应一个会话或子进程（AnySearch） |
| `drain` | 按配置顺序第一把健康的 Key | 先花完一份余额或每月赠送额度再用下一份（Parallel、Firecrawl） |

游标跨重启持久化，并通过 SQLite 在多个并发进程间共享。健康状态按 Key 指纹记录，调换或删减 Key 不会把历史记到别的 Key 上。

| 结果 | 对 Key 的处理 | 重试 |
| --- | --- | --- |
| 成功 | 清零失败计数，耗尽的 Key 恢复健康 | |
| 额度或余额用完（`402`、Tavily 的 `432`/`433`，或无状态码及 `400`/`401`/`403`/`429` 下出现 "Insufficient balance"、`spend_cap_exceeded` 等报错） | 记为耗尽，停用 30 分钟、6 小时、24 小时，之后排在所有健康 Key 后面 | 最多换 3 把；整池用完时自动路由去下一家 |
| 套餐不支持（"not allowed for free accounts"、"Payment method required"） | 不停用 | 换没标成 `free` 的 Key，最多 3 把，没有就去下一家 |
| `401` / `403` | 停用 1 小时，再犯依次 6 小时、24 小时 | 最多换 3 把 |
| `429` / Tavily `434` | 停用 1、5、15 分钟，或按 `Retry-After` / `X-RateLimit-Reset` | 最多换 3 把 |
| `5xx` 或连接断开 | 不停用 | 再换 1 把 |
| 超时 | 不停用 | 不换 Key，自动路由直接去下一家 |
| `400` / `404` / `422`、上游工具自己的错误、被读取网页自己的状态码（`TargetPageError`） | 不停用 | 不重试 |

### 套餐和单把 Key 的规则

同一个池里可混用字符串 Key 和带备注对象（`tier`、`label`、`allowTools`、`denyTools`）。`tier` 缺省继承 `defaultTier`，列在 `paidTools` 里的工具只用 `paid` Key。`search_pool_status` 在 `verbose: true` 下（以及精简模式中的异常槽位）显示每个槽位的套餐和备注；`search-toolkit config` 只输出每个 Provider 按套餐汇总的数量，不展示单槽备注或 Key。详细配置见 [docs/operator-guide.md](docs/operator-guide.md)。

### 余额

`search-toolkit quota [provider]` 会按 Provider 并发读取各家账单接口的剩余额度（免费读取：Serper、Tavily、Firecrawl、LinkUp、You.com、TinyFish、DeepSeek、Vercel AI Gateway；Brave 也会在真实请求响应头中被动追踪月度余量）。读数记录单位（`credits`、`USD`、`cents`）、折算后的易读余额和低余额预警，并自动跳过已禁用的 Provider 防止未解析的密钥引用外发。owner 调用方也可在 `search_pool_status` 中传 `refreshQuota: true` 触发实时刷新。各接口细节及特例（TinyFish、Vercel AI Gateway、Tavily 冷却保护）见 [docs/operator-guide.md](docs/operator-guide.md)。

`providers.json`、真实 Key 和状态库都被 Git 忽略，输出里只显示 Key 掩码。

## Skill

`skills/search-toolkit/` 是一个 Agent Skill，复制或链接到 agent 的 skill 目录即可。`SKILL.md` 放每次搜索都需要的路由与安全护栏，`references/provider-routing.md` 放模式路由表、结果元数据和各专长 Provider 参数。

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
