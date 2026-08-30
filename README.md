# Search Toolkit

Official-first web tools for AI agents, with persistent multi-key rotation, MCP over STDIO or Streamable HTTP, CLI, and Agent Skills.

[简体中文](README.zh-CN.md)

## Design

Search Toolkit preserves provider-specific capabilities instead of flattening every backend into one generic search endpoint.

- Official Remote MCP proxy: Exa, Tavily, LinkUp, and AnySearch.
- Official STDIO MCP proxy: Firecrawl.
- Thin official-API adapters: Querit, Serper, Brave Web/News/Images/LLM Context, You.com Web Search, Parallel Search, Jina Search, TinyFish Search, Doubao Search, and xAI Responses Web/X Search.
- Persistent per-provider key pools backed by SQLite.
- Provider-prefixed upstream tool names and schemas are discovered from official MCP servers at startup, then filtered by an optional provider tool policy.
- Raw keys stay outside the repository in a local JSON file.

Official references used by the implementation include the [Codex MCP configuration guide](https://learn.chatgpt.com/docs/extend/mcp), [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk), [Exa MCP](https://exa.ai/docs/reference/exa-mcp), [Tavily MCP](https://docs.tavily.com/documentation/mcp), [LinkUp MCP](https://docs.linkup.so/pages/integrations/mcp/mcp), [AnySearch MCP](https://github.com/anysearch-ai/anysearch-mcp-server), [Firecrawl MCP](https://docs.firecrawl.dev/use-cases/developers-mcp), [You.com Search API](https://you.com/docs/api-reference/search/v1-search), and [Parallel Search API](https://docs.parallel.ai/api-reference/search/search).

## Provider capabilities

| Intent | Provider or tool family |
| --- | --- |
| General quality-oriented lookup | `search_auto` with Parallel, You.com, Brave, Exa, Querit, and Tavily |
| Exact strings, semantic discovery, code and page content | Exa official MCP |
| Current news and fast-changing facts | Brave News, You.com, Tavily, and Serper News |
| Worldwide text-to-image discovery with original image and source metadata | `search_images`: Brave Images → Serper Images |
| Concise Google results, news and images | Serper |
| Independent web/news index and LLM-ready grounding chunks | Brave Web, News, and LLM Context |
| Unified Web + News results with optional query-aware highlights | You.com Search |
| Semantic objectives with ranked, LLM-optimized excerpts | Parallel Search |
| Sourced answers and research jobs | LinkUp official MCP |
| Manual general/vertical search, parallel batches, and URL extraction | AnySearch official MCP |
| Search, scrape, crawl, map and structured extraction | Firecrawl official MCP |
| Compact search | Jina Search |
| Compact independent search | TinyFish Search |
| Chinese-local search with explicit quota use | Doubao, manual-only by default |
| Native Web + X search with model synthesis | Grok / xAI Responses |

## Install

```powershell
git clone https://github.com/TheWiseWolfHolo/search-toolkit E:/Script/Services/search-toolkit
cd E:/Script/Services/search-toolkit
npm install
npm run build
```

Node.js 22 or newer is required. Node.js 24 is recommended because the persistent rotation store uses the built-in `node:sqlite` module.

## Configure

Copy `config.example.json` to a private path outside the repository and replace placeholder keys:

```powershell
$env:SEARCH_TOOLKIT_CONFIG = "$HOME/.config/search-toolkit/providers.json"
```

The local one-time importer can migrate configured Kelivo search keys into the standalone text config:

```powershell
npm run import:kelivo
```

The importer reads Kelivo once and writes `%USERPROFILE%/.config/search-toolkit/providers.json` on Windows. This avoids MSIX `AppData/Local` virtualization, so Codex, Claude Code, and ordinary CLI processes read the same physical file. Runtime MCP and CLI processes never access Kelivo.

## CLI

```powershell
node dist/src/cli.js tools
node dist/src/cli.js status
node dist/src/cli.js call querit_search '{"query":"latest AI agent news","limit":5}'
node dist/src/cli.js probe querit "Search Toolkit rotation probe"
```

## MCP

Build first, then add the local STDIO server to Codex:

```toml
[mcp_servers.searchToolkit]
command = "C:/path/to/node.exe"
args = ["E:/Script/Services/search-toolkit/dist/src/mcp-server.js", "--config", "C:/Users/you/.config/search-toolkit/providers.json"]
startup_timeout_sec = 30
tool_timeout_sec = 120
enabled = true
default_tools_approval_mode = "writes"
```

For mobile or remote clients, start the same toolkit over stateful Streamable HTTP. Store only SHA-256 client-token hashes on the server:

```powershell
$env:SEARCH_TOOLKIT_HTTP_TOKENS = '[{"hash":"<owner-sha256-hex>"},{"hash":"<guest-sha256-hex>","tools":["search_auto","search_images"],"requestsPerMinute":30,"maxSessions":8}]'
$env:SEARCH_TOOLKIT_HTTP_ALLOWED_HOSTS = 'search-mcp.example.com'
node dist/src/http-server.js --config C:/Users/you/.config/search-toolkit/providers.json
```

Clients connect to `/mcp` with `Authorization: Bearer <client-token>`. A token without `tools` is an owner token; shared tokens should use an explicit tool allowlist, `requestsPerMinute` limit, and optional `maxSessions` cap. Owner tokens remain uncapped unless they explicitly set `maxSessions`. STDIO and HTTP use the same Provider config, rotation state, and routing behavior; HTTP only adds transport-level access policy. Put public deployments behind HTTPS and keep Provider keys server-side.

The MCP server exposes:

- Provider-prefixed official upstream tools selected by the provider's tool policy. Firecrawl defaults to seven focused retrieval/acquisition tools instead of its entire management catalog.
- Every configured REST adapter tool.
- `search_auto` for quality-first capability routing with `balanced` and `max` quality profiles. It considers only providers with `automatic: true`, always excludes `manualOnly` providers, and may try one compatible retrieval fallback after a recognized provider-availability failure.
- `search_images` for quality-first worldwide text-to-image discovery through Brave Images, then Serper Images on availability failure. Country-specific filtering stays on direct Provider tools. It is not reverse image search and does not receive chat attachments by itself.
- `search_pool_status` for masked key-pool diagnostics.
- `search_rotation_probe` for a live, quota-consuming rotation proof.

Every successful provider call carries auditable `{provider, tool, upstreamTool}` provenance. REST calls expose it in structured content, upstream MCP calls prepend a model-visible `searchToolkitRoute` content block, and `search_auto` normalizes both paths to one route block without duplication. Automatic results also include mode, quality, candidate rank, and the bounded attempt list in `structuredContent.searchAuto`.

Set `toolPolicy.allow` to `["*"]` for a provider only when exposing its full upstream catalog is intentional. Write and destructive tools retain corrected annotations so clients can request approval.

## Key rotation

Each request selects one key from the relevant provider pool. The cursor persists across process restarts and is coordinated across concurrent agent processes through SQLite.

- `200`: advance normally.
- `429` or `402`: cool down the current key.
- `401` or `403`: disable the current key.
- `5xx` or network failure: retry once with the next key.
- `400`, `404`, or `422`: preserve the request error without blaming another key.

`providers.json`, raw keys, and rotation state are ignored by Git. Command output and MCP metadata show only masked key slots.

## Skill

The reusable skill is under `skills/search-toolkit/`. Copy or link it into your agent's skill directory. It routes normal research directly to Search Toolkit and keeps deep-research orchestration for genuinely multi-stage work.

## Development

```powershell
npm test
npm run smoke:mcp
npm run smoke:http -- https://search-mcp.example.com/mcp C:/private/client-token.txt
npm pack --dry-run
```

## License

MIT
