import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { requestJson, searchTool, type RestAdapter } from "../base.js";
import { normalizeItem, normalizeSerperImage, numberArg, stringArg } from "../normalize.js";

export class SerperAdapter implements RestAdapter {
  tools(): Tool[] {
    return ["search", "news", "images"].map((kind) => searchTool(
      `serper_${kind}`,
      `Serper ${kind[0]?.toUpperCase()}${kind.slice(1)}`,
      kind === "images"
        ? "Search Google Images through Serper. Returns original image and thumbnail URLs, dimensions, source page, publisher, and rank when available. This is text-to-image discovery, not reverse image search."
        : `Query Google's ${kind} results through the official Serper REST API with concise snippets.`,
      {
        gl: { type: "string", description: "Country code" },
        hl: { type: "string", description: "Language code" },
        tbs: { type: "string", description: "Google time filter" },
      },
    ));
  }

  async call(tool: string, args: Record<string, unknown>, key: string): Promise<unknown> {
    const kind = tool.replace("serper_", "");
    const body: Record<string, unknown> = { q: stringArg(args, "query"), num: numberArg(args, "limit", 6) };
    for (const name of ["gl", "hl", "tbs"]) if (stringArg(args, name)) body[name] = stringArg(args, name);
    const data = await requestJson(`https://google.serper.dev/${kind}`, {
      method: "POST",
      headers: { "X-API-KEY": key, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const source = kind === "search" ? data.organic : data[kind];
    const normalize = kind === "images" ? normalizeSerperImage : (row: unknown) => normalizeItem(row, { dateKeys: ["date"] });
    return { items: Array.isArray(source) ? source.slice(0, numberArg(args, "limit", 6)).map(normalize) : [] };
  }
}
