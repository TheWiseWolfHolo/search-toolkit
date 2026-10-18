export type AutoMode = "general" | "exact" | "current" | "official" | "context";
export type AutoQuality = "balanced" | "max";
export type AutoFreshness = "day" | "week" | "month" | "year";

export interface AutoCandidate {
  name: string;
  nativeArguments?: Record<string, unknown>;
}

export function autoMode(value: unknown): AutoMode {
  return value === "exact" || value === "current" || value === "official" || value === "context"
    ? value
    : "general";
}

function autoFreshness(value: unknown): AutoFreshness {
  return value === "day" || value === "month" || value === "year" ? value : "week";
}

function explicitFreshness(value: unknown): AutoFreshness | undefined {
  return value === "day" || value === "week" || value === "month" || value === "year" ? value : undefined;
}

function cleanDomains(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item ?? "").trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "").toLowerCase())
    .filter(Boolean);
}

function queryWithSiteOperators(query: string, include: string[], exclude: string[]): string {
  const parts = [query];
  if (include.length === 1) parts.push(`site:${include[0]}`);
  else if (include.length > 1) parts.push(`(${include.map((domain) => `site:${domain}`).join(" OR ")})`);
  for (const domain of exclude) parts.push(`-site:${domain}`);
  return parts.join(" ");
}

export function autoCandidates(mode: AutoMode, quality: AutoQuality, args: Record<string, unknown> = {}): AutoCandidate[] {
  const query = String(args.query ?? "");
  const limit = Number(args.limit ?? 6);
  const parallelMode = quality === "max" ? "advanced" : "fast";
  const tavilyDepth = quality === "max" ? "advanced" : "basic";
  const braveTokens = typeof args.maximumNumberOfTokens === "number" ? args.maximumNumberOfTokens : 4096;
  const maxCharsPerResult = typeof args.maxCharsPerResult === "number" && args.maxCharsPerResult > 0
    ? Math.round(args.maxCharsPerResult)
    : undefined;
  const includeDomains = cleanDomains(args.includeDomains);
  const excludeDomains = cleanDomains(args.excludeDomains);
  const hasDomains = includeDomains.length > 0 || excludeDomains.length > 0;
  const siteQuery = hasDomains ? queryWithSiteOperators(query, includeDomains, excludeDomains) : query;

  const freshness = mode === "current" ? autoFreshness(args.freshness) : explicitFreshness(args.freshness);
  const braveFreshness = freshness ? { day: "pd", week: "pw", month: "pm", year: "py" }[freshness] : undefined;
  const serperFreshness = freshness ? { day: "qdr:d", week: "qdr:w", month: "qdr:m", year: "qdr:y" }[freshness] : undefined;
  const parallelMaxAge = freshness ? { day: 86_400, week: 604_800, month: 2_592_000, year: 31_536_000 }[freshness] : undefined;

  const domainArgsFor = (name: string): Record<string, unknown> => {
    if (!hasDomains) return {};
    if (name === "parallel_search" || name === "you_search" || name === "exa_web_search_advanced_exa") {
      return {
        ...(includeDomains.length ? { includeDomains } : {}),
        ...(excludeDomains.length ? { excludeDomains } : {}),
      };
    }
    if (name === "tavily_tavily_search") {
      return {
        ...(includeDomains.length ? { include_domains: includeDomains } : {}),
        ...(excludeDomains.length ? { exclude_domains: excludeDomains } : {}),
      };
    }
    if (name === "querit_search") {
      return {
        ...(includeDomains.length ? { sitesInclude: includeDomains } : {}),
        ...(excludeDomains.length ? { sitesExclude: excludeDomains } : {}),
      };
    }
    return {};
  };

  const timeArgsFor = (name: string): Record<string, unknown> => {
    if (!freshness || mode === "current") return {};
    if (name.startsWith("brave_")) return { freshness: braveFreshness };
    if (name.startsWith("serper_")) return { tbs: serperFreshness };
    if (name === "you_search") return { freshness };
    if (name === "tavily_tavily_search") return { time_range: freshness };
    if (name === "parallel_search") return { maxAgeSeconds: parallelMaxAge };
    if (name === "querit_search") return { timeRange: freshness };
    return {};
  };

  const budgetArgsFor = (name: string): Record<string, unknown> => {
    if (maxCharsPerResult === undefined) return {};
    if (name === "parallel_search") return { maxCharsPerResult };
    if (name === "exa_web_search_advanced_exa") return { contextMaxCharacters: maxCharsPerResult * limit };
    return {};
  };

  const candidate = (
    name: string,
    limitKey: "limit" | "max_results" | "maxResults" | "numResults" | undefined,
    nativeArguments: Record<string, unknown> = {},
  ): AutoCandidate => {
    const usesSiteQuery = hasDomains && (name.startsWith("brave_") || name.startsWith("serper_") || name === "exa_web_search_exa");
    return {
      name,
      nativeArguments: {
        query: usesSiteQuery ? siteQuery : query,
        ...(limitKey ? { [limitKey]: limit } : {}),
        ...domainArgsFor(name),
        ...timeArgsFor(name),
        ...budgetArgsFor(name),
        ...nativeArguments,
      },
    };
  };
  const braveMax = quality === "max" ? { extraSnippets: true } : {};
  switch (mode) {
    case "exact":
      return [
        candidate(quality === "max" ? "exa_web_search_advanced_exa" : "exa_web_search_exa", "numResults"),
        candidate("serper_search", "limit"),
        candidate("tavily_tavily_search", "max_results", { search_depth: tavilyDepth, exact_match: true }),
        candidate("brave_web_search", "limit", braveMax),
      ];
    case "context":
      return quality === "max"
        ? [
            candidate("parallel_search", "maxResults", { mode: "advanced" }),
            candidate("brave_llm_context", undefined, { count: 20, maximumNumberOfTokens: braveTokens }),
            candidate("you_search", "limit", { contentLevel: "highlights" }),
            candidate("tavily_tavily_search", "max_results", { search_depth: "advanced" }),
          ]
        : [
            candidate("brave_llm_context", undefined, { count: 20, maximumNumberOfTokens: braveTokens }),
            candidate("parallel_search", "maxResults", { mode: "basic" }),
            candidate("you_search", "limit", { contentLevel: "highlights" }),
            candidate("tavily_tavily_search", "max_results", { search_depth: "basic" }),
          ];
    case "current":
      return [
        candidate("brave_news_search", "limit", { freshness: braveFreshness, ...braveMax }),
        candidate("serper_news", "limit", { tbs: serperFreshness }),
        candidate("you_search", "limit", { contentLevel: "snippets", freshness }),
        candidate("tavily_tavily_search", "max_results", { search_depth: tavilyDepth, time_range: freshness }),
      ];
    case "official":
      return [
        candidate("serper_search", "limit"),
        candidate("brave_web_search", "limit", braveMax),
        candidate(quality === "max" ? "exa_web_search_advanced_exa" : "exa_web_search_exa", "numResults"),
        candidate("you_search", "limit", { contentLevel: "snippets" }),
      ];
    default:
      return [
        candidate("parallel_search", "maxResults", { mode: parallelMode }),
        candidate("you_search", "limit", { contentLevel: quality === "max" ? "highlights" : "snippets" }),
        candidate("brave_web_search", "limit", braveMax),
        candidate("exa_web_search_exa", "numResults"),
        candidate("querit_search", "limit"),
        candidate("tavily_tavily_search", "max_results", { search_depth: tavilyDepth }),
      ];
  }
}

export function imageCandidates(args: Record<string, unknown> = {}): AutoCandidate[] {
  const query = String(args.query ?? "");
  const limit = Number(args.limit ?? 10);
  const language = typeof args.language === "string" && args.language ? args.language : undefined;
  const safesearch = args.safesearch === "off" ? "off" : "strict";
  return [
    {
      name: "brave_image_search",
      nativeArguments: { query, limit, country: "ALL", ...(language ? { searchLang: language } : {}), safesearch },
    },
    {
      name: "serper_images",
      nativeArguments: { query, limit, ...(language ? { hl: language } : {}) },
    },
    {
      name: "parallel_image_search",
      nativeArguments: { query, limit, mode: "fast" },
    },
  ];
}

export const DEFAULT_FETCH_CHARS = 12_000;

/**
 * Known-URL retrieval chain. Balanced prefers the cheapest faithful reader
 * first; max leads with Firecrawl for JavaScript-heavy or difficult pages.
 */
export function fetchCandidates(quality: AutoQuality, args: Record<string, unknown> = {}): AutoCandidate[] {
  const url = String(args.url ?? "");
  const maxChars = typeof args.maxChars === "number" ? args.maxChars : DEFAULT_FETCH_CHARS;
  const exa: AutoCandidate = { name: "exa_web_fetch_exa", nativeArguments: { urls: [url], maxCharacters: maxChars } };
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
  return quality === "max"
    ? [firecrawl, tavily, parallel, exa, you, linkup, anysearch]
    : [exa, tavily, parallel, you, firecrawl, linkup, anysearch];
}
