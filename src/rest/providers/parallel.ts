import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { TargetPageError } from "../../errors.js";
import type { ProviderConfig } from "../../types.js";
import { baseUrlOf, requestJson, searchTool, type RestAdapter } from "../base.js";
import {
  arrayArg, normalizeParallelImage, normalizeParallelItem, objectRecord, stringArg, stringValue,
} from "../normalize.js";

const READ_ONLY_OPEN = { readOnlyHint: true, destructiveHint: false, openWorldHint: true } as const;

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
        maxCharsPerResult: { type: "integer", minimum: 1 },
        includeDomains: { type: "array", items: { type: "string" } },
        excludeDomains: { type: "array", items: { type: "string" } },
        afterDate: { type: "string", format: "date", description: "Only include content published on or after this YYYY-MM-DD date" },
        maxAgeSeconds: { type: "integer", minimum: 0 },
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
          maxItems: 5,
          items: { type: "string", maxLength: 200 },
          description: "Concise keyword image queries; defaults to [query]",
        },
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

  async call(tool: string, args: Record<string, unknown>, key: string, config: ProviderConfig): Promise<unknown> {
    if (tool === "parallel_extract") return this.callExtract(args, key, config);
    if (tool === "parallel_image_search") return this.callImageSearch(args, key, config);
    return this.callSearch(args, key, config);
  }

  private async callSearch(args: Record<string, unknown>, key: string, config: ProviderConfig): Promise<unknown> {
    const query = stringArg(args, "query");
    const searches = arrayArg(args, "searchQueries");
    const body: Record<string, unknown> = {
      objective: query,
      search_queries: searches.length ? searches : [query],
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
    const include = arrayArg(args, "includeDomains");
    const exclude = arrayArg(args, "excludeDomains");
    const afterDate = stringArg(args, "afterDate");
    if (include.length) sourcePolicy.include_domains = include;
    if (exclude.length) sourcePolicy.exclude_domains = exclude;
    if (afterDate) sourcePolicy.after_date = afterDate;
    if (Object.keys(sourcePolicy).length) advanced.source_policy = sourcePolicy;
    if (typeof args.maxAgeSeconds === "number") advanced.fetch_policy = { max_age_seconds: args.maxAgeSeconds };
    if (typeof args.maxCharsPerResult === "number") advanced.excerpt_settings = { max_chars_per_result: args.maxCharsPerResult };
    const maxResults = typeof args.maxResults === "number"
      ? args.maxResults
      : typeof args.limit === "number"
        ? args.limit
        : undefined;
    if (maxResults !== undefined) advanced.max_results = maxResults;
    if (stringArg(args, "location")) advanced.location = stringArg(args, "location").toLowerCase();
    if (Object.keys(advanced).length) body.advanced_settings = advanced;
    const base = baseUrlOf(config, "https://api.parallel.ai/v1/search");
    const data = await requestJson(base, {
      method: "POST",
      headers: { "x-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }, 60_000);
    return {
      items: Array.isArray(data.results) ? data.results.map(normalizeParallelItem) : [],
      searchId: data.search_id,
      sessionId: data.session_id,
      warnings: data.warnings,
      usage: data.usage,
    };
  }

  private async callExtract(args: Record<string, unknown>, key: string, config: ProviderConfig): Promise<unknown> {
    const urls = collectUrls(args);
    if (!urls.length) throw new Error("parallel_extract requires url or urls");
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
    const maxCharsPerResult = typeof args.maxCharsPerResult === "number" ? args.maxCharsPerResult : undefined;
    if (fullContent) {
      advanced.full_content = maxCharsPerResult !== undefined ? { max_chars_per_result: maxCharsPerResult } : true;
    } else if (maxCharsPerResult !== undefined) {
      advanced.excerpt_settings = { max_chars_per_result: maxCharsPerResult };
    }
    if (typeof args.maxAgeSeconds === "number") {
      advanced.fetch_policy = { max_age_seconds: Math.max(600, args.maxAgeSeconds) };
    }
    if (Object.keys(advanced).length) body.advanced_settings = advanced;
    const base = baseUrlOf(config, "https://api.parallel.ai/v1/extract").replace(/\/v1\/search\/?$/, "/v1/extract");
    const data = await requestJson(base, {
      method: "POST",
      headers: { "x-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }, 60_000);
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
    const text = results.map((entry) => {
      const title = stringValue(entry.title);
      const url = stringValue(entry.url) ?? "";
      const date = stringValue(entry.publish_date);
      const full = stringValue(entry.full_content);
      const excerpts = Array.isArray(entry.excerpts) ? entry.excerpts.map(String).filter(Boolean).join("\n\n") : "";
      const header = [title ? `# ${title}` : "", url ? `URL: ${url}${date ? ` (${date})` : ""}` : ""].filter(Boolean).join("\n");
      return [header, full ?? excerpts].filter(Boolean).join("\n\n");
    }).filter(Boolean).join("\n\n---\n\n");
    return {
      text,
      results,
      errors,
      extractId: data.extract_id,
      sessionId: data.session_id,
      warnings: data.warnings,
      usage: data.usage,
    };
  }

  private async callImageSearch(args: Record<string, unknown>, key: string, config: ProviderConfig): Promise<unknown> {
    const query = stringArg(args, "query");
    const searches = arrayArg(args, "searchQueries");
    const body: Record<string, unknown> = {
      objective: query,
      search_queries: searches.length ? searches : [query],
      mode: stringArg(args, "mode", "fast"),
    };
    for (const [source, target] of [
      ["sessionId", "session_id"],
      ["clientModel", "client_model"],
    ] as const) {
      const value = args[source];
      if (value !== undefined && value !== null && value !== "") body[target] = value;
    }
    const advanced: Record<string, unknown> = {};
    if (typeof args.limit === "number") advanced.max_results = args.limit;
    if (stringArg(args, "location")) advanced.location = stringArg(args, "location").toLowerCase();
    if (Object.keys(advanced).length) body.advanced_settings = advanced;
    const base = baseUrlOf(config, "https://api.parallel.ai/v1/images/search").replace(/\/v1\/search\/?$/, "/v1/images/search");
    const data = await requestJson(base, {
      method: "POST",
      headers: { "x-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }, 30_000);
    return {
      items: Array.isArray(data.results) ? data.results.map(normalizeParallelImage) : [],
      searchId: data.search_id,
      sessionId: data.session_id,
      warnings: data.warnings,
      usage: data.usage,
    };
  }
}

function collectUrls(args: Record<string, unknown>): string[] {
  const urls: string[] = [];
  if (typeof args.url === "string" && args.url.trim()) urls.push(args.url.trim());
  for (const item of arrayArg(args, "urls")) {
    if (!urls.includes(item)) urls.push(item);
  }
  return urls.slice(0, 20);
}
