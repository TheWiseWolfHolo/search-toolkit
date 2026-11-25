import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ProviderConfig } from "../../types.js";
import { baseUrlOf, requestJson, searchTool, timeoutOf, type RestAdapter, type RestAdapterContext } from "../base.js";
import { DEFAULT_ITEM_TEXT_CHARS, normalizeItem, numberArg, stringArg } from "../normalize.js";

const FULL_CONTENT_MAX_CHARS = 32_000;

export class JinaAdapter implements RestAdapter {
  tools(): Tool[] {
    return [searchTool("jina_search", "Jina Search", "Search with Jina Search and return compact result descriptions (uses X-Respond-With: no-content by default for low latency).", {
      fullContent: { type: "boolean", default: false, description: "Read full page content for each hit (slower and uses more tokens)" },
    })];
  }

  async call(
    _tool: string,
    args: Record<string, unknown>,
    key: string,
    config?: ProviderConfig,
    context?: RestAdapterContext,
  ): Promise<unknown> {
    const fullContent = args.fullContent === true;
    const limit = Math.max(1, Math.round(numberArg(args, "limit", 6)));
    const headers: Record<string, string> = {
      Authorization: `Bearer ${key}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    };
    if (!fullContent) headers["X-Respond-With"] = "no-content";
    const data = await requestJson(baseUrlOf(config, "https://s.jina.ai/"), {
      method: "POST",
      headers,
      body: JSON.stringify({ q: stringArg(args, "query"), num: limit }),
    }, {
      timeoutMs: timeoutOf(config, fullContent ? 30_000 : 20_000),
      ...(context?.signal ? { signal: context.signal } : {}),
    });
    const rows = data.data ?? data.results;
    const maxChars = fullContent ? FULL_CONTENT_MAX_CHARS : DEFAULT_ITEM_TEXT_CHARS;
    return { items: Array.isArray(rows) ? rows.slice(0, limit).map((row) => normalizeItem(row, { maxChars })) : [] };
  }
}
