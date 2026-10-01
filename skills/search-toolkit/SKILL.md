---
name: search-toolkit
description: Retrieve current web sources through available Search Toolkit MCP or CLI tools. Use for general web lookup and source extraction; dedicated official API documentation routes and user-selected tools take precedence. Doubao requires explicit authorization.
---

# Search Toolkit

Choose by capability fit and retrieval quality first. Respect known quota and cost constraints; avoid unnecessary latency, oversized responses, and implicit research or crawling. Escalate from search to selected-page fetch, then to research or automation only when the simpler step is insufficient.

## Retrieval workflow

1. Search once with roughly 5-8 compact results.
2. Inspect titles, URLs, dates, snippets, and source independence.
3. Fetch only the selected pages needed for the answer. Never search for a URL you already have; use `fetch_auto`.
4. Use deep research only for multi-step synthesis, gap analysis, or exhaustive comparison.
5. Use browser/agent automation only when information requires interaction.

## Interface selection

Prefer the native Search Toolkit MCP tools when they are in the live inventory: `search_auto`, `search_images`, `fetch_auto`, `search_pool_status`, and the provider tools (`brave_*`, `exa_*`, `firecrawl_*`, ...). A server running the `lean` profile lists only the unified tools plus a gateway: list provider tools with `provider_tools`, read one's schema with `provider_tools {name}`, and run it with `provider_call {name, arguments}`.

If the Skill is present but the MCP functions were not injected, use an installed `search-toolkit` CLI against the same backend:

```text
search-toolkit search "<query>" [--mode general|exact|current|official|context] [--quality max] [--limit 6] [--cross]
search-toolkit fetch <url> [--quality max] [--max-chars 12000]
search-toolkit tools            # names only; --json for schemas
search-toolkit call <tool> '<json-arguments>'
```

CLI output is the same text a model receives from MCP: a route line, then the results. If both interfaces are unavailable or lack the required capability, report the limitation and use an available same-capability official or web retrieval route. A permission denial is not an availability failure. Do not open the Provider config or pass raw keys on the command line. Never invent tools or silently claim a different provider was used.

## Capability routing

| Need | Use |
| --- | --- |
| General lookup | `search_auto` (balanced). `quality: max` for broad, ambiguous, multi-aspect, or high-value retrieval. |
| Exact strings, code, obscure sources | `search_auto` with `mode: exact` (Exa first). `quality: max` or `exa_web_search_advanced_exa` when domain, date, category, or highlight controls matter. For local or just-pushed code use `rg` or `gh search code` first; web indexes lag. |
| Current news, fast-changing facts | `mode: current` with `freshness: day\|week\|month\|year` (default week). |
| Independent confirmation of a consequential claim | `crossCheck: true` on `search_auto`, or a separate path through Brave. Reposts of one report are not independent. |
| Pre-extracted grounding chunks within a token budget | `mode: context`, or `brave_llm_context` directly. 4096 tokens by default; set `maximumNumberOfTokens` for more. |
| Official-site or concise Google-style results | `mode: official`, or `serper_search`. |
| A known URL | `fetch_auto`. `quality: max` leads with Firecrawl for JavaScript-heavy pages; `maxChars` caps the returned text. |
| Images | `search_images`: text-to-image only, no uploads, no reverse search. Preserve the original image URL, thumbnail, dimensions, and source page. |
| Site crawl, map, structured extraction, difficult pages | Firecrawl (`firecrawl_*`) or Tavily crawl/map/extract, only when the task needs more than lookup. |
| Sourced synthesis, long research | LinkUp or Tavily research; avoid deep modes for routine questions. |
| X-native posts and social signals | Grok X Search; corroborate important claims on the wider web. |
| Several unrelated lookups at once, vertical sources | AnySearch, manual only; call `get_sub_domains` before any vertical search. |
| Chinese-local retrieval | Doubao only when the user explicitly asks or approves its quota. Never automatic. |

Jina and TinyFish expose search only; do not invent Reader, Agent, or Browser tools. Read `references/provider-routing.md` when exact provider order, fallback behavior, or a provider's trade-offs matter.

## Reading results

Every result starts with a JSON block, `{"searchToolkitRoute": {...}, "searchToolkitAuto": {...}}`, followed by readable text: numbered results with the provider's publication date in parentheses when it reports one. `searchToolkitAuto` lists which providers were tried and how each attempt ended.

`search_auto` stops at the first provider that answers; after an availability failure (credentials, balance, rate limit, timeout, 5xx) it tries one more. `fetch_auto` also moves on when a reader returns almost no text, and tries up to three. Request-shape errors, policy blocks, and unknown failures are returned as-is. Nothing is merged unless `crossCheck` is set, which queries two independent indexes and merges by URL, listing which providers found each result.

## Evidence discipline

Search results discover sources; they do not automatically prove every snippet claim. For important or time-sensitive claims, read the most relevant page before answering. Keep citations adjacent to the claims they support. Prefer primary sources, and cross-check consequential or disputed claims through an independent retrieval path.

Report provider routing only when requested or when a fallback or limitation materially affects interpretation. Copy the values from the returned route block, preferring `structuredContent.route` when the client exposes it; never infer or fabricate a route.

For exact code or configuration-string origin questions, verify repository identity before saying "出自" or "originates from": inspect the matched file, repository name, commit date, and any fork or rename relationship. If several repositories contain the string and ancestry is unresolved, cite the candidates and say the origin is uncertain.

## Key pools and side effects

Search Toolkit rotates every configured key per provider. A key that returns authentication, quota, or rate-limit errors is benched and returns on its own; there is nothing to fix from the agent side. Do not request, print, or inspect raw keys. `search_pool_status` shows masked health and cool-downs. Run `search_rotation_probe` only when the user explicitly wants a live rotation test, because it consumes provider quota.

Respect annotations and approval prompts. Do not call tools that create, update, delete, start jobs, send notifications, interact with pages, or submit feedback unless the user asked for that side effect.

## Deep research boundary

Use the tools above directly for normal research. Use a separate deep-research orchestrator only when the user asks for multi-stage planning, gap analysis, or exhaustive cross-source synthesis.
