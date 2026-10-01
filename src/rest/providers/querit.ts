import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ProviderConfig } from "../../types.js";
import { baseUrlOf, requestJson, searchTool, type RestAdapter } from "../base.js";
import { arrayArg, normalizeItem, numberArg, stringArg } from "../normalize.js";

export class QueritAdapter implements RestAdapter {
  tools(): Tool[] {
    return [searchTool(
      "querit_search",
      "Querit Search",
      "Search with Querit's filtered web search API. Best general-purpose default in Search Toolkit.",
      {
        sitesInclude: { type: "array", items: { type: "string" } },
        sitesExclude: { type: "array", items: { type: "string" } },
        countries: { type: "array", items: { type: "string" } },
        languages: { type: "array", items: { type: "string" } },
        timeRange: { type: "string" },
      },
    )];
  }

  async call(_tool: string, args: Record<string, unknown>, key: string, config: ProviderConfig): Promise<unknown> {
    const body: Record<string, unknown> = { query: stringArg(args, "query"), count: numberArg(args, "limit", 6) };
    const filters: Record<string, unknown> = {};
    const include = arrayArg(args, "sitesInclude");
    const exclude = arrayArg(args, "sitesExclude");
    if (include.length || exclude.length) filters.sites = { ...(include.length ? { include } : {}), ...(exclude.length ? { exclude } : {}) };
    const countries = arrayArg(args, "countries");
    const languages = arrayArg(args, "languages");
    if (countries.length) filters.geo = { countries: { include: countries } };
    if (languages.length) filters.languages = { include: languages };
    if (stringArg(args, "timeRange")) filters.timeRange = { date: stringArg(args, "timeRange") };
    if (Object.keys(filters).length) body.filters = filters;
    const base = baseUrlOf(config, "https://api.querit.ai/v1/search");
    const data = await requestJson(base, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const results = (data.results as Record<string, unknown> | undefined)?.result;
    return { items: Array.isArray(results) ? results.map((row) => normalizeItem(row, { dateKeys: ["page_time", "page_age", "published", "date"] })) : [] };
  }
}
