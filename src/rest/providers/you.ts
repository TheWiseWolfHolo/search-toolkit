import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ProviderConfig, SearchItem } from "../../types.js";
import { baseUrlOf, requestJson, searchTool, type RestAdapter } from "../base.js";
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
        excludeDomains: { type: "array", maxItems: 500, items: { type: "string" } },
        boostDomains: { type: "array", maxItems: 500, items: { type: "string" } },
        contentLevel: {
          type: "string",
          enum: ["snippets", "highlights", "full_page"],
          default: "snippets",
          description: "snippets (low-cost default), highlights (query-aware passage extraction), or full_page (full Markdown crawl)",
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
          description: "Enforce quoted phrases and site: operators strictly without relaxation",
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
      title: "You.com Contents",
      description: "Extract clean Markdown, HTML, or metadata from 1-10 known URLs via the You.com Contents API.",
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
          crawlTimeout: { type: "integer", minimum: 1, maximum: 60, default: 10 },
          maxAgeSeconds: { type: "integer", minimum: 0, description: "Max cached content age in seconds (0 forces live refetch)" },
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
    if (typeof args.crawlTimeout === "number") body.crawl_timeout = args.crawlTimeout;
    const contentLevel = stringArg(args, "contentLevel");
    if (contentLevel === "highlights") {
      const highlights: Record<string, unknown> = {};
      if (typeof args.highlightsMaxTokens === "number") highlights.total_max_tokens = args.highlightsMaxTokens;
      body.extraction = { extraction_mode: "highlights", highlights };
    } else if (contentLevel === "full_page") {
      body.extraction = { extraction_mode: "full_page", full_page: { extraction_formats: ["markdown"] } };
    }
    const base = baseUrlOf(config, "https://ydc-index.io/v1/search");
    const data = await requestJson(base, {
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
    for (let index = 0; items.length < limit && (index < web.length || index < news.length); index += 1) {
      const webItem = web[index];
      const newsItem = news[index];
      if (webItem) items.push(webItem);
      if (newsItem && items.length < limit) items.push(newsItem);
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
    const formats = arrayArg(args, "formats");
    const body: Record<string, unknown> = {
      urls: urls.slice(0, 10),
      formats: formats.length ? formats : ["markdown"],
    };
    if (typeof args.crawlTimeout === "number") body.crawl_timeout = args.crawlTimeout;
    if (typeof args.maxAgeSeconds === "number") body.max_age = args.maxAgeSeconds;
    const base = baseUrlOf(config, "https://ydc-index.io/v1/contents").replace(/\/v1\/search\/?$/, "/v1/contents");
    const raw = await requestJson(base, {
      method: "POST",
      headers: { "X-API-Key": key, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }, 30_000) as unknown;
    const pages = Array.isArray(raw) ? raw.map(objectRecord) : [];
    const text = pages.map((page) => {
      const title = stringValue(page.title);
      const url = stringValue(page.url) ?? "";
      const content = stringValue(page.markdown) ?? stringValue(page.html) ?? "";
      const header = [title ? `# ${title}` : "", url ? `URL: ${url}` : ""].filter(Boolean).join("\n");
      return [header, content.trim()].filter(Boolean).join("\n\n");
    }).filter(Boolean).join("\n\n---\n\n");
    return { text, pages };
  }
}
