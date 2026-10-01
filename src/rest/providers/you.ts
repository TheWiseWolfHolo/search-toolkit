import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ProviderConfig, SearchItem } from "../../types.js";
import { baseUrlOf, requestJson, searchTool, type RestAdapter } from "../base.js";
import { arrayArg, normalizeYouSection, numberArg, stringArg } from "../normalize.js";

export class YouAdapter implements RestAdapter {
  tools(): Tool[] {
    return [searchTool(
      "you_search",
      "You.com Web Search",
      "Search You.com's unified Web and News index. Returns snippets by default or query-aware highlights when explicitly requested.",
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
          enum: ["snippets", "highlights"],
          default: "snippets",
          description: "Highlights trigger query-aware per-page extraction; snippets are the low-cost default",
        },
      },
    )];
  }

  async call(_tool: string, args: Record<string, unknown>, key: string, config: ProviderConfig): Promise<unknown> {
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
    for (const [source, target] of [
      ["includeDomains", "include_domains"],
      ["excludeDomains", "exclude_domains"],
      ["boostDomains", "boost_domains"],
    ] as const) {
      const values = arrayArg(args, source);
      if (values.length) body[target] = values;
    }
    if (stringArg(args, "contentLevel") === "highlights") {
      body.extraction = { extraction_mode: "highlights", highlights: {} };
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
    const web = normalizeYouSection(results.web, "web");
    const news = normalizeYouSection(results.news, "news");
    const limit = numberArg(args, "limit", 6);
    const items: SearchItem[] = [];
    for (let index = 0; items.length < limit && (index < web.length || index < news.length); index += 1) {
      const webItem = web[index];
      const newsItem = news[index];
      if (webItem) items.push(webItem);
      if (newsItem && items.length < limit) items.push(newsItem);
    }
    return { items, metadata: data.metadata };
  }
}
