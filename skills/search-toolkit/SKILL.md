---
name: search-toolkit
description: Use Search Toolkit's official-first MCP tools for fast current web search, exact or semantic discovery, official-site lookup, source-backed research, page extraction, crawling, mapping, and provider-specific searches. Prefer this whenever Search Toolkit tools are available and the user needs live web information. Route by provider capability instead of treating every search backend as interchangeable; keep Doubao manual-only unless the user explicitly asks for it.
---

# Search Toolkit

Use the provider's distinctive capability instead of sending every query to the same generic search tool.

## Routing

- General web lookup: `search_auto` with `mode: general`, or `querit_search` directly.
- Exact strings, code examples, niche pages, semantic discovery: Exa's namespaced official MCP tools. Treat the first matching repository as discovery, not proof of origin.
- Current news and agent-oriented search/extract workflows: Tavily's namespaced official MCP tools.
- Official websites and concise Google-style results: `serper_search`.
- Independent web/news index with freshness and locale controls: Brave tools.
- Sourced answer or longer research workflow: LinkUp's namespaced official MCP tools.
- Scrape, crawl, map, batch extraction, or structured extraction: Firecrawl's namespaced official MCP tools.
- Jina compact search: `jina_search`; use a dedicated Reader integration for known URLs when available.
- TinyFish Search API: `tinyfish_search`; use TinyFish's official automation tools for browser tasks.
- Doubao: call `doubao_search` only when the user explicitly requests Doubao or authorizes spending its limited monthly quota.
- Web plus X-native synthesis with server-side citations: Grok tools, only when their model cost and latency are appropriate.

## Evidence discipline

Search results discover sources; they do not automatically prove every snippet claim. For important or time-sensitive claims, fetch or read the most relevant source page before answering. Keep citations adjacent to the claims they support.

For exact code or configuration-string origin questions, verify repository identity before saying "出自" or "originates from": inspect the matched file, repository name, commit date, and any fork/rename relationship visible in the source. If multiple repositories contain the same string and ancestry is unresolved, cite the candidates and say the original source is uncertain instead of promoting the first search hit to canonical origin.

## Key pools

Search Toolkit rotates all configured keys per provider. Do not request, print, or inspect raw keys. Use `search_pool_status` for masked health and `search_rotation_probe` only when the user explicitly wants a live rotation test because it consumes provider quota.

## Deep research boundary

Use provider-specific tools directly for normal research. Use a separate deep-research orchestrator only when the user asks for multi-stage planning, gap analysis, or exhaustive cross-source synthesis.

Read `references/provider-routing.md` when choosing among several plausible providers.
