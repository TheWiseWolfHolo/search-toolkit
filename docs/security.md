# Security model

## Secrets

- Raw keys live outside the repository: either in a standalone `providers.json`, or referenced via `"env:VAR_NAME"` / `"file:/path/to/secret"` (supporting `~/` expansion). Disabled providers skip secret resolution so unresolved references are never read or transmitted, and `migrate-config` preserves secret references (`keyRefs`) rather than writing resolved values back to disk.
- The repository ignores `.env`, `providers.json`, SQLite state, logs, and package archives.
- MCP and CLI output expose only masked key slots. Startup registers configured key literals (and their URL-encoded forms) with `redact()`, which masks exact configured secrets, `Bearer` headers, secret query parameters, known provider key prefixes, and high-entropy token runs while preserving lowercase `snake_case` error codes, UUIDs, and tool names. Key health is stored by a truncated SHA-256 fingerprint, never the key.
- `migrate-config` prints only the list of changes and writes a backup beside the original atomically; it never prints key values.
- STDIO MCP children receive an explicit minimal allowlist of OS/runtime/proxy environment variables plus their own `envKey` and `integration.env`; ambient host secrets (such as `SEARCH_TOOLKIT_HTTP_TOKENS` or other providers' API keys) are not inherited.
- The tool-catalog cache in `state.db` (`tool_catalog` table) holds each upstream's public tool metadata and a hash of its integration settings. It contains no keys.
- Official upstream `_meta` is stripped at the MCP boundary except for `searchToolkit`, so provider session or analytics tokens are never forwarded to models.
- Outbound REST and quota requests disable redirects (`redirect: "error"`) and enforce response byte caps so API key headers are never forwarded across redirect hops and oversized responses cannot exhaust memory.

## Rotation and failure isolation

- Rotation state is coordinated through an atomic SQLite transaction shared with the result cache and tool catalog on a single WAL connection.
- `401` and `403` bench only the selected key, for 1 hour and then longer on repeated faults (6 and 24 hours); the key is tried again when its window ends, with half-open probe leasing to prevent thundering-herd retries.
- `402` and Tavily `432`/`433` (and explicit out-of-credit wording under statusless/400/401/403/429) mark a key exhausted for 30 minutes, then 6 and 24 hours. `429` and Tavily `434` (Flex Tier Capacity) bench for 1, 5, then 15 minutes, or for the provider's `Retry-After` / `X-RateLimit-Reset`.
- Network and `5xx` failures can retry the next healthy key once, do not bench the key, and never reset an already-benched or exhausted key back to healthy.
- `400`, `404`, `422`, validation errors (`InvalidRequestError`), and unexpected arguments remain request-shape errors; they do not burn through the rest of the key pool.
- Provider health (`recentFailure`) is tracked per capability (`search`, `images`, `fetch`), so fetch hiccups never demote search on dual-capability providers.
- An upstream MCP tool's own error is returned as the tool's result. It is treated as a key fault only when the text is clearly about the key (and fetch-intent tools require explicit provider/key qualifiers before attributing 401/429 to an API key), so a scraped page answering 403 cannot disable the key that fetched it.
- When every key is benched, selection fails closed and reports when the first key recovers.

## Open-world tools

Search, crawl, scrape, and remote MCP tools interact with the public internet. MCP annotations are hints rather than an authorization boundary, but Search Toolkit classifies upstream tools deterministically in `safeToolAnnotations()` (`src/upstream.ts`) in this precedence order:

1. **Destructive (`readOnlyHint: false, destructiveHint: true`)**: tool names matching `delete`, `remove`, `destroy`, or `revoke`.
2. **Explicit writes (`readOnlyHint: false, destructiveHint: false`)**: tool names matching `create`, `update`, `patch`, `set`, `run`, `start`, `stop`, `feedback`, or `interact`.
3. **Read-only retrieval (`readOnlyHint: true, destructiveHint: false`)**: tool names matching `search`, `fetch`, `scrape`, `extract`, `map`, `list`, `get`, `status`, `check`, `read`, `inspect`, or `related`. Because retrieval is checked before job keywords, read-only status/search tools such as `firecrawl_check_crawl_status` and `firecrawl_research_search_papers` remain read-only.
4. **Background/costly jobs (`readOnlyHint: false, destructiveHint: false`)**: tool names matching `agent`, `crawl`, `parse`, or `research` (when not already matched by retrieval).

Additional tool-surface guardrails:
- Firecrawl monitor, interaction, feedback, and agent tools are not exposed by the default focused allowlist (for both local STDIO `firecrawl-mcp` and hosted remote MCP `https://mcp.firecrawl.dev/v2/mcp`). Set `toolPolicy.allow` to `["*"]` only when the full catalog and its approval surface are intentional. `remote_mcp` also supports keyless `auth: { kind: "none" }` endpoints.
- In `lean` and `curated` profiles, `provider_call` can reach any provider tool, so it is annotated as a non-read-only tool and clients prompt for approval according to their own policy. It validates arguments against the target tool's schema and cannot call the unified management tools.
- `fetch_auto` accepts only `http` and `https` URLs without embedded credentials. By default all configured readers are third-party services; nothing is fetched from the machine running the server unless the opt-in keyless `direct_markdown` provider (`direct_markdown_fetch`) is enabled. When enabled, `direct_markdown_fetch` performs a direct host-side HTTP GET with `Accept: text/markdown` under strict SSRF checks: public `http(s)` URLs on standard ports (80/443) only, embedded credentials rejected, local/private hostnames (`localhost`, `*.localhost`, `*.local`, `*.internal`, `*.home.arpa`, single-label hosts) and loopback/RFC1918/link-local/CGNAT/metadata/NAT64/ULA/deprecated IPv4+IPv6 literals and DNS-resolved private IPs blocked, socket-level IP pinning to prevent DNS rebinding (TOCTOU), every redirect hop (max 3) re-validated under a single total deadline, 1 MB response cap, 1-15s timeout, and `text/markdown` Content-Type required. Leave `direct_markdown` disabled if strict third-party-only fetching is required.

Codex should use `default_tools_approval_mode = "writes"` so non-read-only tools prompt. Agents and users should still review URLs, fetched content, and upstream annotations as untrusted input.

## HTTP transport

Streamable HTTP authenticates with a bearer token whose SHA-256 hash is compared in constant time. Token policies should set explicit `role: "owner" | "client"` (legacy tokens without `role` are treated as owner only when no restrictions are set). Shared client tokens should carry a tool allowlist (`tools`), per-tool argument restrictions (`allowedToolArguments`, e.g. `{"grok_*":{"depth":["fast","deep"]}}`; global `allowedArgumentValues` is also supported), a per-minute call limit (`requestsPerMinute`), and a session cap (`maxSessions`).

- Both `tools` and argument restrictions are enforced on direct calls, inside `provider_call`, and on `search_rotation_probe`; `provider_tools` hides disallowed tools.
- `search_pool_status` live `refreshQuota: true` is restricted to owner callers.
- `POST /admin/reload` and `POST /admin/shutdown` require an owner token and are mounted only on loopback listeners (`127.0.0.1`, `::1`, `localhost`) when `SEARCH_TOOLKIT_HTTP_ALLOWED_HOSTS` is unset or contains only loopback hosts.
- Requests are capped at 100 KiB and 10,000 JSON argument elements before schema validation, `X-Powered-By` is disabled, cross-origin requests are rejected unless allowed, and the `Host` header is validated case-insensitively when allowed hosts are set. Provider keys never leave the server.
