# Web retrieval routing policy

Choose providers by capability and task intent. Prefer the cheapest, narrowest, and least context-heavy tool that can reliably solve the task.

## Core rules

1. Start ordinary lookup with Querit unless another provider has a clear advantage.
2. Do not send the same query to every provider. Use a second independent path only when the claim matters or the first result set is weak.
3. Escalate in this order: compact search → inspect → fetch selected URLs → deep research → browser/agent automation.
4. If a URL is known, fetch or scrape it directly instead of searching for it again.
5. Request about 5-8 results for routine lookup. Prefer snippets/highlights over unrestricted full bodies.
6. Inspect the live tool inventory. Official MCP catalogs change, and optional tools may be filtered by policy.
7. Keep raw keys out of prompts, results, logs, and tool arguments where they are not required.

## Provider roles

### Querit — default retrieval

Use for ordinary factual lookup, fast source discovery, and current information without a specialist requirement. Do not escalate merely because a more sophisticated provider is available.

### Exa — precision and long-tail discovery

Use for exact error messages, identifiers, configuration keys, code strings, obscure repositories, implementation examples, semantic discovery, specialist people/companies/papers, and long-tail queries. Prefer bounded highlights/context. Use advanced search only for filters, categories, dates, domains, or deeper structured retrieval.

### Brave — independent grounding

Use Brave Web for structured independent-index results and Brave News for current or breaking news. Prefer Brave when a consequential claim needs a second retrieval perspective. The current server does not expose Brave LLM Context, so do not request it until it appears in the live inventory.

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
