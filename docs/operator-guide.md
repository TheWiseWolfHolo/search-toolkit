# Operator Guide

This guide covers configuration details, key rotation mechanics, billing quota endpoints, tool policies, and historical provider observations moved out of the agent skill so agent prompts stay compact.

## Configuration & Secret Indirection

Default config path:
- Windows: `%USERPROFILE%/.config/search-toolkit/providers.json` (kept outside `AppData/Local` so MSIX-packaged apps and ordinary CLI processes read the same physical file).
- macOS / Linux: `${XDG_CONFIG_HOME:-~/.config}/search-toolkit/providers.json`.
- Override with `--config <path>` or `SEARCH_TOOLKIT_CONFIG`.

`statePath` supports `~/` expansion and paths relative to the directory containing the config file.

### Secret References

Keys in `providers.<name>.keys` may be plain strings, `"env:VAR_NAME"`, or `"file:/path/to/secret"` (with `~/` expansion), or objects `{ key, tier?, label?, allowTools?, denyTools? }`. Disabled providers skip env/file resolution so paused or example entries stay valid. `search-toolkit migrate-config` preserves secret references (`keyRefs`) rather than writing resolved values back to disk.

### Provider Options

Only these `options` keys are read by adapters (unrecognized option keys produce startup warnings):

| Adapter | Supported `options` |
| --- | --- |
| `grok` | `model` (default `grok-4.20-0309-non-reasoning`; `grok-4.7*` defaults `reasoningEffort` to `"low"`), `multiAgentModel` (default `grok-4.20-multi-agent-0309`), `reasoningEffort`, `systemPrompt`, `customUrl` |
| `deepseek` | `localization` (optional IPv4/IPv6 for regional localization) |
| `vercel_gateway` | `model` (default `nvidia/nemotron-3.5-lightning-free`), `reasoning` (default `"none"`), `enableParallelFast` (default `true`), `localization`, `fallbackModels`, `authMethod` (`"api-key"` or `"oidc"`) |
| `direct_markdown` | `timeoutMs` (1000-15000, default 4000) |

### Tool Policies & Profiles

- `shaping`: `maxDescriptionChars` (default 700), `maxParamDescriptionChars` (default 220); `0` preserves upstream text.
- `toolPolicy.allow`, `toolPolicy.deny`, `toolPolicy.descriptions` (keyed by upstream tool name).
- **Firecrawl default allowlist**: exposes 9 core tools (`firecrawl_scrape`, `firecrawl_map`, `firecrawl_search`, `firecrawl_crawl`, `firecrawl_check_crawl_status`, `firecrawl_developer_search`, `firecrawl_research_search_papers`, `firecrawl_gov_search`, `firecrawl_credit_usage`) for both local STDIO (`firecrawl-mcp@3.41.0`) and hosted remote MCP (`https://mcp.firecrawl.dev/v2/mcp`, Bearer auth). Set `toolPolicy.allow: ["*"]` to expose the full upstream catalog.
- **AnySearch default deny**: hides `score` (feedback tool whose upstream description asks to be called after every search).
- **Idle STDIO shutdown**: local `stdio_mcp` child processes close after 10 minutes of inactivity (`integration.idleTimeoutMs`, `0` disables) and respawn transparently on the next call.
- **Tool catalog cache**: stored inside `state.db` (`tool_catalog` WAL table, automatically migrated from legacy `tool-catalog.json`) and refreshed in the background after 12 hours (`notifications/tools/list_changed`).

## Key Rotation & Health Internals

Keys are tracked in SQLite (`state.db`) by truncated SHA-256 fingerprint, so reordering a pool preserves per-key history.

### Strategies

- `round_robin` (default): advances to the next healthy key after each call. Suits monthly free allowances and per-key QPS caps (Serper, Tavily, Exa).
- `sticky`: stays on one key until it fails, minimizing upstream MCP sessions/subprocesses (AnySearch).
- `drain`: always uses the first healthy key in configured order so older prepaid or resetting monthly balances are spent before top-ups (Parallel, Firecrawl).

### Failure Classification & Backoff

| Failure | Key penalty | Key retries | Provider failover |
| --- | --- | --- | --- |
| Success | Clears strikes; restores exhausted key | - | - |
| Out of credit (`402`, Tavily `432`/`433`, or out-of-credit text such as `Insufficient balance`, `spend_cap_exceeded`, `free_allowance_exhausted`, `index_daily_limit` under statusless/400/401/403/429) | `exhausted`: benched 30m, 6h, 24h; afterwards waits behind healthy keys (`drain` retries once per window) | Up to 3 keys | Yes |
| Plan limit (`not allowed for free accounts`, `Payment method required`) | Not benched | Up to 3 keys not marked `free` | Yes |
| `401` / `403` (auth/key) | `disabled`: benched 1h, 6h, 24h | Up to 3 keys | Yes (non-policy 403) |
| `429` / Tavily `434` (Flex Tier Capacity) | `cooldown`: benched 1m, 5m, 15m, or `Retry-After` / `X-RateLimit-Reset` | Up to 3 keys | Yes |
| `5xx` or dropped connection | Not benched | 1 more key | Yes |
| Timeout | Not benched | None | Yes |
| `400` / `404` / `422`, upstream tool error, policy block, or `TargetPageError` (page status) | Not benched | None | Only `TargetPageError` (excluding 404/410/451) in `fetch_auto` |

Strike counts decay after 24 hours without errors, and half-open probe leasing prevents thundering-herd retries when a benched key's cooldown expires.

### Provider Health (`recentFailure`)

Automatic-route failures update a per-capability (`search`, `images`, `fetch`) EWMA score with a 15-minute half-life so fetch hiccups never demote search. Two consecutive failures move a provider behind healthy peers until one success or a quiet half hour. `search_pool_status` reports each provider's worst active score as `recentFailure`.

## Billing & Quota Endpoints (`search-toolkit quota`)

`search-toolkit quota [provider] [--verbose] [--json]` queries providers concurrently (sequentially per provider's keys) and skips disabled providers so unresolved secret references are never sent over the network.

| Provider | Billing endpoint | Unit | Special handling |
| --- | --- | --- | --- |
| Serper | `GET /account` | `credits` | Standard |
| Tavily | `GET /usage` | `credits` | Accounts for plan + PAYGO and per-key cap; enforces >= 65s cooldown when `!force` to stay under Tavily's 10 req/10 min usage API limit |
| Firecrawl | `GET /v2/team/credit-usage` | `credits` | Checks `success !== false` |
| LinkUp | `GET /v1/credits/balance` | `USD` | Standard |
| You.com | `GET /v1/billing/account_balance` | `cents` | Converts to `displayRemaining` in `USD` while keeping raw cents |
| TinyFish | `GET /v1/wallet` | `USD` | `exhaustOnZero: false` and `preserveStatusOnPositive: true`: a `$0` paid wallet never benches the separate free 1,000 URLs/day Fetch tier, and a `$10` wallet does not clear `free_allowance_exhausted` |
| DeepSeek | `GET /user/balance` | `USD` / currency | Preserves per-currency fields without summing different currencies |
| Vercel AI Gateway | `GET /v1/credits` | `USD` | `exhaustOnZero: false`: a `$0` credit balance still allows `$0` promo tools such as `vercel_parallel_fast` (hosted DeepSeek tools draw `$0.75/1k` from gateway credits on the `$0` default host model `nvidia/nemotron-3.5-lightning-free`; check Vercel AI Gateway pricing for current promo windows) |
| Brave | Passive header tracking | `credits` | Reads monthly remaining quota from `X-RateLimit-Remaining` / `X-RateLimit-Limit` headers on live requests |

Readings at or below zero mark the key `exhausted` (6h bench) unless `exhaustOnZero: false`. Confirmed billing 401/402 errors are surfaced as health warnings. Calling `search_pool_status` with `refreshQuota: true` triggers live reads for owner callers only.

## HTTP Token Policies & Admin Controls

Token policies live in `SEARCH_TOOLKIT_HTTP_TOKENS` or `SEARCH_TOOLKIT_HTTP_TOKENS_FILE` as JSON objects with SHA-256 hex `hash`:

```json
[
  { "hash": "<owner-sha256-hex>", "role": "owner" },
  {
    "hash": "<shared-sha256-hex>",
    "role": "client",
    "profile": "lean",
    "tools": ["search_auto", "search_images", "fetch_auto", "provider_tools", "provider_call", "grok_x_search"],
    "allowedToolArguments": { "grok_*": { "depth": ["fast", "deep"] } },
    "requestsPerMinute": 30,
    "maxSessions": 16
  }
]
```

- Prefer explicit `role: "owner" | "client"` (legacy tokens omitting `role` are treated as owner only when `tools`, `allowedArgumentValues`, `allowedToolArguments`, `requestsPerMinute`, and `maxSessions` are all unset).
- Prefer `allowedToolArguments` (keyed by exact tool name or `"prefix_*"` glob) over global `allowedArgumentValues` so restricting `grok_*` `depth` does not block unrelated tools such as `linkup_linkup_search` (`depth: "standard"`).
- `POST /admin/reload` and `POST /admin/shutdown` are enabled only when listening on loopback (`127.0.0.1`, `::1`, `localhost`) and `SEARCH_TOOLKIT_HTTP_ALLOWED_HOSTS` is unset or contains only loopback hosts, and require an owner token.

## Historical Provider Notes

- **AnySearch (live checks, Aug 2026)**: strong English official docs, detailed `security.vuln`, useful finance quotes, accurate React `code.doc`, isolated `batch_search` error handling; noisy Chinese general results, weak `academic.search`, and slow repo-constrained `code.snippet`. Free plan advertised 1,000 req/day and 20 QPS; terms permit service logs with truncated query content.
- **Octen (live check, Nov 2026)**: some gift-credit keys intermittently answered `403 Payment method required` on `octen_extract` while succeeding on other calls; leave tier unset or mark paid keys explicitly so plan-limit retry handles it cleanly.
- **Grok via `grok2api` Console**: Console gateway drops `allowedDomains` / `allowedXHandles` API fields, so the adapter appends filter hints into the prompt text; concurrency `429` retries once after 3 seconds.
