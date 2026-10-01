# Security model

## Secrets

- Raw keys live only in a standalone `providers.json` outside the repository.
- The repository ignores `.env`, `providers.json`, SQLite state, logs, and package archives.
- MCP and CLI output expose only masked key slots. Key health is stored by a truncated SHA-256 fingerprint, never the key.
- `migrate-config` prints only the list of changes and writes a backup beside the original; it never prints key values.
- The tool-catalog cache beside the state database holds each upstream's public tool metadata and a hash of its integration settings. It contains no keys.
- Official upstream `_meta` is replaced rather than forwarded because it can contain provider session or analytics tokens.

## Rotation and failure isolation

- Rotation state is coordinated through an atomic SQLite transaction.
- `401` and `403` bench only the selected key, for 1 hour and then longer on repeated faults (6 and 24 hours); the key is tried again when its window ends.
- `402` benches for 30 minutes, then 6 and 24 hours. `429` benches for 1, 5, then 15 minutes, or for the provider's `Retry-After`.
- Network and `5xx` failures can retry the next healthy key once and do not bench the key.
- `400`, `404`, `422`, validation errors, and unexpected arguments remain request-shape errors; they do not burn through the rest of the key pool.
- An upstream MCP tool's own error is returned as the tool's result. It is treated as a key fault only when the text is clearly about the key (invalid key, quota, rate limit), so a scraped page answering 403 cannot disable the key that fetched it.
- When every key is benched, selection fails closed and reports when the first key recovers.

## Open-world tools

Search, crawl, scrape, and remote MCP tools interact with the public internet. MCP annotations are hints rather than an authorization boundary, but Search Toolkit does not overwrite every upstream tool as read-only:

- Pure lookup, fetch, scrape, map, list, get, status, and check tools are marked read-only.
- Create, update, run, feedback, interaction, crawl, extract, agent, parse, and research jobs are marked as writes.
- Delete, remove, destroy, and revoke tools are marked destructive.
- Firecrawl monitor, interaction, feedback, and agent tools are not exposed by the default focused allowlist. Set `toolPolicy.allow` to `["*"]` only when the full catalog and its approval surface are intentional.
- In the `lean` profile, `provider_call` can reach any provider tool, so it is annotated as a non-read-only tool and clients prompt for approval according to their own policy. It validates arguments against the target tool's schema and cannot call the unified management tools.
- `fetch_auto` accepts only `http` and `https` URLs. It sends the URL to third-party readers; it never fetches from the machine running the server.

Codex should use `default_tools_approval_mode = "writes"` so non-read-only tools prompt. Agents and users should still review URLs, fetched content, and upstream annotations as untrusted input.

## HTTP transport

Streamable HTTP authenticates with a bearer token whose SHA-256 hash is compared in constant time. Shared tokens should carry a tool allowlist, a per-minute call limit, and a session cap. The server rejects cross-origin requests unless the origin is allowed, and validates the `Host` header when allowed hosts are set. Provider keys never leave the server.
