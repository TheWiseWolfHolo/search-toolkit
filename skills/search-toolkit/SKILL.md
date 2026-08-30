---
name: search-toolkit
description: Use Search Toolkit's official-first MCP tools for fast current web search, exact or semantic discovery, official-site lookup, source-backed research, page extraction, crawling, mapping, and provider-specific searches. Prefer this whenever Search Toolkit tools are available and the user needs live web information. Route by provider capability instead of treating every search backend as interchangeable; keep Doubao manual-only unless the user explicitly asks for it.
---

# Search Toolkit

Choose by capability fit and retrieval quality first. Request price is a secondary constraint because the configured quotas are ample, but avoid unnecessary latency, oversized responses, and implicit research or crawling. Escalate from search to selected-page fetch, then to research or automation only when the simpler step is insufficient.

## Retrieval workflow

1. Search once with roughly 5-8 compact results.
2. Inspect titles, URLs, snippets, and source independence.
3. Fetch only the selected pages needed for the answer; do not search a known URL again.
4. Use deep research only for multi-step synthesis, gap analysis, or exhaustive comparison.
5. Use browser/agent automation only when information requires interaction.

## Interface selection

Prefer the native Search Toolkit MCP tools when they are present in the live inventory. If an agent has the Skill but the MCP functions were not injected, use an installed `search-toolkit` CLI as the fallback interface to the same backend: inspect `search-toolkit tools`, then run `search-toolkit call <tool> <json-arguments>`. This is not permission to fall back to a different search engine such as smart-search. Do not open the Provider config or pass raw keys on the command line. If neither MCP nor CLI is available, report the missing interface instead of inventing a tool.

## Capability routing

- General lookup: `search_auto` with `mode: general, quality: balanced`. Use `quality: max` for broad, ambiguous, multi-aspect, or high-value retrieval so the router can select deeper semantic search rather than merely choosing a cheaper mode. Read the routing reference when exact Provider order matters.
- Exact strings, code, obscure sources, and semantic discovery: Exa. Balanced exact search uses normal Exa Search; use `quality: max` or the direct Advanced tool when domain, date, text, subpage, category, or highlight controls justify it. Verify repository identity and fork/rename relationships before naming an origin. For local repositories or code that was just written or pushed, use `rg` or `gh search code` first because web indexes may not contain it yet.
- Independent cross-checking and current news: Brave Web/News. Use `search_auto` current mode for fast-changing facts; it applies a one-week freshness window by default and accepts `freshness: day|week|month|year`, mapped to each Provider's native control. Its availability fallback is Serper News. A successful automatic call stops after the first Provider, so when news coverage or corroboration matters, run Serper News explicitly as a second search instead of assuming automatic routing queried both. Use Brave directly when an independent index is important. The current Tavily MCP schema exposes general search rather than a news topic, so use its supported time range instead of an invented `topic: news`. Use `brave_llm_context` or `search_auto` in context mode when the model needs relevance-ranked content chunks from multiple pages within a controlled token budget. Direct calls and `search_auto` requests routed to Brave send a 4096-token budget by default; set `maximumNumberOfTokens` explicitly when the task needs another value. Context fallbacks use provider-specific controls, so this parameter does not apply to them. LLM Context returns grounding and source metadata, not a final synthesized answer; do not use it for simple URL discovery or a known URL that should be fetched directly.
- Unified Web and News retrieval: `you_search`. Keep `contentLevel: snippets` for ordinary discovery; request `highlights` only when the model needs query-aware passages from the returned pages. Do not turn on extraction merely because it is available.
- Semantic, multi-aspect retrieval: `parallel_search`. Give it a self-contained natural-language objective plus 1-3 concise `searchQueries` when the task is broader than one keyword query. Use `fast` for most interactive agent retrieval, `basic` when the task specifically benefits from extended excerpts, and `advanced` for complex semantic or multi-hop work. Use `turbo` only for English or Japanese queries that prioritize the lowest latency; it shares `fast`'s price tier, while `basic` shares `advanced`'s price tier. The current Search API modes are turbo, fast, basic, and advanced. Use the ranked excerpts before deciding whether any page still needs fetching.
- Official-site and concise Google-style results: Serper.
- Image discovery: use `search_images` for quality-first worldwide text-to-image search. It routes Brave Images first and Serper Images only as the availability fallback; automatic image routing does not narrow by country. Use `brave_image_search` or `serper_images` directly only when the index or a country-specific filter itself matters. Preserve original image URL, thumbnail, dimensions, and source-page metadata in the answer. These tools do not inspect an uploaded image and are not reverse image search; if a client only gives the model pixels and no attachment URL, visual description followed by text-to-image search is an explicit fallback, not an equivalent capability.
- Search-to-extract, crawl, map, and managed research: Tavily, only when the workflow needs more than lookup.
- Sourced synthesis and long research: LinkUp; avoid deep modes for routine questions.
- Manual general/vertical retrieval: AnySearch. Keep it out of `search_auto`; call it explicitly when its `batch_search`, source-directory routing, or URL `extract` interface is useful. Run `get_sub_domains` before a vertical search and obey the returned parameter schema. Current live checks favor `security.vuln`, structured finance, and `code.doc`; inspect all vertical results closely because `academic.search` and a repository-constrained `code.snippet` query ranked poorly. Batch items fail independently, so use it when several unrelated lookups can run together. Do not send sensitive queries on the assumption of zero logging: the provider's legal terms say truncated query content may appear in service logs.
- Known-page scrape, site acquisition, structured extraction, and difficult pages: Firecrawl. Its default tool policy hides monitor, feedback, interaction, and agent management tools.
- Jina and TinyFish currently expose search only. Do not invent Reader, Agent, Browser, or automation tools that are absent from the live inventory.
- Chinese-local retrieval: Doubao only when the user explicitly requests it or approves its limited quota. It never enters automatic routing or fallback.
- X-native posts and social signals: Grok/X Search when X itself matters; corroborate important claims on the wider web.

`search_auto` may try one additional compatible retrieval Provider after a recognized availability failure: unusable credentials or balance, network failure, timeout, HTTP 408/425/429, Provider 5xx, or clear statusless MCP messages such as rate limits and temporary unavailability. Request/schema errors, policy or safety blocks, local code errors, and unknown failures remain terminal. The router never upgrades ordinary search into Research, Crawl, full-page extraction, or agentic work. Successful results include `structuredContent.searchAuto`; terminal errors include a safe Provider/tool/status attempt summary without upstream error bodies.

## Evidence discipline

Search results discover sources; they do not automatically prove every snippet claim. For important or time-sensitive claims, fetch or read the most relevant source page before answering. Keep citations adjacent to the claims they support.

For source-backed web research, current-fact answers, exact-source tracing, and audit-oriented work, end with one compact route line so the provider decision remains auditable. Match the answer language, for example `Search route: provider/tool` or `搜索路由：provider/tool`. Copy the values from returned provenance: prefer `structuredContent.route`, otherwise use the leading `searchToolkitRoute` content block, and use `_meta.searchToolkit.route` only when the client exposes it. `structuredContent.searchAuto` explains automatic routing and bounded failover when present. Omit the footer for trivial utility lookups unless provenance materially helps or the user requests it; never infer or fabricate missing route values.

For consequential or disputed claims, prefer primary sources and cross-check through an independent retrieval path; Brave is the preferred independent-index check. Multiple copies of one underlying report are not independent confirmation.

For exact code or configuration-string origin questions, verify repository identity before saying "出自" or "originates from": inspect the matched file, repository name, commit date, and any fork/rename relationship visible in the source. If multiple repositories contain the same string and ancestry is unresolved, cite the candidates and say the original source is uncertain instead of promoting the first search hit to canonical origin.

## Key pools

Search Toolkit rotates all configured keys per provider. Do not request, print, or inspect raw keys. Use `search_pool_status` for masked health and `search_rotation_probe` only when the user explicitly wants a live rotation test because it consumes provider quota.

Respect annotations and approval prompts. Do not call tools that create, update, delete, start jobs, send notifications, interact with pages, or submit feedback unless the user explicitly requested that side effect.

## Deep research boundary

Use provider-specific tools directly for normal research. Use a separate deep-research orchestrator only when the user asks for multi-stage planning, gap analysis, or exhaustive cross-source synthesis.

Read `references/provider-routing.md` when choosing among several plausible providers, fetching known URLs, or deciding whether to escalate.
