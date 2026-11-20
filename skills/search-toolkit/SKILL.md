---
name: search-toolkit
description: Retrieve current web sources through available Search Toolkit MCP or CLI tools. Use for general web lookup and source extraction; dedicated official API documentation routes and user-selected tools take precedence. Doubao requires explicit authorization.
---

# Search Toolkit

Pick by capability fit and retrieval quality; respect known quota and cost limits, and avoid needless latency, oversized responses, and implicit research or crawling.

## Workflow

1. Search once, about 5-8 results.
2. Judge titles, URLs, dates, snippets, and whether the sources are independent.
3. Read only the pages the answer needs. Use `fetch_auto` for a URL (or up to 5 `urls`) you already have, and pass `section` or `offset` when reading specific headings or paging through long documents; never search for a URL you already have.
4. Escalate to deep research only for multi-step synthesis, gap analysis, or exhaustive comparison, and to browser automation only when the task needs interaction.

## Interface

Prefer the native MCP tools: `search_auto` (web), `search_images`, `fetch_auto`, and `search_pool_status`, plus provider tools such as `brave_llm_context`, `parallel_extract`, `you_contents`, `deepseek_search`, `vercel_parallel_fast`, `serper_scholar`, or `firecrawl_crawl` when their specific capability is needed. A `curated` server exposes the unified tools, specialist tools, and a gateway; a `lean` server lists only the unified tools and the gateway: `provider_tools` lists provider tools or returns one's schema, and `provider_call` runs it.

Without MCP, use the `search-toolkit` CLI on the same backend: `search-toolkit search "<query>" [--mode ...] [--quality max] [--domains a,b] [--cross]`, `search-toolkit fetch <url...> [--section heading] [--offset n]`, `search-toolkit call <tool> '<json>'`. If neither interface exists or has the capability, say so and use an available same-capability route; a permission denial is not unavailability. Never open the provider config, pass raw keys, invent tools, or imply a different provider was used.

## Routing rules

- Start with `search_auto`. Use `quality: max` when the question is broad, ambiguous, multi-aspect, or high-value; `mode: exact` for quoted strings and error messages, `current` for news, `official` for official sites, `scholar` for papers, `code` for repositories and code examples, `context` for grounding chunks within a token budget. Pass `includeDomains` (supports path prefixes such as `github.com/org`), `excludeDomains`, `freshness`, or `maxCharsPerResult` directly on `search_auto` when needed.
- Balanced `fetch_auto` tries zero-cost native Markdown (`direct_markdown_fetch`) first when enabled, then Exa, DeepSeek, Vercel DeepSeek, and other readers; `quality: max` leads with Firecrawl for JS-heavy pages.
- Search Chinese topics in Chinese; such queries are routed to Chinese-market settings, so do not translate them to English first.
- `"cached":"4m"` in the route block means the answer was reused from the last few minutes. For news that must be newer, say so or rephrase.
- A claim that matters needs an independent second path: `crossCheck: true`, or Brave. Reposts of one report count as one source.
- `search_auto` stops at the first provider that answers, so it will not give you a second opinion unless you ask for `crossCheck`.
- Code that is local or was just pushed: use `rg` or `gh search code`; web indexes lag.
- `search_images` finds images by `query`, or by image with `imageUrl` (Google Lens): pages showing the same or a similar picture, to identify it or trace its source. The image needs a public URL; a local file or chat upload without one cannot be searched by image.
- Crawl, map, and structured extraction belong to Firecrawl or Tavily, and long sourced research to LinkUp, only when the task needs more than lookup. Keep routine web lookup on `search_auto` rather than Firecrawl search (narrow single-entity US queries can trigger extra Ultrasearch credits).
- AnySearch is manual; call `get_sub_domains` before any vertical search. Grok X Search only when X itself matters. Grok tools return a cited answer, not a result list; `depth=deep` (4 agents) or `depth=max` (16 agents, about $2-3 a call) is for broad research questions that combine Web and X, never for single facts. DeepSeek (`deepseek_search`, `deepseek_fetch`) enforces a 128-character query cap; Vercel AI Gateway exposes hosted DeepSeek tools plus `vercel_parallel_fast` ($0 promo through 2027-01-31). Jina is search-only and defaults to no-content snippets for low latency; Querit supports `querit_contents` plus `code`/`finance` verticals; TinyFish Search supports `domainType` (web/news/research_paper) and TinyFish Fetch has a free daily tier independent of a `$0` wallet. `exa_agent_run` is a long, billed multi-step research job: only when the user asks for one.
- Doubao only when the user explicitly asks or approves its quota, never as a fallback.

## Evidence

Search results discover sources; they do not prove snippet claims. Read the page behind any important or time-sensitive claim, keep citations next to the claims they support, and prefer primary sources.

Report which provider answered only when asked, or when a fallback or limitation changes how the result should be read. Take the values from the returned route block, never infer them. Before saying a code or config string "originates from" a project, check repository identity and any fork or rename; if ancestry is unresolved, say the origin is uncertain.

## Keys and side effects

Do not request, print, or inspect keys. Benched keys recover on their own; an exhausted key (out of credit) waits behind healthy ones until a call or a quota reading shows credit again. "paid tier required" means no key in that pool may run the tool: use another provider rather than retrying. Run `search_rotation_probe` only on explicit request because it spends quota. Do not call tools that create, update, delete, start jobs, interact with pages, or submit feedback unless the user asked for that effect, and respect approval prompts.

Read `references/provider-routing.md` when the exact provider order, fallback behavior, how to read a result, or a provider's trade-offs matters.
