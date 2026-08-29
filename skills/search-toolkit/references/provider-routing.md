# Web retrieval routing policy

Choose providers by capability and task intent. Prefer strong retrieval that fits the task; request price is secondary because configured quotas are ample. Still avoid unnecessary latency, oversized context, and implicit research or crawling.

## Core rules

1. Start ordinary lookup with `search_auto` in balanced general mode. Use max quality for broad, ambiguous, multi-aspect, or high-value retrieval.
2. Do not send the same query to every provider. Use a second independent path only when the claim matters or the first result set is weak.
3. Escalate in this order: compact search → inspect → fetch selected URLs → deep research → browser/agent automation.
4. If a URL is known, fetch or scrape it directly instead of searching for it again.
5. Request about 5-8 results for routine lookup. Prefer snippets/highlights over unrestricted full bodies.
6. Inspect the live tool inventory. Official MCP catalogs change, and optional tools may be filtered by policy.
7. Keep raw keys out of prompts, results, logs, and tool arguments where they are not required.

## Provider roles

### Querit — balanced compact retrieval

Use for compact factual lookup and source discovery when its result style fits the task. It remains available in the general automatic pool and for direct calls, but it is not the unconditional first hop.

### Exa — precision and long-tail discovery

Use for exact error messages, identifiers, configuration keys, code strings, obscure repositories, implementation examples, semantic discovery, specialist people/companies/papers, and long-tail queries. Prefer bounded highlights/context. Use advanced search only for filters, categories, dates, domains, or deeper structured retrieval.

### Brave — independent grounding

Use Brave Web for structured independent-index results and Brave News for current or breaking news. Prefer Brave when a consequential claim needs a second retrieval perspective.

Use Brave LLM Context when an agent needs pre-extracted text, tables, code, or discussion chunks from several search results without separately fetching each page. Control the response with URL, token, per-URL, snippet, freshness, threshold, Goggles, and optional local-recall parameters. Direct calls and `search_auto` requests routed to Brave send 4096 tokens by default; increase `maximumNumberOfTokens` only when the task justifies more context. Parallel and You.com fallbacks use their own controls, so this Brave-specific parameter does not apply to those routes. It returns `grounding` plus `sources`, not a generated final answer. Keep ordinary URL discovery on Brave Web, known-URL reading on a fetch/scrape tool, and deep multi-step synthesis on Tavily or LinkUp research.

### You.com — unified Web and News with query-aware highlights

Use `you_search` when one current query should return both Web and News sections, or when You.com's query-aware highlights can replace a separate fetch pass. Keep the default `contentLevel: snippets` for ordinary discovery. Select `highlights` explicitly for citation chunks or RAG-style grounding; extraction can add latency and provider charges. This adapter intentionally does not expose full-page mode: known URLs belong on a fetch/contents tool, and unrestricted full bodies are too easy to invoke accidentally.

### Parallel — semantic objectives and dense excerpts

Use `parallel_search` for broad or ambiguous goals where the agent can state what evidence it wants, not merely a keyword. Supply a self-contained objective in `query` and preferably 1-3 short `searchQueries`; Parallel ranks URLs and returns compressed excerpts designed for model context. Use `basic` for routine quality retrieval, `advanced` for complex semantic or multi-hop work, and `turbo` only when low latency matters more than depth. The stable V1 modes are turbo, basic, and advanced; do not describe the legacy `fast` alias as a separate low-cost tier. Leave `advanced_settings` controls unset unless freshness, domains, location, result count, or excerpt size is genuinely constrained, because restrictive settings may reduce quality.

## Automatic routing

Balanced routing uses these quality-oriented profiles:

- General: Parallel Basic → You snippets → Brave Web → Exa Search → Querit → Tavily Basic.
- Exact: Exa Search → Serper → Tavily exact/basic → Brave Web.
- Context: Brave LLM Context 4096 → Parallel Basic → You highlights → Tavily Basic.
- Current: Brave News → You snippets → Tavily Search → Serper News. The live Tavily MCP schema fixes `topic` to general, so do not send `topic: news`; use supported freshness/date controls when needed.
- Official navigation: Serper → Brave Web → Exa Search → You snippets.

Max quality changes General to Parallel Advanced, Exact to Exa Advanced, and Context to Parallel Advanced before Brave LLM Context. It does not silently turn ordinary lookup into Research, Crawl, full-page extraction, or an agentic task.

Automatic routing may try at most two Providers. A second compatible retrieval Provider is eligible after a recognized availability failure: HTTP 401/402, an authentication/plan/permission 403 that is not a policy or safety block, network failure, timeout, HTTP 408/425/429, Provider 5xx, or clear statusless MCP messages such as rate limits, temporary unavailability, and no healthy slots. Request/schema errors, policy or safety blocks, local code errors, and unknown failures are terminal. Explicit HTTP status outranks error-body keyword guesses. The first successful result is returned without silently merging Providers; use an explicit independent cross-check when the claim warrants one.

### Serper — concise Google-style SERP

Use to locate official sites, known pages, or a small ranked result set. It is not a page reader, crawler, research engine, or browser.

### Tavily — managed web workflow

Use when the task naturally extends from search into extraction, fresh/news follow-up, mapping, crawling, or multi-source research. Do not use Tavily Research for a lookup that ordinary search can answer.

### LinkUp — sourced synthesis and research

Use for sourced synthesized answers, sequential retrieval, structured research, and explicitly long-running tasks. Prefer raw results for downstream model synthesis when possible; deep modes are slower and more expensive.

### Firecrawl — web data acquisition

Use for known-page scrape, clean Markdown/HTML, screenshots or structured JSON, site crawl/map, difficult JavaScript pages, and extraction. Ordinary search normally stays with a retrieval provider unless Firecrawl's search-to-content behavior is specifically useful.

The default server policy exposes only scrape, map, search, crawl, crawl status, developer search, and GitHub research search. The deprecated standalone Extract tool and all monitor, feedback, interaction, agent, and other management tools are hidden; use Scrape JSON for structured extraction. A provider policy with `allow: ["*"]` can expose the full catalog, but write/destructive annotations and approval prompts still apply.

### Jina and TinyFish — search-only in this server

Use `jina_search` or `tinyfish_search` only when their compact search perspective is useful. Jina Reader and TinyFish Agent/Browser are valid provider capabilities in other integrations, but they are not exposed here and must not be invented.

### Doubao — Chinese-local, quota-sensitive

Use only when the user explicitly requests Doubao or approves consuming its limited quota. Never select it automatically or as silent paid fallback.

### Grok / xAI — X-native retrieval

Use when X posts, users, threads, reactions, or X-native breaking signals are central. Corroborate important claims with normal web providers. Do not use Grok as generic search when X is irrelevant.

## Fetch policy

Fetch only selected sources. Prefer the current provider's fetch tool when suitable, Exa Fetch for Exa-discovered pages, and Firecrawl Scrape for robust rendering, structured extraction, screenshots, crawling, or difficult pages. The current server has no Querit Contents or Jina Reader tool.

## Research and verification

Normal web questions need ordinary search, not deep research. Escalate to Tavily Research or LinkUp Research only for several searches, lead-following, broad comparison, substantial reports, or demonstrated retrieval gaps.

For disputed or consequential claims, prefer authoritative primary sources, useful domain/date constraints, and a provider backed by a different retrieval path. Brave is the preferred independent-index cross-check. Reposts of the same underlying source count as one source.
