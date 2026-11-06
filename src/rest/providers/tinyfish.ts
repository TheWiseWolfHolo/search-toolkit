import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { TargetPageError } from "../../errors.js";
import type { ProviderConfig } from "../../types.js";
import { baseUrlOf, requestJson, searchTool, type RestAdapter } from "../base.js";
import { arrayArg, normalizeItem, numberArg, objectRecord, stringArg, stringValue } from "../normalize.js";

const FETCH_ENDPOINT = "https://api.fetch.tinyfish.ai";

const FETCH_TOOL: Tool = {
  name: "tinyfish_fetch",
  title: "TinyFish Fetch",
  description: "Read 1-10 known URLs through TinyFish's Chromium-rendered Fetch API and return clean Markdown, HTML, or a JSON document tree. Free up to 1,000 URLs a day.",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", minLength: 1, description: "Single public http(s) URL" },
      urls: { type: "array", minItems: 1, maxItems: 10, items: { type: "string", minLength: 1 } },
      format: { type: "string", enum: ["markdown", "html", "json"], default: "markdown" },
      purpose: { type: "string", minLength: 1, maxLength: 2000, description: "Why the pages are being read; helps extraction" },
      links: { type: "boolean", description: "Also return the page's links" },
      ttl: { type: "integer", minimum: 0, description: "Accept cached copies younger than this many seconds; 0 forces a live fetch" },
      includeSelectors: { type: "array", minItems: 1, maxItems: 20, items: { type: "string", minLength: 1 }, description: "CSS selectors to keep" },
      excludeSelectors: { type: "array", minItems: 1, maxItems: 20, items: { type: "string", minLength: 1 }, description: "CSS selectors to drop" },
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
};

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
    ), FETCH_TOOL];
  }

  async call(tool: string, args: Record<string, unknown>, key: string, config: ProviderConfig): Promise<unknown> {
    if (tool === "tinyfish_fetch") return this.fetch(args, key);
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

  private async fetch(args: Record<string, unknown>, key: string): Promise<unknown> {
    const urls = [...new Set([stringArg(args, "url").trim(), ...arrayArg(args, "urls")].filter(Boolean))].slice(0, 10);
    if (!urls.length) throw new Error("tinyfish_fetch requires url or urls");
    const format = stringArg(args, "format", "markdown");
    const body: Record<string, unknown> = { urls, format, per_url_timeout_ms: 45_000 };
    if (stringArg(args, "purpose").trim()) body.purpose = stringArg(args, "purpose").trim();
    if (typeof args.links === "boolean") body.links = args.links;
    if (typeof args.ttl === "number") body.ttl = args.ttl;
    for (const [source, target] of [["includeSelectors", "include_selectors"], ["excludeSelectors", "exclude_selectors"]] as const) {
      const values = arrayArg(args, source);
      if (values.length) body[target] = values;
    }
    const data = await requestJson(FETCH_ENDPOINT, {
      method: "POST",
      headers: { "X-API-Key": key, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }, 60_000);
    const results = Array.isArray(data.results) ? data.results.map(objectRecord) : [];
    const errors = Array.isArray(data.errors) ? data.errors.map(objectRecord) : [];
    const readable = results.filter((page) => readableText(page.text));
    if (!readable.length) {
      // Per-URL failures are about the page (bot_blocked, page_not_found, timeout), not the key.
      const first = errors[0] ?? {};
      const code = stringValue(first.error) ?? (results.length ? "empty_content" : "fetch_error");
      const pageStatus = typeof first.status === "number" ? first.status : code === "page_not_found" ? 404 : undefined;
      throw new TargetPageError(`TinyFish fetch failed: ${code}${pageStatus ? ` (page answered ${pageStatus})` : ""}`, pageStatus);
    }
    const text = readable.map((page) => {
      const title = stringValue(page.title);
      const url = stringValue(page.final_url) ?? stringValue(page.url) ?? "";
      const date = stringValue(page.published_date);
      const header = [title ? `# ${title}` : "", url ? `URL: ${url}${date ? ` (${date.slice(0, 10)})` : ""}` : ""].filter(Boolean).join("\n");
      return [header, readableText(page.text)].filter(Boolean).join("\n\n");
    }).join("\n\n---\n\n");
    return { text, ...(errors.length ? { errors } : {}) };
  }
}

function readableText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  return value && typeof value === "object" ? JSON.stringify(value) : "";
}
