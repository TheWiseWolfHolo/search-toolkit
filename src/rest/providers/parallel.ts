import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ProviderConfig } from "../../types.js";
import { baseUrlOf, requestJson, searchTool, type RestAdapter } from "../base.js";
import { arrayArg, normalizeParallelItem, stringArg } from "../normalize.js";

export class ParallelAdapter implements RestAdapter {
  tools(): Tool[] {
    return [searchTool(
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
        maxAgeSeconds: { type: "integer", minimum: 0 },
        location: { type: "string", minLength: 2, maxLength: 2, description: "ISO 3166-1 alpha-2 country code" },
        sessionId: { type: "string", maxLength: 1000 },
        clientModel: { type: "string" },
      },
    )];
  }

  async call(_tool: string, args: Record<string, unknown>, key: string, config: ProviderConfig): Promise<unknown> {
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
    if (include.length) sourcePolicy.include_domains = include;
    if (exclude.length) sourcePolicy.exclude_domains = exclude;
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
}
