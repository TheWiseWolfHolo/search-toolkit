---
name: search-toolkit
description: Retrieve current web sources through available Search Toolkit MCP or CLI tools. Use for general web lookup and source extraction; dedicated official API documentation routes and user-selected tools take precedence. Doubao requires explicit authorization.
---

# Search Toolkit

Pick by capability fit and retrieval quality; respect known quota and cost limits, and avoid needless latency, oversized responses, and implicit research or crawling.

## Workflow

1. Search once, about 5-8 results.
2. Judge titles, URLs, dates, snippets, and whether the sources are independent.
3. Read only the pages the answer needs. Use `fetch_auto` for a URL you already have; never search for it.
4. Escalate to deep research only for multi-step synthesis, gap analysis, or exhaustive comparison, and to browser automation only when the task needs interaction.

## Interface

Prefer the native MCP tools: `search_auto` (web), `search_images`, `fetch_auto`, and `search_pool_status`, plus provider tools such as `brave_llm_context` or `firecrawl_crawl` when their specific capability is needed. A `lean` server lists only the unified tools and a gateway: `provider_tools` lists provider tools or returns one's schema, and `provider_call` runs it.

Without MCP, use the `search-toolkit` CLI on the same backend: `search-toolkit search "<query>" [--mode ...] [--quality max] [--cross]`, `search-toolkit fetch <url>`, `search-toolkit call <tool> '<json>'`. If neither interface exists or has the capability, say so and use an available same-capability route; a permission denial is not unavailability. Never open the provider config, pass raw keys, invent tools, or imply a different provider was used.

## Routing rules

- Start with `search_auto`. Use `quality: max` when the question is broad, ambiguous, multi-aspect, or high-value; `mode: exact` for exact strings and code, `current` (with `freshness`) for news, `context` for grounding chunks within a token budget, `official` for official sites.
- A claim that matters needs an independent second path: `crossCheck: true`, or Brave. Reposts of one report count as one source.
- `search_auto` stops at the first provider that answers, so it will not give you a second opinion unless you ask for `crossCheck`.
- Code that is local or was just pushed: use `rg` or `gh search code`; web indexes lag.
- `search_images` is text-to-image only: no uploads, no reverse search.
- Crawl, map, and structured extraction belong to Firecrawl or Tavily, and long sourced research to LinkUp, only when the task needs more than lookup.
- AnySearch is manual; call `get_sub_domains` before any vertical search. Grok X Search only when X itself matters. Jina and TinyFish are search-only.
- Doubao only when the user explicitly asks or approves its quota, never as a fallback.

## Evidence

Search results discover sources; they do not prove snippet claims. Read the page behind any important or time-sensitive claim, keep citations next to the claims they support, and prefer primary sources.

Report which provider answered only when asked, or when a fallback or limitation changes how the result should be read. Take the values from the returned route block, never infer them. Before saying a code or config string "originates from" a project, check repository identity and any fork or rename; if ancestry is unresolved, say the origin is uncertain.

## Keys and side effects

Do not request, print, or inspect keys. Benched keys recover on their own. Run `search_rotation_probe` only on explicit request because it spends quota. Do not call tools that create, update, delete, start jobs, interact with pages, or submit feedback unless the user asked for that effect, and respect approval prompts.

Read `references/provider-routing.md` when the exact provider order, fallback behavior, how to read a result, or a provider's trade-offs matters.
