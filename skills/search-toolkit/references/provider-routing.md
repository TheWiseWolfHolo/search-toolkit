# Web retrieval routing policy

Choose providers by capability and task intent. Prefer strong retrieval that fits the task; request price is secondary because configured quotas are ample. Still avoid unnecessary latency, oversized context, and implicit research or crawling.

## Core rules

1. Start ordinary lookup with `search_auto` in balanced general mode. Use max quality for broad, ambiguous, multi-aspect, or high-value retrieval.
2. Do not send the same query to every provider. Use a second independent path (`crossCheck`) only when the claim matters or the first result set is weak.
3. Escalate in this order: compact search → inspect → fetch selected URLs → deep research → browser/agent automation.
4. If a URL is known, `fetch_auto` it instead of searching for it again.
5. Request about 5-8 results for routine lookup. Prefer snippets and highlights over unrestricted full bodies.
6. Inspect the live tool inventory. Official MCP catalogs change, and tools may be hidden by a provider's tool policy or by the `lean` profile.
7. Keep raw keys out of prompts, results, logs, and tool arguments.

## Which providers automatic routing may use

A provider is eligible for `search_auto`, `search_images`, or `fetch_auto` only when its config lists the matching capability in `auto` (`search`, `images`, `fetch`). A provider with an empty `auto` list, such as Doubao, LinkUp, AnySearch, Grok, Jina, and TinyFish in the reference setup, is reachable only by calling its tools directly.

## Automatic routing

Balanced search routing uses these profiles. Each is an ordered candidate list; the first eligible provider answers, and one more is tried after an availability failure.

- General: Parallel Fast → You snippets → Brave Web → Exa Search → Querit → Tavily Basic.
- Exact: Exa Search → Serper → Tavily exact/basic → Brave Web.
- Context: Brave LLM Context 4096 → Parallel Basic → You highlights → Tavily Basic.
- Current: Brave News → Serper News → You snippets → Tavily Search. `freshness` (default `week`) maps to Brave `pw`, Serper `qdr:w`, You.com `week`, Tavily `week`; callers can select day, month, or year. The live Tavily MCP schema fixes `topic` to general, so do not send `topic: news`.
- Official navigation: Serper → Brave Web → Exa Search → You snippets.

Max quality uses Parallel Advanced for General and Context, Exa Advanced for Exact and Official, You.com highlights in General, and Tavily Advanced wherever Tavily appears. Max never turns ordinary lookup into Research, Crawl, full-page extraction, or an agentic task.

An availability failure that allows a second provider is: HTTP 401/402, an authentication/plan/permission 403 that is not a policy or safety block, network failure, timeout, HTTP 408/425/429, provider 5xx, or a clear statusless message such as a rate limit, temporary unavailability, or no healthy key slots. Request or schema errors, policy or safety blocks, local code errors, and unknown failures end the chain. An explicit HTTP status outranks error-body keyword guesses. An upstream tool's own error (for example a scraped page answering 403) is the tool's verdict and is returned, not retried.

### Cross-checking

`crossCheck: true` runs the first two eligible REST-backed providers of the mode's candidate list concurrently, de-duplicates by canonical URL (scheme, `www`, fragments, trailing slashes, and tracking parameters ignored), and returns corroborated URLs first, then the rest interleaved by rank. Each result lists which providers found it. If one provider fails, the other's results are returned and `searchToolkitAuto.crossCheck.failed` names the failure. It is ignored in context mode, whose results are chunks rather than items, and falls back to a normal search when fewer than two REST providers are eligible.

### Known-URL fetch

`fetch_auto` chain: Exa Fetch → Tavily Extract → Firecrawl Scrape → LinkUp Fetch → AnySearch Extract, subject to which providers list `fetch` in `auto`. With `quality: max` Firecrawl leads (JavaScript rendering), Tavily uses advanced extraction, and LinkUp renders JavaScript. A reader that answers with fewer than 80 characters is treated as empty and the next is tried, up to three providers; if none is substantial the fullest answer is returned. `maxChars` (default 12000) caps the text, with a marker stating how much was dropped.

### Image discovery

`search_images` prefers Brave's independent image index and falls back to Serper's Google Images results only after an availability failure. Country hints are ignored so a narrow regional request cannot displace the stronger primary index; use `brave_image_search` or `serper_images` directly when country targeting or the index itself is the requirement. Tavily images remain available through direct Tavily Search but are not part of the automatic chain because their shape is not a normalized image result. Preserve original image URLs separately from source-page URLs and thumbnails.

None of these tools performs reverse image search. An uploaded image can reach a reverse-image provider only if the client exposes an attachment URL or passes supported image bytes to a tool. Captioning the upload and then running text-to-image search is a useful fallback, but it must not be described as visual matching or source tracing.

## Provider roles

### Querit — balanced compact retrieval

Compact factual lookup and source discovery. It stays in the general automatic pool and for direct calls but is not the unconditional first hop.

### Exa — precision and long-tail discovery

Exact error messages, identifiers, configuration keys, code strings, obscure repositories, implementation examples, semantic discovery, specialist people, companies and papers. Prefer bounded highlights or context. Use advanced search only for filters, categories, dates, domains, or deeper structured retrieval. Exa Fetch reads pages Exa discovered.

### Brave — independent grounding

Brave Web for structured independent-index results, Brave News for current or breaking news. Prefer Brave when a consequential claim needs a second retrieval perspective.

Brave LLM Context returns pre-extracted text, tables, code, or discussion chunks from several results without a separate fetch. It is controlled by URL, token, per-URL, snippet, freshness, threshold, Goggles, and optional local-recall parameters. Direct calls and `search_auto` requests routed to Brave send 4096 tokens by default; raise `maximumNumberOfTokens` only when the task justifies it. Parallel and You.com fallbacks use their own controls, so that parameter does not apply to them. It returns grounding per source, not a generated answer. Keep URL discovery on Brave Web, known-URL reading on a fetch tool, and multi-step synthesis on Tavily or LinkUp research.

### You.com — unified Web and News with query-aware highlights

Use when one query should return both Web and News sections, or when query-aware highlights can replace a fetch pass. Keep `contentLevel: snippets` for ordinary discovery; choose `highlights` explicitly for citation chunks or RAG-style grounding, since extraction adds latency and provider charges. The adapter deliberately has no full-page mode.

### Parallel — semantic objectives and dense excerpts

For broad or ambiguous goals where the agent can state what evidence it wants. Supply a self-contained objective in `query` and preferably 1-3 short `searchQueries`; Parallel ranks URLs and returns compressed excerpts for model context. `fast` suits most interactive retrieval, `basic` returns extended excerpts, `advanced` targets complex multi-hop work, and `turbo` minimises latency for English or Japanese only. Turbo and fast share the lower price tier, basic and advanced the higher one. Parallel documents broad multilingual coverage only for basic and advanced, although `fast` returned useful Chinese results in a live check. Leave `advanced_settings` unset unless freshness, domains, location, result count, or excerpt size is genuinely constrained, because restrictive settings may reduce quality.

### Serper — concise Google-style SERP

Locate official sites, known pages, or a small ranked result set. It is not a page reader, crawler, research engine, or browser.

### Tavily — managed web workflow

When the task extends from search into extraction, mapping, crawling, or multi-source research. Do not use Tavily Research for a lookup that ordinary search can answer.

### LinkUp — sourced synthesis and research

Sourced synthesized answers, sequential retrieval, structured research, and long-running tasks. Prefer raw results for downstream synthesis when possible; deep modes are slower and more expensive.

### AnySearch — manual multi-interface retrieval

Use manually when one request benefits from parallel batches, source-directory discovery, vertical routing, or its paired URL extraction. Before any vertical search call `get_sub_domains` and pass only the returned sub-domain and parameter fields; inspect the results rather than assuming vertical routing worked. Use its Extract as a convenient reader, not as a replacement for Firecrawl on difficult pages.

Observations from live checks in August 2026, which may have changed: strong English official-document discovery, detailed `security.vuln` output, useful structured finance quotes, accurate React results from `code.doc`, and `batch_search` isolating a malformed item without losing its siblings; noisy Chinese general results, irrelevant `academic.search` ranking, and a slow repository-constrained `code.snippet` query that ignored the intended repository. The free plan then advertised 1,000 requests per day and 20 QPS per key. Treat privacy conservatively: the provider's terms allow service logs with truncated query content.

### Firecrawl — web data acquisition

Known-page scrape, clean Markdown/HTML, screenshots or structured JSON, site crawl and map, difficult JavaScript pages, extraction. Ordinary search normally stays with a retrieval provider.

The default tool policy exposes scrape, map, search, crawl, crawl status, developer search, and GitHub research search. Monitor, feedback, interaction, agent, and other management tools are hidden; use Scrape JSON for structured extraction. `allow: ["*"]` exposes the full catalog, but write and destructive annotations and approval prompts still apply. Note that firecrawl-mcp 3.27 no longer ships `firecrawl_research_search_github`, so the pinned version matters.

### Jina and TinyFish — search-only in this server

Use only when their compact search perspective is useful. Jina Reader and TinyFish Agent/Browser are real provider capabilities elsewhere but are not exposed here and must not be invented.

### Doubao — Chinese-local, quota-sensitive

Only when the user explicitly requests it or approves consuming its limited quota. Never selected automatically or as a silent fallback.

### Grok / xAI — X-native retrieval

When X posts, users, threads, reactions, or X-native breaking signals are central. Corroborate important claims with normal web providers. Do not use it as generic search when X is irrelevant. The configured `systemPrompt` is sent as the request's instructions.

## Key health

Keys are tracked by fingerprint, so reordering a pool does not move their history. Authentication failures bench a key for 1 hour, then 6, then 24; quota failures for 30 minutes, then 6 hours, then 24; rate limits for 1, 5, then 15 minutes, or for the provider's `Retry-After`. A success clears the strikes. Server errors and a tool's own errors never bench a key. When every key in a pool is benched the call fails with the time until the first recovers.

## Profiles and context cost

The `full` profile exposes every provider tool; descriptions are trimmed to a configurable length (default 700 characters, 220 per parameter) while input schemas stay intact, and `toolPolicy.descriptions` replaces a tool's text outright. The `lean` profile exposes only the unified tools and `provider_tools`/`provider_call`, which cuts the tool list by more than 90%; use it for clients that load every tool schema into every conversation.

## Research and verification

Normal web questions need ordinary search, not deep research. Escalate to Tavily Research or LinkUp Research only for several searches, lead-following, broad comparison, substantial reports, or demonstrated retrieval gaps.

For disputed or consequential claims, prefer authoritative primary sources, useful domain and date constraints, and a provider backed by a different retrieval path. Brave is the preferred independent-index cross-check.

For local repositories and newly written or freshly pushed code, use `rg` or `gh search code` before web search. Exa and Firecrawl Developer are useful after code has been indexed, but no web provider should be expected to find a commit immediately.
