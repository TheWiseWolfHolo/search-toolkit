import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { TargetPageError } from "../../errors.js";
import type { ProviderConfig } from "../../types.js";
import {
  cleanHosts, collectValidatedUrls, formatExtractedLink, formatExtractedPage, READ_ONLY_OPEN, requestJson,
  searchTool, timeoutOf, validateFetchTargetUrl, type RestAdapter, type RestAdapterContext,
} from "../base.js";
import { arrayArg, normalizeItem, numberArg, objectRecord, stringArg, stringValue } from "../normalize.js";

const SEARCH_ENDPOINT = "https://api.search.tinyfish.ai";
const FETCH_ENDPOINT = "https://api.fetch.tinyfish.ai";

const FETCH_TOOL: Tool = {
  name: "tinyfish_fetch",
  title: "TinyFish Fetch",
  description: "Read 1-10 known URLs through TinyFish's Chromium-rendered Fetch API and return clean Markdown, HTML, or a JSON document tree. Free up to 1,000 URLs a day.",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", minLength: 1, description: "Single public http(s) URL" },
      urls: { type: "array", minItems: 1, maxItems: 10, items: { type: "string", minLength: 1 } },
      format: { type: "string", enum: ["markdown", "html", "json"], default: "markdown" },
      purpose: { type: "string", minLength: 1, maxLength: 2000, description: "Why the pages are being read; helps extraction" },
      links: { type: "boolean", description: "Also return the page's links" },
      ttl: { type: "integer", minimum: 0, description: "Accept cached copies younger than this many seconds; 0 forces a live fetch" },
      includeSelectors: { type: "array", minItems: 1, maxItems: 20, items: { type: "string", minLength: 1 }, description: "CSS selectors to keep" },
      excludeSelectors: { type: "array", minItems: 1, maxItems: 20, items: { type: "string", minLength: 1 }, description: "CSS selectors to drop" },
      perUrlTimeoutMs: { type: "integer", minimum: 5_000, maximum: 110_000, default: 45_000, description: "Per-URL render timeout in milliseconds (up to 110000)" },
    },
    additionalProperties: false,
  },
  annotations: READ_ONLY_OPEN,
};

function resolveTinyfishUrl(config: ProviderConfig | undefined, kind: "search" | "fetch"): string {
  const optionKey = kind === "search" ? "searchBaseUrl" : "fetchBaseUrl";
  const rawOption = config?.options?.[optionKey];
  if (typeof rawOption === "string" && rawOption.trim()) {
    validateFetchTargetUrl(rawOption.trim(), `tinyfish_${kind}`);
    return rawOption.trim();
  }
  const configuredBase = config?.integration.kind === "rest" && config.integration.baseUrl
    ? config.integration.baseUrl.trim()
    : undefined;
  if (!configuredBase) return kind === "search" ? SEARCH_ENDPOINT : FETCH_ENDPOINT;
  const lower = configuredBase.toLowerCase();
  if (kind === "search") {
    return lower.includes("api.fetch.tinyfish.ai") || /\/fetch\/?$/.test(lower)
      ? SEARCH_ENDPOINT
      : configuredBase;
  }
  // Avoid routing POST fetch requests onto a search-only baseUrl when search & fetch live on separate hosts.
  return lower.includes("fetch") ? configuredBase : FETCH_ENDPOINT;
}

export class TinyfishAdapter implements RestAdapter {
  tools(): Tool[] {
    return [searchTool(
      "tinyfish_search",
      "TinyFish Search",
      "Search through TinyFish's official Search API (web, news, and research papers). TinyFish browser automation remains available through its official CLI/MCP separately.",
      {
        location: { type: "string" },
        language: { type: "string" },
        purpose: { type: "string", maxLength: 2000, description: "Why the results are needed; guides ranking and snippet selection" },
        domainType: { type: "string", enum: ["web", "news", "research_paper"], description: "Vertical filter: web, news, or research_paper" },
        recencyMinutes: { type: "integer", minimum: 1, description: "Only return results from the past N minutes" },
        afterDate: { type: "string", format: "date", description: "Only include results published on or after YYYY-MM-DD" },
        beforeDate: { type: "string", format: "date", description: "Only include results published on or before YYYY-MM-DD" },
        includeDomains: { type: "array", items: { type: "string" } },
        excludeDomains: { type: "array", items: { type: "string" } },
      },
    ), FETCH_TOOL];
  }

  async call(
    tool: string,
    args: Record<string, unknown>,
    key: string,
    config: ProviderConfig,
    context?: RestAdapterContext,
  ): Promise<unknown> {
    if (tool === "tinyfish_fetch") return this.fetch(args, key, config, context);
    const limit = Math.max(1, Math.round(numberArg(args, "limit", 6)));
    const url = new URL(resolveTinyfishUrl(config, "search"));
    url.searchParams.set("query", stringArg(args, "query"));
    url.searchParams.set("limit", String(limit));
    for (const [source, target] of [
      ["location", "location"],
      ["language", "language"],
      ["purpose", "purpose"],
      ["domainType", "domain_type"],
      ["afterDate", "after_date"],
      ["beforeDate", "before_date"],
    ] as const) {
      if (stringArg(args, source)) url.searchParams.set(target, stringArg(args, source));
    }
    if (typeof args.recencyMinutes === "number" && Number.isFinite(args.recencyMinutes)) {
      url.searchParams.set("recency_minutes", String(Math.round(args.recencyMinutes)));
    }
    const includeDomains = cleanHosts(arrayArg(args, "includeDomains"));
    const excludeDomains = cleanHosts(arrayArg(args, "excludeDomains"));
    if (includeDomains.length) url.searchParams.set("include_domains", includeDomains.join(","));
    if (excludeDomains.length) url.searchParams.set("exclude_domains", excludeDomains.join(","));
    const data = await requestJson(url.toString(), {
      headers: { "X-API-Key": key },
    }, {
      timeoutMs: timeoutOf(config, 15_000),
      ...(context?.signal ? { signal: context.signal } : {}),
    });
    return {
      items: Array.isArray(data.results)
        ? data.results.slice(0, limit).map((row) => normalizeTinyfishItem(row))
        : [],
    };
  }

  private async fetch(
    args: Record<string, unknown>,
    key: string,
    config: ProviderConfig,
    context?: RestAdapterContext,
  ): Promise<unknown> {
    const urls = collectValidatedUrls(args, "tinyfish_fetch", 10);
    const format = stringArg(args, "format", "markdown");
    const perUrlTimeoutMs = typeof args.perUrlTimeoutMs === "number" && Number.isFinite(args.perUrlTimeoutMs)
      ? args.perUrlTimeoutMs
      : 45_000;
    const body: Record<string, unknown> = { urls, format, per_url_timeout_ms: perUrlTimeoutMs };
    if (stringArg(args, "purpose").trim()) body.purpose = stringArg(args, "purpose").trim();
    if (typeof args.links === "boolean") body.links = args.links;
    if (typeof args.ttl === "number" && Number.isFinite(args.ttl)) body.ttl = args.ttl;
    for (const [source, target] of [["includeSelectors", "include_selectors"], ["excludeSelectors", "exclude_selectors"]] as const) {
      const values = arrayArg(args, source);
      if (values.length) body[target] = values;
    }
    const fetchUrl = resolveTinyfishUrl(config, "fetch");
    const data = await requestJson(fetchUrl, {
      method: "POST",
      headers: { "X-API-Key": key, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }, {
      timeoutMs: timeoutOf(config, Math.max(60_000, perUrlTimeoutMs + 15_000)),
      ...(context?.signal ? { signal: context.signal } : {}),
    });
    const results = Array.isArray(data.results) ? data.results.map(objectRecord) : [];
    const errors = Array.isArray(data.errors) ? data.errors.map(objectRecord) : [];
    const readable = results.filter((page) => readableText(page.text));
    if (!readable.length) {
      // Per-URL failures are about the page (bot_blocked, page_not_found, timeout), not the key.
      const first = errors[0] ?? {};
      const code = stringValue(first.error) ?? (results.length ? "empty_content" : "fetch_error");
      const pageStatus = typeof first.status === "number" ? first.status : code === "page_not_found" ? 404 : undefined;
      const selectorDetails = code === "selector_not_matched" ? formatSelectorHints(first) : "";
      throw new TargetPageError(
        `TinyFish fetch failed: ${code}${pageStatus ? ` (page answered ${pageStatus})` : ""}${selectorDetails}`,
        pageStatus,
      );
    }
    const text = readable.map((page) => {
      const title = stringValue(page.title);
      const url = stringValue(page.final_url) ?? stringValue(page.url);
      const date = stringValue(page.published_date);
      const links = args.links === true && Array.isArray(page.links)
        ? page.links.slice(0, 50).map(formatExtractedLink).filter(Boolean)
        : [];
      return formatExtractedPage({
        ...(title ? { title } : {}),
        ...(url ? { url } : {}),
        ...(date ? { date } : {}),
        body: readableText(page.text),
        ...(links.length ? { links } : {}),
      });
    }).join("\n\n---\n\n");
    return { text, ...(errors.length ? { errors } : {}) };
  }
}

function normalizeTinyfishItem(row: unknown) {
  const item = objectRecord(row);
  const base = normalizeItem(item);
  const metaParts: string[] = [];
  if (Array.isArray(item.authors) && item.authors.length) {
    metaParts.push(`Authors: ${item.authors.map(String).filter(Boolean).slice(0, 5).join(", ")}`);
  }
  if (typeof item.cited_by_count === "number") metaParts.push(`Cited by ${item.cited_by_count}`);
  if (typeof item.pdf_url === "string" && item.pdf_url.trim()) metaParts.push(`PDF: ${item.pdf_url.trim()}`);
  if (!metaParts.length) return base;
  return { ...base, text: [metaParts.join(" · "), base.text].filter(Boolean).join("\n") };
}

function formatSelectorHints(error: Record<string, unknown>): string {
  const parts: string[] = [];
  if (Array.isArray(error.unmatched_selectors) && error.unmatched_selectors.length) {
    parts.push(`unmatched: ${error.unmatched_selectors.map(String).join(", ")}`);
  }
  if (Array.isArray(error.candidate_selectors) && error.candidate_selectors.length) {
    parts.push(`candidates: ${error.candidate_selectors.map(String).slice(0, 6).join(", ")}`);
  }
  return parts.length ? ` (${parts.join("; ")})` : "";
}

function readableText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  return value && typeof value === "object" ? JSON.stringify(value) : "";
}
