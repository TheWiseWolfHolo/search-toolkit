import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { requestJson, searchTool, type RestAdapter } from "../base.js";
import { normalizeItem, numberArg, stringArg } from "../normalize.js";

export class JinaAdapter implements RestAdapter {
  tools(): Tool[] {
    return [searchTool("jina_search", "Jina Search", "Search with Jina Search and return compact result descriptions.")];
  }

  async call(_tool: string, args: Record<string, unknown>, key: string): Promise<unknown> {
    const data = await requestJson("https://s.jina.ai/", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ q: stringArg(args, "query") }),
    }, 20_000);
    const rows = data.data ?? data.results;
    return { items: Array.isArray(rows) ? rows.slice(0, numberArg(args, "limit", 6)).map((row) => normalizeItem(row)) : [] };
  }
}
