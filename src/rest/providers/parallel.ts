import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { TargetPageError } from "../../errors.js";
import type { ProviderConfig } from "../../types.js";
import {
  cleanDomains, collectValidatedUrls, endpointOf, formatExtractedLink, formatExtractedPage, READ_ONLY_OPEN,
  requestJson, searchTool, timeoutOf, type RestAdapter, type RestAdapterContext,
} from "../base.js";
import {
  arrayArg, DEFAULT_ITEM_TEXT_CHARS, normalizeParallelImage, normalizeParallelItem, numberArg, objectRecord,
  stringArg, stringValue,
} from "../normalize.js";

function mergeWarnings(upstream: unknown, extra: readonly string[]): unknown {
  if (!extra.length) return upstream;
  const list = Array.isArray(upstream) ? [...upstream, ...extra] : [...extra];
  return list;
}

export class ParallelAdapter implements RestAdapter {
  tools(): Tool[] {
    const search = searchTool(
      "parallel_search",
      "Parallel Search",
      "Search Parallel's AI-native index with a natural-language objective and LLM-optimized excerpts. Supply 1-3 concise keyword queries when possible.",
      {
        searchQueries: {
          type: "array",
          minItems: 1,
          maxItems: 5,
          items: { type: "string", maxLength: 200 },
          description: "Concise 3-6 word keyword searches; the main query is used if omitted",
        },
        mode: {
          type: "string",
          enum: ["turbo", "fast", "basic", "advanced"],
          default: "fast",
          description: "Fast is the recommended default for most agents and shares turbo's price tier; turbo minimizes latency and is limited to English and Japanese, basic returns extended excerpts at the same price tier as advanced, and advanced targets highest-quality multi-hop retrieval",
        },
        maxCharsTotal: { type: "integer", minimum: 1 },
        maxResults: { type: "integer", minimum: 1, maximum: 20 },
        maxCharsPerResult: { type: "integer", minimum: 1, description: "Approximate per-result budget; mapped to max_chars_total when maxCharsTotal is unset" },
        includeDomains: { type: "array", items: { type: "string" } },
        excludeDomains: { type: "array", items: { type: "string" } },
        afterDate: { type: "string", format: "date", description: "Only include content published on or after this YYYY-MM-DD date" },
        maxAgeSeconds: { type: "integer", minimum: 600, description: "Max cached page age in seconds before a live fetch (not a publish-date filter; use afterDate)" },
        location: { type: "string", minLength: 2, maxLength: 2, description: "ISO 3166-1 alpha-2 country code" },
        sessionId: { type: "string", maxLength: 1000 },
        clientModel: { type: "string" },
      },
    );
    const extract: Tool = {
      name: "parallel_extract",
      title: "Parallel Extract",
      description: "Extract clean, LLM-optimized Markdown excerpts or full page content from 1-20 public URLs via Parallel's v1 Extract API.",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", minLength: 1, description: "Single public http(s) URL to extract" },
          urls: {
            type: "array",
            minItems: 1,
            maxItems: 20,
            items: { type: "string", minLength: 1 },
            description: "Up to 20 public http(s) URLs to extract",
          },
          objective: { type: "string", description: "Optional natural-language goal to focus extracted excerpts" },
          searchQueries: {
            type: "array",
            minItems: 1,
            maxItems: 5,
            items: { type: "string", maxLength: 200 },
            description: "Optional keyword queries to focus extracted excerpts",
          },
          fullContent: { type: "boolean", default: true, description: "Return full Markdown page content alongside excerpts" },
          links: { type: "boolean", description: "Return extracted links from each page" },
          maxCharsPerResult: { type: "integer", minimum: 100, description: "Max characters per URL" },
          maxCharsTotal: { type: "integer", minimum: 100 },
          maxAgeSeconds: { type: "integer", minimum: 600, description: "Max cached content age in seconds before live fetch (min 600)" },
          sessionId: { type: "string", maxLength: 1000 },
          clientModel: { type: "string" },
        },
        additionalProperties: false,
      },
      annotations: READ_ONLY_OPEN,
    };
    const imageSearch = searchTool(
      "parallel_image_search",
      "Parallel Image Search",
      "Search Parallel's web image index with keyword queries and a natural-language objective. Returns direct image URLs, source page URLs, and dimensions.",
      {
        searchQueries: {
          type: "array",
          minItems: 1,
          maxItems: 3,
          items: { type: "string", maxLength: 200 },
          description: "Up to 3 concise keyword image queries; defaults to [query]",
        },
        limit: { type: "integer", minimum: 1, maximum: 20, default: 10 },
        mode: {
          type: "string",
          enum: ["fast", "advanced"],
          default: "fast",
          description: "fast minimizes latency and cost; advanced targets higher-quality image discovery",
        },
        location: { type: "string", minLength: 2, maxLength: 2, description: "ISO 3166-1 alpha-2 country code" },
        sessionId: { type: "string", maxLength: 1000 },
        clientModel: { type: "string" },
      },
    );
    return [search, extract, imageSearch];
  }

  async call(
    tool: string,
    args: Record<string, unknown>,
    key: string,
    config: ProviderConfig,
    context?: RestAdapterContext,
  ): Promise<unknown> {
    if (tool === "parallel_extract") return this.callExtract(args, key, config, context);
    if (tool === "parallel_image_search") return this.callImageSearch(args, key, config, context);
    return this.callSearch(args, key, config, context);
  }

  private async callSearch(
    args: Record<string, unknown>,
    key: string,
    config: ProviderConfig,
    context?: RestAdapterContext,
  ): Promise<unknown> {
    const query = stringArg(args, "query");
    const searches = arrayArg(args, "searchQueries");
    const localWarnings: string[] = [];
    const body: Record<string, unknown> = {
      objective: query,
      search_queries: searches.length ? searches : [Array.from(query).slice(0, 200).join("")],
      mode: stringArg(args, "mode", "fast"),
    };
    for (const [source, target] of [
      ["maxCharsTotal", "max_chars_total"],
      ["sessionId", "session_id"],
      ["clientModel", "client_model"],
    ] as const) {
      const value = args[source];
      if (value !== undefined && value !== null && value !== "") body[target] = value;
    }
    const advanced: Record<string, unknown> = {};
    const sourcePolicy: Record<string, unknown> = {};
    const include = cleanDomains(arrayArg(args, "includeDomains"));
    const exclude = cleanDomains(arrayArg(args, "excludeDomains"));
    const afterDate = stringArg(args, "afterDate").trim();
    // Parallel ignores exclude_domains next to include_domains; an include list already decides.
    if (include.length) {
      sourcePolicy.include_domains = include;
      if (exclude.length) {
        localWarnings.push("excludeDomains was ignored because Parallel does not combine exclude_domains with include_domains");
      }
    } else if (exclude.length) {
      sourcePolicy.exclude_domains = exclude;
    }
    if (afterDate) sourcePolicy.after_date = afterDate;
    if (Object.keys(sourcePolicy).length) advanced.source_policy = sourcePolicy;
    if (typeof args.maxAgeSeconds === "number" && Number.isFinite(args.maxAgeSeconds)) {
      advanced.fetch_policy = { max_age_seconds: Math.max(600, Math.round(args.maxAgeSeconds)) };
    }
    const maxResults = typeof args.maxResults === "number" && Number.isFinite(args.maxResults)
      ? Math.min(20, Math.max(1, Math.round(args.maxResults)))
      : Math.min(20, Math.max(1, Math.round(numberArg(args, "limit", 6))));
    const maxCharsPerResult = typeof args.maxCharsPerResult === "number" && Number.isFinite(args.maxCharsPerResult)
      ? args.maxCharsPerResult
      : undefined;
    if (body.max_chars_total === undefined && maxCharsPerResult !== undefined) {
      // Parallel v1 Search uses top-level max_chars_total instead of advanced_settings.excerpt_settings.
      body.max_chars_total = Math.max(1, Math.round(maxCharsPerResult * maxResults));
    }
    advanced.max_results = maxResults;
    if (stringArg(args, "location").trim()) advanced.location = stringArg(args, "location").trim().toLowerCase();
    if (Object.keys(advanced).length) body.advanced_settings = advanced;
    const data = await requestJson(endpointOf(config, "https://api.parallel.ai", "/v1/search"), {
      method: "POST",
      headers: { "x-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }, {
      timeoutMs: timeoutOf(config, 60_000),
      ...(context?.signal ? { signal: context.signal } : {}),
    });
    const itemMaxChars = Math.max(DEFAULT_ITEM_TEXT_CHARS, maxCharsPerResult ? Math.round(maxCharsPerResult) : 0);
    return {
      items: Array.isArray(data.results) ? data.results.slice(0, maxResults).map((row) => normalizeParallelItem(row, itemMaxChars)) : [],
      searchId: data.search_id,
      sessionId: data.session_id,
      warnings: mergeWarnings(data.warnings, localWarnings),
      usage: data.usage,
    };
  }

  private async callExtract(
    args: Record<string, unknown>,
    key: string,
    config: ProviderConfig,
    context?: RestAdapterContext,
  ): Promise<unknown> {
    const urls = collectValidatedUrls(args, "parallel_extract", 20);
    const body: Record<string, unknown> = { urls };
    if (stringArg(args, "objective")) body.objective = stringArg(args, "objective");
    const searches = arrayArg(args, "searchQueries");
    if (searches.length) body.search_queries = searches;
    for (const [source, target] of [
      ["maxCharsTotal", "max_chars_total"],
      ["sessionId", "session_id"],
      ["clientModel", "client_model"],
    ] as const) {
      const value = args[source];
      if (value !== undefined && value !== null && value !== "") body[target] = value;
    }
    const advanced: Record<string, unknown> = {};
    const fullContent = args.fullContent !== false;
    const maxCharsPerResult = typeof args.maxCharsPerResult === "number" && Number.isFinite(args.maxCharsPerResult)
      ? args.maxCharsPerResult
      : undefined;
    if (fullContent) {
      advanced.full_content = maxCharsPerResult !== undefined ? { max_chars_per_result: maxCharsPerResult } : true;
    } else if (maxCharsPerResult !== undefined) {
      advanced.excerpt_settings = { max_chars_per_result: maxCharsPerResult };
    }
    if (typeof args.maxAgeSeconds === "number" && Number.isFinite(args.maxAgeSeconds)) {
      advanced.fetch_policy = { max_age_seconds: Math.max(600, Math.round(args.maxAgeSeconds)) };
    }
    if (args.links === true) advanced.links = true;
    if (Object.keys(advanced).length) body.advanced_settings = advanced;
    const data = await requestJson(endpointOf(config, "https://api.parallel.ai", "/v1/extract"), {
      method: "POST",
      headers: { "x-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }, {
      timeoutMs: timeoutOf(config, 60_000),
      ...(context?.signal ? { signal: context.signal } : {}),
    });
    const results = Array.isArray(data.results) ? data.results.map(objectRecord) : [];
    const errors = Array.isArray(data.errors) ? data.errors.map(objectRecord) : [];
    if (results.length === 0 && errors.length > 0) {
      const firstErr = errors[0] ?? {};
      // http_status_code is what the page answered Parallel, not a verdict on our key.
      const pageStatus = typeof firstErr.http_status_code === "number" ? firstErr.http_status_code : undefined;
      throw new TargetPageError(
        `Parallel extract failed${pageStatus ? ` (page answered ${pageStatus})` : ""}: ${String(firstErr.content ?? firstErr.error_type ?? "fetch_error")}`,
        pageStatus,
      );
    }
    const sections = results.map((entry) => {
      const title = stringValue(entry.title);
      const url = stringValue(entry.url);
      const date = stringValue(entry.publish_date);
      const full = stringValue(entry.full_content)?.trim();
      const excerpts = Array.isArray(entry.excerpts)
        ? entry.excerpts.map((part) => (typeof part === "string" ? part.trim() : "")).filter(Boolean).join("\n\n")
        : "";
      const bodyText = full || excerpts;
      const links = args.links === true && Array.isArray(entry.links)
        ? entry.links.slice(0, 50).map(formatExtractedLink).filter(Boolean)
        : [];
      if (!bodyText && !links.length) return "";
      return formatExtractedPage({
        ...(title ? { title } : {}),
        ...(url ? { url } : {}),
        ...(date ? { date } : {}),
        body: bodyText,
        ...(links.length ? { links } : {}),
      });
    }).filter(Boolean);
    if (!sections.length) {
      throw new TargetPageError("Parallel extract returned no content for the page");
    }
    return {
      text: sections.join("\n\n---\n\n"),
      results,
      errors,
      extractId: data.extract_id,
      sessionId: data.session_id,
      warnings: data.warnings,
      usage: data.usage,
    };
  }

  private async callImageSearch(
    args: Record<string, unknown>,
    key: string,
    config: ProviderConfig,
    context?: RestAdapterContext,
  ): Promise<unknown> {
    const query = stringArg(args, "query");
    const searches = arrayArg(args, "searchQueries");
    const limit = Math.min(20, Math.max(1, Math.round(numberArg(args, "limit", 10))));
    const body: Record<string, unknown> = {
      objective: query,
      search_queries: searches.length ? searches : [Array.from(query).slice(0, 200).join("")],
      mode: stringArg(args, "mode", "fast"),
    };
    for (const [source, target] of [
      ["sessionId", "session_id"],
      ["clientModel", "client_model"],
    ] as const) {
      const value = args[source];
      if (value !== undefined && value !== null && value !== "") body[target] = value;
    }
    const advanced: Record<string, unknown> = { max_results: limit };
    if (stringArg(args, "location").trim()) advanced.location = stringArg(args, "location").trim().toLowerCase();
    body.advanced_settings = advanced;
    const data = await requestJson(endpointOf(config, "https://api.parallel.ai", "/v1/images/search"), {
      method: "POST",
      headers: { "x-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }, {
      timeoutMs: timeoutOf(config, 30_000),
      ...(context?.signal ? { signal: context.signal } : {}),
    });
    return {
      items: Array.isArray(data.results) ? data.results.slice(0, limit).map(normalizeParallelImage) : [],
      searchId: data.search_id,
      sessionId: data.session_id,
      warnings: data.warnings,
      usage: data.usage,
    };
  }
}
