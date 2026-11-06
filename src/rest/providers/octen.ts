import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { HttpError, TargetPageError } from "../../errors.js";
import type { ProviderConfig } from "../../types.js";
import { baseUrlOf, requestJson, searchTool, type RestAdapter } from "../base.js";
import { arrayArg, normalizeItem, numberArg, objectRecord, stringArg, stringValue } from "../normalize.js";

const FRESHNESS = ["day", "week", "month", "year"];

const EXTRACT_TOOL: Tool = {
  name: "octen_extract",
  title: "Octen Extract",
  description: "Read 1-20 known URLs through Octen's Extract API as clean Markdown, or only the passages relevant to a query. mode=advanced tries harder on difficult pages; failed URLs are not billed.",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", minLength: 1, description: "Single public http(s) URL" },
      urls: { type: "array", minItems: 1, maxItems: 20, items: { type: "string", minLength: 1, maxLength: 2048 } },
      mode: { type: "string", enum: ["standard", "advanced", "auto"], default: "standard" },
      query: { type: "string", maxLength: 500, description: "Return only passages relevant to this instead of the whole page" },
      format: { type: "string", enum: ["markdown", "text"], default: "markdown" },
      maxAgeSeconds: { type: "integer", minimum: 300, maximum: 31_536_000, description: "Re-fetch pages cached longer than this" },
      timeout: { type: "integer", minimum: 1, maximum: 60, description: "Per-URL timeout in seconds" },
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
};

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
        fullContent: { type: "boolean", default: false, description: "Return each page's content instead of a highlight (costs more)" },
        fullContentMaxTokens: { type: "integer", minimum: 100, description: "Token cap per page when fullContent is on" },
      },
    ), EXTRACT_TOOL];
  }

  async call(tool: string, args: Record<string, unknown>, key: string, config: ProviderConfig): Promise<unknown> {
    const root = baseUrlOf(config, "https://api.octen.ai").replace(/\/+$/, "");
    if (tool === "octen_extract") return this.extract(args, key, root);
    const limit = numberArg(args, "limit", 6);
    const body: Record<string, unknown> = { query: stringArg(args, "query"), count: limit };
    for (const [source, target] of [["includeDomains", "include_domains"], ["excludeDomains", "exclude_domains"], ["language", "language"]] as const) {
      const values = arrayArg(args, source);
      if (values.length) body[target] = values;
    }
    const freshness = stringArg(args, "freshness");
    if (FRESHNESS.includes(freshness)) body.time_range = freshness;
    const fullContent = args.fullContent === true;
    if (fullContent) {
      body.full_content = { enable: true, ...(typeof args.fullContentMaxTokens === "number" ? { max_tokens: args.fullContentMaxTokens } : {}) };
    }
    const data = checked(await requestJson(`${root}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Api-Key": key },
      body: JSON.stringify(body),
    }));
    const results = (data.data as { results?: unknown } | undefined)?.results;
    return {
      items: Array.isArray(results)
        ? results.slice(0, limit).map((row) => {
          const record = row as Record<string, unknown>;
          const text = fullContent && typeof record.full_content === "string" && record.full_content.trim()
            ? record.full_content
            : spaced(String(record.highlight ?? ""));
          return normalizeItem({ ...record, text }, { dateKeys: ["time_published"] });
        })
        : [],
    };
  }

  private async extract(args: Record<string, unknown>, key: string, root: string): Promise<unknown> {
    const urls = [...new Set([stringArg(args, "url").trim(), ...arrayArg(args, "urls")].filter(Boolean))].slice(0, 20);
    if (!urls.length) throw new Error("octen_extract requires url or urls");
    const body: Record<string, unknown> = { urls };
    for (const [source, target] of [["mode", "mode"], ["query", "query"], ["format", "format"]] as const) {
      if (stringArg(args, source).trim()) body[target] = stringArg(args, source).trim();
    }
    if (typeof args.maxAgeSeconds === "number") body.max_age_seconds = args.maxAgeSeconds;
    if (typeof args.timeout === "number") body.timeout = args.timeout;
    const data = checked(await requestJson(`${root}/extract`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Api-Key": key },
      body: JSON.stringify(body),
    }, 70_000));
    const rows = ((data.data as { results?: unknown } | undefined)?.results ?? []) as unknown[];
    const pages = Array.isArray(rows) ? rows.map(objectRecord) : [];
    const succeeded = pages.filter((page) => page.status === "success" && pageText(page));
    if (!succeeded.length) {
      // A batch answers 200 while every URL failed; the failure belongs to the page.
      const reason = stringValue(pages.find((page) => page.status === "failed")?.error_message) ?? "no content";
      throw new TargetPageError(`Octen extract failed: ${reason}`, /not\s*found|404/i.test(reason) ? 404 : undefined);
    }
    const text = succeeded.map((page) => {
      const title = stringValue(page.title);
      const url = stringValue(page.url) ?? "";
      const date = stringValue(page.time_published);
      const header = [title ? `# ${title}` : "", url ? `URL: ${url}${date ? ` (${date.slice(0, 10)})` : ""}` : ""].filter(Boolean).join("\n");
      return [header, pageText(page)].filter(Boolean).join("\n\n");
    }).join("\n\n---\n\n");
    const failed = pages.filter((page) => page.status !== "success").map((page) => ({ url: page.url, error: page.error_message }));
    return { text, ...(failed.length ? { failed } : {}) };
  }
}

/** Octen reports some failures (balance, rate limit) as a business code inside a 200 body. */
function checked(data: Record<string, unknown>): Record<string, unknown> {
  if (data.code === 0) return data;
  const code = typeof data.code === "number" && data.code >= 400 && data.code < 600 ? data.code : 502;
  throw new HttpError(`HTTP ${code}: ${String(data.msg ?? "Octen error")}`, code);
}

function pageText(page: Record<string, unknown>): string {
  if (typeof page.full_content === "string" && page.full_content.trim()) return page.full_content.trim();
  return Array.isArray(page.highlights) ? page.highlights.map((item) => spaced(String(item))).join("\n\n") : "";
}
