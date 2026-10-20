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

## Reading a result

Every result starts with a compact JSON block, `{"searchToolkitRoute": {"provider", "tool"}, "searchToolkitAuto": {"mode", "quality"}}`, followed by readable text: numbered results with the provider's publication date in parentheses when it reports one. When a fallback happened, `searchToolkitAuto.attempts` lists each try as `tool:outcome`, for example `["parallel_search:429", "you_search:success"]`; a first-try success omits it. The upstream tool name, candidate rank, and full attempt records are in `structuredContent` and `_meta`.

`search_auto` stops at the first provider that answers and tries one more only after an availability failure. `fetch_auto` also moves on when a reader returns almost no text, up to three providers. Nothing is merged unless `crossCheck` is set.

## CLI

```text
search-toolkit search "<query>" [--mode general|exact|current|official|context] [--quality max] [--limit 6] [--freshness week] [--domains a.com,b.com] [--exclude-domains x.com] [--max-chars 700] [--cross]
search-toolkit fetch <url...> [--quality max] [--max-chars 12000] [--offset 0] [--section "Heading"]
search-toolkit tools [--profile full|curated|lean] [--json]
search-toolkit call <tool> '<json-arguments>' [--json]
search-toolkit status [--verbose]
```

Output is the same text a model receives over MCP: a route line, then the results. `--json` prints the full structured result. `reset` and `migrate-config` are operator commands, not for agents.

## Code and configuration origin

Before saying a string "originates from" a project (出自), inspect the matched file, repository name, commit date, and any fork or rename relationship visible in the source. If several repositories contain the string and ancestry is unresolved, cite the candidates and say the origin is uncertain rather than promoting the first hit.

## Which providers automatic routing may use

A provider is eligible for `search_auto`, `search_images`, or `fetch_auto` only when its config lists the matching capability in `auto` (`search`, `images`, `fetch`). Providers with currently usable key slots are ordered ahead of providers whose entire key pool is in cooldown. A provider with an empty `auto` list, such as Doubao, LinkUp, AnySearch, Grok, Jina, and TinyFish in the reference setup, is reachable only by calling its tools directly.

## Automatic routing

Balanced search routing uses these profiles. Each is an ordered candidate list; the first eligible provider answers, and up to two more are tried after availability failures. `includeDomains`, `excludeDomains`, `freshness`, and `maxCharsPerResult` are mapped to each candidate's native parameters (or automatic `site:` / `-site:` query operators for Brave and Serper).

- General: Parallel Fast → You snippets → Brave Web → Exa Search → Querit → Tavily Basic.
- Exact: Exa Search → Serper → Tavily exact/basic → Brave Web.
- Context: Brave LLM Context 4096 → Parallel Basic → You highlights → Tavily Basic.
- Current: Brave News → Serper News → You snippets → Tavily Search. `freshness` (default `week` in current mode, optional in all other modes) maps to Brave `pd/pw/pm/py`, Serper `qdr:d/w/m/y`, You.com `day/week/month/year`, Querit `d/w/m/y`, and Tavily `day/week/month/year`. The live Tavily MCP schema fixes `topic` to general, so do not send `topic: news`.
- Official navigation: Serper → Brave Web → Exa Search → You snippets.

Max quality uses Parallel Advanced for General and Context, Exa Advanced for Exact and Official, You.com highlights in General, and Tavily Advanced wherever Tavily appears. Max never turns ordinary lookup into Research, Crawl, full-page extraction, or an agentic task.

An availability failure that allows a second provider is: HTTP 401/402, an authentication/plan/permission 403 that is not a policy or safety block, network failure, timeout, HTTP 408/425/429, provider 5xx, or a clear statusless message such as a rate limit, temporary unavailability, or no healthy key slots. Request or schema errors, policy or safety blocks, local code errors, and unknown failures end the chain. An explicit HTTP status outranks error-body keyword guesses. An upstream tool's own error is the tool's verdict and is returned to a direct caller. Inside `fetch_auto`, a reader that could not get the page (the site answered 403, 429, or 5xx, or showed a block or captcha) hands over to the next reader; a missing page (404/410) or a malformed request ends the chain.

### Cross-checking

`crossCheck: true` runs the first two eligible search providers of the mode's candidate list concurrently (across both REST adapters and normalized MCP upstreams such as Exa and Tavily), de-duplicates by canonical URL (scheme, `www`, fragments, trailing slashes, `.md`/`.html` doc suffixes, and tracking parameters ignored), and returns corroborated URLs first, then the rest interleaved by rank. Each result lists which providers found it. If one provider fails, the other's results are returned and `searchToolkitAuto.crossCheck.failed` names the failure. If both fail, the ordinary chain continues with the remaining candidates and does not call the failed two again. It is ignored in context mode, whose results are chunks rather than items.

### Known-URL fetch

`fetch_auto` chain: Exa Fetch → Tavily Extract → Parallel Extract → You.com Contents → Firecrawl Scrape → LinkUp Fetch → AnySearch Extract, subject to which providers list `fetch` in `auto`. Pass `url` for a single page or `urls` for up to 5 pages fetched concurrently. With `quality: max` Firecrawl leads (JavaScript rendering), Tavily uses advanced extraction, Parallel Extract returns full page content, and LinkUp renders JavaScript. A reader that answers with fewer than 80 characters or returns an anti-bot/Cloudflare challenge shell is treated as unusable and the next is tried, up to three providers; if none is substantial the fullest answer is returned. `maxChars` (default 12000) caps the text, `offset` continues from a character offset, and `section` extracts a specific Markdown heading section.

### Image discovery

`search_images` prefers Brave's independent image index, then Parallel Image Search, and falls back to Serper's Google Images results only after an availability failure. Country hints are ignored so a narrow regional request cannot displace the stronger primary index; use `brave_image_search`, `parallel_image_search`, or `serper_images` directly when country targeting or the index itself is the requirement. Tavily images remain available through direct Tavily Search but are not part of the automatic chain because their shape is not a normalized image result. Preserve original image URLs separately from source-page URLs and thumbnails.

None of these tools performs reverse image search. An uploaded image can reach a reverse-image provider only if the client exposes an attachment URL or passes supported image bytes to a tool. Captioning the upload and then running text-to-image search is a useful fallback, but it must not be described as visual matching or source tracing.

## Provider roles

### Querit — balanced compact retrieval

Compact factual lookup and source discovery. It stays in the general automatic pool and for direct calls but is not the unconditional first hop.

### Exa — precision and long-tail discovery

Exact error messages, identifiers, configuration keys, code strings, obscure repositories, implementation examples, semantic discovery, specialist people, companies and papers. Prefer bounded highlights or context. Use advanced search only for filters, dates, domains, or deeper structured retrieval. Exa Fetch reads pages Exa discovered.

### Brave — independent grounding

Brave Web for structured independent-index results, Brave News for current or breaking news (`extraSnippets: true` returns up to 5 extra excerpts per result; `goggles` applies custom ranking; `offset` paginates). Prefer Brave when a consequential claim needs a second retrieval perspective.

Brave LLM Context returns pre-extracted text, tables, code, or discussion chunks from several results without a separate fetch. It is controlled by URL, token, per-URL, snippet, freshness, threshold, Goggles, and optional local-recall parameters. Direct calls and `search_auto` requests routed to Brave send 4096 tokens by default; raise `maximumNumberOfTokens` only when the task justifies it. Parallel and You.com fallbacks use their own controls, so that parameter does not apply to them. It returns grounding per source, not a generated answer. Keep URL discovery on Brave Web, known-URL reading on a fetch tool, and multi-step synthesis on Tavily or LinkUp research.

### You.com — unified Web, News, live knowledge cards, and URL extraction

Use `you_search` when one query should return both Web and News sections, when `knowledge: true` can attach live licensed data cards (stock/crypto quotes, weather, sports scores, economic indicators) at zero extra cost, or when query-aware highlights (`contentLevel: highlights`, `highlightsMaxTokens`) or full-page Markdown (`contentLevel: full_page`) can replace a separate fetch pass. Keep `contentLevel: snippets` for ordinary discovery; pass `strictOperators: true` when boolean/filetype/site operators must be strictly enforced. Use `you_contents` to extract clean Markdown, HTML, or metadata from 1 to 10 known URLs directly.

### Parallel — semantic objectives, batch URL extraction, and semantic image search

For broad or ambiguous goals where the agent can state what evidence it wants. Supply a self-contained objective in `query` and preferably 1-3 short `searchQueries`; Parallel ranks URLs and returns compressed excerpts for model context (`afterDate` filters by publication date `YYYY-MM-DD`). `fast` suits most interactive retrieval, `basic` returns extended excerpts, `advanced` targets complex multi-hop work, and `turbo` minimises latency for English or Japanese only. Turbo and fast share the lower price tier, basic and advanced the higher one. Leave `advanced_settings` unset unless freshness, domains, location, result count, or excerpt size is genuinely constrained, because restrictive settings may reduce quality.

Use `parallel_extract` to extract query-focused excerpts or full Markdown content from 1 to 20 URLs with an optional `objective` and `searchQueries`. Use `parallel_image_search` (`fast` or `advanced`) for natural-language image discovery with image dimensions and source page metadata.

### Serper — concise Google-style SERP and Google Scholar

Locate official sites, known pages, or a small ranked result set (`serper_search`, `serper_news`, `serper_images`), or search academic papers with publication info, year, and citation counts via `serper_scholar`. It is not a page reader, crawler, research engine, or browser.

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

### Grok / xAI — X-native and multimodal retrieval

When X posts, users, threads, reactions, or X-native breaking signals are central (`grok_x_search`, `grok_web_x_search`). Supports `enableImageUnderstanding` (Web & X), `enableVideoUnderstanding` (X), and `userLocationCountry` (Web). Corroborate important claims with normal web providers. Do not use it as generic search when X is irrelevant. The configured `systemPrompt` is sent as the request's instructions.

## Key health

Keys are tracked by fingerprint, so reordering a pool does not move their history. Authentication failures bench a key for 1 hour, then 6, then 24; quota failures for 30 minutes, then 6 hours, then 24; rate limits for 1, 5, then 15 minutes, or for the provider's `Retry-After`. A success clears the strikes. Server errors, a tool's own errors, and a target page's status never bench a key. A key fault (401/402/403/429) tries up to 3 healthy keys in the pool; a 5xx or dropped connection tries one more key; timeouts, page failures, and request errors are not retried on another key, so an automatic route reaches the next provider quickly. `search_pool_status` with `verbose: true` shows each key's last error and when it happened. When every key in a pool is benched the call fails with the time until the first recovers.

## Profiles and context cost

The `full` profile exposes every provider tool; descriptions are trimmed to a configurable length (default 700 characters, 220 per parameter) while input schemas stay intact, and `toolPolicy.descriptions` replaces a tool's text outright. The `curated` profile keeps the unified tools, the `provider_tools`/`provider_call` gateway, and specialist tools (`exa_web_search_advanced_exa`, `brave_llm_context`, `parallel_extract`, `you_contents`, `serper_scholar`, `firecrawl_*`, `tavily_tavily_research`, `linkup_linkup_research`, `grok_*`, `doubao_search`, `anysearch_batch_search`) while hiding redundant basic search tools. The `lean` profile exposes only the unified tools and `provider_tools`/`provider_call`, which cuts the tool list by more than 80%; use it for clients that load every tool schema into every conversation.

## Research and verification

Normal web questions need ordinary search, not deep research. Escalate to Tavily Research or LinkUp Research only for several searches, lead-following, broad comparison, substantial reports, or demonstrated retrieval gaps.

For disputed or consequential claims, prefer authoritative primary sources, useful domain and date constraints, and a provider backed by a different retrieval path. Brave is the preferred independent-index cross-check.

For local repositories and newly written or freshly pushed code, use `rg` or `gh search code` before web search. Exa and Firecrawl Developer are useful after code has been indexed, but no web provider should be expected to find a commit immediately.
