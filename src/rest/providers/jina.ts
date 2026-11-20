import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ProviderConfig } from "../../types.js";
import { baseUrlOf, requestJson, searchTool, type RestAdapter } from "../base.js";
import { normalizeItem, numberArg, stringArg } from "../normalize.js";

export class JinaAdapter implements RestAdapter {
  tools(): Tool[] {
    return [searchTool("jina_search", "Jina Search", "Search with Jina Search and return compact result descriptions (uses X-Respond-With: no-content by default for low latency).", {
      fullContent: { type: "boolean", default: false, description: "Read full page content for each hit (slower and uses more tokens)" },
    })];
  }

  async call(_tool: string, args: Record<string, unknown>, key: string, config?: ProviderConfig): Promise<unknown> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${key}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    };
    if (args.fullContent !== true) headers["X-Respond-With"] = "no-content";
    const data = await requestJson(baseUrlOf(config, "https://s.jina.ai/"), {
      method: "POST",
      headers,
      body: JSON.stringify({ q: stringArg(args, "query") }),
    }, args.fullContent === true ? 30_000 : 20_000);
    const rows = data.data ?? data.results;
    return { items: Array.isArray(rows) ? rows.slice(0, numberArg(args, "limit", 6)).map((row) => normalizeItem(row)) : [] };
  }
}
