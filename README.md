# Search Toolkit

Official-first web tools for AI agents, with persistent multi-key rotation, MCP over STDIO or Streamable HTTP, a CLI, and an Agent Skill.

[简体中文](README.zh-CN.md)

## Design

Search Toolkit preserves provider-specific capabilities instead of flattening every backend into one generic search endpoint.

- Official Remote MCP proxy: Exa, Tavily, LinkUp, and AnySearch.
- Official STDIO MCP proxy: Firecrawl.
- Thin official-API adapters: Querit, Serper, Brave Web/News/Images/LLM Context, You.com Web Search, Parallel Search, Jina Search, TinyFish Search, Doubao Search, and xAI Responses Web/X Search.
- Persistent per-provider key pools in SQLite, tracked by key fingerprint so reordering a pool never moves history.
- Upstream tool names and schemas are discovered from the official MCP servers, cached on disk, and filtered by an optional per-provider tool policy.
- Raw keys stay outside the repository in a local JSON file.

Official references used by the implementation include the [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk), [Exa MCP](https://exa.ai/docs/reference/exa-mcp), [Tavily MCP](https://docs.tavily.com/documentation/mcp), [LinkUp MCP](https://docs.linkup.so/pages/integrations/mcp/mcp), [AnySearch MCP](https://github.com/anysearch-ai/anysearch-mcp-server), [Firecrawl MCP](https://docs.firecrawl.dev/use-cases/developers-mcp), [You.com Search API](https://you.com/docs/api-reference/search/v1-search), and [Parallel Search API](https://docs.parallel.ai/api-reference/search/search).

## Provider capabilities

| Intent | Provider or tool family |
| --- | --- |
| General quality-oriented lookup | `search_auto` with Parallel, You.com, Brave, Exa, Querit, and Tavily |
| Exact strings, semantic discovery, code and page content | Exa official MCP |
| Current news and fast-changing facts | Brave News, You.com, Tavily, and Serper News |
| Independent confirmation | `search_auto` with `crossCheck: true` |
| Read a known URL | `fetch_auto`: Exa → Tavily → Firecrawl → LinkUp → AnySearch |
| Worldwide text-to-image discovery with original image and source metadata | `search_images`: Brave Images → Serper Images |
| Concise Google results, news and images | Serper |
| Independent web/news index and LLM-ready grounding chunks | Brave Web, News, and LLM Context |
| Unified Web + News results with optional query-aware highlights | You.com Search |
| Semantic objectives with ranked, LLM-optimized excerpts | Parallel Search |
| Sourced answers and research jobs | LinkUp official MCP |
| Manual general/vertical search, parallel batches, and URL extraction | AnySearch official MCP |
| Search, scrape, crawl, map and structured extraction | Firecrawl official MCP |
| Compact search | Jina Search, TinyFish Search |
| Chinese-local search with explicit quota use | Doubao, manual-only |
| Native Web + X search with model synthesis | Grok / xAI Responses |

## Install

```powershell
git clone https://github.com/TheWiseWolfHolo/search-toolkit
cd search-toolkit
npm install
npm run build
```

Node.js 22 or newer is required. Node.js 24 is recommended because the persistent rotation store uses the built-in `node:sqlite` module.

## Configure

Copy `config.example.json` to a private path outside the repository and replace the placeholder keys:

```powershell
$env:SEARCH_TOOLKIT_CONFIG = "$HOME/.config/search-toolkit/providers.json"
```

On Windows the default is `%USERPROFILE%/.config/search-toolkit/providers.json`, which avoids MSIX `AppData/Local` virtualization so packaged apps and ordinary CLI processes read the same physical file.

A provider entry lists what it may be chosen for without being named:

```json
"brave": {
  "enabled": true,
  "auto": ["search", "images"],
  "keys": ["..."],
  "integration": { "kind": "rest", "adapter": "brave" }
}
```

`auto` is any of `search`, `images`, `fetch`. An empty list makes a provider manual-only: it is reachable by calling its tools directly and is never picked by `search_auto`, `search_images`, or `fetch_auto`, nor used as a fallback. Doubao ships that way.

Optional top-level settings:

- `profile`: `full` (default) or `lean`, see [Context cost](#context-cost). The `--profile` flag and the `SEARCH_TOOLKIT_PROFILE` variable override it.
- `shaping`: `maxDescriptionChars` (default 700) and `maxParamDescriptionChars` (default 220); `0` keeps upstream text untouched.
- Per provider, `toolPolicy.allow`, `toolPolicy.deny`, and `toolPolicy.descriptions` (a replacement description keyed by upstream tool name).

Version 1 configs (`automatic` / `manualOnly`) still load. Upgrade one with:

```powershell
node dist/src/cli.js migrate-config           # dry run: lists the changes
node dist/src/cli.js migrate-config --write   # backs the file up, then writes v2
```

The migration also drops provider `options` that no adapter reads. Only Grok reads any (`model`, `reasoningEffort`, `systemPrompt`, `customUrl`).

## CLI

```powershell
node dist/src/cli.js search "MCP session management" --quality max --cross
node dist/src/cli.js fetch https://example.com/article --max-chars 8000
node dist/src/cli.js tools                    # names; --json for full schemas
node dist/src/cli.js call querit_search '{"query":"latest AI agent news","limit":5}'
node dist/src/cli.js status                   # masked key health, cool-downs, warnings
node dist/src/cli.js reset brave              # clear key cool-downs (optionally a slot)
node dist/src/cli.js probe querit "Search Toolkit rotation probe"
```

`search`, `fetch`, and `call` print what a model would read: a route line, then the results. Add `--json` for the complete structured result.

## MCP

Build first, then add the local STDIO server to your client, for example Codex:

```toml
[mcp_servers.searchToolkit]
command = "C:/path/to/node.exe"
args = ["E:/Script/Services/search-toolkit/dist/src/mcp-server.js", "--config", "C:/Users/you/.config/search-toolkit/providers.json"]
startup_timeout_sec = 30
tool_timeout_sec = 120
enabled = true
default_tools_approval_mode = "writes"
```

The server exposes:

- Provider-prefixed official upstream tools selected by each provider's tool policy. Firecrawl defaults to seven focused retrieval/acquisition tools instead of its whole management catalog.
- Every configured REST adapter tool.
- `search_auto`: quality-first routing with `balanced` and `max` profiles. It considers only providers whose `auto` includes `search`, and after a recognized availability failure may try one compatible fallback. `crossCheck: true` runs two independent REST-backed indexes and merges them by canonical URL, listing which providers found each result.
- `fetch_auto`: reads one known URL through Exa, Tavily, Firecrawl, LinkUp, or AnySearch (those whose `auto` includes `fetch`). A reader that returns almost nothing is skipped, up to three are tried, and `maxChars` caps the text with a truncation marker. `quality: max` leads with Firecrawl for JavaScript-heavy pages.
- `search_images`: quality-first worldwide text-to-image discovery through Brave Images, then Serper Images on availability failure. It is not reverse image search and does not receive chat attachments by itself.
- `search_pool_status`: masked key-pool diagnostics, including cool-downs.
- `search_rotation_probe`: a live, quota-consuming rotation proof.

### What the model reads

Results carry one leading route block, `{"searchToolkitRoute": {provider, tool, upstreamTool}}` (plus `searchToolkitAuto` with mode, quality, and the bounded attempt list for the unified tools), then compact text: numbered results with the provider's publication date, an excerpt, and for cross-checks the providers that found each result. Brave LLM Context renders grounding per source; Grok answers list their citations. The full normalized payload, key slot, and latency stay in `structuredContent` and `_meta`. Brave highlight markup is removed.

### Context cost

Every tool schema a client loads costs context. By default descriptions are trimmed at a paragraph or sentence boundary and parameter descriptions are capped, while types, enums, defaults, and required lists are left as the upstream defined them. For clients that load the whole list into every conversation, `--profile lean` exposes only `search_auto`, `search_images`, `fetch_auto`, `search_pool_status`, `search_rotation_probe`, and a gateway: `provider_tools` lists provider tools or returns one's full schema, and `provider_call` runs one. `npm run measure` reports startup time and tool-list size for either profile.

### Startup

Providers are discovered concurrently, and each upstream's tool catalog is cached beside the state database. Later starts are ready immediately and connect to an upstream (including spawning Firecrawl) only when one of its tools is first called. A catalog older than 12 hours is refreshed in the background and, if it changed, announced with `notifications/tools/list_changed`.

## Streamable HTTP

For mobile or remote clients, start the same toolkit over stateful Streamable HTTP. Store only SHA-256 client-token hashes on the server:

```powershell
$env:SEARCH_TOOLKIT_HTTP_TOKENS = '[{"hash":"<owner-sha256-hex>"},{"hash":"<guest-sha256-hex>","tools":["search_auto","search_images"],"requestsPerMinute":30,"maxSessions":8}]'
$env:SEARCH_TOOLKIT_HTTP_ALLOWED_HOSTS = 'search-mcp.example.com'
node dist/src/http-server.js --config C:/Users/you/.config/search-toolkit/providers.json
```

Clients connect to `/mcp` with `Authorization: Bearer <client-token>`. A token without `tools` is an owner token; shared tokens should use an explicit tool allowlist, a `requestsPerMinute` limit, and an optional `maxSessions` cap. Owner tokens remain uncapped unless they set `maxSessions`. STDIO and HTTP use the same provider config, rotation state, and routing; HTTP only adds transport-level access policy. Put public deployments behind HTTPS and keep provider keys server-side.

## Key rotation

Each request selects one healthy key from the provider's pool. The cursor persists across restarts and is coordinated across concurrent agent processes through SQLite. Health is recorded per key fingerprint, so reordering or trimming a pool does not misattribute history.

- Success: clear the key's strikes.
- `401` or `403`: bench the key for 1 hour, then 6, then 24 on repeated faults. Never permanent: when the window ends the key is tried again.
- `402`: bench for 30 minutes, then 6 hours, then 24.
- `429`: bench for 1, 5, then 15 minutes, or for the provider's `Retry-After`.
- `5xx`, network failure, or timeout: retry once on a different key; the key is not benched.
- `400`, `404`, `422`, and an upstream MCP tool's own error (for example a scraped page answering 403) are not blamed on a key and do not retry; the tool's answer is returned. Only error text that is clearly about the key (invalid key, quota, rate limit) counts as a key fault.
- A pool whose keys are all benched fails closed and says when the first recovers. `search-toolkit reset <provider>` clears the benches by hand.

`providers.json`, raw keys, and rotation state are ignored by Git. Command output and MCP metadata show only masked key slots.

## Skill

The reusable skill is under `skills/search-toolkit/`. Copy or link it into your agent's skill directory. It routes normal research directly to Search Toolkit and keeps deep-research orchestration for genuinely multi-stage work.

## Development

```powershell
npm test
npm run smoke:mcp
npm run measure
npm run smoke:http -- https://search-mcp.example.com/mcp C:/private/client-token.txt
npm pack --dry-run
```

## License

MIT
