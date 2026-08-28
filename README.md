# Search Toolkit

Official-first web tools for AI agents, with persistent multi-key rotation and three entry points: MCP, CLI, and Agent Skills.

[简体中文](README.zh-CN.md)

## Design

Search Toolkit preserves provider-specific capabilities instead of flattening every backend into one generic search endpoint.

- Official Remote MCP proxy: Exa, Tavily, and LinkUp.
- Official STDIO MCP proxy: Firecrawl.
- Thin official-API adapters: Querit, Serper, Brave, Jina Search, TinyFish Search, Doubao Search, and xAI Responses Web/X Search.
- Persistent per-provider key pools backed by SQLite.
- Provider-prefixed upstream tool names and schemas are discovered from official MCP servers at startup.
- Raw keys stay outside the repository in a local JSON file.

Official references used by the implementation include the [Codex MCP configuration guide](https://learn.chatgpt.com/docs/extend/mcp), [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk), [Exa MCP](https://exa.ai/docs/reference/exa-mcp), [Tavily MCP](https://docs.tavily.com/documentation/mcp), [LinkUp MCP](https://docs.linkup.so/pages/integrations/mcp/mcp), and [Firecrawl MCP](https://docs.firecrawl.dev/use-cases/developers-mcp).

## Provider capabilities

| Intent | Provider or tool family |
| --- | --- |
| General fast web lookup | Querit |
| Exact strings, semantic discovery, code and page content | Exa official MCP |
| Current search, extraction and agent research | Tavily official MCP |
| Concise Google results, news and images | Serper |
| Independent web/news index | Brave Search |
| Sourced answers and research jobs | LinkUp official MCP |
| Search, scrape, crawl, map and structured extraction | Firecrawl official MCP |
| Compact search | Jina Search |
| Search plus separate web-agent automation | TinyFish |
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
$env:SEARCH_TOOLKIT_CONFIG = "$env:LOCALAPPDATA/search-toolkit/providers.json"
```

The local one-time importer can migrate configured Kelivo search keys into the standalone text config:

```powershell
npm run import:kelivo
```

The importer reads Kelivo once and writes `%LOCALAPPDATA%/search-toolkit/providers.json`. Runtime MCP and CLI processes never access Kelivo.

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
args = ["E:/Script/Services/search-toolkit/dist/src/mcp-server.js"]
startup_timeout_sec = 30
tool_timeout_sec = 120
enabled = true
```

The MCP server exposes:

- Every discovered official upstream MCP tool, prefixed by provider.
- Every configured REST adapter tool.
- `search_auto` for capability-aware default routing.
- `search_pool_status` for masked key-pool diagnostics.
- `search_rotation_probe` for a live, quota-consuming rotation proof.

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
npm pack --dry-run
```

## License

MIT
