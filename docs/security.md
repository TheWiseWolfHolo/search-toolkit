# Security model

## Secrets

- Raw keys live only in a standalone `providers.json` outside the repository.
- The repository ignores `.env`, `providers.json`, SQLite state, logs, and package archives.
- MCP and CLI output expose only masked key slots.
- The one-time Kelivo importer prints provider names and key counts, never values.
- Official upstream `_meta` is replaced rather than forwarded because it can contain provider session or analytics tokens.

## Rotation and failure isolation

- Rotation state is coordinated through an atomic SQLite transaction.
- `401` and `403` disable only the selected key.
- `402` and `429` cool down only the selected key.
- Network and `5xx` failures can retry the next healthy key once.
- `400`, `404`, `422`, validation errors, and unexpected arguments remain request-shape errors; they do not burn through the rest of the key pool.
- When every key is disabled or cooling down, selection fails closed.

## Open-world tools

Search, crawl, scrape, and remote MCP tools interact with the public internet. MCP annotations are hints rather than an authorization boundary, but Search Toolkit does not overwrite every upstream tool as read-only:

- Pure lookup, fetch, scrape, map, list, get, status, and check tools are marked read-only.
- Create, update, run, feedback, interaction, crawl, extract, agent, parse, and research jobs are marked as writes.
- Delete, remove, destroy, and revoke tools are marked destructive.
- Firecrawl monitor, interaction, feedback, and agent tools are not exposed by the default focused allowlist. Set `toolPolicy.allow` to `["*"]` only when the full catalog and its approval surface are intentional.

Codex should use `default_tools_approval_mode = "writes"` so non-read-only tools prompt. Agents and users should still review URLs, fetched content, and upstream annotations as untrusted input.
