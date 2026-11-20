export type AutoMode = "general" | "exact" | "current" | "official" | "context" | "scholar" | "code";
export type AutoQuality = "balanced" | "max";
export type AutoFreshness = "day" | "week" | "month" | "year";

export interface AutoCandidate {
  name: string;
  nativeArguments?: Record<string, unknown>;
}

export function autoMode(value: unknown): AutoMode {
  return value === "exact" || value === "current" || value === "official" || value === "context" || value === "scholar" || value === "code"
    ? value
    : "general";
}

function autoFreshness(value: unknown): AutoFreshness {
  return value === "day" || value === "month" || value === "year" ? value : "week";
}

function explicitFreshness(value: unknown): AutoFreshness | undefined {
  return value === "day" || value === "week" || value === "month" || value === "year" ? value : undefined;
}

/**
 * Domains as given, minus scheme, query, and trailing slashes. A path prefix
 * ("github.com/modelcontextprotocol") is kept: site: operators honour it.
 */
function cleanDomains(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item ?? "").trim().replace(/^https?:\/\//i, "").replace(/[?#].*$/, "").replace(/\/+$/, "").toLowerCase())
    .filter(Boolean);
}

/** Native domain filters take hosts; a path prefix there would match nothing. */
function hostsOf(domains: string[]): string[] {
  return [...new Set(domains.map((domain) => domain.replace(/\/.*$/, "")))];
}

// Longest query each operator-based provider takes. Brave Web/LLM allow 600 chars / 75 words
// while Brave News allows 400 / 50; Google behind Serper ignores words past 32; DeepSeek allows 128 code points.
const SITE_QUERY_LIMITS: Record<string, { chars?: number; words?: number; codePoints?: number }> = {
  brave_web_search: { chars: 600, words: 75 },
  brave_llm_context: { chars: 600, words: 75 },
  brave_news_search: { chars: 400, words: 50 },
  brave: { chars: 400, words: 50 },
  serper: { chars: 2_048, words: 32 },
  deepseek_search: { codePoints: 128 },
  vercel_deepseek_search: { codePoints: 128 },
};

function fitsQueryLimit(name: string, query: string): boolean {
  const limit = SITE_QUERY_LIMITS[name] ?? SITE_QUERY_LIMITS[name.split("_")[0] ?? ""];
  if (!limit) return true;
  if (limit.codePoints !== undefined && Array.from(query).length > limit.codePoints) return false;
  if (limit.chars !== undefined && query.length > limit.chars) return false;
  if (limit.words !== undefined && query.trim().split(/\s+/).length > limit.words) return false;
  return true;
}

function queryWithSiteOperators(query: string, include: string[], exclude: string[]): string {
  const parts = [query];
  if (include.length === 1) parts.push(`site:${include[0]}`);
  else if (include.length > 1) parts.push(`(${include.map((domain) => `site:${domain}`).join(" OR ")})`);
  for (const domain of exclude) parts.push(`-site:${domain}`);
  return parts.join(" ");
}

function deepseekOperatorQuery(query: string, include: string[], exclude: string[], publishedSince?: string): string {
  const parts = [queryWithSiteOperators(query, include, exclude)];
  if (publishedSince) parts.push(`after:${publishedSince}`);
  return parts.join(" ").trim();
}

export function autoCandidates(mode: AutoMode, quality: AutoQuality, args: Record<string, unknown> = {}): AutoCandidate[] {
  // A long site: list goes to providers with native domain filters instead of failing or being cut short.
  return routeCandidates(mode, quality, args).filter((candidate) =>
    fitsQueryLimit(candidate.name, String(candidate.nativeArguments?.query ?? "")));
}

function routeCandidates(mode: AutoMode, quality: AutoQuality, args: Record<string, unknown>): AutoCandidate[] {
  const query = String(args.query ?? "");
  const limit = Number(args.limit ?? 6);
  // Ask for a little more than shown: duplicates and mirrors are dropped before the list is capped to `limit`.
  const requested = Math.min(limit + 2, 20);
  // Serper charges 2x credits for num > 10; stay within the 1-credit tier whenever the caller asked for <= 10.
  const serperRequested = limit <= 10 ? Math.min(requested, 10) : requested;
  const parallelMode = quality === "max" ? "advanced" : "fast";
  const tavilyDepth = quality === "max" ? "advanced" : "basic";
  const braveTokens = typeof args.maximumNumberOfTokens === "number" ? args.maximumNumberOfTokens : 4096;
  const maxCharsPerResult = typeof args.maxCharsPerResult === "number" && args.maxCharsPerResult > 0
    ? Math.round(args.maxCharsPerResult)
    : undefined;
  const includeDomains = cleanDomains(args.includeDomains);
  const excludeDomains = cleanDomains(args.excludeDomains);
  const includeHosts = hostsOf(includeDomains);
  const excludeHosts = hostsOf(excludeDomains);
  const hasDomains = includeDomains.length > 0 || excludeDomains.length > 0;
  const siteQuery = hasDomains ? queryWithSiteOperators(query, includeDomains, excludeDomains) : query;

  const freshness = mode === "current" ? autoFreshness(args.freshness) : explicitFreshness(args.freshness);
  const braveFreshness = freshness ? { day: "pd", week: "pw", month: "pm", year: "py" }[freshness] : undefined;
  const serperFreshness = freshness ? { day: "qdr:d", week: "qdr:w", month: "qdr:m", year: "qdr:y" }[freshness] : undefined;
  const windowSeconds = freshness ? { day: 86_400, week: 604_800, month: 2_592_000, year: 31_536_000 }[freshness] : undefined;
  // Exa filters by publish date only in its advanced tool (maxAgeHours is cache staleness, not a date filter).
  const publishedSince = windowSeconds ? new Date(Date.now() - windowSeconds * 1000).toISOString().slice(0, 10) : undefined;

  const domainArgsFor = (name: string): Record<string, unknown> => {
    if (!hasDomains) return {};
    // Exa and Parallel honor path prefixes (e.g. github.com/modelcontextprotocol) natively.
    if (name === "parallel_search" || name === "vercel_parallel_fast" || name === "exa_web_search_advanced_exa") {
      return {
        ...(includeDomains.length ? { includeDomains } : {}),
        ...(excludeDomains.length ? { excludeDomains } : {}),
      };
    }
    if (name === "you_search" || name === "octen_search") {
      return {
        ...(includeHosts.length ? { includeDomains: includeHosts } : {}),
        ...(excludeHosts.length ? { excludeDomains: excludeHosts } : {}),
      };
    }
    if (name === "tavily_tavily_search") {
      return {
        ...(includeHosts.length ? { include_domains: includeHosts } : {}),
        ...(excludeHosts.length ? { exclude_domains: excludeHosts } : {}),
      };
    }
    if (name === "querit_search") {
      return {
        ...(includeHosts.length ? { sitesInclude: includeHosts } : {}),
        ...(excludeHosts.length ? { sitesExclude: excludeHosts } : {}),
      };
    }
    return {};
  };

  const timeArgsFor = (name: string): Record<string, unknown> => {
    if (!freshness || mode === "current") return {};
    if (name.startsWith("brave_")) return { freshness: braveFreshness };
    if (name === "serper_scholar") return {};
    if (name.startsWith("serper_")) return { tbs: serperFreshness };
    if (name === "you_search" || name === "octen_search") return { freshness };
    if (name === "tavily_tavily_search") return { time_range: freshness };
    // Parallel's max_age_seconds is cache staleness; the publish-date filter is after_date.
    if (name === "parallel_search" || name === "vercel_parallel_fast") return { afterDate: publishedSince };
    if (name === "exa_web_search_advanced_exa") return { startPublishedDate: publishedSince };
    if (name === "querit_search") return { timeRange: freshness };
    return {};
  };

  const budgetArgsFor = (name: string): Record<string, unknown> => {
    if (maxCharsPerResult === undefined) return {};
    if (name === "parallel_search") return { maxCharsPerResult };
    if (name === "vercel_parallel_fast") return { maxCharsTotal: maxCharsPerResult * limit };
    if (name === "exa_web_search_advanced_exa") return { contextMaxCharacters: maxCharsPerResult * limit };
    return {};
  };

  const candidate = (
    requestedName: string,
    limitKey: "limit" | "max_results" | "maxResults" | "numResults" | undefined,
    nativeArguments: Record<string, unknown> = {},
  ): AutoCandidate => {
    // Basic Exa search has no date filter, so a time-bounded request goes to the advanced tool.
    const name = requestedName === "exa_web_search_exa" && publishedSince ? "exa_web_search_advanced_exa" : requestedName;
    if (name !== requestedName) delete nativeArguments.objective;
    const isDeepSeek = name === "deepseek_search" || name === "vercel_deepseek_search";
    const usesSiteQuery = hasDomains && (name.startsWith("brave_") || name.startsWith("serper_") || name === "exa_web_search_exa");
    const effectiveLimit = name.startsWith("serper_") ? serperRequested : requested;
    const queryValue = isDeepSeek
      ? deepseekOperatorQuery(query, includeDomains, excludeDomains, publishedSince)
      : usesSiteQuery
        ? siteQuery
        : query;
    const built: AutoCandidate = {
      name,
      nativeArguments: {
        query: queryValue,
        ...(limitKey ? { [limitKey]: effectiveLimit } : {}),
        // Exa ranks by a stated goal; its schema requires one.
        ...(name === "exa_web_search_exa" ? { objective: query } : {}),
        ...domainArgsFor(name),
        ...timeArgsFor(name),
        ...budgetArgsFor(name),
        ...nativeArguments,
      },
    };
    // Lite rejects contextMaxCharacters; excerpts are capped after the call instead.
    if (built.nativeArguments?.type === "lite") delete built.nativeArguments.contextMaxCharacters;
    return built;
  };
  const braveMax = quality === "max" ? { extraSnippets: true } : {};
  const youLevel = quality === "max" ? "highlights" : "snippets";
  // Chinese queries get Chinese-market parameters; the 2026-10 eval showed Parallel and You.com
  // mixing in English pages for them while Brave and Serper with zh settings stayed on target.
  const zh = isChineseQuery(query);
  const braveLang = zh ? { searchLang: "zh-hans", country: "CN" } : {};
  const serperLang = zh ? { gl: "cn", hl: "zh-cn" } : {};
  const youLang = zh ? { language: "zh-hans", country: "CN" } : {};
  const deepseekArgs = quality === "max" ? { needContent: true } : {};
  const deepseekPair = () => [
    candidate("deepseek_search", "limit", deepseekArgs),
    candidate("vercel_deepseek_search", "limit", deepseekArgs),
  ];
  const vercelParallel = () => candidate("vercel_parallel_fast", "maxResults", {});
  // Exa Lite (Exa 3.0, 2026-10) matched Auto on general, official, scholar, and code queries at a third of the
  // latency and a lower price, so balanced routes use it; max keeps Auto. Lite is weak on exact strings.
  const exaLite = (extra: Record<string, unknown> = {}) => candidate("exa_web_search_advanced_exa", "numResults", { type: "lite", ...extra });
  const exa = quality === "max" ? candidate("exa_web_search_advanced_exa", "numResults", { type: "auto" }) : exaLite();
  const exaNews = quality === "max"
    ? candidate("exa_web_search_advanced_exa", "numResults", { type: "auto", category: "news", startPublishedDate: publishedSince })
    : exaLite({ category: "news", startPublishedDate: publishedSince });
  // Orders follow evals/search-queries.json results (gold-source hits, language match, dates, latency).
  switch (mode) {
    case "exact":
      return zh
        ? [
            candidate("brave_web_search", "limit", { ...braveLang, ...braveMax }),
            candidate("serper_search", "limit", serperLang),
            ...deepseekPair(),
            candidate("you_search", "limit", { ...youLang, contentLevel: youLevel }),
            candidate("parallel_search", "maxResults", { mode: parallelMode }),
          ]
        : [
            candidate("parallel_search", "maxResults", { mode: parallelMode }),
            candidate("brave_web_search", "limit", braveMax),
            candidate("serper_search", "limit"),
            candidate("you_search", "limit", { ...youLang, contentLevel: youLevel }),
            candidate("tavily_tavily_search", "max_results", { search_depth: tavilyDepth, exact_match: true }),
            ...deepseekPair(),
          ];
    case "context":
      return quality === "max"
        ? [
            candidate("parallel_search", "maxResults", { mode: "advanced" }),
            candidate("brave_llm_context", undefined, { count: 20, maximumNumberOfTokens: braveTokens, ...braveLang }),
            candidate("you_search", "limit", { ...youLang, contentLevel: "highlights" }),
            candidate("tavily_tavily_search", "max_results", { search_depth: "advanced" }),
            ...deepseekPair(),
          ]
        : [
            candidate("brave_llm_context", undefined, { count: 20, maximumNumberOfTokens: braveTokens, ...braveLang }),
            candidate("parallel_search", "maxResults", { mode: "basic" }),
            candidate("you_search", "limit", { ...youLang, contentLevel: "highlights" }),
            candidate("tavily_tavily_search", "max_results", { search_depth: "basic" }),
            ...deepseekPair(),
          ];
    case "current": {
      // Exa news filtered by publish date led Chinese news and was second in English.
      const you = candidate("you_search", "limit", { ...youLang, contentLevel: youLevel, freshness, preferNews: true });
      return [
        ...(zh ? [exaNews, you] : [you, exaNews]),
        candidate("octen_search", "limit", { freshness, ...(zh ? { language: ["zh"] } : {}) }),
        candidate("serper_news", "limit", { tbs: serperFreshness, ...serperLang }),
        candidate("brave_news_search", "limit", { freshness: braveFreshness, ...braveLang, ...braveMax }),
        candidate("tavily_tavily_search", "max_results", { search_depth: tavilyDepth, topic: "news", time_range: freshness }),
        ...deepseekPair(),
      ];
    }
    case "official":
      return zh
        ? [
            exa,
            candidate("serper_search", "limit", serperLang),
            ...deepseekPair(),
            candidate("parallel_search", "maxResults", { mode: parallelMode }),
            candidate("brave_web_search", "limit", { ...braveLang, ...braveMax }),
          ]
        : [
            exa,
            candidate("brave_web_search", "limit", braveMax),
            candidate("serper_search", "limit"),
            candidate("you_search", "limit", { ...youLang, contentLevel: youLevel }),
            ...deepseekPair(),
            vercelParallel(),
          ];
    case "scholar":
      return [
        quality === "max"
          ? candidate("exa_web_search_exa", "numResults", { objective: `Research papers, preprints, and scholarly reviews about: ${query}` })
          : exaLite({ category: "publication" }),
        candidate("parallel_search", "maxResults", { mode: parallelMode }),
        candidate("you_search", "limit", { ...youLang, contentLevel: youLevel }),
        candidate("serper_scholar", "limit", serperLang),
        vercelParallel(),
      ];
    case "code": {
      const githubDomains = includeDomains.length
        ? includeDomains
        : excludeHosts.includes("github.com")
          ? undefined
          : ["github.com"];
      const exaCodeArgs = githubDomains ? { includeDomains: githubDomains } : {};
      return [
        quality === "max"
          ? candidate("exa_web_search_advanced_exa", "numResults", { type: "auto", ...exaCodeArgs })
          : exaLite(exaCodeArgs),
        candidate("parallel_search", "maxResults", { mode: parallelMode }),
        candidate("serper_search", "limit", serperLang),
        ...deepseekPair(),
        vercelParallel(),
      ];
    }
    default:
      return zh
        ? [
            candidate("brave_web_search", "limit", { ...braveLang, ...braveMax }),
            candidate("serper_search", "limit", serperLang),
            ...deepseekPair(),
            candidate("you_search", "limit", { ...youLang, contentLevel: youLevel }),
            candidate("parallel_search", "maxResults", { mode: parallelMode }),
            vercelParallel(),
            candidate("tavily_tavily_search", "max_results", { search_depth: tavilyDepth }),
          ]
        : [
            // Max serves multi-hop questions, where Exa with highlights led the Artificial Analysis Search Index (2026-10).
            ...(quality === "max" ? [candidate("exa_web_search_advanced_exa", "numResults", { type: "auto", enableHighlights: true })] : []),
            candidate("parallel_search", "maxResults", { mode: parallelMode }),
            candidate("serper_search", "limit"),
            ...(quality === "max" ? [] : [exaLite()]),
            candidate("you_search", "limit", { ...youLang, contentLevel: youLevel }),
            candidate("octen_search", "limit"),
            candidate("brave_web_search", "limit", braveMax),
            candidate("tavily_tavily_search", "max_results", { search_depth: tavilyDepth }),
            ...deepseekPair(),
            vercelParallel(),
          ];
  }
}

/** Han characters with no kana or Hangul: Japanese and Korean text stay on the default routes. */
export function isChineseQuery(query: string): boolean {
  const han = query.match(/[\u3400-\u9fff]/g)?.length ?? 0;
  return han >= 2 && !/[\u3040-\u30ff\uac00-\ud7af]/.test(query);
}

function normalizeImageLang(language: string | undefined, target: "brave" | "serper"): string | undefined {
  if (!language) return undefined;
  const lower = language.trim().toLowerCase();
  if (!lower) return undefined;
  if (lower === "zh" || lower === "zh-cn" || lower === "zh-hans") {
    return target === "brave" ? "zh-hans" : "zh-cn";
  }
  if (lower === "zh-tw" || lower === "zh-hant") {
    return target === "brave" ? "zh-hant" : "zh-tw";
  }
  return language.trim();
}

export function imageCandidates(args: Record<string, unknown> = {}): AutoCandidate[] {
  const query = String(args.query ?? "");
  const limit = Number(args.limit ?? 10);
  const language = typeof args.language === "string" && args.language ? args.language : undefined;
  const serperHl = normalizeImageLang(language, "serper");
  const braveLang = normalizeImageLang(language, "brave");
  if (typeof args.imageUrl === "string" && args.imageUrl.trim()) {
    return [{ name: "serper_lens", nativeArguments: { url: args.imageUrl.trim(), limit, ...(serperHl ? { hl: serperHl } : {}) } }];
  }
  const safesearch = args.safesearch === "off" ? "off" : "strict";
  return [
    {
      name: "brave_image_search",
      nativeArguments: { query, limit, country: "ALL", ...(braveLang ? { searchLang: braveLang } : {}), safesearch },
    },
    {
      name: "serper_images",
      nativeArguments: { query, limit, ...(serperHl ? { hl: serperHl } : {}) },
    },
    {
      name: "parallel_image_search",
      nativeArguments: { query, limit, mode: "fast" },
    },
  ];
}

export const DEFAULT_FETCH_CHARS = 12_000;

/**
 * Known-URL retrieval chain. Balanced starts with zero-cost native Markdown
 * negotiation (when enabled), then the cheapest faithful readers; max leads
 * with Firecrawl for JavaScript-heavy or difficult pages.
 */
export function fetchCandidates(quality: AutoQuality, args: Record<string, unknown> = {}): AutoCandidate[] {
  const url = String(args.url ?? "");
  const maxChars = typeof args.maxChars === "number" ? args.maxChars : DEFAULT_FETCH_CHARS;
  const directMarkdown: AutoCandidate = { name: "direct_markdown_fetch", nativeArguments: { url } };
  const exa: AutoCandidate = { name: "exa_web_fetch_exa", nativeArguments: { urls: [url], maxCharacters: maxChars } };
  const deepseek: AutoCandidate = { name: "deepseek_fetch", nativeArguments: { url } };
  const vercelDeepseek: AutoCandidate = { name: "vercel_deepseek_fetch", nativeArguments: { url } };
  const tavily: AutoCandidate = {
    name: "tavily_tavily_extract",
    nativeArguments: { urls: [url], extract_depth: quality === "max" ? "advanced" : "basic", format: "markdown" },
  };
  const parallel: AutoCandidate = {
    name: "parallel_extract",
    nativeArguments: { urls: [url], fullContent: true, maxCharsPerResult: maxChars },
  };
  const you: AutoCandidate = {
    name: "you_contents",
    nativeArguments: { urls: [url], formats: ["markdown"] },
  };
  const firecrawl: AutoCandidate = {
    name: "firecrawl_firecrawl_scrape",
    nativeArguments: { url, formats: ["markdown"], onlyMainContent: true },
  };
  const linkup: AutoCandidate = { name: "linkup_linkup_fetch", nativeArguments: { url, ...(quality === "max" ? { renderJs: true } : {}) } };
  const anysearch: AutoCandidate = { name: "anysearch_extract", nativeArguments: { url } };
  // TinyFish renders in Chromium; Octen's advanced mode targets hard pages. Both are opt-in through auto: ["fetch"].
  const tinyfish: AutoCandidate = { name: "tinyfish_fetch", nativeArguments: { urls: [url], format: "markdown" } };
  const octen: AutoCandidate = { name: "octen_extract", nativeArguments: { urls: [url], ...(quality === "max" ? { mode: "auto" } : {}) } };
  return quality === "max"
    ? [firecrawl, tinyfish, tavily, parallel, exa, deepseek, vercelDeepseek, you, octen, linkup, anysearch]
    : [directMarkdown, exa, deepseek, vercelDeepseek, tavily, parallel, tinyfish, you, octen, firecrawl, linkup, anysearch];
}
