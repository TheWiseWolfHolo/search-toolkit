import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ProviderConfig } from "../../types.js";
import {
  endpointOf, READ_ONLY_OPEN, requestJson, searchTool, timeoutOf, validateFetchTargetUrl,
  type RestAdapter, type RestAdapterContext,
} from "../base.js";
import { normalizeItem, normalizeSerperImage, numberArg, stringArg } from "../normalize.js";

const LENS_TOOL: Tool = {
  name: "serper_lens",
  title: "Serper Lens",
  description: "Reverse image search through Google Lens: pages showing the same or a visually similar image, with page link, publisher, and image URLs. Needs a publicly reachable image URL; costs 3 Serper credits.",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", minLength: 1, description: "Public http(s) URL of the image" },
      limit: { type: "integer", minimum: 1, maximum: 50, default: 10 },
      gl: { type: "string", description: "Country code" },
      hl: { type: "string", description: "Language code" },
    },
    required: ["url"],
    additionalProperties: false,
  },
  annotations: READ_ONLY_OPEN,
};

export const LENS_NO_MATCHES = "Google Lens found no matches. Some image hosts, Wikimedia originals among them, do not serve Google's fetcher; a smaller or re-hosted copy of the same image usually works.";

export class SerperAdapter implements RestAdapter {
  tools(): Tool[] {
    return [...["search", "news", "images", "scholar"].map((kind) => searchTool(
      `serper_${kind}`,
      `Serper ${kind[0]?.toUpperCase()}${kind.slice(1)}`,
      kind === "images"
        ? "Search Google Images through Serper. Returns original image and thumbnail URLs, dimensions, source page, publisher, and rank when available. This is text-to-image discovery, not reverse image search."
        : kind === "scholar"
          ? "Search Google Scholar academic papers and citations through Serper. Returns paper title, URL, publication info, year, citation count, and snippet."
          : `Query Google's ${kind} results through the official Serper REST API with concise snippets.`,
      {
        gl: { type: "string", description: "Country code" },
        hl: { type: "string", description: "Language code" },
        ...(kind === "scholar" ? {} : { tbs: { type: "string", description: "Google time filter" } }),
        page: { type: "integer", minimum: 1, description: "1-based result page number" },
        autocorrect: { type: "boolean", description: "Enable Google query autocorrect" },
      },
    )), LENS_TOOL];
  }

  async call(
    tool: string,
    args: Record<string, unknown>,
    key: string,
    config?: ProviderConfig,
    context?: RestAdapterContext,
  ): Promise<unknown> {
    const kind = tool.replace("serper_", "");
    if (kind === "lens") return this.lens(args, key, config, context);
    const limit = Math.max(1, Math.round(numberArg(args, "limit", 6)));
    const body: Record<string, unknown> = { q: stringArg(args, "query"), num: limit };
    // Scholar has no web time filter; a tbs there narrows nothing and can empty the results.
    for (const name of kind === "scholar" ? ["gl", "hl"] : ["gl", "hl", "tbs"]) if (stringArg(args, name)) body[name] = stringArg(args, name);
    if (typeof args.page === "number" && Number.isFinite(args.page)) body.page = args.page;
    if (typeof args.autocorrect === "boolean") body.autocorrect = args.autocorrect;
    const data = await requestJson(endpointOf(config, "https://google.serper.dev", `/${kind}`), {
      method: "POST",
      headers: { "X-API-KEY": key, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }, {
      timeoutMs: timeoutOf(config, 15_000),
      ...(context?.signal ? { signal: context.signal } : {}),
    });
    const source = kind === "search" || kind === "scholar" ? data.organic : data[kind];
    const dateKeys = kind === "scholar" ? ["year", "date"] : ["date"];
    const normalize = kind === "images" ? normalizeSerperImage : (row: unknown) => normalizeItem(row, { dateKeys });
    return { items: Array.isArray(source) ? source.slice(0, limit).map(normalize) : [] };
  }

  private async lens(
    args: Record<string, unknown>,
    key: string,
    config?: ProviderConfig,
    context?: RestAdapterContext,
  ): Promise<unknown> {
    const rawUrl = stringArg(args, "url").trim();
    validateFetchTargetUrl(rawUrl, "serper_lens");
    const limit = Math.max(1, Math.round(numberArg(args, "limit", 10)));
    const body: Record<string, unknown> = { url: rawUrl };
    for (const name of ["gl", "hl"]) if (stringArg(args, name)) body[name] = stringArg(args, name);
    const data = await requestJson(endpointOf(config, "https://google.serper.dev", "/lens"), {
      method: "POST",
      headers: { "X-API-KEY": key, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }, {
      timeoutMs: timeoutOf(config, 30_000),
      ...(context?.signal ? { signal: context.signal } : {}),
    });
    const rows = Array.isArray(data.organic) ? data.organic.slice(0, limit) : [];
    // Lens sometimes names the matched image with an internal x-raw-image:// reference; the thumbnail is the usable copy.
    const items = rows.map((row) => {
      const item = normalizeSerperImage(row);
      return item.imageUrl?.startsWith("x-raw-image:") ? { ...item, imageUrl: item.thumbnailUrl ?? "" } : item;
    });
    return items.length ? { items } : { items, warnings: [LENS_NO_MATCHES] };
  }
}
