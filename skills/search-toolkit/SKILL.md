---
name: search-toolkit
description: Retrieve current web sources, run web or reverse image search, and read known URLs through available Search Toolkit MCP or CLI tools. Use for general web lookup, image discovery, and URL extraction; dedicated official API documentation routes and user-selected tools take precedence. Doubao requires explicit authorization.
---

# Search Toolkit

Pick by capability fit and retrieval quality; respect quota and cost limits, and avoid needless latency, oversized responses, and implicit research or crawling.

## Workflow

1. Search once, about 5-8 results.
2. Judge titles, URLs, dates, snippets, and source independence.
3. Read only the pages the answer needs. Use `fetch_auto` for 1 to 5 known URLs (`url` or `urls`), passing `section` or `offset` for targeted or paged reads; never search for a URL you already have.
4. Escalate to deep research only for multi-step synthesis, gap analysis, or exhaustive comparison, and to browser automation only when interaction is required.

## Interface

Prefer native MCP tools: `search_auto` (web), `search_images`, `fetch_auto`, and `search_pool_status`, plus specialist tools such as `brave_llm_context`, `parallel_extract`, `you_contents`, `deepseek_search`, `vercel_parallel_fast`, `serper_scholar`, or `firecrawl_firecrawl_crawl` when specifically needed.

Profiles: `full` exposes unified tools, status, probe, and all enabled provider tools (no gateway); `curated` adds specialist tools plus the gateway; `lean` exposes only `search_auto`, `search_images`, `fetch_auto`, `search_pool_status`, `search_rotation_probe`, `provider_tools`, and `provider_call`. Inspect a tool's schema with `provider_tools` before calling `provider_call`.

Without MCP, use the `search-toolkit` CLI on the same backend:
- `search-toolkit search "<query>" [--mode ...] [--quality max] [--domains a,b] [--exclude-domains x] [--cross]`
- `search-toolkit images "<query | image-url>" [--query "..."] [--image-url "..."] [--limit 10]`
- `search-toolkit fetch <url...> [--quality max] [--section heading] [--offset n] [--max-chars n]`
- `search-toolkit tools [--provider <name>] [--describe <tool>] [--json]`
- `search-toolkit call <tool> '<json>'` (or `--input -` / `@args.json`, preferred on Windows PowerShell)

If neither interface exists or has the capability, say so and use an available same-capability route; a permission denial is not unavailability. Never open provider config, pass raw keys, invent tools, or imply a different provider answered.

## Routing rules

- Start with `search_auto`. Use `quality: max` for broad, ambiguous, multi-aspect, or high-value queries; `mode: exact` for quoted strings and error messages, `current` for news, `official` for official sites, `scholar` for papers, `code` for repositories and code examples, `context` for token-bounded grounding chunks. Pass `includeDomains` (path prefixes like `github.com/org` supported), `excludeDomains`, `freshness`, or `maxCharsPerResult` directly.
- Use `fetch_auto` (`balanced` by default; `quality: max` for JS-heavy or blocked pages). Check `page.status`: `readable` means substantial body text; `partial` means a fragment (retry with `quality: max` if the page matters). On truncated readable pages, continue with the returned `nextOffset`.
- Search Chinese topics in Chinese; Simplified and Traditional queries receive Chinese-market settings automatically.
- `"cached":"4m"` (or `"12s"`) in the route block means a recent cached answer was reused. For breaking news that must be newer, note the age, rephrase, or pass `--no-cache` in CLI.
- `search_auto` stops at the first provider with results. For consequential claims needing an independent second opinion, pass `crossCheck: true` (or corroborate with Brave). Reposts of one report count as one source.
- For local repositories or freshly pushed code, use `rg` or `gh search code`; web indexes lag.
- `search_images` takes `query` (text) or `imageUrl` (Google Lens reverse search). Reverse search requires a public http(s) URL (no local files or chat uploads) and gives no dates, so fetch candidate pages to verify earliest origin.

## Cost & specialist guardrails

- **Crawl, map, and research**: use Firecrawl (`firecrawl_firecrawl_map`, `firecrawl_firecrawl_crawl`), Tavily, or LinkUp only when lookup is insufficient. Keep routine search on `search_auto`, not `firecrawl_firecrawl_search` (narrow US queries can trigger extra Ultrasearch credits).
- **Grok (`grok_x_search`, `grok_web_x_search`)**: use only when X posts or threads matter. Returns a cited answer, not a URL list. Default to `depth: fast`; `deep` (4 agents) and `max` (16 agents, ~$2-3/call) are for broad multi-faceted research, never single facts.
- **Long billed jobs (`exa_agent_run`)**: run only when the user explicitly requests one.
- **AnySearch verticals**: manual-only; call `anysearch_get_sub_domains` first and pass only its returned sub-domain and parameter fields.
- **DeepSeek (`deepseek_search`, `vercel_deepseek_search`)**: enforces a 128 Unicode code-point query cap (skipped automatically in `search_auto` when exceeded).
- **Doubao (`doubao_search`)**: explicit user request or quota approval only; never a fallback.

## Evidence

Search results discover sources; they do not prove snippet claims. Read the page behind any important or time-sensitive claim, keep citations next to claims, and prefer primary sources. Report which provider answered only when asked, or when a fallback or limitation changes interpretation (read values from the route block, never infer them). Before claiming a string "originates from" a project, check repo identity and fork/rename history; if unresolved, say the origin is uncertain.

## Keys and side effects

Never request, print, or inspect keys. Benched keys recover automatically; exhausted keys wait behind healthy ones until a call or quota reading shows credit. "paid tier required" means no key in that pool may run the tool: use another provider rather than retrying. Run `search_rotation_probe` only on explicit request (spends quota). Never call tools that create, update, delete, start jobs, interact with pages, or submit feedback without explicit user intent, and respect approval prompts.

Read `references/provider-routing.md` when exact mode orders, fallback rules, result metadata, or specialist provider parameters matter.
