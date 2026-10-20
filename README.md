# Search Toolkit

Official-first web tools for AI agents, with persistent multi-key rotation, MCP over STDIO or Streamable HTTP, a CLI, and an Agent Skill.

[简体中文](README.zh-CN.md)

## Design

Search Toolkit preserves provider-specific capabilities instead of flattening every backend into one generic search endpoint.

- Official Remote MCP proxy: Exa, Tavily, LinkUp, and AnySearch.
- Official STDIO MCP proxy: Firecrawl.
- Thin official-API adapters: Querit, Serper (Web/News/Images/Scholar), Brave Web/News/Images/LLM Context, You.com Search/Contents, Parallel Search/Extract/Images, Jina Search, TinyFish Search, Doubao Search, and xAI Responses Web/X Search.
- Persistent per-provider key pools in SQLite, tracked by key fingerprint so reordering a pool never moves history.
- Upstream tool names and schemas are discovered from the official MCP servers, cached on disk, and filtered by an optional per-provider tool policy.
- Raw keys stay outside the repository in a local JSON file.

Official references used by the implementation include the [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk), [Exa MCP](https://exa.ai/docs/reference/exa-mcp), [Tavily MCP](https://docs.tavily.com/documentation/mcp), [LinkUp MCP](https://docs.linkup.so/pages/integrations/mcp/mcp), [AnySearch MCP](https://github.com/anysearch-ai/anysearch-mcp-server), [Firecrawl MCP](https://docs.firecrawl.dev/use-cases/developers-mcp), [You.com Search API](https://you.com/docs/api-reference/search/v1-search), and [Parallel Search API](https://docs.parallel.ai/api-reference/search/search).

## Provider capabilities

| Intent | Provider or tool family |
| --- | --- |
| General quality-oriented lookup | `search_auto`: modes general, exact, current, official, scholar, code, and context, each with a measured provider order; Chinese queries use Brave and Serper with Chinese-market settings |
| Exact strings, semantic discovery, code and page content | Exa official MCP |
| Current news and fast-changing facts | Brave News, You.com, Tavily, and Serper News |
| Independent confirmation | `search_auto` with `crossCheck: true` |
| Read one or up to 5 known URLs | `fetch_auto`: Exa → Tavily → Parallel Extract → You.com Contents → Firecrawl → LinkUp → AnySearch |
| Worldwide text-to-image discovery with original image and source metadata | `search_images`: Brave Images → Parallel Images → Serper Images |
| Concise Google results, news, images, and Scholar papers | Serper (`serper_search`, `serper_news`, `serper_images`, `serper_scholar`) |
| Independent web/news index (`extraSnippets`, `goggles`) and LLM-ready grounding chunks | Brave Web, News, and LLM Context |
| Unified Web + News results, live `knowledge` cards, `full_page` markdown, and URL extraction | You.com Search & Contents (`you_search`, `you_contents`) |
| Semantic objectives with ranked excerpts, batch URL extraction, and semantic image search | Parallel Search, Extract, and Images (`parallel_search`, `parallel_extract`, `parallel_image_search`) |
| Sourced answers and research jobs | LinkUp official MCP |
| Manual general/vertical search, parallel batches, and URL extraction | AnySearch official MCP |
| Search, scrape, crawl, map and structured extraction | Firecrawl official MCP |
| Compact search (manual) | Querit, TinyFish Search, Jina Search |
| Chinese-local search with explicit quota use | Doubao, manual-only |
| Native Web + X search with model synthesis and image/video understanding | Grok / xAI Responses |

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

- `profile`: `full` (default), `curated`, or `lean`, see [Context cost](#context-cost). The `--profile` flag and the `SEARCH_TOOLKIT_PROFILE` variable override it.
- `shaping`: `maxDescriptionChars` (default 700) and `maxParamDescriptionChars` (default 220); `0` keeps upstream text untouched.
- `cache`: `enabled` (default `true`), `searchTtlSeconds` (900), `newsTtlSeconds` (300, for `mode: current`), and `fetchTtlSeconds` (1800); see [Cache](#cache).
- Per provider, `toolPolicy.allow`, `toolPolicy.deny`, and `toolPolicy.descriptions` (a replacement description keyed by upstream tool name).

Version 1 configs (`automatic` / `manualOnly`) still load. Upgrade one with:

```powershell
node dist/src/cli.js migrate-config           # dry run: lists the changes
node dist/src/cli.js migrate-config --write   # backs the file up, then writes v2
```

The migration also drops provider `options` that no adapter reads. Only Grok reads any (`model`, `reasoningEffort`, `systemPrompt`, `customUrl`).

## CLI

```powershell
node dist/src/cli.js search "MCP session management" --quality max --domains modelcontextprotocol.io,github.com --cross
node dist/src/cli.js fetch https://example.com/article --section "Rate Limits" --max-chars 8000
node dist/src/cli.js fetch https://example.com/a https://example.com/b --max-chars 6000
node dist/src/cli.js tools --profile curated  # names; --json for full schemas
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
args = ["C:/path/to/search-toolkit/dist/src/mcp-server.js", "--config", "C:/Users/you/.config/search-toolkit/providers.json"]
startup_timeout_sec = 30
tool_timeout_sec = 120
enabled = true
default_tools_approval_mode = "writes"
```

The server exposes:

- Provider-prefixed official upstream tools selected by each provider's tool policy. Firecrawl defaults to seven focused retrieval/acquisition tools instead of its whole management catalog.
- Every configured REST adapter tool (or only specialist tools under `--profile curated`).
- `search_auto`: quality-first routing with `balanced` and `max` profiles, plus `includeDomains`, `excludeDomains`, universal `freshness`, and `maxCharsPerResult`. It prioritizes providers with currently healthy key slots, de-duplicates canonical URLs (including `.md` / `.html` documentation mirrors), and caps per-result excerpts so routine lookups stay compact and inline-friendly. `crossCheck: true` queries two independent search providers (REST or normalized MCP such as Exa and Tavily) concurrently and merges them by canonical URL, listing which providers found each result.
- `fetch_auto`: reads one `url` or up to five `urls` concurrently through Exa, Tavily, Parallel Extract, You.com Contents, Firecrawl, LinkUp, or AnySearch (those whose `auto` includes `fetch`). Readers that return almost nothing, return anti-bot/Cloudflare challenge shells, or are refused by the site (403/429/5xx) are skipped automatically, up to three are tried, a missing page (404/410) ends the chain, and `maxChars`, `offset`, and `section` support pagination and Markdown heading extraction. `quality: max` leads with Firecrawl for JavaScript-heavy pages.
- `search_images`: quality-first worldwide text-to-image discovery through Brave Images, Parallel Image Search, and Serper Images on availability failure. It is not reverse image search and does not receive chat attachments by itself.
- `search_pool_status`: masked key-pool diagnostics, including cool-downs.
- `search_rotation_probe`: a live, quota-consuming rotation proof.

### Routing evidence

Provider orders are measured, not guessed. `npm run eval:search` runs the queries in `evals/search-queries.json` (English and Chinese, across web, news, scholar, and code) on every provider variant and scores gold-source hits, language match, dates, freshness, duplicates, and latency without an LLM judge. It spends real quota. The October 2026 run behind the current orders is summarized in [docs/search-eval-2026-10.md](docs/search-eval-2026-10.md).

### What the model reads

Results carry one leading route block, `{"searchToolkitRoute": {provider, tool}}` (plus `searchToolkitAuto` with mode and quality for the unified tools, and an `attempts` list such as `["parallel_search:429", "you_search:success"]` only when a fallback happened), then compact text: numbered results with the provider's publication date, a bounded excerpt (page furniture such as copy buttons, anchors, and table rules removed; when an excerpt is too long, the sentences that mention the query are kept instead of only its head), and for cross-checks the providers that found each result. Upstream MCP search tools (such as Exa and Tavily) are normalized into the same compact numbered format while preserving structured items in `structuredContent`. Brave LLM Context renders grounding per source; Grok answers list their citations.

### Cache

`search_auto`, `search_images`, and `fetch_auto` keep successful answers for a short time in the shared state database, so a search or page repeated by another turn, agent, or client within the window is answered without a provider call. A reused answer says so in its route block, for example `"cached":"4m"`. A cached page also serves later `offset` and `section` reads of the same document. Failures and thin fetch fallbacks are never cached. Turn it off with `cache.enabled: false`, `SEARCH_TOOLKIT_CACHE=off`, or `--no-cache` on the CLI; `search-toolkit cache-clear` empties it.

### Same-site duplicates and provider health

Within one result list, the same page in another release or mirror (same site, same title once `x.y.z` version numbers are dropped) keeps only its best-ranked copy, and providers are asked for two more results than shown so the list stays full. A provider whose automatic calls failed twice in a row is tried after its healthy peers; one success or a quiet half hour restores its place. `search_pool_status` shows the score as `recentFailure`.

### Context cost

Every tool schema a client loads costs context. By default descriptions are trimmed at a paragraph or sentence boundary and parameter descriptions are capped, while types, enums, defaults, and required lists are left as the upstream defined them:

- `full` (default): exposes all unified tools and every enabled provider tool (~42 tools).
- `curated`: exposes the unified tools, the `provider_tools`/`provider_call` gateway, and high-value specialist tools (`exa_web_search_advanced_exa`, `brave_llm_context`, `parallel_extract`, `you_contents`, `serper_scholar`, `firecrawl_*`, `tavily_tavily_research`, `linkup_linkup_research`, `grok_*`, `doubao_search`, `anysearch_batch_search`) while omitting redundant single-provider basic search tools.
- `lean`: exposes only `search_auto`, `search_images`, `fetch_auto`, `search_pool_status`, `search_rotation_probe`, and the `provider_tools`/`provider_call` gateway (7 tools total).

`npm run measure` reports startup time and tool-list size for any profile.

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
- `401`/`402`/`403`/`429` try up to 3 healthy keys per pool.
- `5xx` or a dropped connection tries one more healthy key; neither benches the key.
- A timeout is not retried on another key: the automatic route moves on to the next provider instead.
- `400`, `404`, `422`, an upstream MCP tool's own error, and the status of a page being read (for example a site answering Parallel Extract with 403) are not blamed on a key and do not retry. Only error text that is clearly about the key (invalid key, quota, rate limit) counts as a key fault.
- `search-toolkit status --verbose` shows each key's last error and when it happened.
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
