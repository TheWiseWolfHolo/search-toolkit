import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { HttpError, TargetPageError } from "../../errors.js";
import type { ProviderConfig, SearchItem } from "../../types.js";
import { endpointOf, requestJson, searchTool, type RestAdapter } from "../base.js";
import {
  arrayArg, normalizeYouKnowledge, normalizeYouSection, numberArg, objectRecord, stringArg, stringValue,
} from "../normalize.js";

const READ_ONLY_OPEN = { readOnlyHint: true, destructiveHint: false, openWorldHint: true } as const;

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
          maxAgeSeconds: { type: "integer", minimum: 0, description: "0 forces extraction_source=fetch for a live refetch" },
        },
        additionalProperties: false,
      },
      annotations: READ_ONLY_OPEN,
    };
    return [search, contents];
  }

  async call(tool: string, args: Record<string, unknown>, key: string, config: ProviderConfig): Promise<unknown> {
    if (tool === "you_contents") return this.callContents(args, key, config);
    return this.callSearch(args, key, config);
  }

  private async callSearch(args: Record<string, unknown>, key: string, config: ProviderConfig): Promise<unknown> {
    const body: Record<string, unknown> = {
      query: stringArg(args, "query"),
      count: numberArg(args, "limit", 6),
    };
    for (const [source, target] of [
      ["freshness", "freshness"],
      ["offset", "offset"],
      ["country", "country"],
      ["language", "language"],
      ["safesearch", "safesearch"],
    ] as const) {
      const value = args[source];
      if (value !== undefined && value !== null && value !== "") body[target] = value;
    }
    const includeDomains = arrayArg(args, "includeDomains");
    const excludeDomains = arrayArg(args, "excludeDomains");
    const boostDomains = arrayArg(args, "boostDomains");
    // You.com returns 422 if include_domains is combined with exclude_domains or boost_domains.
    if (includeDomains.length) {
      body.include_domains = includeDomains;
    } else {
      if (excludeDomains.length) body.exclude_domains = excludeDomains;
      if (boostDomains.length) body.boost_domains = boostDomains;
    }
    if (args.knowledge === true) body.knowledge = "core";
    if (typeof args.strictOperators === "boolean") body.strict_operators = args.strictOperators;
    const contentLevel = stringArg(args, "contentLevel");
    const extractionSource = stringArg(args, "extractionSource");
    // crawl_timeout only applies to full-page crawls; sent with snippets or highlights it is a 422.
    if (typeof args.crawlTimeout === "number" && contentLevel === "full_page") body.crawl_timeout = args.crawlTimeout;
    if (contentLevel === "highlights") {
      const highlights: Record<string, unknown> = {};
      if (typeof args.highlightsMaxTokens === "number") highlights.total_max_tokens = args.highlightsMaxTokens;
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
    }, 30_000);
    const results = data.results && typeof data.results === "object"
      ? data.results as Record<string, unknown>
      : {};
    const knowledge = normalizeYouKnowledge(results.knowledge);
    const web = normalizeYouSection(results.web, "web");
    const news = normalizeYouSection(results.news, "news");
    const limit = numberArg(args, "limit", 6);
    const items: SearchItem[] = [...knowledge.slice(0, Math.min(2, limit))];
    const preferNews = args.preferNews === true;
    const primary = preferNews ? news : web;
    const secondary = preferNews ? web : news;
    for (let index = 0; items.length < limit && (index < primary.length || index < secondary.length); index += 1) {
      const first = primary[index];
      const second = secondary[index];
      if (first) items.push(first);
      if (second && items.length < limit) items.push(second);
    }
    return { items, metadata: data.metadata };
  }

  private async callContents(args: Record<string, unknown>, key: string, config: ProviderConfig): Promise<unknown> {
    const urls: string[] = [];
    if (typeof args.url === "string" && args.url.trim()) urls.push(args.url.trim());
    for (const item of arrayArg(args, "urls")) {
      if (!urls.includes(item)) urls.push(item);
    }
    if (!urls.length) throw new Error("you_contents requires url or urls");
    const requestedFormats = arrayArg(args, "formats");
    const formats = requestedFormats.length ? requestedFormats : ["markdown"];
    const fullPageFormats = formats.filter((format) => format === "markdown" || format === "html");
    const extractionSource = args.maxAgeSeconds === 0
      ? "fetch"
      : stringArg(args, "extractionSource") || undefined;
    const parseEffort = stringArg(args, "parseEffort") || undefined;
    const timeout = typeof args.crawlTimeout === "number" ? args.crawlTimeout : undefined;
    const endpoint = endpointOf(config, "https://ydc-index.io", "/v1/extract");
    const timeoutMs = Math.max(30_000, (timeout ?? 10) * 1000 + 15_000);

    const settled = await Promise.allSettled(urls.slice(0, 10).map(async (url) => {
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
        }, timeoutMs);
        return objectRecord(Array.isArray(raw) ? raw[0] : raw);
      } catch (error) {
        if (error instanceof HttpError) {
          const lower = error.message.toLowerCase();
          if (error.status === 422 || /site_blocked|site_unreachable|unsupported_content|pdf_too_large|invalid_url/.test(lower)) {
            const pageStatus = /\b404\b|page[\s_]+not[\s_]+found|404[\s_]+not[\s_]+found/.test(lower) ? 404 : /\b403\b|site_blocked/.test(lower) ? 403 : undefined;
            throw new TargetPageError(`You.com could not read the page: ${error.message}`, pageStatus);
          }
        }
        throw error;
      }
    }));

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
          errors.push({ url, error: reason instanceof Error ? reason.message : String(reason) });
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
      const url = stringValue(page.url) ?? "";
      const markdown = stringValue(contents.markdown) ?? stringValue(page.markdown);
      const html = stringValue(contents.html) ?? stringValue(page.html);
      const content = markdown ?? html ?? "";
      const metaBlock = !content.trim() && formats.includes("metadata") && page.metadata && typeof page.metadata === "object"
        ? JSON.stringify(page.metadata, null, 2)
        : "";
      const header = [title ? `# ${title}` : "", url ? `URL: ${url}` : ""].filter(Boolean).join("\n");
      return [header, (content.trim() || metaBlock)].filter(Boolean).join("\n\n");
    }).filter(Boolean);

    const hasText = pages.some((page) => {
      const contents = objectRecord(page.contents);
      return Boolean((stringValue(contents.markdown) ?? stringValue(page.markdown))?.trim()
        || (stringValue(contents.html) ?? stringValue(page.html))?.trim());
    });
    if (wantsText && !hasText) {
      throw new TargetPageError("You.com returned no content for the page");
    }
    return { text: formatted.join("\n\n---\n\n"), pages, ...(errors.length ? { errors } : {}) };
  }
}
