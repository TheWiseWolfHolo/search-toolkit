# Web Retrieval Routing Reference

Agent reference for routing orders, result metadata, and specialist parameters. For deployment, config schema, key rotation backoff, billing endpoints, and historical notes, see `docs/operator-guide.md` and `docs/search-eval-2026-10.md`.

## Reading a Result

Every result begins with one compact JSON route block followed by readable text:

```json
{"searchToolkitRoute":{"provider":"parallel","tool":"parallel_search"},"searchToolkitAuto":{"mode":"general","quality":"balanced"}}
```

| Field | Meaning |
| --- | --- |
| `searchToolkitAuto.attempts` | Shown only on fallback (e.g. `["parallel_search:429","you_search:success"]`). Omitted on first-try success and zero-cost `direct_markdown_fetch` skips. |
| `searchToolkitAuto.cached` | Reused recent answer (`"12s"`, `"4m"`). Default TTLs: 15m search (and direct Grok), 5m `mode: current`, 30m fetch. |
| `searchToolkitAuto.crossCheck` | `{ providers, failed?, empty?, status: "complete" \| "partial" \| "unavailable", corroborated }`. Items list `found by: ...`. |
| `searchToolkitAuto.page` | Single-URL `fetch_auto`: `status: "readable"` (full body) or `"partial"` (fragment), plus `nextOffset` when clipped readable text continues. |
| `searchToolkitAuto.batch` | Multi-URL `fetch_auto`: `{ total, succeeded, partial?, failed? }`. Only `readable` pages count in `succeeded`. |
| `_meta.searchToolkit` | Upstream tool name, candidate rank, latency, and full attempt records; model text lives in `content`. |

## CLI Reference (Without MCP)

```text
search-toolkit search "<query>" [--mode general|exact|current|official|scholar|code|context] [--quality balanced|max] [--limit 6] [--freshness day|week|month|year] [--domains a.com,b.com] [--exclude-domains x.com] [--max-chars 700] [--max-tokens 4096] [--cross] [--no-cache] [--json]
search-toolkit images "<query | image-url>" [--query "..."] [--image-url "https://..."] [--limit 10] [--language code] [--safesearch strict|off] [--no-cache] [--json]
search-toolkit fetch <url...> [--quality balanced|max] [--max-chars 12000] [--offset 0] [--section "Heading"] [--no-cache] [--json]
search-toolkit tools [--profile full|curated|lean] [--provider <name>] [--describe <tool>] [--json]
search-toolkit call <tool> '<json>' [--input - | @args.json] [--no-cache] [--json]
search-toolkit status [--verbose]
```

On Windows PowerShell, prefer `--input -` (stdin) or `@args.json` for complex JSON in `call`. Operator commands (`reset`, `quota`, `config`, `cache-clear`, `migrate-config`, `probe`) are not for routine agent use.

## Automatic Search (`search_auto`)

Uses only providers configured with `auto: ["search"]`. Tries up to **3 providers** (first eligible plus up to 2 fallbacks), failing over on availability faults (401/402/non-policy 403, 408/425/429/434, Tavily 432/433, 5xx, timeouts, network errors, plan limits, exhausted pools) **and** on empty results (`0` items or empty grounding). Request-shape errors (400/422) and policy/safety blocks stop the chain.

### Mode Order (`balanced`)

| Mode | Use for | English order | Chinese order |
| --- | --- | --- | --- |
| `general` | Everyday lookup | Parallel Fast -> Serper -> Exa Lite -> You -> Octen -> Brave -> Tavily -> DeepSeek -> Vercel DeepSeek -> Vercel Parallel Fast | Brave -> Serper -> DeepSeek -> Vercel DeepSeek -> You -> Parallel -> Vercel Parallel Fast -> Tavily |
| `exact` | Quoted strings, errors | Parallel -> Brave -> Serper -> You -> Tavily (`exact_match`) -> DeepSeek -> Vercel DeepSeek | Brave -> Serper -> DeepSeek -> Vercel DeepSeek -> You -> Parallel |
| `official` | Vendor/gov sites | Exa Lite -> Brave -> Serper -> You -> DeepSeek -> Vercel DeepSeek -> Vercel Parallel Fast | Exa Lite -> Serper -> DeepSeek -> Vercel DeepSeek -> Parallel -> Brave |
| `current` | News (default `week`) | You (`preferNews`) -> Exa Lite news -> Octen -> Serper News -> Brave News -> Tavily news -> DeepSeek -> Vercel DeepSeek | Exa Lite news -> You (`preferNews`) -> Octen (`zh`) -> Serper News -> Brave News -> Tavily news -> DeepSeek -> Vercel DeepSeek |
| `scholar` | Papers, reviews | Exa Lite (`publication`) -> Parallel -> You -> Serper Scholar -> Vercel Parallel Fast | Same |
| `code` | Repos, API examples | Exa Lite (`github.com`) -> Parallel -> Serper -> DeepSeek -> Vercel DeepSeek -> Vercel Parallel Fast | Same |
| `context` | Grounding chunks | Brave LLM Context (4096) -> Parallel Basic -> You highlights -> Tavily Basic -> DeepSeek -> Vercel DeepSeek | Same |

### `quality: max` & Query Translation

- **`quality: max`**: English `general` leads with Exa Auto (`enableHighlights: true`) then Parallel Advanced; `context` puts Parallel Advanced ahead of Brave LLM Context; `scholar` uses Exa Search with a research-paper objective (or Exa Auto + `category: publication` when `freshness` is set); elsewhere switches Parallel `fast` -> `advanced`, Exa `lite` -> `auto`, DeepSeek `needContent: true`, You `highlights`, Brave `extraSnippets: true`, Tavily `advanced`. Never escalates to Research, Crawl, or agent jobs.
- **Chinese locale**: >= 2 Han chars without kana/Hangul. Simplified sends `zh-hans`/`CN` (`gl: cn, hl: zh-cn` on Serper); Traditional sends `zh-hant`/`TW` or `HK` on Brave, Serper, You.com; Octen gets `language: ["zh"]`, DeepSeek gets `lang:zh`. Exa and Tavily accept no locale overrides (so in Chinese `current`, Exa news and Tavily run without locale params while You/Octen/Serper/Brave/DeepSeek apply Chinese settings).
- **Domains (`includeDomains`, `excludeDomains`)**: Exa Advanced, Parallel, Vercel Parallel Fast, and `site:`/`-site:` providers (Brave, Serper, Exa basic, DeepSeek) preserve path prefixes (`github.com/org`); You.com, Octen, Tavily take hostnames only. Path-scoped `excludeDomains` are never widened to whole-host exclusions; path-capable providers are preferred for path prefixes or mixed include+exclude lists.
- **Query length caps**: operator-expanded queries automatically skip providers past their limit (DeepSeek 128 Unicode code points, Serper 32 words, Brave Web/LLM 600 chars / 75 words, Brave News 400 / 50).
- **Freshness**: `day`/`week`/`month`/`year` maps to Brave `pd/pw/pm/py`, Serper `qdr:d/w/m/y`, You/Octen/Tavily native freshness, Parallel `afterDate`, DeepSeek `after:YYYY-MM-DD`, Exa `startPublishedDate`. `serper_scholar` ignores `freshness`.
- **Cross-check (`crossCheck: true`)**: runs the first two eligible distinct search providers concurrently, deduplicates by canonical URL and release/mirror key, merges with Reciprocal Rank Fusion (RRF), and puts corroborated items first. One failure returns `status: "partial"`; both failing continues with a 3rd provider. Ignored in `context` mode.

## Known-URL Reading (`fetch_auto`)

Accepts `url` (1) or `urls` (up to 5 concurrently; non-SPA `#fragments` stripped, `#/` and `#!` preserved).

- **`balanced`**: Direct Markdown (opt-in zero-cost `Accept: text/markdown`) -> Exa -> DeepSeek -> Vercel DeepSeek -> Tavily -> Parallel Extract -> TinyFish -> You.com Extract -> Octen -> Firecrawl -> LinkUp -> AnySearch.
- **`quality: max`**: Firecrawl -> TinyFish -> Tavily (`advanced`) -> Parallel Extract -> Exa -> DeepSeek -> Vercel DeepSeek -> You.com Extract -> Octen (`mode: auto`) -> LinkUp (`renderJs: true`) -> AnySearch.
- **Notes**: `fetch_auto` sends `fullContent: true` to Parallel Extract in both `balanced` and `max`. Tries up to **3 standard/paid readers**; zero-cost `direct_markdown_fetch` skips do **not** consume one of the 3 attempts. Fails over on site blocks (403/429/5xx, captchas, Cloudflare/Vercel/SPA challenge shells, Exa `CRAWL_HTTP_403`, Firecrawl `unsupported_site`, DeepSeek 403/404, Tavily `failed_results`) or thin text (< 80 chars). Confirmed 404/410/451 or malformed URLs stop the chain.
- **Slicing**: `maxChars` defaults to `12000` (split across batch `urls`). `section` matches Markdown ATX (`#`) and Setext (`===`/`---`) headings (ignores `#` in fenced code, prefers exact > word-boundary > substring). Pass returned `nextOffset` via `offset` to continue clipped readable pages.

## Image Discovery (`search_images`)

- **Text (`query`)**: Brave Images -> Serper Images -> Parallel Images, capped at **2 runtime provider attempts** (`maxProviders: 2`; Parallel is used automatically when Brave or Serper is disabled/benched beforehand). Country hints are ignored; call `brave_image_search`, `serper_images`, or `parallel_image_search` directly for country targeting.
- **Reverse image (`imageUrl`)**: Google Lens (`serper_lens`, 3 Serper credits). Needs a public http(s) URL (no local files/chat uploads); some hosts (e.g. Wikimedia originals) block Google's fetcher, so a resized/re-hosted copy works better. Lens returns no dates; fetch candidate pages to establish earliest publication.

## Specialist Provider Quick Reference

| Provider / Tools | Direct use | Key parameters & limits |
| --- | --- | --- |
| **Exa** (`exa_web_search_advanced_exa`, `exa_web_fetch_exa`, `exa_agent_run`) | Semantic search, official sites, papers, GitHub code | `category` (`news`, `publication`, `company`, `people`; `github`/`pdf` deprecated), `includeDomains` (path prefixes ok), `startPublishedDate`. `type: lite` rejects `contextMaxCharacters`. Weak on exact strings. `exa_agent_run` is billed multi-step research (explicit request only). |
| **Brave** (`brave_web_search`, `brave_news_search`, `brave_llm_context`, `brave_image_search`) | Independent web/news, Goggles, grounding chunks | Direct `brave_llm_context` defaults to **8192** tokens (`search_auto context` uses **4096**); prefer `maximumNumberOfTokens`, `maximumNumberOfTokensPerUrl`, `maximumNumberOfUrls`. `extraSnippets: true` adds up to 5 excerpts. |
| **You.com** (`you_search`, `you_contents`) | Unified Web + News, live `knowledge: true` cards, highlights, 1-10 URL extract | `preferNews`, `contentLevel` (`snippets`/`highlights`/`full_page`), `extractionSource` (`blend`/`cache`/`fetch`), `strictOperators` + `includeDomains` (do not combine with `excludeDomains`/`boostDomains`). `you_contents`: `maxAgeSeconds: 0` forces live fetch. |
| **Parallel** (`parallel_search`, `parallel_extract`, `parallel_image_search`) | Broad semantic objectives, 1-20 URL extract, semantic images | Objective in `query` + 1-3 `searchQueries`; `mode`: `fast` (default), `turbo` (EN/JA), `basic`, `advanced`. Publish date is `afterDate` (`maxAgeSeconds` is cache age). `parallel_extract` supports `objective`, `fullContent`, `links: true`. |
| **Serper** (`serper_search`, `serper_news`, `serper_images`, `serper_scholar`, `serper_lens`) | Google SERP, Scholar (citations + `pdfUrl`), Lens | Free keys reject complex dorks (`inurl:`, `intitle:`, `filetype:`); use Brave/You for strict operators. `serper_scholar` has no `tbs` filter. >10 results doubles credits. |
| **DeepSeek** (`deepseek_search`, `deepseek_fetch`) | Chinese/bilingual search with `rerankScore`/`authority`, Markdown fetch | Strict **128 code-point** query cap (incl. operators); `needContent: true` for fuller text. |
| **Vercel Gateway** (`vercel_deepseek_search`, `vercel_deepseek_fetch`, `vercel_parallel_fast`) | Hosted DeepSeek search/fetch & Parallel Fast | 128-char cap on `vercel_deepseek_search`; `vercel_parallel_fast` pins `mode: fast` with domain/date/`maxCharsTotal` filters. |
| **Direct Markdown** (`direct_markdown_fetch`) | Zero-cost native `text/markdown` fetch | Public http(s) ports 80/443 only; non-Markdown HTML throws page error so `fetch_auto` falls through. |
| **Octen** (`octen_search`, `octen_extract`) | Fast (~0.3s) highlights, 1-20 URL extract | `premier: true`, up to 1,200 include/exclude domains, `language: ["zh"]`, `fullContent: true`. Third in `current`, mid-pack in EN `general`. |
| **Firecrawl** (`firecrawl_firecrawl_*`) | JS scrape, JSON extract, `map`, `crawl`, developer/paper/gov search | Avoid `firecrawl_firecrawl_search` for routine lookup (narrow US queries can trigger Ultrasearch surcharges). Write/crawl/agent tools need explicit intent. |
| **Tavily & LinkUp** (`tavily_tavily_*`, `linkup_linkup_*`) | Managed extract/crawl/map & deep sourced research | Plain search ranked lowest in 2026-10 evals; reserve for extraction, crawling, or explicit research jobs. |
| **AnySearch** (`anysearch_search`, `anysearch_batch_search`, `anysearch_extract`, `anysearch_get_sub_domains`) | Manual batch search, directory, verticals | Always call `anysearch_get_sub_domains` before vertical search and pass only returned schema fields; verify results. |
| **TinyFish & Jina** (`tinyfish_fetch`, `tinyfish_search`, `jina_search`) | Chromium fetch (1-10 URLs, selectors, `links`), vertical search (`web`/`news`/`research_paper`), compact search | `tinyfish_fetch` supports `perUrlTimeoutMs` <= 110,000. `jina_search` defaults to `no-content` (`fullContent: true` is slow). Jina Reader & TinyFish Browser/Agent are not exposed. |
| **Querit** (`querit_search`, `querit_contents`) | Manual English lookup, `code`/`finance` verticals, 1-10 URL extract | Pass `languages` when language matters; manual-only. |
| **Grok** (`grok_x_search`, `grok_web_x_search`, `grok_web_search`) | X posts/threads, multimodal image/video, Web+X synthesis | Returns cited answer, not URL list. `depth`: `fast` (5-10s), `deep` (4 agents, 30-60s), `max` (16 agents, 1-5m, ~$2-3). `[Grok no ... search was run]` = unsourced memory. Cached 15m. |
| **Doubao** (`doubao_search`) | Chinese local search (`timeRange`, `sites`, `blockHosts` <= 5) | **Explicit user authorization only.** Never automatic or fallback. |

## Status, Profiles, and Origin Checks

- **Pool status**: `search_pool_status` reports masked key health, per-capability `recentFailure` (fetch hiccups never demote search), and cached balances with units (`credits`, `USD`, `cents`, `CNY`) and age. `refreshQuota: true` performs live billing reads for owner callers only (local STDIO/CLI or owner HTTP tokens).
- **Profiles**: `full` exposes unified tools, status, probe, and all enabled provider tools (hides `provider_tools`/`provider_call`); `curated` exposes unified tools, status, probe, gateway, and 14 specialist tools; `lean` exposes only the 7 unified/status/probe/gateway tools.
- **Origin & verification**: check matched file, repo identity, commit date, and fork/rename history before saying a string "originates from" (出自) a project; use `rg` or `gh search code` for local/freshly pushed code.
