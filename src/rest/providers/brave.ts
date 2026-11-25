import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { HttpError } from "../../errors.js";
import type { ProviderConfig } from "../../types.js";
import {
  endpointOf, READ_ONLY_OPEN, requestJson, searchTool, timeoutOf,
  type RestAdapter, type RestAdapterContext,
} from "../base.js";
import { normalizeBraveImage, normalizeItem, numberArg, stringArg } from "../normalize.js";

function observeBraveQuota(headers: Headers, context?: RestAdapterContext): void {
  if (!context?.recordPassiveQuota) return;
  const rawRemaining = headers.get("x-ratelimit-remaining") ?? headers.get("ratelimit-remaining");
  if (!rawRemaining) return;
  const parts = rawRemaining.split(",").map((part) => Number(part.trim()));
  if (parts.length >= 2) {
    const monthly = parts[1];
    if (monthly !== undefined && Number.isFinite(monthly) && monthly >= 0) {
      context.recordPassiveQuota(monthly, "credits");
    }
    return;
  }
  const single = parts[0];
  const rawLimit = headers.get("x-ratelimit-limit") ?? headers.get("ratelimit-limit");
  const limitVal = rawLimit ? Number(rawLimit.split(",")[0]?.trim()) : undefined;
  if (single !== undefined && Number.isFinite(single) && single >= 0 && limitVal !== undefined && Number.isFinite(limitVal) && limitVal > 100) {
    context.recordPassiveQuota(single, "credits");
  }
}

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
        extraSnippets: { type: "boolean", description: "Return up to 5 extra text excerpts per result" },
        offset: { type: "integer", minimum: 0, maximum: 9, description: "Pagination offset (0-9)" },
        goggles: {
          oneOf: [
            { type: "string" },
            { type: "array", minItems: 1, maxItems: 3, items: { type: "string" } },
          ],
          description: "Custom ranking Goggle URL(s) or inline Goggle DSL rules",
        },
      },
    ));
    const context: Tool = {
      name: "brave_llm_context",
      title: "Brave LLM Context",
      description: "Retrieve pre-extracted, relevance-ranked Web content for AI agents, grounding, and RAG with explicit token and URL budgets.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", minLength: 1, maxLength: 600, description: "Search query; Brave allows at most 75 words" },
          country: { type: "string", minLength: 2, maxLength: 2 },
          searchLang: { type: "string", minLength: 2 },
          count: { type: "integer", minimum: 1, maximum: 50, default: 20, description: "Search results considered before context extraction" },
          maximumNumberOfUrls: { type: "integer", minimum: 1, maximum: 50, default: 20 },
          maximumNumberOfTokens: { type: "integer", minimum: 1024, maximum: 32768, default: 8192 },
          maximumNumberOfSnippets: { type: "integer", minimum: 1, maximum: 256, default: 50, description: "Legacy snippet count cap; prefer maximumNumberOfTokens and maximumNumberOfUrls" },
          contextThresholdMode: { type: "string", enum: ["disabled", "strict", "balanced", "lenient"] },
          maximumNumberOfTokensPerUrl: { type: "integer", minimum: 512, maximum: 8192, default: 4096 },
          maximumNumberOfSnippetsPerUrl: { type: "integer", minimum: 1, maximum: 100, default: 50, description: "Legacy per-URL snippet cap; prefer maximumNumberOfTokensPerUrl" },
          goggles: {
            oneOf: [
              { type: "string" },
              { type: "array", minItems: 1, maxItems: 3, items: { type: "string" } },
            ],
          },
          freshness: { type: "string", description: "pd, pw, pm, py, or YYYY-MM-DDtoYYYY-MM-DD" },
          safesearch: { type: "string", enum: ["off", "moderate", "strict"] },
          spellcheck: { type: "boolean", default: true },
          operators: { type: "boolean", default: true, description: "Apply search operators such as site: and quotes" },
          operatorsFallback: { type: "boolean", default: true, description: "Fall back to plain results when operator matching finds nothing" },
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
      annotations: READ_ONLY_OPEN,
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
      annotations: READ_ONLY_OPEN,
    };
    return [...searches, images, context];
  }

  async call(
    tool: string,
    args: Record<string, unknown>,
    key: string,
    config?: ProviderConfig,
    context?: RestAdapterContext,
  ): Promise<unknown> {
    if (tool === "brave_llm_context") return this.callLlmContext(args, key, config, context);
    if (tool === "brave_image_search") return this.callImageSearch(args, key, config, context);
    const kind = tool.includes("news") ? "news" : "web";
    const limit = Math.max(1, Math.round(numberArg(args, "limit", 6)));
    const url = new URL(endpointOf(config, "https://api.search.brave.com", `/res/v1/${kind}/search`));
    // Plain text on Web Search (News Search does not accept text_decorations).
    if (kind === "web") url.searchParams.set("text_decorations", "false");
    url.searchParams.set("q", stringArg(args, "query"));
    url.searchParams.set("count", String(limit));
    const country = stringArg(args, "country").trim();
    if (country) url.searchParams.set("country", country.toUpperCase());
    for (const [source, target] of [["searchLang", "search_lang"], ["freshness", "freshness"], ["safesearch", "safesearch"]] as const) {
      const value = stringArg(args, source).trim();
      if (value) url.searchParams.set(target, value);
    }
    if (typeof args.extraSnippets === "boolean") url.searchParams.set("extra_snippets", String(args.extraSnippets));
    if (typeof args.offset === "number" && Number.isFinite(args.offset)) url.searchParams.set("offset", String(args.offset));
    if (typeof args.goggles === "string" && args.goggles) url.searchParams.set("goggles", args.goggles);
    else if (Array.isArray(args.goggles)) {
      for (const goggle of args.goggles) {
        if (typeof goggle === "string" && goggle) url.searchParams.append("goggles", goggle);
      }
    }
    const data = await requestJson(url.toString(), {
      headers: { Accept: "application/json", "X-Subscription-Token": key },
    }, {
      timeoutMs: timeoutOf(config, 15_000),
      ...(context?.signal ? { signal: context.signal } : {}),
      onHeaders: (headers) => observeBraveQuota(headers, context),
    });
    const container = data[kind] as Record<string, unknown> | undefined;
    const rows = container?.results ?? data.results;
    return {
      items: Array.isArray(rows)
        ? rows.slice(0, limit).map((row) => normalizeItem(row, { html: true, dateKeys: ["page_age", "age"] }))
        : [],
    };
  }

  private async callImageSearch(
    args: Record<string, unknown>,
    key: string,
    config?: ProviderConfig,
    context?: RestAdapterContext,
  ): Promise<unknown> {
    const limit = Math.max(1, Math.round(numberArg(args, "limit", 10)));
    const url = new URL(endpointOf(config, "https://api.search.brave.com", "/res/v1/images/search"));
    url.searchParams.set("q", stringArg(args, "query"));
    url.searchParams.set("count", String(limit));
    url.searchParams.set("country", stringArg(args, "country", "ALL").trim().toUpperCase() || "ALL");
    for (const [source, target] of [["searchLang", "search_lang"], ["safesearch", "safesearch"]] as const) {
      const value = stringArg(args, source).trim();
      if (value) url.searchParams.set(target, value);
    }
    if (typeof args.spellcheck === "boolean") url.searchParams.set("spellcheck", String(args.spellcheck));
    const data = await requestJson(url.toString(), {
      headers: { Accept: "application/json", "X-Subscription-Token": key },
    }, {
      timeoutMs: timeoutOf(config, 15_000),
      ...(context?.signal ? { signal: context.signal } : {}),
      onHeaders: (headers) => observeBraveQuota(headers, context),
    });
    return { items: Array.isArray(data.results) ? data.results.slice(0, limit).map(normalizeBraveImage) : [] };
  }

  private async callLlmContext(
    args: Record<string, unknown>,
    key: string,
    config?: ProviderConfig,
    context?: RestAdapterContext,
  ): Promise<unknown> {
    const body: Record<string, unknown> = {
      q: stringArg(args, "query"),
      maximum_number_of_tokens: numberArg(args, "maximumNumberOfTokens", 8192),
    };
    const country = stringArg(args, "country").trim();
    if (country) body.country = country.toUpperCase();
    for (const [source, target] of [
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
      ["operators", "operators"],
      ["operatorsFallback", "operators_fallback"],
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
      if (typeof value === "string" && value.trim()) {
        const normalized = source === "locationCountry" ? value.trim().toUpperCase() : value;
        headers[target] = sanitizeHeaderValue(normalized);
      }
      if (typeof value === "number" && Number.isFinite(value)) headers[target] = String(value);
    }
    const data = await requestJson(endpointOf(config, "https://api.search.brave.com", "/res/v1/llm/context"), {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }, {
      timeoutMs: timeoutOf(config, 30_000),
      ...(context?.signal ? { signal: context.signal } : {}),
      onHeaders: (responseHeaders) => observeBraveQuota(responseHeaders, context),
    });
    if (!data.grounding || typeof data.grounding !== "object") {
      throw new HttpError("HTTP 502: Brave LLM Context returned no grounding payload", 502);
    }
    return data;
  }
}

function sanitizeHeaderValue(raw: string): string {
  const cleaned = raw.replace(/[\r\n]+/g, " ").trim();
  return /[^\x20-\x7e]/.test(cleaned) ? encodeURIComponent(cleaned) : cleaned;
}
