import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { requestJson, searchTool, type RestAdapter } from "../base.js";
import { normalizeBraveImage, normalizeItem, numberArg, stringArg } from "../normalize.js";

export class BraveAdapter implements RestAdapter {
  tools(): Tool[] {
    const searches = ["web", "news"].map((kind) => searchTool(
      `brave_${kind}_search`,
      `Brave ${kind === "web" ? "Web" : "News"} Search`,
      `Search Brave's independent ${kind} index with the official Search API.`,
      {
        country: { type: "string" },
        searchLang: { type: "string" },
        freshness: { type: "string" },
        safesearch: { type: "string", enum: ["off", "moderate", "strict"] },
      },
    ));
    const context: Tool = {
      name: "brave_llm_context",
      title: "Brave LLM Context",
      description: "Retrieve pre-extracted, relevance-ranked Web content for AI agents, grounding, and RAG with explicit token and URL budgets.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", minLength: 1, maxLength: 400, description: "Search query; Brave allows at most 50 words" },
          country: { type: "string", minLength: 2, maxLength: 2 },
          searchLang: { type: "string", minLength: 2 },
          count: { type: "integer", minimum: 1, maximum: 50, default: 20, description: "Search results considered before context extraction" },
          maximumNumberOfUrls: { type: "integer", minimum: 1, maximum: 50, default: 20 },
          maximumNumberOfTokens: { type: "integer", minimum: 1024, maximum: 32768, default: 4096 },
          maximumNumberOfSnippets: { type: "integer", minimum: 1, maximum: 256, default: 50 },
          contextThresholdMode: { type: "string", enum: ["disabled", "strict", "balanced", "lenient"] },
          maximumNumberOfTokensPerUrl: { type: "integer", minimum: 512, maximum: 8192, default: 4096 },
          maximumNumberOfSnippetsPerUrl: { type: "integer", minimum: 1, maximum: 100, default: 50 },
          goggles: {
            oneOf: [
              { type: "string" },
              { type: "array", minItems: 1, maxItems: 3, items: { type: "string" } },
            ],
          },
          freshness: { type: "string", description: "pd, pw, pm, py, or YYYY-MM-DDtoYYYY-MM-DD" },
          safesearch: { type: "string", enum: ["off", "moderate", "strict"] },
          spellcheck: { type: "boolean", default: true },
          enableLocal: { type: "boolean" },
          enableSourceMetadata: { type: "boolean", default: false },
          locationLatitude: { type: "number", minimum: -90, maximum: 90 },
          locationLongitude: { type: "number", minimum: -180, maximum: 180 },
          locationCity: { type: "string" },
          locationState: { type: "string" },
          locationStateName: { type: "string" },
          locationCountry: { type: "string", minLength: 2, maxLength: 2 },
          locationPostalCode: { type: "string" },
        },
        required: ["query"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    };
    const images: Tool = {
      name: "brave_image_search",
      title: "Brave Image Search",
      description: "Search Brave's independent image index. Returns original image and privacy-proxied thumbnail URLs, source pages, dimensions, descriptions, and publishers when available. This is text-to-image discovery, not reverse image search.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", minLength: 1, maxLength: 400, description: "Image search query; Brave allows at most 50 words" },
          limit: { type: "integer", minimum: 1, maximum: 200, default: 10 },
          country: {
            type: "string",
            enum: ["AR", "AU", "AT", "BE", "BR", "CA", "CL", "DK", "FI", "FR", "DE", "GR", "HK", "IN", "ID", "IT", "JP", "KR", "MY", "MX", "NL", "NZ", "NO", "CN", "PL", "PT", "PH", "RU", "SA", "ZA", "ES", "SE", "CH", "TW", "TR", "GB", "US", "ALL"],
            default: "ALL",
          },
          searchLang: { type: "string", minLength: 2 },
          safesearch: { type: "string", enum: ["off", "strict"], default: "strict" },
          spellcheck: { type: "boolean", default: true },
        },
        required: ["query"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    };
    return [...searches, images, context];
  }

  async call(tool: string, args: Record<string, unknown>, key: string): Promise<unknown> {
    if (tool === "brave_llm_context") return this.callLlmContext(args, key);
    if (tool === "brave_image_search") return this.callImageSearch(args, key);
    const kind = tool.includes("news") ? "news" : "web";
    const url = new URL(`https://api.search.brave.com/res/v1/${kind}/search`);
    url.searchParams.set("q", stringArg(args, "query"));
    url.searchParams.set("count", String(numberArg(args, "limit", 6)));
    for (const [source, target] of [["country", "country"], ["searchLang", "search_lang"], ["freshness", "freshness"], ["safesearch", "safesearch"]] as const) {
      if (stringArg(args, source)) url.searchParams.set(target, stringArg(args, source));
    }
    const data = await requestJson(url.toString(), {
      headers: { Accept: "application/json", "X-Subscription-Token": key },
    });
    const container = data[kind] as Record<string, unknown> | undefined;
    const rows = container?.results ?? data.results;
    return { items: Array.isArray(rows) ? rows.map((row) => normalizeItem(row, { html: true, dateKeys: ["page_age", "age"] })) : [] };
  }

  private async callImageSearch(args: Record<string, unknown>, key: string): Promise<unknown> {
    const url = new URL("https://api.search.brave.com/res/v1/images/search");
    url.searchParams.set("q", stringArg(args, "query"));
    url.searchParams.set("count", String(numberArg(args, "limit", 10)));
    url.searchParams.set("country", stringArg(args, "country", "ALL"));
    for (const [source, target] of [["searchLang", "search_lang"], ["safesearch", "safesearch"]] as const) {
      if (stringArg(args, source)) url.searchParams.set(target, stringArg(args, source));
    }
    if (typeof args.spellcheck === "boolean") url.searchParams.set("spellcheck", String(args.spellcheck));
    const data = await requestJson(url.toString(), {
      headers: { Accept: "application/json", "X-Subscription-Token": key },
    });
    return { items: Array.isArray(data.results) ? data.results.map(normalizeBraveImage) : [] };
  }

  private async callLlmContext(args: Record<string, unknown>, key: string): Promise<unknown> {
    const body: Record<string, unknown> = {
      q: stringArg(args, "query"),
      maximum_number_of_tokens: numberArg(args, "maximumNumberOfTokens", 4096),
    };
    for (const [source, target] of [
      ["country", "country"],
      ["searchLang", "search_lang"],
      ["count", "count"],
      ["maximumNumberOfUrls", "maximum_number_of_urls"],
      ["maximumNumberOfSnippets", "maximum_number_of_snippets"],
      ["contextThresholdMode", "context_threshold_mode"],
      ["maximumNumberOfTokensPerUrl", "maximum_number_of_tokens_per_url"],
      ["maximumNumberOfSnippetsPerUrl", "maximum_number_of_snippets_per_url"],
      ["goggles", "goggles"],
      ["freshness", "freshness"],
      ["safesearch", "safesearch"],
      ["spellcheck", "spellcheck"],
      ["enableLocal", "enable_local"],
      ["enableSourceMetadata", "enable_source_metadata"],
    ] as const) {
      const value = args[source];
      if (value !== undefined && value !== null && value !== "") body[target] = value;
    }
    const headers: Record<string, string> = {
      Accept: "application/json",
      "Accept-Encoding": "gzip",
      "Content-Type": "application/json",
      "X-Subscription-Token": key,
    };
    for (const [source, target] of [
      ["locationLatitude", "X-Loc-Lat"],
      ["locationLongitude", "X-Loc-Long"],
      ["locationCity", "X-Loc-City"],
      ["locationState", "X-Loc-State"],
      ["locationStateName", "X-Loc-State-Name"],
      ["locationCountry", "X-Loc-Country"],
      ["locationPostalCode", "X-Loc-Postal-Code"],
    ] as const) {
      const value = args[source];
      if (typeof value === "string" && value.trim()) headers[target] = value;
      if (typeof value === "number" && Number.isFinite(value)) headers[target] = String(value);
    }
    return requestJson("https://api.search.brave.com/res/v1/llm/context", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }, 30_000);
  }
}
