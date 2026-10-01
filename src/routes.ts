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

export function autoCandidates(mode: AutoMode, quality: AutoQuality, args: Record<string, unknown> = {}): AutoCandidate[] {
  const query = String(args.query ?? "");
  const limit = Number(args.limit ?? 6);
  const parallelMode = quality === "max" ? "advanced" : "fast";
  const tavilyDepth = quality === "max" ? "advanced" : "basic";
  const braveTokens = typeof args.maximumNumberOfTokens === "number" ? args.maximumNumberOfTokens : 4096;
  const freshness = autoFreshness(args.freshness);
  const braveFreshness = { day: "pd", week: "pw", month: "pm", year: "py" }[freshness];
  const serperFreshness = { day: "qdr:d", week: "qdr:w", month: "qdr:m", year: "qdr:y" }[freshness];
  const candidate = (
    name: string,
    limitKey: "limit" | "max_results" | "maxResults" | "numResults" | undefined,
    nativeArguments: Record<string, unknown> = {},
  ): AutoCandidate => ({
    name,
    nativeArguments: {
      query,
      ...(limitKey ? { [limitKey]: limit } : {}),
      ...nativeArguments,
    },
  });
  switch (mode) {
    case "exact":
      return [
        candidate(quality === "max" ? "exa_web_search_advanced_exa" : "exa_web_search_exa", "numResults"),
        candidate("serper_search", "limit"),
        candidate("tavily_tavily_search", "max_results", { search_depth: tavilyDepth, exact_match: true }),
        candidate("brave_web_search", "limit"),
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
        candidate("brave_news_search", "limit", { freshness: braveFreshness }),
        candidate("serper_news", "limit", { tbs: serperFreshness }),
        candidate("you_search", "limit", { contentLevel: "snippets", freshness }),
        candidate("tavily_tavily_search", "max_results", { search_depth: tavilyDepth, time_range: freshness }),
      ];
    case "official":
      return [
        candidate("serper_search", "limit"),
        candidate("brave_web_search", "limit"),
        candidate(quality === "max" ? "exa_web_search_advanced_exa" : "exa_web_search_exa", "numResults"),
        candidate("you_search", "limit", { contentLevel: "snippets" }),
      ];
    default:
      return [
        candidate("parallel_search", "maxResults", { mode: parallelMode }),
        candidate("you_search", "limit", { contentLevel: quality === "max" ? "highlights" : "snippets" }),
        candidate("brave_web_search", "limit"),
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
  const firecrawl: AutoCandidate = {
    name: "firecrawl_firecrawl_scrape",
    nativeArguments: { url, formats: ["markdown"], onlyMainContent: true },
  };
  const linkup: AutoCandidate = { name: "linkup_linkup_fetch", nativeArguments: { url, ...(quality === "max" ? { renderJs: true } : {}) } };
  const anysearch: AutoCandidate = { name: "anysearch_extract", nativeArguments: { url } };
  return quality === "max"
    ? [firecrawl, tavily, exa, linkup, anysearch]
    : [exa, tavily, firecrawl, linkup, anysearch];
}
