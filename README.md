# Search Toolkit

Web search, image search, and page reading for AI agents, routed across many providers by measured quality, with persistent multi-key rotation. Runs as an MCP server (STDIO or Streamable HTTP), a CLI, and an Agent Skill.

[简体中文](README.zh-CN.md)

## What it gives an agent

Three tools cover almost every lookup. Each picks a provider, falls back when one fails, and says which one answered.

| Tool | Does | How it routes |
| --- | --- | --- |
| `search_auto` | Web search | Seven modes, each with a provider order measured on real queries (see below). Chinese queries switch to Chinese-market settings automatically. |
| `search_images` | Images by text, or by image | Text: Brave Images → Serper Images → Parallel Images. Image URL: Google Lens reverse search, to identify a picture or trace where it appears. |
| `fetch_auto` | Read 1 to 5 known URLs | Exa → Tavily → Parallel Extract → You.com Contents → Firecrawl → LinkUp → AnySearch, skipping readers that return challenge pages, almost nothing, or a refusal. |

`search_auto` modes, in balanced quality:

| Mode | For | English order | Chinese order |
| --- | --- | --- | --- |
| `general` | Everyday lookup | Parallel → Serper → Exa Lite → You.com → Octen → Brave → Tavily | Brave → Serper → You.com → Parallel → Tavily |
| `exact` | Quoted strings, error messages | Parallel → Brave → Serper → You.com → Tavily | Brave → Serper → You.com → Parallel |
| `official` | Vendor, product, or government sites | Exa Lite → Brave → Serper → You.com | Exa Lite → Serper → Parallel → Brave |
| `current` | News | You.com → Exa news → Octen → Serper News → Brave News → Tavily news | Exa news → You.com → Octen → Serper News → Brave News → Tavily news |
| `scholar` | Papers, preprints, reviews | Exa Lite → Parallel → You.com → Serper Scholar | same |
| `code` | Repositories, examples, API usage | Exa Lite (GitHub category) → Parallel → Serper → Exa Lite | same |
| `context` | Grounding chunks within a token budget | Brave LLM Context → Parallel → You.com → Tavily | same |

`quality: max` is for broad or multi-hop questions: English general starts with Exa Auto with highlights, Exa Lite becomes Exa Auto elsewhere, and Parallel, You.com, Brave, and Tavily switch to their deeper settings. Every mode accepts `includeDomains`, `excludeDomains`, `freshness`, and `maxCharsPerResult`, translated into each provider's own parameters. `crossCheck: true` asks two independent indexes at once and marks which found each result.

### Where the orders come from

`npm run eval:search` runs the queries in `evals/search-queries.json` (English and Chinese, across web, news, scholar, and code) on every provider variant and scores, without an LLM judge, whether an authoritative source is in the top three, the share of authoritative sources, language match, dates, freshness, duplicates, and latency. It spends real quota. The October 2026 run, the end-to-end check of the shipped routes, and a comparison with the Artificial Analysis Search Index are in [docs/search-eval-2026-10.md](docs/search-eval-2026-10.md).

## Providers

| Intent | Provider or tool family |
| --- | --- |
| Semantic discovery, official sites, papers, code repositories, page content | Exa official MCP |
| Concise Google results, news, images, Scholar papers, and Google Lens | Serper (`serper_search`, `serper_news`, `serper_images`, `serper_scholar`, `serper_lens`) |
| Independent web and news index (`extraSnippets`, `goggles`) and LLM-ready grounding chunks | Brave Web, News, Images, and LLM Context |
| Web + News in one call, live `knowledge` cards, `full_page` Markdown, URL extraction | You.com Search and Contents |
| Natural-language objectives with ranked excerpts, batch URL extraction, semantic image search | Parallel Search, Extract, and Images |
| Fast search with long query-relevant highlights | Octen Search |
| Managed extraction, mapping, crawling, and research | Tavily official MCP |
| Search, scrape, crawl, map, and structured extraction | Firecrawl official MCP |
| Sourced answers and research jobs | LinkUp official MCP |
| Manual general or vertical search, parallel batches, URL extraction | AnySearch official MCP |
| Native Web + X search with model synthesis and image or video understanding | Grok / xAI Responses |
| Compact search, manual only | Querit, TinyFish Search, Jina Search |
| Chinese local search with explicit quota use, manual only | Doubao |

Remote MCP servers (Exa, Tavily, LinkUp, AnySearch) and the STDIO Firecrawl server are proxied with their official tool names and schemas. Everything else is a thin adapter over the provider's official REST API.

## Install

```powershell
git clone https://github.com/TheWiseWolfHolo/search-toolkit
cd search-toolkit
npm install
npm run build
```

Node.js 22 or newer is required; Node.js 24 is recommended. Key health, the result cache, and provider health live in a SQLite file through the built-in `node:sqlite`.

## Configure

Copy `config.example.json` to a private path outside the repository and replace the placeholder keys. The default path is `%USERPROFILE%/.config/search-toolkit/providers.json` on Windows (outside `AppData/Local`, so MSIX-packaged apps and ordinary processes read the same file) and `~/.config/search-toolkit/providers.json` elsewhere. `SEARCH_TOOLKIT_CONFIG` or `--config` points somewhere else.

A provider entry lists what it may be chosen for without being named:

```json
"brave": {
  "enabled": true,
  "auto": ["search", "images"],
  "keys": ["key-1", "key-2"],
  "integration": { "kind": "rest", "adapter": "brave" }
}
```

`auto` holds any of `search`, `images`, `fetch`. An empty list makes a provider manual-only: its tools can still be called directly, but `search_auto`, `search_images`, and `fetch_auto` never pick it, not even as a fallback. Doubao ships that way.

Optional top-level settings:

- `profile`: `full` (default), `curated`, or `lean`; see [Context cost](#context-cost). `--profile` and `SEARCH_TOOLKIT_PROFILE` override it.
- `cache`: `enabled` (default `true`), `searchTtlSeconds` (900), `newsTtlSeconds` (300, for `mode: current`), `fetchTtlSeconds` (1800); see [Cache](#cache).
- `shaping`: `maxDescriptionChars` (default 700) and `maxParamDescriptionChars` (default 220); `0` keeps upstream text untouched.
- Per provider, `toolPolicy.allow`, `toolPolicy.deny`, and `toolPolicy.descriptions` (replacement descriptions keyed by upstream tool name). Firecrawl defaults to seven retrieval tools; `toolPolicy.allow: ["*"]` exposes its whole catalog.

Version 1 configs (`automatic` / `manualOnly`) still load. To upgrade one:

```powershell
node dist/src/cli.js migrate-config           # dry run: lists the changes
node dist/src/cli.js migrate-config --write   # backs the file up, then writes v2
```

## CLI

```powershell
node dist/src/cli.js search "MCP session management" --quality max --domains modelcontextprotocol.io,github.com --cross
node dist/src/cli.js search "台风 预警" --mode current
node dist/src/cli.js images "Shorncliffe pier at sunset"
node dist/src/cli.js images https://example.com/photo.jpg   # search by image
node dist/src/cli.js fetch https://example.com/article --section "Rate Limits" --max-chars 8000
node dist/src/cli.js fetch https://example.com/a https://example.com/b --max-chars 6000
node dist/src/cli.js call serper_scholar '{"query":"retrieval augmented generation survey","limit":5}'
node dist/src/cli.js tools --profile curated  # names; --json for full schemas
node dist/src/cli.js status --verbose         # masked key health, cool-downs, last errors
node dist/src/cli.js reset brave              # clear key cool-downs (optionally one slot)
node dist/src/cli.js cache-clear
```

`search`, `images`, `fetch`, and `call` print what a model would read. `--json` prints the complete structured result, `--no-cache` skips the cache.

## MCP

Build first, then register the STDIO server with your client. Claude Code:

```powershell
claude mcp add searchToolkit --scope user -- node C:/path/to/search-toolkit/dist/src/mcp-server.js --config C:/Users/you/.config/search-toolkit/providers.json
```

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.searchToolkit]
command = "C:/path/to/node.exe"
args = ["C:/path/to/search-toolkit/dist/src/mcp-server.js", "--config", "C:/Users/you/.config/search-toolkit/providers.json", "--profile", "lean"]
startup_timeout_sec = 30
tool_timeout_sec = 120
default_tools_approval_mode = "writes"
```

Besides the three unified tools, the server exposes `search_pool_status` (masked key diagnostics), `search_rotation_probe` (a live, quota-consuming rotation proof), and, depending on the profile, the provider tools directly or through the `provider_tools` / `provider_call` gateway. Tools that create, update, start jobs, or send feedback are not marked read-only, and delete tools are marked destructive.

### What the model reads

Each result starts with one compact route block, then readable text:

```text
{"searchToolkitRoute":{"provider":"parallel","tool":"parallel_search"},"searchToolkitAuto":{"mode":"general","quality":"balanced"}}

1. Page title (2026-10-15)
   https://example.com/page
   Excerpt with the sentences that mention the query…
```

`attempts` (such as `["parallel_search:429", "you_search:success"]`) appears only when a fallback happened, and `"cached":"4m"` only when the answer was reused. Excerpts are bounded, lose page furniture (copy buttons, anchors, table rules, image and link syntax), and keep the sentences that mention the query when they are too long. Image results list the image, thumbnail, source page, and publisher.

Over MCP only `content` and `_meta` are sent. Claude Code and other clients show `structuredContent` to the model instead of `content` when both are present, which would replace the readable text with raw JSON, and upstream `outputSchema` declarations are dropped for the same reason. The full structured result is available from the CLI with `--json`.

### Cache

`search_auto`, `search_images`, and `fetch_auto` keep successful answers for a short time in the shared state database, so a search or page repeated by another turn, agent, or client within the window costs no provider call. A cached page also serves later `offset` and `section` reads of the same document. Failures and thin fetch fallbacks are never cached. Turn it off with `cache.enabled: false`, `SEARCH_TOOLKIT_CACHE=off`, or `--no-cache`.

### Result hygiene and provider health

Within one result list, duplicate URLs (including `.md` / `.html` documentation mirrors) and the same page in another release (same site, same title once `x.y.z` versions are dropped) keep only their best-ranked copy, and providers are asked for two extra results so the list stays full. A provider whose automatic calls failed twice in a row is tried after its healthy peers until one success or a quiet half hour; `search_pool_status` shows the score as `recentFailure`.

### Context cost

Every tool schema a client loads costs context. Descriptions are trimmed at a sentence boundary and parameter descriptions are capped; types, enums, defaults, and required lists stay as the upstream defined them. With every provider in the example config enabled:

| Profile | Exposes | Tools | Schema tokens |
| --- | --- | --- | --- |
| `full` (default) | Unified tools and every provider tool | 49 | about 20,000 |
| `curated` | Unified tools, the gateway, and specialist tools (`exa_web_search_advanced_exa`, `brave_llm_context`, `parallel_extract`, `you_contents`, `serper_scholar`, `firecrawl_*`, `tavily_tavily_research`, `linkup_linkup_research`, `grok_*`, `doubao_search`, `anysearch_batch_search`) | 22 | about 9,400 |
| `lean` | Unified tools, status, probe, and the gateway | 7 | about 2,100 |

`npm run measure -- --profile lean` reports startup time and tool-list size.

### Startup

Providers are discovered concurrently and each upstream's tool catalog is cached beside the state database, so later starts are ready in under half a second and connect to an upstream (including spawning Firecrawl) only when one of its tools is first called. A catalog older than 12 hours is refreshed in the background and announced with `notifications/tools/list_changed` when it changed.

## Streamable HTTP

For mobile or remote clients, serve the same toolkit over stateful Streamable HTTP. The server stores only SHA-256 hashes of client tokens:

```powershell
$env:SEARCH_TOOLKIT_HTTP_TOKENS = '[{"hash":"<owner-sha256-hex>"},{"hash":"<guest-sha256-hex>","tools":["search_auto","search_images"],"requestsPerMinute":30,"maxSessions":8}]'
$env:SEARCH_TOOLKIT_HTTP_ALLOWED_HOSTS = 'search-mcp.example.com'
node dist/src/http-server.js --config C:/Users/you/.config/search-toolkit/providers.json
```

Clients connect to `/mcp` with `Authorization: Bearer <client-token>`. A token without `tools` is an owner token. Shared tokens should carry a tool allowlist, a `requestsPerMinute` limit, and optionally `maxSessions`. Put public deployments behind HTTPS; provider keys stay on the server.

## Key rotation

Each request takes one healthy key from the provider's pool. The cursor persists across restarts and is shared by concurrent processes through SQLite. Health is recorded per key fingerprint, so reordering or trimming a pool does not misattribute history.

| Outcome | Effect on the key | Retry |
| --- | --- | --- |
| Success | Strikes cleared | |
| `401` / `403` | Benched 1 h, then 6 h, then 24 h | Up to 3 keys |
| `402` | Benched 30 min, then 6 h, then 24 h | Up to 3 keys |
| `429` | Benched 1, 5, then 15 min, or for `Retry-After` | Up to 3 keys |
| `5xx` or dropped connection | Not benched | One more key |
| Timeout | Not benched | None; the route moves to the next provider |
| `400` / `404` / `422`, an upstream tool's own error, or the status of a page being read | Not benched | None |

Benches are never permanent. Only error text clearly about the key (invalid key, quota, balance, rate limit) counts as a key fault; a site answering a reader with 403 does not. A pool whose keys are all benched fails at once and says when the first recovers; `reset <provider>` clears benches by hand. `providers.json`, raw keys, and state are ignored by Git, and output shows only masked key slots.

## Skill

`skills/search-toolkit/` is an Agent Skill: copy or link it into your agent's skill directory. `SKILL.md` holds the routing rules an agent needs on every search; `references/provider-routing.md` holds provider roles, mode details, and how to read results.

## Development

```powershell
npm test
npm run smoke:mcp
npm run measure
npm run eval:search -- --variants auto          # spends quota
npm run smoke:http -- https://search-mcp.example.com/mcp C:/private/client-token.txt
npm pack --dry-run
```

## License

MIT
