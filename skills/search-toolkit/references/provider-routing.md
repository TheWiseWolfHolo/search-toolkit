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

Every result starts with a compact JSON block, `{"searchToolkitRoute": {"provider", "tool"}, "searchToolkitAuto": {"mode", "quality"}}`, followed by readable text: numbered results with the provider's publication date in parentheses when it reports one. When a fallback happened, `searchToolkitAuto.attempts` lists each try as `tool:outcome`, for example `["parallel_search:429", "you_search:success"]`; a first-try success omits it. `"cached":"4m"` means the unified tool reused a successful answer from the last few minutes (15 for search, 5 for `mode: current`, 30 for fetch) instead of calling a provider; for news that must be newer than that, say so or narrow the query. The upstream tool name, candidate rank, and full attempt records are in `_meta.searchToolkit`; the readable text is the result.

`search_auto` stops at the first provider that answers and tries one more only after an availability failure. `fetch_auto` also moves on when a reader returns almost no text, up to three providers. Nothing is merged unless `crossCheck` is set.

## CLI

```text
search-toolkit search "<query>" [--mode general|exact|current|official|scholar|code|context] [--quality max] [--limit 6] [--freshness week] [--domains a.com,b.com] [--exclude-domains x.com] [--max-chars 700] [--max-tokens 4096] [--cross]
search-toolkit images "<query | image-url>" [--limit 10] [--language code] [--safesearch strict|off]
search-toolkit fetch <url...> [--quality max] [--max-chars 12000] [--offset 0] [--section "Heading"]
search-toolkit tools [--profile full|curated|lean] [--json]
search-toolkit call <tool> '<json-arguments>' [--json]
search-toolkit status [--verbose]
```

Output is the same text a model receives over MCP: a route line, then the results. `--json` prints the full structured result. `reset`, `quota`, and `migrate-config` are operator commands, not for agents.

## Code and configuration origin

Before saying a string "originates from" a project (出自), inspect the matched file, repository name, commit date, and any fork or rename relationship visible in the source. If several repositories contain the string and ancestry is unresolved, cite the candidates and say the origin is uncertain rather than promoting the first hit.

## Which providers automatic routing may use

A provider is eligible for `search_auto`, `search_images`, or `fetch_auto` only when its config lists the matching capability in `auto` (`search`, `images`, `fetch`). Within a candidate list, healthy providers come first, then any provider whose automatic calls just failed twice in a row (`recentFailure` in `search_pool_status`, isolated per capability so fetch failures never demote search; one success or a quiet half hour restores it), then providers left with only exhausted keys (out of credit; tried as a last resort), then providers whose entire key pool is in cooldown. Key rules count here: a provider none of whose keys may run the candidate tool (`paidTools`, per-key `allowTools`/`denyTools`) is skipped before any request. A provider with an empty `auto` list, such as Doubao, AnySearch, Grok, and Querit in the reference setup, is reachable only by calling its tools directly; LinkUp, TinyFish, and opt-in keyless `direct_markdown` participate in `fetch_auto` only when enabled with `auto: ["fetch"]`.

## Automatic routing

Balanced search routing uses these profiles. Each is an ordered candidate list; the first eligible provider answers, and up to two more are tried after availability failures. `includeDomains`, `excludeDomains`, `freshness`, and `maxCharsPerResult` are mapped to each candidate's native parameters (or automatic `site:` / `-site:` / `after:` query operators for Brave, Serper, Exa Search, and DeepSeek). Exa, Parallel, and `site:` providers preserve path prefixes (such as `github.com/modelcontextprotocol`); You.com, Octen, Tavily, and Querit take hostnames. Long operator queries automatically skip providers with tighter limits (DeepSeek 128 code points, Serper 32 words, Brave Web/LLM 600 chars / 75 words, Brave News 400 chars / 50 words). Serper caps `num` at 10 when `limit <= 10` to stay in its 1-credit tier. The baseline orders come from a 461-call comparison on 42 real English and Chinese queries (`npm run eval:search`, summarized in `docs/search-eval-2026-10.md`).

A query with at least two Han characters and no kana or Hangul counts as Chinese. Chinese queries send Brave `searchLang: zh-hans, country: CN`, Serper `gl: cn, hl: zh-cn`, and You.com `language: zh-hans, country: CN`, and lead with Brave and Serper (followed by DeepSeek / Vercel DeepSeek when enabled), because Parallel and You.com mixed English pages into Chinese results.

- General: Parallel Fast → Serper → Exa Lite → You snippets → Octen → Brave Web → Tavily Basic → DeepSeek → Vercel DeepSeek → Vercel Parallel Fast. Chinese: Brave → Serper → DeepSeek → Vercel DeepSeek → You → Parallel → Vercel Parallel Fast → Tavily.
- Exact (quoted strings, error messages): Parallel → Brave Web → Serper → You → Tavily exact → DeepSeek → Vercel DeepSeek. Chinese: Brave → Serper → DeepSeek → Vercel DeepSeek → You → Parallel. Exa ranks semantically and was weakest here.
- Official (vendor, product, or government sites): Exa Lite → Brave Web → Serper → You → DeepSeek → Vercel DeepSeek → Vercel Parallel Fast. Chinese: Exa → Serper → DeepSeek → Vercel DeepSeek → Parallel → Brave. Exa returned the highest share of official pages in both languages.
- Current (news): You.com (`freshness`, `preferNews: true`) → Exa Lite news filtered by publish date → Octen with `freshness` → Serper News → Brave News → Tavily news topic → DeepSeek → Vercel DeepSeek. Chinese queries start with Exa news, which led Chinese news, then You.com, all with Chinese-market settings. `freshness` (default `week` in current mode, optional in all other modes) maps to Brave `pd/pw/pm/py`, Serper `qdr:d/w/m/y`, You.com, Octen, and Tavily `day/week/month/year`, Parallel `afterDate` (its `maxAgeSeconds` is cache staleness), DeepSeek `after:YYYY-MM-DD`, and Exa `startPublishedDate` (a time-bounded request always uses Exa's advanced tool, since basic Exa search has no date filter; `maxAgeHours` only controls cache staleness).
- Scholar (papers, preprints, reviews): Exa Lite (`category: publication`; max: Exa Search with a research-paper objective) → Parallel → You → Serper Scholar (ignores `freshness`/`tbs`) → Vercel Parallel Fast. Call `serper_scholar` directly when citation counts matter.
- Code (repositories, examples, API usage): Exa Lite (`includeDomains: ["github.com"]`; max: Exa Auto) → Parallel → Serper → DeepSeek → Vercel DeepSeek → Vercel Parallel Fast.
- Context: Brave LLM Context 4096 → Parallel Basic → You highlights → Tavily Basic → DeepSeek → Vercel DeepSeek.

Max quality is for multi-hop or high-stakes questions. English General max starts with Exa Advanced (`type: auto`, highlights), which led the Artificial Analysis Search Index for agentic research in October 2026, then Parallel Advanced; `context` max puts Parallel Advanced ahead of Brave LLM Context. Elsewhere max uses Parallel Advanced wherever Parallel appears, Exa Auto instead of Exa Lite, DeepSeek `needContent: true`, You.com highlights, Brave extra snippets, and Tavily Advanced. Max never turns ordinary lookup into Research, Crawl, full-page extraction, or an agentic task.

An availability failure that allows a second provider is: an exhausted key pool (402, Tavily 432/433, or out-of-credit wording such as Octen's 403 "Insufficient balance", You.com's `spend_cap_exceeded`, TinyFish `free_allowance_exhausted`, or Firecrawl `index_daily_limit`), a plan limit ("not allowed for free accounts", "Payment method required") when no paid key is left, HTTP 401, an authentication/plan/permission 403 that is not a policy or safety block, network failure, timeout, HTTP 408/425/429/434, provider 5xx, or a clear statusless message such as a rate limit, temporary unavailability, or no healthy key slots. Request or schema errors, policy or safety blocks, local code errors, and unknown failures end the chain. An explicit HTTP status outranks error-body keyword guesses. An upstream tool's own error is the tool's verdict and is returned to a direct caller. Inside `fetch_auto`, a reader that could not get the page (the site answered 403, 429, or 5xx, showed a block or captcha, returned non-Markdown to `direct_markdown_fetch`, or a reader code such as Exa `CRAWL_HTTP_403`, `CRAWL_EMPTY_CONTENT`, Firecrawl `unsupported_site`, DeepSeek 403/404 extraction failure, or a Tavily answer with only `failed_results`) hands over to the next reader; a confirmed missing page (404/410) or a malformed request ends the chain.

### Cross-checking

`crossCheck: true` runs the first two eligible search providers of the mode's candidate list concurrently (across both REST adapters and normalized MCP upstreams such as Exa and Tavily), de-duplicates by canonical URL and release/mirror near-duplicate key (scheme, `www`, fragments, trailing slashes, `.md`/`.html` doc suffixes, tracking parameters, and `x.y.z` release numbers ignored), and returns corroborated URLs first, then the rest interleaved by rank. Each result lists which providers found it. If one provider fails, the other's results are returned and `searchToolkitAuto.crossCheck.failed` names the failure. If both fail, the ordinary chain continues with the remaining candidates and does not call the failed two again. It is ignored in context mode, whose results are chunks rather than items.

### Known-URL fetch

`fetch_auto` balanced chain: Direct Markdown (`direct_markdown_fetch`, opt-in zero-cost `Accept: text/markdown`) → Exa Fetch → DeepSeek Fetch → Vercel DeepSeek Fetch → Tavily Extract → Parallel Extract → TinyFish Fetch → You.com Extract → Octen Extract → Firecrawl Scrape → LinkUp Fetch → AnySearch Extract, subject to which providers list `fetch` in `auto`. With `quality: max` the order is Firecrawl → TinyFish → Tavily → Parallel → Exa → DeepSeek → Vercel DeepSeek → You.com → Octen (`mode: auto`) → LinkUp → AnySearch. Tavily and Firecrawl answers arrive as Markdown, not their JSON envelopes. Pass `url` for a single page or `urls` for up to 5 pages fetched concurrently. With `quality: max` Firecrawl leads (JavaScript rendering), Tavily uses advanced extraction, Parallel Extract returns full page content, and LinkUp renders JavaScript. A reader that answers with fewer than 80 characters or returns an anti-bot/Cloudflare/Vercel Security Checkpoint/SPA challenge shell is treated as unusable and the next is tried, up to three providers; if none is substantial the fullest answer is returned. `maxChars` (default 12000) caps the text, `offset` continues from a character offset, and `section` extracts a specific Markdown heading section (ignoring `#` comments inside fenced code blocks and empty sibling tab headings).

### Image discovery

With `query`, `search_images` prefers Brave's independent image index, then Serper's Google Images, then Parallel Image Search, moving on only after an availability failure. Country hints are ignored so a narrow regional request cannot displace the stronger primary index; use `brave_image_search`, `parallel_image_search`, or `serper_images` directly when country targeting or the index itself is the requirement. Tavily images remain available through direct Tavily Search but are not part of the automatic chain because their shape is not a normalized image result. Preserve original image URLs separately from source-page URLs and thumbnails.

With `imageUrl`, it runs a Google Lens reverse search (`serper_lens`, 3 Serper credits): pages that show the same or a visually similar picture, each with page link, publisher, image, and thumbnail. Use it to identify what a picture shows, find a larger or original copy, or trace where an image has been published. Lens gives no dates, so it cannot prove which copy came first; fetch the candidate pages and compare their dates when the origin matters.

The image must be reachable at a public http(s) URL. Some hosts, Wikimedia originals among them, do not serve Google's fetcher and return no matches; a resized or re-hosted copy usually works. A local file or a chat upload without a URL cannot be searched by image. Describing the picture and running a text search is a fallback, but say that it is a text search, not visual matching.

## Provider roles

### Querit — compact English retrieval and verticals, manual

Compact factual lookup in English (`querit_search`), with optional `vertical` (`code`, `finance`), `needContent`/`chunksPerDoc`, `timeRange`, and `querit_contents` (`/v1/contents`, 1-10 URLs). It left the automatic routes after the 2026-10 comparison: Chinese queries came back mostly in English, and exact-string lookups rarely surfaced the right source. Call `querit_search` directly (with `languages` when the language matters).

### Exa — semantic discovery, official sources, papers, and code

Semantic discovery, official and primary sources, papers, repositories and implementation examples, specialist people and companies. It ranks by meaning, so it is the weakest choice for exact error messages or quoted strings. Exa 3.0 (October 2026) added a Lite search type, which matched Auto on general, official, scholar, and code queries at about a third of the latency and $4 instead of $7 per 1,000 requests; balanced routes use `web_search_advanced_exa` with `type: lite`, max uses Auto. Lite rejects `contextMaxCharacters`. Use `category` (`news`, `publication`, `company`, `people`, …), `includeDomains` (supports path prefixes such as `github.com/org`), and `startPublishedDate` for scoped searches; `github` and `pdf` categories are deprecated. Exa Fetch reads pages Exa discovered.

### Brave — independent grounding

Brave Web for structured independent-index results (up to 600 chars / 75 words; sends `text_decorations=false` on Web only), Brave News for current or breaking news (up to 400 chars / 50 words; `extraSnippets: true` returns up to 5 extra excerpts per result; `goggles` supports both hosted URLs and inline Goggle DSL rules; `offset` paginates). Prefer Brave when a consequential claim needs a second retrieval perspective.

Brave LLM Context returns pre-extracted text, tables, code, or discussion chunks from several results without a separate fetch. It is controlled by URL, token, per-URL, freshness, threshold, Goggles, and optional local-recall parameters (snippet count parameters are legacy; prefer `maximumNumberOfTokens`, `maximumNumberOfTokensPerUrl`, and `maximumNumberOfUrls`). `search_auto` (`mode: context`) requests 4096 tokens by default (sending `country: CN` + `searchLang: zh-hans` for Chinese queries), while direct `brave_llm_context` calls default to 8192 tokens; raise `maximumNumberOfTokens` only when the task justifies it. Parallel and You.com fallbacks use their own controls, so that parameter does not apply to them. It returns grounding per source, not a generated answer. Keep URL discovery on Brave Web, known-URL reading on a fetch tool, and multi-step synthesis on Tavily or LinkUp research.

### You.com — unified Web, News, live knowledge cards, and URL extraction

Use `you_search` when one query should return both Web and News sections (pass `preferNews: true` to put news ahead of web), when `knowledge: true` can attach live licensed data cards (stock/crypto quotes, weather, sports scores, economic indicators) at zero extra cost, or when query-aware highlights (`contentLevel: highlights`, `highlightsMaxTokens`) or full-page Markdown (`contentLevel: full_page`, `crawlTimeout`) can replace a separate fetch pass. `extractionSource` (`blend`/`cache`/`fetch`) controls freshness of extracted text; `excludeDomains` accepts up to 5,000 domains (`includeDomains` cannot be combined with `excludeDomains`/`boostDomains`). Keep `contentLevel: snippets` for ordinary discovery; combine `strictOperators: true` with `includeDomains` when hard domain pinning is required. Use `you_contents` (backed by `/v1/extract`) to extract clean Markdown, HTML, or metadata from 1 to 10 known URLs concurrently (`parseEffort`, `extractionSource`, `maxAgeSeconds: 0` for live fetch).

### Parallel — semantic objectives, batch URL extraction, and semantic image search

For broad or ambiguous goals where the agent can state what evidence it wants. Supply a self-contained objective in `query` and preferably 1-3 short `searchQueries`; Parallel ranks URLs and returns compressed excerpts for model context (`afterDate` filters by publication date `YYYY-MM-DD`, `includeDomains`/`excludeDomains` support path prefixes, and v1 Search uses top-level `max_chars_total` via `maxCharsTotal` or mapped from `maxCharsPerResult`). `fast` suits most interactive retrieval, `basic` returns extended excerpts, `advanced` targets complex multi-hop work, and `turbo` minimises latency for English or Japanese only. Turbo and fast share the lower price tier, basic and advanced the higher one. Leave `advanced_settings` unset unless freshness, domains, location, result count, or excerpt size is genuinely constrained, because restrictive settings may reduce quality.

Use `parallel_extract` to extract query-focused excerpts or full Markdown content (and optional `links: true`) from 1 to 20 URLs with an optional `objective` and `searchQueries`. Use `parallel_image_search` (`fast` or `advanced`, up to 3 `searchQueries`) for natural-language image discovery with image dimensions and source page metadata.

### Serper — concise Google-style SERP and Google Scholar

Locate official sites, known pages, or a small ranked result set (`serper_search`, `serper_news`, `serper_images`), or search academic papers with publication info, year, citation counts, and open-access `pdfUrl` via `serper_scholar` (which has no web `tbs` filter). It is not a page reader, crawler, research engine, or browser. Requesting more than 10 results doubles Serper's credit charge, so `search_auto` caps `num` at 10 whenever `limit <= 10`. The reference keys are on Serper's free tier, which rejects Google-dork operator combinations (such as `inurl:`, `intitle:`, `filetype:`, or complex boolean `site:` patterns) with HTTP 400 `Query pattern not allowed for free accounts`; that counts as a plan limit, so `search_auto` moves to the next provider without benching the key. Send plain keyword queries to Serper directly, and use `brave_web_search` or `you_search` when strict operators are required.

### DeepSeek — Chinese/bilingual search and clean Markdown fetch

Official REST integration (`deepseek_search`, `deepseek_fetch`) over `api.deepseek.com/v1/tools/{search,fetch}`. Search returns summaries, snippets, dates, `rerankScore`, and `authority`, and compiles `includeDomains`/`excludeDomains`/`languages`/`afterDate`/`beforeDate` into native `site:`/`-site:`/`lang:`/`after:`/`before:` operators within DeepSeek's strict 128 Unicode code-point query limit (longer queries are skipped automatically in `search_auto`). On `deepseek_fetch`, HTTP 403 reflects target security policy and HTTP 404 conflates missing and unextractable/SPA pages; both are mapped to `TargetPageError` so the API key is never benched and `fetch_auto` still fails over cleanly. Balance reads use `GET /user/balance`.

### Vercel AI Gateway — hosted DeepSeek & free Parallel Fast promo

Zero-dependency adapter over `https://ai-gateway.vercel.sh/v4/ai/language-model` (`vercel_deepseek_search`, `vercel_deepseek_fetch`, and `vercel_parallel_fast`). Uses a `$0` default host model (`nvidia/nemotron-3.5-lightning-free`, `reasoning: "none"`) so only the gateway tool fee applies: DeepSeek tools draw `$0.75/1k` from Vercel AI Gateway free/paid credits, and `vercel_parallel_fast` pins `mode: "fast"` for `$0` promo pricing through 2027-01-31. Configure with `"keys": ["env:AI_GATEWAY_API_KEY"]` (plus optional `fallbackModels` and `authMethod: "api-key" | "oidc"`); balance reads use `GET /v1/credits` and `$0` credit readings do not bench the key so `vercel_parallel_fast` stays usable.

### Direct Markdown — zero-cost native Markdown negotiation

Opt-in, keyless adapter (`direct_markdown_fetch`) that probes known URLs with `Accept: text/markdown` (serving Cloudflare Markdown for Agents, Vercel Docs, Stripe, Mintlify, etc. directly with `x-markdown-tokens` metadata). Strict SSRF checks block localhost/private IPs and re-validate redirects; non-Markdown or thin responses throw `TargetPageError` without `pageStatus` so `fetch_auto` seamlessly falls through to paid readers.

### Tavily — managed web workflow

When the task extends from search into extraction, mapping, crawling, or multi-source research. Prefer Bearer auth (`auth: { kind: "bearer" }`) over query-string keys. Do not use Tavily Research for a lookup that ordinary search can answer. As plain search it ranked last or near last in every 2026-10 category and reports no dates, so it is only the final automatic fallback. Its search accepts `topic: news` again, which the Current route uses. Tavily `432`/`433` count as quota exhaustion and `434` (Flex Tier Capacity) triggers a short cooldown + failover.

### LinkUp — sourced synthesis and research

Its plain search ranked last in the 2026-10 comparison, so keep it for what it is built for: sourced synthesized answers, sequential retrieval, structured research, and long-running tasks. Prefer raw results for downstream synthesis when possible; deep modes are slower and more expensive.

### AnySearch — manual multi-interface retrieval

Use manually when one request benefits from parallel batches, source-directory discovery, vertical routing, or its paired URL extraction. Before any vertical search call `get_sub_domains` and pass only the returned sub-domain and parameter fields; inspect the results rather than assuming vertical routing worked. Use its Extract as a convenient reader, not as a replacement for Firecrawl on difficult pages.

Observations from live checks in August 2026, which may have changed: strong English official-document discovery, detailed `security.vuln` output, useful structured finance quotes, accurate React results from `code.doc`, and `batch_search` isolating a malformed item without losing its siblings; noisy Chinese general results, irrelevant `academic.search` ranking, and a slow repository-constrained `code.snippet` query that ignored the intended repository. The free plan then advertised 1,000 requests per day and 20 QPS per key. Treat privacy conservatively: the provider's terms allow service logs with truncated query content.

### Firecrawl — web data acquisition

Known-page scrape, clean Markdown/HTML, screenshots or structured JSON, site crawl and map, difficult JavaScript pages, extraction. Ordinary search normally stays with a retrieval provider: `firecrawl_search` dynamically triggers Ultrasearch/Alexandria structured enrichment on narrow single-entity US queries (2 credits per 10 results plus scrape/JSON surcharges), while bypassing comparisons and non-US markets.

Supports local STDIO (`firecrawl-mcp@3.41.0`) or official hosted remote MCP (`https://mcp.firecrawl.dev/v2/mcp`, Bearer auth). The default tool policy exposes 9 core tools: scrape, map, search, crawl, crawl status, developer search (GitHub issues, pull requests, READMEs, and code documentation), paper search (PubMed, bioRxiv, medRxiv, arXiv), government search (US statutes, regulations, court opinions), and credit usage. Monitor, feedback, interaction, agent, and other management tools are hidden; use Scrape JSON for structured extraction. `allow: ["*"]` exposes the full catalog, but write and destructive annotations and approval prompts still apply.

### Octen — fast highlights

The fastest search here, about 0.3 seconds per call, with dated results and a long query-relevant highlight per result (supports `premier: true` for `/search-premier`, up to 1,200 `includeDomains`/`excludeDomains`, `language: ["zh"]`, and `fullContent: true`). In the 2026-10 comparison it was second for English news, but its first page carried fewer official or primary sources than Parallel, Exa, Brave, or Serper, so it sits in the middle of General and second in Current. It ranked near the top of the Artificial Analysis Search Index, where an agent reads highlights over many searches. `octen_extract` reads up to 20 URLs (`mode: "auto"` in `fetch_auto` max quality). In a 2026-11 check the same keys answered it with 403 "Payment method required" on some calls and succeeded on others, so its keys carry no tier and a refused call simply tries the next key.

### TinyFish and Jina

TinyFish Fetch (`tinyfish_fetch`) renders pages in Chromium and returns Markdown, HTML, or a JSON document tree (plus optional `links: true` and `perUrlTimeoutMs` up to 110,000 ms) for up to 10 URLs; it is free up to 1,000 URLs a day and read a page Exa answered with `CRAWL_HTTP_403` in a 2026-11 check. A `$0` paid wallet from `quota tinyfish` is displayed without marking the key exhausted because the free daily tier is separate; hitting `free_allowance_exhausted` at runtime marks it exhausted cleanly. Per-URL failures (`bot_blocked`, `page_not_found`, `selector_not_matched`, `timeout`) are page failures, not key faults. `tinyfish_search` supports `domainType` (`web`, `news`, `research_paper` with authors/citations/PDF), `recencyMinutes`, `afterDate`/`beforeDate`, and `purpose`. Jina Search now sends `X-Respond-With: no-content` by default to eliminate the 13-second full-page scraping latency seen in the 2026-10 run (pass `fullContent: true` only when full bodies are needed). Jina Reader and TinyFish Agent/Browser are not exposed here and must not be invented.

### Doubao — Chinese-local, quota-sensitive

Only when the user explicitly requests it or approves consuming its limited quota. Never selected automatically or as a silent fallback. Sends `NeedSummary: true` by default and supports `timeRange`, `sites`, `blockHosts` (max 5 each), `needContent`, and `contentFormat`.

### Grok / xAI — X-native and multimodal retrieval

When X posts, users, threads, reactions, or X-native breaking signals are central (`grok_x_search`, `grok_web_x_search`). Supports `enableImageSearch` (Web), `enableImageUnderstanding` (Web & X), `enableVideoUnderstanding` (X), and `userLocationCountry` (Web). Corroborate important claims with normal web providers. Do not use it as generic search when X is irrelevant. The configured `systemPrompt` is sent as the request's instructions.

`depth` picks the model. `fast` (default) uses `options.model` (code default `grok-4.20-0309-non-reasoning` for grok2api compatibility; when configured to `grok-4.7*`, defaults to `reasoningEffort: "low"` unless overridden), about 5-10 seconds. `deep` runs 4 collaborating agents, about 30-60 seconds. `max` runs 16 agents (`options.multiAgentModel`) that issue over a hundred web and X searches, about a minute or more and roughly $2-3 per call; use it for multi-faceted research questions where breadth matters, not for single facts. Concurrency `429` responses retry once after 3 seconds. In the reference setup Grok goes through a grok2api gateway whose Console provider drops domain and handle filters, so the adapter also writes those limits into the question; treat them as strong hints, not guarantees. When the answer starts with `[Grok no ... search was run]`, the model answered from memory and the result is unsourced. The last line reports the depth and how many web and X searches ran (plus `costUsd` in structured output when reported). Grok answers are cached for 15 minutes like `search_auto` results (both direct calls and `provider_call`), so repeating a question returns the stored answer instead of paying again. An HTTP token can be limited with `allowedArgumentValues` (for example `{"depth": ["fast", "deep"]}`), enforced on both direct calls and `provider_call`.

## Key health

Keys are tracked by fingerprint, so reordering a pool does not move their history. Keys may use `"env:VAR_NAME"` or `"file:PATH"` references. Each provider walks its pool by `strategy`: `round_robin` (default) spreads calls, `sticky` stays on one key until it fails (one upstream session), and `drain` uses keys in configured order so one balance is spent before the next. Authentication failures bench a key for 1 hour, then 6, then 24. Running out of credit marks it exhausted for 30 minutes, then 6 hours, then 24, after which it waits behind every healthy key; under `drain` it gets one try per window, so a reset monthly allowance is spent first again. A success, a positive `search-toolkit quota` reading (Serper, Tavily, Firecrawl, LinkUp, You.com, TinyFish `$0`-safe, DeepSeek, Vercel AI Gateway `$0`-safe), or `reset` restores it. A plan limit never benches a key: the call moves to keys not marked `free` (paid, or plan unknown), up to three. Rate limits (`429` and Tavily `434`) bench a key for 1, 5, then 15 minutes, or for the provider's `Retry-After`. A success clears the strikes. Server errors, a tool's own errors, and a target page's status never bench a key (and never wipe an existing bench/exhausted state). A key fault (401/402/403/429) tries up to 3 healthy keys in the pool; a 5xx or dropped connection tries one more key; timeouts, page failures, and request errors are not retried on another key, so an automatic route reaches the next provider quickly. `search_pool_status` shows each provider's strategy, exhausted keys, and the summed balance from the last quota reading; with `verbose: true` it adds each key's tier, label, last error, and balance. When every key in a pool is benched the call fails with the time until the first recovers.

## Profiles and context cost

The `full` profile exposes every provider tool; descriptions are trimmed to a configurable length (default 700 characters, 220 per parameter) while input schemas stay intact, and `toolPolicy.descriptions` replaces a tool's text outright. The `curated` profile keeps the unified tools, the `provider_tools`/`provider_call` gateway, and specialist tools (`exa_web_search_advanced_exa`, `exa_agent_run`, `brave_llm_context`, `parallel_search`, `parallel_extract`, `you_search`, `you_contents`, `deepseek_search`, `deepseek_fetch`, `vercel_deepseek_search`, `vercel_deepseek_fetch`, `vercel_parallel_fast`, `serper_scholar`, `firecrawl_firecrawl_map`, `firecrawl_firecrawl_crawl`, `firecrawl_firecrawl_check_crawl_status`, `tavily_tavily_research`, `linkup_linkup_research`, `grok_x_search`, `grok_web_x_search`, `doubao_search`, `anysearch_batch_search`) while hiding redundant basic search tools. The `lean` profile exposes only the unified tools and `provider_tools`/`provider_call`, which cuts the tool list by more than 80%; use it for clients that load every tool schema into every conversation.

## Research and verification

Normal web questions need ordinary search, not deep research. Escalate to Tavily Research or LinkUp Research only for several searches, lead-following, broad comparison, substantial reports, or demonstrated retrieval gaps.

For disputed or consequential claims, prefer authoritative primary sources, useful domain and date constraints, and a provider backed by a different retrieval path. Brave is the preferred independent-index cross-check.

For local repositories and newly written or freshly pushed code, use `rg` or `gh search code` before web search. Exa and Firecrawl Developer are useful after code has been indexed, but no web provider should be expected to find a commit immediately.
