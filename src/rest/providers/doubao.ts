import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { requestJson, searchTool, type RestAdapter } from "../base.js";
import { normalizeItem, numberArg, objectValue, stringArg } from "../normalize.js";

export class DoubaoAdapter implements RestAdapter {
  tools(): Tool[] {
    return [searchTool(
      "doubao_search",
      "Doubao Web Search (manual only)",
      "Search the Chinese web through Doubao. This provider is manual-only to preserve the monthly free quota.",
    )];
  }

  async call(_tool: string, args: Record<string, unknown>, key: string): Promise<unknown> {
    const data = await requestJson("https://open.feedcoopapi.com/search_api/web_search", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        Query: stringArg(args, "query"),
        SearchType: "web",
        Count: numberArg(args, "limit", 6),
        Filter: { NeedUrl: true },
      }),
    });
    const result = data.Result as Record<string, unknown> | undefined;
    const rows = result?.WebResults;
    return { items: Array.isArray(rows) ? rows.map((item) => normalizeItem({
      title: objectValue(item, "Title"),
      url: objectValue(item, "Url"),
      text: objectValue(item, "Summary") || objectValue(item, "Content") || objectValue(item, "Snippet"),
      date: objectValue(item, "PublishTime") || objectValue(item, "PublishDate"),
    })) : [] };
  }
}
