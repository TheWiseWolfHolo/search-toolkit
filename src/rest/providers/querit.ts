import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { HttpError } from "../../errors.js";
import type { ProviderConfig } from "../../types.js";
import { baseUrlOf, requestJson, searchTool, type RestAdapter } from "../base.js";
import { arrayArg, normalizeItem, numberArg, stringArg } from "../normalize.js";

// Querit's filters.timeRange.date takes d1/w1/m1/y1; the toolkit's freshness words map onto them.
const QUERIT_TIME: Record<string, string> = { day: "d1", week: "w1", month: "m1", year: "y1" };

export class QueritAdapter implements RestAdapter {
  tools(): Tool[] {
    return [searchTool(
      "querit_search",
      "Querit Search",
      "Search with Querit's filtered web search API. Compact English results; pass languages for other languages.",
      {
        sitesInclude: { type: "array", items: { type: "string" } },
        sitesExclude: { type: "array", items: { type: "string" } },
        countries: { type: "array", items: { type: "string" } },
        languages: { type: "array", items: { type: "string" } },
        timeRange: { type: "string", description: "day, week, month, year (or d1, w1, m1, y1, or a YYYY-MM-DDtoYYYY-MM-DD range)" },
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
    const timeRange = stringArg(args, "timeRange").trim();
    if (timeRange) filters.timeRange = { date: QUERIT_TIME[timeRange] ?? timeRange };
    if (Object.keys(filters).length) body.filters = filters;
    const base = baseUrlOf(config, "https://api.querit.ai/v1/search");
    const data = await requestJson(base, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    // Querit reports some failures in a 200 body: error_code is 200 on success.
    const errorCode = data.error_code;
    if (typeof errorCode === "number" && errorCode !== 200) {
      const status = errorCode >= 400 && errorCode < 600 ? errorCode : 502;
      throw new HttpError(`HTTP ${status}: ${String(data.error_msg ?? "Querit error")} (error_code ${errorCode})`, status);
    }
    const results = (data.results as Record<string, unknown> | undefined)?.result;
    return { items: Array.isArray(results) ? results.map((row) => normalizeItem(row, { dateKeys: ["page_time", "page_age", "published", "date"] })) : [] };
  }
}
