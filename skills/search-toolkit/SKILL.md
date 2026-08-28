---
name: search-toolkit
description: Use Search Toolkit's official-first MCP tools for fast current web search, exact or semantic discovery, official-site lookup, source-backed research, page extraction, crawling, mapping, and provider-specific searches. Prefer this whenever Search Toolkit tools are available and the user needs live web information. Route by provider capability instead of treating every search backend as interchangeable; keep Doubao manual-only unless the user explicitly asks for it.
---

# Search Toolkit

Use the cheapest, narrowest provider that reliably fits the task. Escalate from search to selected-page fetch, then to research or automation only when the simpler step is insufficient.

## Retrieval workflow

1. Search once with roughly 5-8 compact results.
2. Inspect titles, URLs, snippets, and source independence.
3. Fetch only the selected pages needed for the answer; do not search a known URL again.
4. Use deep research only for multi-step synthesis, gap analysis, or exhaustive comparison.
5. Use browser/agent automation only when information requires interaction.

## Capability routing

- General lookup: `search_auto` in general mode or Querit.
- Exact strings, code, obscure sources, and semantic discovery: Exa. Verify repository identity and fork/rename relationships before naming an origin.
- Independent cross-checking and current news: Brave Web/News. The current server does not expose Brave LLM Context.
- Official-site and concise Google-style results: Serper.
- Search-to-extract, crawl, map, and managed research: Tavily, only when the workflow needs more than lookup.
- Sourced synthesis and long research: LinkUp; avoid deep modes for routine questions.
- Known-page scrape, site acquisition, structured extraction, and difficult pages: Firecrawl. Its default tool policy hides monitor, feedback, interaction, and agent management tools.
- Jina and TinyFish currently expose search only. Do not invent Reader, Agent, Browser, or automation tools that are absent from the live inventory.
- Chinese-local retrieval: Doubao only when the user explicitly requests it or approves its limited quota. It never enters automatic routing or fallback.
- X-native posts and social signals: Grok/X Search when X itself matters; corroborate important claims on the wider web.

## Evidence discipline

Search results discover sources; they do not automatically prove every snippet claim. For important or time-sensitive claims, fetch or read the most relevant source page before answering. Keep citations adjacent to the claims they support.

For source-backed web research, current-fact answers, exact-source tracing, and audit-oriented work, end with one compact route line so the provider decision remains auditable. Match the answer language, for example `Search route: provider/tool` or `搜索路由：provider/tool`. Copy the values from returned provenance: prefer `structuredContent.route`, otherwise use the leading `searchToolkitRoute` content block, and use `_meta.searchToolkit.route` only when the client exposes it. Omit the footer for trivial utility lookups unless provenance materially helps or the user requests it; never infer or fabricate missing route values.

For consequential or disputed claims, prefer primary sources and cross-check through an independent retrieval path; Brave is the preferred independent-index check. Multiple copies of one underlying report are not independent confirmation.

For exact code or configuration-string origin questions, verify repository identity before saying "出自" or "originates from": inspect the matched file, repository name, commit date, and any fork/rename relationship visible in the source. If multiple repositories contain the same string and ancestry is unresolved, cite the candidates and say the original source is uncertain instead of promoting the first search hit to canonical origin.

## Key pools

Search Toolkit rotates all configured keys per provider. Do not request, print, or inspect raw keys. Use `search_pool_status` for masked health and `search_rotation_probe` only when the user explicitly wants a live rotation test because it consumes provider quota.

Respect annotations and approval prompts. Do not call tools that create, update, delete, start jobs, send notifications, interact with pages, or submit feedback unless the user explicitly requested that side effect.

## Deep research boundary

Use provider-specific tools directly for normal research. Use a separate deep-research orchestrator only when the user asks for multi-stage planning, gap analysis, or exhaustive cross-source synthesis.

Read `references/provider-routing.md` when choosing among several plausible providers, fetching known URLs, or deciding whether to escalate.
