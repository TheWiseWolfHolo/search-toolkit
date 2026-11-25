import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { HttpError, TargetPageError } from "../../errors.js";
import { cleanError } from "../../provenance.js";
import type { ProviderConfig, SearchItem } from "../../types.js";
import {
  cleanHosts, collectValidatedUrls, endpointOf, formatExtractedPage, READ_ONLY_OPEN, requestJson, searchTool, timeoutOf,
  type RestAdapter, type RestAdapterContext,
} from "../base.js";
import {
  arrayArg, DEFAULT_ITEM_TEXT_CHARS, normalizeYouKnowledge, normalizeYouSection, numberArg, objectRecord,
  stringArg, stringValue,
} from "../normalize.js";

const FULL_PAGE_MAX_CHARS = 32_000;
const CONTENTS_CONCURRENCY = 3;
const YOU_PAGE_ERROR_TEXT = /site_blocked|site_unreachable|unsupported_content|pdf_too_large|invalid_url|cannot_extract|extract_failed|crawl_failed|page_not_found|blocked|unreachable|fetch_error/;

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<Array<PromiseSettledResult<R>>> {
  const results = new Array<PromiseSettledResult<R>>(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      try {
        results[index] = { status: "fulfilled", value: await worker(items[index] as T, index) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  });
  await Promise.all(runners);
  return results;
}

export class YouAdapter implements RestAdapter {
  tools(): Tool[] {
    const search = searchTool(
      "you_search",
      "You.com Web Search",
      "Search You.com's unified Web, News, and Knowledge index. Returns snippets by default, query-aware highlights, or full-page Markdown.",
      {
        freshness: { type: "string", description: "day, week, month, year, or YYYY-MM-DDtoYYYY-MM-DD" },
        offset: { type: "integer", minimum: 0, maximum: 9, default: 0 },
        country: { type: "string" },
        language: { type: "string", description: "BCP 47 language code" },
        safesearch: { type: "string", enum: ["off", "moderate", "strict"], default: "moderate" },
        includeDomains: { type: "array", maxItems: 500, items: { type: "string" } },
        excludeDomains: { type: "array", maxItems: 5000, items: { type: "string" } },
        boostDomains: { type: "array", maxItems: 500, items: { type: "string" } },
        contentLevel: {
          type: "string",
          enum: ["snippets", "highlights", "full_page"],
          default: "snippets",
          description: "snippets (low-cost default), highlights (query-aware passage extraction), or full_page (full Markdown crawl)",
        },
        extractionSource: {
          type: "string",
          enum: ["blend", "cache", "fetch"],
          description: "Source for extracted text when contentLevel is highlights or full_page: blend (default), cache (faster), or fetch (live)",
        },
        highlightsMaxTokens: {
          type: "integer",
          minimum: 1024,
          maximum: 8192,
          description: "Approximate total highlight token budget across results when contentLevel=highlights",
        },
        knowledge: {
          type: "boolean",
          default: false,
          description: "Include live licensed knowledge cards (stock/crypto prices, weather, sports, economic data) alongside web/news at no extra cost",
        },
        strictOperators: {
          type: "boolean",
          default: false,
          description: "Request strict operator matching; combine with includeDomains when hard domain pinning is required",
        },
        preferNews: {
          type: "boolean",
          default: false,
          description: "Interleave News items ahead of Web items (useful for breaking news)",
        },
        crawlTimeout: {
          type: "integer",
          minimum: 1,
          maximum: 60,
          description: "Max time in seconds to wait when contentLevel=full_page crawls pages",
        },
      },
    );
    const contents: Tool = {
      name: "you_contents",
      title: "You.com Extract",
      description: "Extract clean Markdown, HTML, or metadata from 1-10 known URLs via the You.com /v1/extract API.",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", minLength: 1, description: "Single public http(s) URL to extract" },
          urls: {
            type: "array",
            minItems: 1,
            maxItems: 10,
            items: { type: "string", minLength: 1 },
            description: "Up to 10 public http(s) URLs to extract",
          },
          formats: {
            type: "array",
            minItems: 1,
            items: { type: "string", enum: ["markdown", "html", "metadata"] },
            default: ["markdown"],
            description: "Content formats to return",
          },
          extractionSource: {
            type: "string",
            enum: ["blend", "cache", "fetch"],
            description: "blend (default), cache (faster), or fetch (live page fetch)",
          },
          parseEffort: {
            type: "string",
            enum: ["fast", "balanced", "thorough"],
            description: "Extraction depth for complex pages",
          },
          crawlTimeout: { type: "integer", minimum: 1, maximum: 60, default: 10 },
          maxAgeSeconds: { type: "integer", minimum: 0, description: "0 forces extraction_source=fetch; 1-3600 selects blend; >3600 selects cache when extractionSource is omitted" },
        },
        additionalProperties: false,
      },
      annotations: READ_ONLY_OPEN,
    };
    return [search, contents];
  }

  async call(
    tool: string,
    args: Record<string, unknown>,
    key: string,
    config: ProviderConfig,
    context?: RestAdapterContext,
  ): Promise<unknown> {
    if (tool === "you_contents") return this.callContents(args, key, config, context);
    return this.callSearch(args, key, config, context);
  }

  private async callSearch(
    args: Record<string, unknown>,
    key: string,
    config: ProviderConfig,
    context?: RestAdapterContext,
  ): Promise<unknown> {
    const limit = Math.max(1, Math.round(numberArg(args, "limit", 6)));
    const body: Record<string, unknown> = {
      query: stringArg(args, "query"),
      count: limit,
    };
    for (const [source, target] of [
      ["freshness", "freshness"],
      ["offset", "offset"],
      ["country", "country"],
      ["language", "language"],
      ["safesearch", "safesearch"],
    ] as const) {
      const value = args[source];
      if (value !== undefined && value !== null && value !== "") {
        body[target] = source === "country" && typeof value === "string" ? value.trim().toUpperCase() : value;
      }
    }
    const includeDomains = cleanHosts(arrayArg(args, "includeDomains"));
    const excludeDomains = cleanHosts(arrayArg(args, "excludeDomains"));
    const boostDomains = cleanHosts(arrayArg(args, "boostDomains"));
    const warnings: string[] = [];
    // You.com returns 422 if include_domains is combined with exclude_domains or boost_domains.
    if (includeDomains.length) {
      body.include_domains = includeDomains;
      const dropped: string[] = [];
      if (excludeDomains.length) dropped.push("excludeDomains");
      if (boostDomains.length) dropped.push("boostDomains");
      if (dropped.length) {
        warnings.push(`${dropped.join(" and ")} ignored because You.com does not combine them with includeDomains`);
      }
    } else {
      if (excludeDomains.length) body.exclude_domains = excludeDomains;
      if (boostDomains.length) body.boost_domains = boostDomains;
    }
    if (args.knowledge === true) body.knowledge = "core";
    if (typeof args.strictOperators === "boolean") body.strict_operators = args.strictOperators;
    const contentLevel = stringArg(args, "contentLevel");
    const extractionSource = stringArg(args, "extractionSource");
    // crawl_timeout only applies to full-page crawls; sent with snippets or highlights it is a 422.
    if (typeof args.crawlTimeout === "number" && Number.isFinite(args.crawlTimeout) && contentLevel === "full_page") {
      body.crawl_timeout = args.crawlTimeout;
    }
    if (contentLevel === "highlights") {
      const highlights: Record<string, unknown> = {};
      if (typeof args.highlightsMaxTokens === "number" && Number.isFinite(args.highlightsMaxTokens)) {
        highlights.total_max_tokens = Math.round(args.highlightsMaxTokens);
      }
      body.extraction = {
        extraction_mode: "highlights",
        highlights,
        ...(extractionSource ? { extraction_source: extractionSource } : {}),
      };
    } else if (contentLevel === "full_page") {
      body.extraction = {
        extraction_mode: "full_page",
        full_page: { extraction_formats: ["markdown"] },
        ...(extractionSource ? { extraction_source: extractionSource } : {}),
      };
    }
    const data = await requestJson(endpointOf(config, "https://ydc-index.io", "/v1/search"), {
      method: "POST",
      headers: { "X-API-Key": key, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }, {
      timeoutMs: timeoutOf(config, 30_000),
      ...(context?.signal ? { signal: context.signal } : {}),
    });
    const results = data.results && typeof data.results === "object"
      ? data.results as Record<string, unknown>
      : {};
    const maxChars = contentLevel === "full_page" ? FULL_PAGE_MAX_CHARS : DEFAULT_ITEM_TEXT_CHARS;
    const knowledge = normalizeYouKnowledge(results.knowledge, maxChars);
    const web = normalizeYouSection(results.web, "web", maxChars);
    const news = normalizeYouSection(results.news, "news", maxChars);
    const items: SearchItem[] = [...knowledge.slice(0, Math.min(2, limit))];
    const preferNews = args.preferNews === true;
    const hasFreshness = Boolean(stringArg(args, "freshness").trim());
    if (preferNews || hasFreshness) {
      const primary = preferNews ? news : web;
      const secondary = preferNews ? web : news;
      for (let index = 0; items.length < limit && (index < primary.length || index < secondary.length); index += 1) {
        const first = primary[index];
        const second = secondary[index];
        if (first) items.push(first);
        if (second && items.length < limit) items.push(second);
      }
    } else {
      // General queries without freshness keep web results ahead of news instead of displacing half the list.
      for (const entry of web) {
        if (items.length >= limit) break;
        items.push(entry);
      }
      for (const entry of news) {
        if (items.length >= limit) break;
        items.push(entry);
      }
    }
    return {
      items,
      metadata: data.metadata,
      ...(warnings.length ? { warnings } : {}),
    };
  }

  private async callContents(
    args: Record<string, unknown>,
    key: string,
    config: ProviderConfig,
    context?: RestAdapterContext,
  ): Promise<unknown> {
    const urls = collectValidatedUrls(args, "you_contents", 10);
    const requestedFormats = arrayArg(args, "formats");
    const formats = requestedFormats.length ? requestedFormats : ["markdown"];
    const fullPageFormats = formats.filter((format) => format === "markdown" || format === "html");
    const explicitSource = stringArg(args, "extractionSource").trim() || undefined;
    const maxAgeSeconds = typeof args.maxAgeSeconds === "number" && Number.isFinite(args.maxAgeSeconds)
      ? args.maxAgeSeconds
      : undefined;
    const extractionSource = maxAgeSeconds === 0
      ? "fetch"
      : explicitSource
        ?? (maxAgeSeconds !== undefined && maxAgeSeconds > 0
          ? (maxAgeSeconds <= 3_600 ? "blend" : "cache")
          : undefined);
    const parseEffort = stringArg(args, "parseEffort") || undefined;
    const timeout = typeof args.crawlTimeout === "number" && Number.isFinite(args.crawlTimeout) ? args.crawlTimeout : undefined;
    const endpoint = endpointOf(config, "https://ydc-index.io", "/v1/extract");
    const timeoutMs = timeoutOf(config, Math.max(30_000, (timeout ?? 10) * 1000 + 15_000));

    const settled = await mapWithConcurrency(urls, CONTENTS_CONCURRENCY, async (url) => {
      const body: Record<string, unknown> = {
        url,
        ...(fullPageFormats.length ? { full_page: { extraction_formats: fullPageFormats } } : {}),
        ...(formats.includes("metadata") ? { metadata: true } : {}),
        ...(extractionSource ? { extraction_source: extractionSource } : {}),
        ...(parseEffort ? { parse_effort: parseEffort } : {}),
        ...(timeout !== undefined ? { timeout } : {}),
      };
      try {
        const raw = await requestJson(endpoint, {
          method: "POST",
          headers: { "X-API-Key": key, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }, {
          timeoutMs,
          allowArray: true,
          ...(context?.signal ? { signal: context.signal } : {}),
        });
        return objectRecord(Array.isArray(raw) ? raw[0] : raw);
      } catch (error) {
        if (error instanceof HttpError) {
          const lower = error.message.toLowerCase();
          if (YOU_PAGE_ERROR_TEXT.test(lower)) {
            const pageStatus = /\b404\b|page[\s_]+not[\s_]+found|404[\s_]+not[\s_]+found/.test(lower) ? 404 : /\b403\b|site_blocked/.test(lower) ? 403 : undefined;
            throw new TargetPageError(`You.com could not read the page: ${error.message}`, pageStatus);
          }
        }
        throw error;
      }
    });

    const pages: Array<Record<string, unknown>> = [];
    const errors: Array<{ url: string; error: string }> = [];
    let firstFatalError: unknown;
    let firstPageError: TargetPageError | undefined;
    settled.forEach((outcome, index) => {
      const url = urls[index] as string;
      if (outcome.status === "fulfilled") {
        pages.push(outcome.value);
      } else {
        const reason = outcome.reason;
        if (reason instanceof TargetPageError) {
          firstPageError ??= reason;
          errors.push({ url, error: reason.message });
        } else {
          firstFatalError ??= reason;
          errors.push({ url, error: cleanError(reason) });
        }
      }
    });

    if (!pages.length) {
      if (firstFatalError) throw firstFatalError;
      throw firstPageError ?? new TargetPageError("You.com returned no content for the page");
    }

    const wantsText = fullPageFormats.length > 0;
    const formatted = pages.map((page) => {
      const contents = objectRecord(page.contents);
      const title = stringValue(page.title) ?? stringValue(objectRecord(page.metadata).title);
      const url = stringValue(page.url);
      const markdown = stringValue(contents.markdown) ?? stringValue(page.markdown);
      const html = stringValue(contents.html) ?? stringValue(page.html);
      const content = markdown ?? html ?? "";
      const metaBlock = !content.trim() && formats.includes("metadata") && page.metadata && typeof page.metadata === "object"
        ? JSON.stringify(page.metadata, null, 2)
        : "";
      const body = content.trim() || metaBlock;
      if (!body) return "";
      return formatExtractedPage({
        ...(title ? { title } : {}),
        ...(url ? { url } : {}),
        body,
      });
    }).filter(Boolean);

    const hasText = pages.some((page) => {
      const contents = objectRecord(page.contents);
      return Boolean((stringValue(contents.markdown) ?? stringValue(page.markdown))?.trim()
        || (stringValue(contents.html) ?? stringValue(page.html))?.trim());
    });
    if (wantsText && !hasText) {
      if (firstFatalError) throw firstFatalError;
      throw new TargetPageError("You.com returned no content for the page");
    }
    const warnings: string[] = [];
    if (firstFatalError !== undefined) {
      // Record key-level / provider-level fatal failures even when earlier URLs in the batch succeeded.
      context?.recordFailure?.(firstFatalError);
      warnings.push(`Some URLs failed with provider error: ${cleanError(firstFatalError)}`);
    }
    return {
      text: formatted.join("\n\n---\n\n"),
      pages,
      ...(errors.length ? { errors } : {}),
      ...(warnings.length ? { warnings } : {}),
    };
  }
}
