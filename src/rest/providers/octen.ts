import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { HttpError } from "../../errors.js";
import type { ProviderConfig } from "../../types.js";
import { baseUrlOf, requestJson, searchTool, type RestAdapter } from "../base.js";
import { arrayArg, normalizeItem, numberArg, stringArg } from "../normalize.js";

const FRESHNESS = ["day", "week", "month", "year"];

// Octen highlights drop the space after commas and sentence ends ("Shorncliffe,Brisbane", "2016.The").
// Numbers such as 1,000 and abbreviations such as U.S. are left alone.
export function spaced(text: string): string {
  return text
    .replace(/([A-Za-z)])([,;])([A-Za-z(])/g, "$1$2 $3")
    .replace(/([a-z0-9)])([.!?])([A-Z][a-z])/g, "$1$2 $3");
}

export class OctenAdapter implements RestAdapter {
  tools(): Tool[] {
    return [searchTool(
      "octen_search",
      "Octen Search",
      "Search Octen's live web index; each result carries a query-relevant highlight. Fast per call.",
      {
        includeDomains: { type: "array", items: { type: "string" }, maxItems: 50 },
        excludeDomains: { type: "array", items: { type: "string" }, maxItems: 50 },
        freshness: { type: "string", enum: FRESHNESS },
        language: { type: "array", items: { type: "string", minLength: 2, maxLength: 2 }, description: "ISO 639-1 codes, such as [\"zh\"]" },
      },
    )];
  }

  async call(_tool: string, args: Record<string, unknown>, key: string, config: ProviderConfig): Promise<unknown> {
    const limit = numberArg(args, "limit", 6);
    const body: Record<string, unknown> = { query: stringArg(args, "query"), count: limit };
    for (const [source, target] of [["includeDomains", "include_domains"], ["excludeDomains", "exclude_domains"], ["language", "language"]] as const) {
      const values = arrayArg(args, source);
      if (values.length) body[target] = values;
    }
    const freshness = stringArg(args, "freshness");
    if (FRESHNESS.includes(freshness)) body.time_range = freshness;
    const data = await requestJson(`${baseUrlOf(config, "https://api.octen.ai")}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Api-Key": key },
      body: JSON.stringify(body),
    });
    // Octen reports some failures (balance, rate limit) as a business code inside a 200 body.
    if (data.code !== 0) {
      const code = typeof data.code === "number" && data.code >= 400 && data.code < 600 ? data.code : 502;
      throw new HttpError(`HTTP ${code}: ${String(data.msg ?? "Octen error")}`, code);
    }
    const results = (data.data as { results?: unknown } | undefined)?.results;
    return {
      items: Array.isArray(results)
        ? results.slice(0, limit).map((row) => normalizeItem(
          { ...(row as Record<string, unknown>), text: spaced(String((row as { highlight?: unknown }).highlight ?? "")) },
          { dateKeys: ["time_published"] },
        ))
        : [],
    };
  }
}
