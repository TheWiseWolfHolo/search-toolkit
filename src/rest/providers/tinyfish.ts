import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ProviderConfig } from "../../types.js";
import { baseUrlOf, requestJson, searchTool, type RestAdapter } from "../base.js";
import { arrayArg, normalizeItem, numberArg, stringArg } from "../normalize.js";

export class TinyfishAdapter implements RestAdapter {
  tools(): Tool[] {
    return [searchTool(
      "tinyfish_search",
      "TinyFish Search",
      "Search through TinyFish's official Search API. TinyFish browser automation remains available through its official CLI/MCP separately.",
      {
        location: { type: "string" },
        language: { type: "string" },
        includeDomains: { type: "array", items: { type: "string" } },
        excludeDomains: { type: "array", items: { type: "string" } },
      },
    )];
  }

  async call(_tool: string, args: Record<string, unknown>, key: string, config: ProviderConfig): Promise<unknown> {
    const base = baseUrlOf(config, "https://api.search.tinyfish.ai");
    const url = new URL(base);
    url.searchParams.set("query", stringArg(args, "query"));
    for (const [source, target] of [["location", "location"], ["language", "language"]] as const) {
      if (stringArg(args, source)) url.searchParams.set(target, stringArg(args, source));
    }
    for (const [source, target] of [["includeDomains", "include_domains"], ["excludeDomains", "exclude_domains"]] as const) {
      const values = arrayArg(args, source);
      if (values.length) url.searchParams.set(target, values.join(","));
    }
    const data = await requestJson(url.toString(), { headers: { "X-API-Key": key } });
    return { items: Array.isArray(data.results) ? data.results.slice(0, numberArg(args, "limit", 6)).map((row) => normalizeItem(row)) : [] };
  }
}
