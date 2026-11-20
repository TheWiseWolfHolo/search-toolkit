# Security model

## Secrets

- Raw keys live outside the repository: either in a standalone `providers.json`, or referenced via `"env:VAR_NAME"` / `"file:/path/to/secret"` (supporting `~/` expansion). `migrate-config` preserves secret references (`keyRefs`) rather than writing resolved values back to disk.
- The repository ignores `.env`, `providers.json`, SQLite state, logs, and package archives.
- MCP and CLI output expose only masked key slots. Startup registers configured key literals with `redact()`, which masks exact configured secrets, `Bearer` headers, secret query parameters, known provider key prefixes, and high-entropy token runs while preserving lowercase `snake_case` error codes and tool names. Key health is stored by a truncated SHA-256 fingerprint, never the key.
- `migrate-config` prints only the list of changes and writes a backup beside the original; it never prints key values.
- STDIO MCP children receive an explicit minimal allowlist of OS/runtime/proxy environment variables plus their own `envKey` and `integration.env`; ambient host secrets (such as `SEARCH_TOOLKIT_HTTP_TOKENS` or other providers' API keys) are not inherited.
- The tool-catalog cache beside the state database holds each upstream's public tool metadata and a hash of its integration settings. It contains no keys.
- Official upstream `_meta` is stripped at the MCP boundary except for `searchToolkit`, so provider session or analytics tokens are never forwarded to models.

## Rotation and failure isolation

- Rotation state is coordinated through an atomic SQLite transaction shared with the result cache on a single connection.
- `401` and `403` bench only the selected key, for 1 hour and then longer on repeated faults (6 and 24 hours); the key is tried again when its window ends.
- `402` and Tavily `432`/`433` (and explicit out-of-credit wording) mark a key exhausted for 30 minutes, then 6 and 24 hours. `429` and Tavily `434` (Flex Tier Capacity) bench for 1, 5, then 15 minutes, or for the provider's `Retry-After`.
- Network and `5xx` failures can retry the next healthy key once, do not bench the key, and never reset an already-benched or exhausted key back to healthy.
- `400`, `404`, `422`, validation errors, and unexpected arguments remain request-shape errors; they do not burn through the rest of the key pool.
- Provider health (`recentFailure`) is tracked per capability (`search`, `images`, `fetch`), so fetch hiccups never demote search on dual-capability providers.
- An upstream MCP tool's own error is returned as the tool's result. It is treated as a key fault only when the text is clearly about the key (invalid key, quota, rate limit), so a scraped page answering 403 cannot disable the key that fetched it.
- When every key is benched, selection fails closed and reports when the first key recovers.

## Open-world tools

Search, crawl, scrape, and remote MCP tools interact with the public internet. MCP annotations are hints rather than an authorization boundary, but Search Toolkit does not overwrite every upstream tool as read-only:

- Pure lookup, fetch, scrape, map, list, get, status, and check tools are marked read-only.
- Create, update, run, feedback, interaction, crawl, extract, agent, parse, and research jobs are marked as writes.
- Delete, remove, destroy, and revoke tools are marked destructive.
- Firecrawl monitor, interaction, feedback, and agent tools are not exposed by the default focused allowlist (for both local STDIO `firecrawl-mcp` and hosted remote MCP `https://mcp.firecrawl.dev/v2/mcp`). Set `toolPolicy.allow` to `["*"]` only when the full catalog and its approval surface are intentional. `remote_mcp` also supports keyless `auth: { kind: "none" }` endpoints.
- In `lean` and `curated` profiles, `provider_call` can reach any provider tool, so it is annotated as a non-read-only tool and clients prompt for approval according to their own policy. It validates arguments against the target tool's schema and cannot call the unified management tools.
- `fetch_auto` accepts only `http` and `https` URLs. By default all configured readers are third-party services; nothing is fetched from the machine running the server unless the opt-in keyless `direct_markdown` provider (`direct_markdown_fetch`) is enabled. When enabled, `direct_markdown_fetch` performs a direct host-side HTTP GET with `Accept: text/markdown` under strict SSRF checks: public `http(s)` URLs only, embedded credentials rejected, local/private hostnames (`localhost`, `*.localhost`, `*.local`, `*.internal`, `*.home.arpa`, single-label hosts) and loopback/RFC1918/link-local/CGNAT/metadata/ULA IPv4+IPv6 literals and DNS-resolved private IPs blocked, every redirect hop (max 3) re-validated, 1 MB response cap, 1–15s timeout, and `text/markdown` Content-Type required. Leave `direct_markdown` disabled if strict third-party-only fetching is required.

Codex should use `default_tools_approval_mode = "writes"` so non-read-only tools prompt. Agents and users should still review URLs, fetched content, and upstream annotations as untrusted input.

## HTTP transport

Streamable HTTP authenticates with a bearer token whose SHA-256 hash is compared in constant time. Shared tokens should carry a tool allowlist (`tools`), `allowedArgumentValues` (for example `{"depth":["fast","deep"]}`), a per-minute call limit (`requestsPerMinute`), and a session cap (`maxSessions`). Both `tools` and `allowedArgumentValues` are also enforced inside `provider_call`, and `provider_tools` hides disallowed tools. Requests are capped at 100 KiB and 10,000 JSON argument elements before schema validation, `X-Powered-By` is disabled, cross-origin requests are rejected unless allowed, and the `Host` header is validated when allowed hosts are set. Provider keys never leave the server.
