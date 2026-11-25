# Search Toolkit

Web search, image search, and page reading for AI agents, routed across many providers by measured quality, with persistent multi-key rotation. Runs as an MCP server (STDIO or Streamable HTTP), a CLI, and an Agent Skill.

[简体中文](README.zh-CN.md) | [Agent Setup](docs/agent-setup.md) | [Operator Guide](docs/operator-guide.md) | [Security Model](docs/security.md) | [Search Eval Notes](docs/search-eval-2026-10.md)

## What it gives an agent

Three tools cover almost every lookup. Each picks a provider, falls back when one fails, and says which one answered.

| Tool | Does | How it routes |
| --- | --- | --- |
| `search_auto` | Web search | Seven modes, each with a provider order grounded in real-query evals (see below), trying up to 3 providers on availability failures or empty results. Simplified and Traditional Chinese queries switch to Chinese-market settings automatically. |
| `search_images` | Images by text, or by image | Text: Brave Images -> Serper Images -> Parallel Images (up to 2 runtime provider attempts; Parallel is reached automatically when Brave or Serper is disabled or benched). Image URL: Google Lens reverse search, to identify a picture or trace where it appears. |
| `fetch_auto` | Read 1 to 5 known URLs | Balanced: Direct Markdown (opt-in zero-cost probe, does not consume the 3-provider budget on skip) -> Exa -> DeepSeek -> Vercel DeepSeek -> Tavily -> Parallel Extract -> TinyFish -> You.com Extract -> Octen -> Firecrawl -> LinkUp -> AnySearch; `quality: max` leads with Firecrawl -> TinyFish -> Tavily -> Parallel. Skips challenge shells, fragments, and site blocks. |

`search_auto` modes, in balanced quality:

| Mode | For | English order | Chinese order |
| --- | --- | --- | --- |
| `general` | Everyday lookup | Parallel -> Serper -> Exa Lite -> You.com -> Octen -> Brave -> Tavily -> DeepSeek -> Vercel DeepSeek -> Vercel Parallel Fast | Brave -> Serper -> DeepSeek -> Vercel DeepSeek -> You.com -> Parallel -> Vercel Parallel Fast -> Tavily |
| `exact` | Quoted strings, error messages | Parallel -> Brave -> Serper -> You.com -> Tavily -> DeepSeek -> Vercel DeepSeek | Brave -> Serper -> DeepSeek -> Vercel DeepSeek -> You.com -> Parallel |
| `official` | Vendor, product, or government sites | Exa Lite -> Brave -> Serper -> You.com -> DeepSeek -> Vercel DeepSeek -> Vercel Parallel Fast | Exa Lite -> Serper -> DeepSeek -> Vercel DeepSeek -> Parallel -> Brave |
| `current` | News | You.com (`preferNews`) -> Exa news -> Octen -> Serper News -> Brave News -> Tavily news -> DeepSeek -> Vercel DeepSeek | Exa news -> You.com (`preferNews`) -> Octen -> Serper News -> Brave News -> Tavily news -> DeepSeek -> Vercel DeepSeek |
| `scholar` | Papers, preprints, reviews | Exa Lite (`category: publication`) -> Parallel -> You.com -> Serper Scholar -> Vercel Parallel Fast | same |
| `code` | Repositories, examples, API usage | Exa Lite (`includeDomains: github.com`) -> Parallel -> Serper -> DeepSeek -> Vercel DeepSeek -> Vercel Parallel Fast | same |
| `context` | Grounding chunks within a token budget | Brave LLM Context -> Parallel -> You.com -> Tavily -> DeepSeek -> Vercel DeepSeek | same |

`quality: max` is for broad or multi-hop questions: English general starts with Exa Auto with highlights, `context` puts Parallel Advanced ahead of Brave LLM Context, Exa Lite becomes Exa Auto elsewhere, DeepSeek enables `needContent: true`, and Parallel, You.com, Brave, and Tavily switch to their deeper settings. Every mode accepts `includeDomains`, `excludeDomains`, `freshness`, and `maxCharsPerResult`, translated into each provider's own parameters (preserving path prefixes like `github.com/org` on Exa, Parallel, and `site:` providers without widening path-scoped exclusions into whole-host exclusions, while automatically skipping providers whose query-length limit would be exceeded: DeepSeek 128 chars, Serper 32 words, Brave 600/400 chars). `crossCheck: true` asks two independent indexes at once, merges them via Reciprocal Rank Fusion (RRF), and marks which providers found each result.

### Where the orders come from

`npm run eval:search` runs the queries in `evals/search-queries.json` (English and Chinese, across web, news, scholar, code, and context) on each provider variant and scores, without an LLM judge, whether an authoritative source is in the top three, the share of authoritative sources, language match, dates, freshness, duplicates, and latency. It spends real quota. The October 2026 run, the end-to-end check of the shipped routes, and a comparison with the Artificial Analysis Search Index are in [docs/search-eval-2026-10.md](docs/search-eval-2026-10.md).

## Providers

| Intent | Provider or tool family |
| --- | --- |
| Semantic discovery, official sites, papers, code repositories, page content | Exa official MCP |
| Concise Google results, news, images, Scholar papers, and Google Lens | Serper (`serper_search`, `serper_news`, `serper_images`, `serper_scholar`, `serper_lens`) |
| Independent web and news index (`extraSnippets`, `goggles`) and LLM-ready grounding chunks | Brave Web, News, Images, and LLM Context |
| Web + News in one call (`preferNews`), live `knowledge` cards, `full_page` Markdown, `/v1/extract` URL extraction | You.com Search and Extract (`you_contents`) |
| Natural-language objectives with ranked excerpts (`max_chars_total`), batch URL extraction (`links`), semantic image search | Parallel Search, Extract, and Images |
| Fast search with long query-relevant highlights (`/search-premier`, 1,200 domains); URL extraction | Octen Search and Extract |
| Chinese and bilingual search with summaries, rerank scores, native operators (max 128 chars), and Markdown fetch | DeepSeek (`deepseek_search`, `deepseek_fetch`) |
| Hosted DeepSeek Search/Fetch ($0.75/1k via gateway credits) and Parallel Fast (promo-priced on $0 default host model) | Vercel AI Gateway (`vercel_deepseek_search`, `vercel_deepseek_fetch`, `vercel_parallel_fast`) |
| Zero-cost host-side `Accept: text/markdown` negotiation (Cloudflare, Vercel Docs, Mintlify) with socket-pinned SSRF guardrails; opt-in, keyless | Direct Markdown (`direct_markdown_fetch`) |
| Managed extraction, mapping, crawling, and research | Tavily official MCP (Bearer auth) |
| Search, scrape, crawl, map, and structured extraction (local `firecrawl-mcp@3.41.0` STDIO or hosted remote MCP `https://mcp.firecrawl.dev/v2/mcp`; note Ultrasearch surcharges on narrow single-entity queries) | Firecrawl official MCP |
| Sourced answers and research jobs | LinkUp official MCP |
| Manual general or vertical search, parallel batches, URL extraction | AnySearch official MCP |
| Native Web + X search with model synthesis and image or video understanding; `depth` up to 16 research agents | Grok / xAI Responses |
| Chromium-rendered page reading (free up to 1,000 URLs/day) plus web/news/research paper search | TinyFish Fetch and Search |
| Filtered search (`code`/`finance` verticals), URL extraction (`querit_contents`), low-latency snippet search (`X-Respond-With: no-content`) | Querit, Jina Search |
| Chinese local search with summaries and domain/time filters, manual only | Doubao |

Remote MCP servers (Exa, Tavily, LinkUp, AnySearch, and optionally Firecrawl `https://mcp.firecrawl.dev/v2/mcp`) and the STDIO Firecrawl server are proxied with their official tool names and schemas. Keyless `remote_mcp` (`auth.kind: "none"`) and `direct_markdown` require no keys. Everything else is a thin adapter over the provider's official REST or Gateway API.

## Install

```powershell
git clone https://github.com/TheWiseWolfHolo/search-toolkit
cd search-toolkit
npm install
npm run build
```

Node.js 22 or newer is required; Node.js 24 is recommended. Key health, the result cache, tool catalog cache, and provider health live in a SQLite file through the built-in `node:sqlite`.

## Configure

Copy `config.example.json` to a private path outside the repository and replace the placeholder keys. The default path is `%USERPROFILE%/.config/search-toolkit/providers.json` on Windows (outside `AppData/Local`, so MSIX-packaged apps and ordinary processes read the same file) and `~/.config/search-toolkit/providers.json` elsewhere. `SEARCH_TOOLKIT_CONFIG` or `--config` points somewhere else. `statePath` supports `~/` expansion and paths relative to the config directory.

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
- Per provider, `strategy`, `defaultTier`, `paidTools`, and annotated keys; keys may be plain strings or `"env:VAR_NAME"` / `"file:/path/to/secret"` (with `~/` expansion), preserved by `migrate-config`; see [Key rotation](#key-rotation) and [docs/operator-guide.md](docs/operator-guide.md).
- Per provider, `options` for adapters that read them: `grok` (`model`, `multiAgentModel`, `reasoningEffort`, `systemPrompt`, `customUrl`), `deepseek` (`localization`), `vercel_gateway` (`model`, `reasoning`, `enableParallelFast`, `localization`, `fallbackModels`, `authMethod`), `direct_markdown` (`timeoutMs`).
- Per provider, `toolPolicy.allow`, `toolPolicy.deny`, and `toolPolicy.descriptions` (replacement descriptions keyed by upstream tool name). Firecrawl defaults to nine retrieval tools; AnySearch hides `score` (feedback tool). `toolPolicy.allow: ["*"]` exposes the full catalog.

Version 1 configs (`automatic` / `manualOnly`) still load. To upgrade one:

```powershell
node dist/src/cli.js migrate-config           # dry run: lists the changes
node dist/src/cli.js migrate-config --write   # backs the file up, then writes v2 atomically
```

## CLI

```powershell
node dist/src/cli.js search "MCP session management" --quality max --domains modelcontextprotocol.io,github.com --cross
node dist/src/cli.js search "台风 预警" --mode current
node dist/src/cli.js images "Shorncliffe pier at sunset"
node dist/src/cli.js images --image-url https://example.com/photo.jpg   # reverse image search
node dist/src/cli.js fetch https://example.com/article --section "Rate Limits" --max-chars 8000
node dist/src/cli.js fetch https://example.com/a https://example.com/b --max-chars 6000
node dist/src/cli.js call serper_scholar '{"query":"retrieval augmented generation survey","limit":5}'
node dist/src/cli.js call serper_scholar @args.json                    # or --input - from stdin
node dist/src/cli.js tools --profile curated --provider exa            # --describe <tool> or --json for schema
node dist/src/cli.js status --verbose                                  # masked key health, cool-downs, last errors
node dist/src/cli.js config                                            # sanitized config summary (aggregate tier counts)
node dist/src/cli.js reset brave                                       # clear key cool-downs and exhaustion
node dist/src/cli.js quota                                             # concurrent balance check from billing APIs
node dist/src/cli.js probe brave "test query"                          # live per-slot rotation verification
node dist/src/cli.js cache-clear
```

`search`, `images`, `fetch`, and `call` print what a model would read. `--json` prints structured JSON across commands, `--no-cache` skips the cache, and failures exit non-zero with errors on `stderr`.

## MCP

Build first, then register the STDIO server (or a shared local Streamable HTTP daemon) with your client; full client recipes for Antigravity CLI, Claude Code, Codex, Cursor, and Gemini CLI are in [docs/agent-setup.md](docs/agent-setup.md).

Claude Code:

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

Besides the three unified tools, the server exposes `search_pool_status` (masked key diagnostics, plus owner-only `refreshQuota: true` for live balance reads), `search_rotation_probe` (a live, quota-consuming rotation proof), and, depending on the profile, the provider tools directly or through the `provider_tools` / `provider_call` gateway. See [docs/security.md](docs/security.md) for annotation precedence (`delete`/`remove` destructive, `create`/`update`/`run` writes, `search`/`fetch`/`scrape`/`extract`/`map`/`status`/`check` read-only, `crawl`/`agent`/`research` jobs).

### What the model reads

Each result starts with one compact route block, then readable text:

```text
{"searchToolkitRoute":{"provider":"parallel","tool":"parallel_search"},"searchToolkitAuto":{"mode":"general","quality":"balanced"}}

1. Page title (2026-10-15)
   https://example.com/page
   Excerpt with the sentences that mention the query…
```

`attempts` (such as `["parallel_search:429", "you_search:success"]`) appears only when a fallback happened (ignoring zero-cost `direct_markdown_fetch` skips), and `"cached":"4m"` only when the answer was reused. Excerpts are bounded, lose page furniture, and keep sentences matching the query. Image results list the image, thumbnail, source page, and publisher.

An empty search list advances to the next provider within the attempt limit (`3` for `search_auto`, `2` for `search_images`). `crossCheck.status` is `complete` when both providers found results, `partial` when one did, or `unavailable` when a cross-check could not be completed. `foundBy` lists which providers found the same URL.

`fetch_auto` marks pages with substantial body text as `readable` and fragments as `partial`. A batch counts only readable pages in `succeeded` and lists retrieval errors in `failed`. For clipped readable text, use `nextOffset` to continue reading the same URL.

Over MCP only `content` and `_meta` are sent. Clients such as Claude Code show `structuredContent` instead of `content` when both are present, which would replace readable text with raw JSON; upstream `outputSchema` declarations are dropped for the same reason. Use CLI `--json` for the full structured payload.

### Cache

`search_auto`, `search_images`, `fetch_auto`, and direct `grok_*` calls (both direct and via `provider_call`, excluding unsourced model-memory fallbacks) keep successful answers for a short time in the shared SQLite state database (`state.db`, with row and byte eviction bounds). A cached page also serves later `offset` and `section` reads of the same document. Empty searches, partial cross-checks, and fragment-only reads skip the cache. Turn it off with `cache.enabled: false`, `SEARCH_TOOLKIT_CACHE=off`, or `--no-cache`.

### Result hygiene and provider health

Within one result list, duplicate URLs (including `.md` / `.html` documentation mirrors) and near-duplicate release mirrors keep their best-ranked copy while merging richer text and dates, and providers are asked for two extra results so the list stays full (Serper caps `num` at 10 when `limit <= 10` to stay in its 1-credit tier). A provider whose automatic calls failed twice in a row is tried after healthy peers until one success or a quiet half hour; health is isolated per capability (`search`, `images`, `fetch`), and `search_pool_status` reports each provider's worst active score as `recentFailure`.

### Context cost

Every tool schema a client loads costs context. Descriptions are trimmed at a sentence boundary and parameter descriptions are capped; types, enums, defaults, and required lists stay intact. Profiles:

| Profile | Exposes |
| --- | --- |
| `full` (default) | Unified tools, `search_pool_status`, `search_rotation_probe`, and every enabled provider tool (`provider_tools` and `provider_call` are hidden) |
| `curated` | Unified tools, `search_pool_status`, `search_rotation_probe`, the gateway (`provider_tools`/`provider_call`), and 14 specialist tools (`anysearch_batch_search`, `brave_llm_context`, `deepseek_search`, `doubao_search`, `exa_web_search_advanced_exa`, `firecrawl_firecrawl_crawl`, `firecrawl_firecrawl_map`, `grok_web_x_search`, `grok_x_search`, `parallel_search`, `serper_scholar`, `vercel_deepseek_search`, `vercel_parallel_fast`, `you_search`) |
| `lean` | Unified tools, `search_pool_status`, `search_rotation_probe`, and the gateway (`7` tools, about 2,350 schema tokens) |

`npm run measure -- --profile lean` reports exact startup time, tool counts, and schema token estimates for your enabled config.

### Startup

Providers are discovered concurrently and each upstream's tool catalog is cached in `state.db` (`tool_catalog` table, migrated automatically from legacy `tool-catalog.json`), so later starts are ready in under half a second and connect to an upstream only on first tool call. Idle local `stdio_mcp` child processes close after 10 minutes (`integration.idleTimeoutMs`, `0` disables) and respawn transparently. Catalogs older than 12 hours refresh in the background and announce changes with `notifications/tools/list_changed`.

## Streamable HTTP

Serve the same toolkit over stateful or stateless Streamable HTTP (`SEARCH_TOOLKIT_HTTP_STATELESS=1`). The server stores only SHA-256 hashes of client tokens:

```powershell
$env:SEARCH_TOOLKIT_HTTP_TOKENS = '[{"hash":"<owner-sha256-hex>","role":"owner"},{"hash":"<guest-sha256-hex>","role":"client","tools":["search_auto","search_images"],"allowedToolArguments":{"grok_*":{"depth":["fast","deep"]}},"requestsPerMinute":30,"maxSessions":8}]'
$env:SEARCH_TOOLKIT_HTTP_ALLOWED_HOSTS = 'search-mcp.example.com'
node dist/src/http-server.js --config C:/Users/you/.config/search-toolkit/providers.json
```

Clients connect to `/mcp` with `Authorization: Bearer <client-token>`. Token policies support explicit `role: "owner" | "client"` (legacy tokens omitting `role` count as owner only when `tools`, `allowedArgumentValues`, `allowedToolArguments`, `requestsPerMinute`, and `maxSessions` are all unset). Shared client tokens should set `role: "client"`, a `tools` allowlist, per-tool argument rules via `allowedToolArguments` (exact tool name or `"prefix_*"` glob; legacy global `allowedArgumentValues` also remains supported), `requestsPerMinute`, and `maxSessions` or per-token `profile`. Tool allowlists and argument restrictions are enforced on direct calls, inside `provider_call`, and on `search_rotation_probe`; `provider_tools` hides disallowed tools.

For local multi-client daemons, set `SEARCH_TOOLKIT_HTTP_STATELESS=1` (`GET /mcp` returns `405` immediately, no session expiry across restarts) and `SEARCH_TOOLKIT_HTTP_TOKENS_FILE`. Loopback listeners (`127.0.0.1`, `::1`, `localhost`) also expose owner-only `POST /admin/reload` and `POST /admin/shutdown` whenever `SEARCH_TOOLKIT_HTTP_ALLOWED_HOSTS` is unset or contains only loopback hosts. Put public deployments behind HTTPS; provider keys stay on the server.

The HTTP endpoint uses MCP SDK 1.32.2, limits JSON requests to 100 KiB and tool arguments to 10,000 total array elements and object keys before schema validation. These HTTP limits do not apply to STDIO.

## Key rotation

Each request takes one key from the provider's pool according to `strategy`:

| `strategy` | Picks | Suits |
| --- | --- | --- |
| `round_robin` (default) | The next healthy key after the last one used | Free monthly quotas and per-key rate limits (Serper, Tavily, Exa) |
| `sticky` | The same key until it fails, then the next healthy one | Upstream MCP servers with per-key sessions (AnySearch) |
| `drain` | The first healthy key in configured order | Spending one balance or monthly allowance before another (Parallel, Firecrawl) |

The cursor persists across restarts and is shared across processes through SQLite. Health is recorded per key fingerprint, so reordering a pool never misattributes history.

| Outcome | Effect on the key | Retry |
| --- | --- | --- |
| Success | Strikes cleared; an exhausted key is healthy again | |
| Out of credit or quota (`402`, Tavily `432`/`433`, or out-of-credit wording such as "Insufficient balance" or `spend_cap_exceeded` when statusless or `400`/`401`/`403`/`429`) | Exhausted: benched 30 min, 6 h, then 24 h, and afterwards kept behind healthy keys | Up to 3 keys; automatic routes move on when spent |
| Plan limit ("not allowed for free accounts", "Payment method required") | Not benched | Up to 3 keys not marked `free`, otherwise next provider |
| `401` / `403` | Benched 1 h, then 6 h, then 24 h | Up to 3 keys |
| `429` / Tavily `434` | Benched 1, 5, then 15 min, or `Retry-After` / `X-RateLimit-Reset` | Up to 3 keys |
| `5xx` or dropped connection | Not benched | One more key |
| Timeout | Not benched | None; route moves to next provider |
| `400` / `404` / `422`, upstream tool error, or target page status (`TargetPageError`) | Not benched | None |

### Plans and per-key rules

Keys can be strings or annotated objects in the same pool (`tier`, `label`, `allowTools`, `denyTools`). `tier` falls back to `defaultTier`; tools in `paidTools` run only on paid keys. `search_pool_status` (`verbose: true`, plus unhealthy slots in compact mode) shows each slot's tier and label; `search-toolkit config` shows aggregate `tiers` counts per provider and never exposes keys. See [docs/operator-guide.md](docs/operator-guide.md) for examples and rotation details.

### Balances

`search-toolkit quota [provider]` reads remaining credit concurrently across providers from each provider's billing API (free reads: Serper, Tavily, Firecrawl, LinkUp, You.com, TinyFish, DeepSeek, Vercel AI Gateway; Brave balances are also tracked passively from response rate-limit headers). Readings record units (`credits`, `USD`, `cents`), display human-friendly currency conversions, flag low balances, and skip disabled providers so unresolved secret references are never transmitted. Owner callers can also pass `refreshQuota: true` to `search_pool_status`. See [docs/operator-guide.md](docs/operator-guide.md) for endpoint details and special cases (TinyFish, Vercel AI Gateway, Tavily cooldown).

`providers.json`, raw keys, and state are ignored by Git, and output shows only masked key slots.

## Skill

`skills/search-toolkit/` is an Agent Skill: copy or link it into your agent's skill directory. `SKILL.md` holds the always-loaded routing and safety rules; `references/provider-routing.md` holds mode tables, result metadata, and specialist provider parameters.

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
