import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { HttpError, TargetPageError } from "../../errors.js";
import type { ProviderConfig } from "../../types.js";
import { endpointOf, requestJson, searchTool, type RestAdapter } from "../base.js";
import { arrayArg, normalizeItem, numberArg, objectRecord, stringArg, stringValue } from "../normalize.js";

// Querit's filters.timeRange.date takes d1/w1/m1/y1; the toolkit's freshness words map onto them.
const QUERIT_TIME: Record<string, string> = { day: "d1", week: "w1", month: "m1", year: "y1" };

const CONTENTS_TOOL: Tool = {
  name: "querit_contents",
  title: "Querit Contents",
  description: "Extract clean page content from 1-10 known URLs through Querit's /v1/contents API.",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", minLength: 1, description: "Single public http(s) URL" },
      urls: { type: "array", minItems: 1, maxItems: 10, items: { type: "string", minLength: 1 } },
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
};

export class QueritAdapter implements RestAdapter {
  tools(): Tool[] {
    return [searchTool(
      "querit_search",
      "Querit Search",
      "Search with Querit's filtered web search API. Supports vertical presets (code, finance) and optional full-page chunks.",
      {
        sitesInclude: { type: "array", items: { type: "string" } },
        sitesExclude: { type: "array", items: { type: "string" } },
        countries: { type: "array", items: { type: "string" } },
        languages: { type: "array", items: { type: "string" } },
        timeRange: { type: "string", description: "day, week, month, year (or d1, w1, m1, y1, or a YYYY-MM-DDtoYYYY-MM-DD range)" },
        vertical: { type: "string", enum: ["code", "finance"], description: "Optional vertical search index" },
        needContent: { type: "boolean", default: false, description: "Return extracted content chunks for each result" },
        chunksPerDoc: { type: "integer", minimum: 1, maximum: 10, description: "Number of content chunks per result when needContent=true" },
      },
    ), CONTENTS_TOOL];
  }

  async call(tool: string, args: Record<string, unknown>, key: string, config: ProviderConfig): Promise<unknown> {
    if (tool === "querit_contents") return this.callContents(args, key, config);
    const body: Record<string, unknown> = { query: stringArg(args, "query"), count: numberArg(args, "limit", 6) };
    const filters: Record<string, unknown> = {};
    const include = arrayArg(args, "sitesInclude");
    const exclude = arrayArg(args, "sitesExclude");
    if (include.length || exclude.length) filters.sites = { ...(include.length ? { include } : {}), ...(exclude.length ? { exclude } : {}) };
    const countries = arrayArg(args, "countries");
    const languages = arrayArg(args, "languages");
    if (countries.length) filters.geo = { countries: { include: countries } };
    if (languages.length) filters.languages = { include: languages };
    const timeRange = stringArg(args, "timeRange").trim();
    if (timeRange) filters.timeRange = { date: QUERIT_TIME[timeRange] ?? timeRange };
    if (Object.keys(filters).length) body.filters = filters;
    const vertical = stringArg(args, "vertical");
    if (vertical) body.vertical = vertical;
    if (args.needContent === true) body.need_content = true;
    if (typeof args.chunksPerDoc === "number") body.chunks_per_doc = args.chunksPerDoc;
    const data = checkedQuerit(await requestJson(endpointOf(config, "https://api.querit.ai", "/v1/search"), {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }));
    const results = (data.results as Record<string, unknown> | undefined)?.result;
    return {
      items: Array.isArray(results)
        ? results.map((row) => {
          const rec = objectRecord(row);
          if (Array.isArray(rec.chunks) && rec.chunks.length) {
            const chunkText = rec.chunks
              .map((chunk) => typeof chunk === "string"
                ? chunk
                : stringValue(objectRecord(chunk).text) ?? stringValue(objectRecord(chunk).content) ?? "")
              .map((part) => part.trim())
              .filter(Boolean)
              .join("\n\n");
            if (chunkText) {
              return normalizeItem({ ...rec, text: chunkText }, { dateKeys: ["page_time", "page_age", "published", "date"] });
            }
          }
          return normalizeItem(row, { dateKeys: ["page_time", "page_age", "published", "date"] });
        })
        : [],
    };
  }

  private async callContents(args: Record<string, unknown>, key: string, config: ProviderConfig): Promise<unknown> {
    const urls = [...new Set([stringArg(args, "url").trim(), ...arrayArg(args, "urls")].filter(Boolean))].slice(0, 10);
    if (!urls.length) throw new Error("querit_contents requires url or urls");
    const data = checkedQuerit(await requestJson(endpointOf(config, "https://api.querit.ai", "/v1/contents"), {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ urls }),
    }, 30_000));
    const rawResults = (data.results as Record<string, unknown> | undefined)?.result ?? data.results ?? data.data;
    const pages = Array.isArray(rawResults) ? rawResults.map(objectRecord) : [];
    const formatted = pages.map((page) => {
      const title = stringValue(page.title);
      const url = stringValue(page.url) ?? "";
      const body = stringValue(page.markdown) ?? stringValue(page.content) ?? stringValue(page.text) ?? "";
      if (!body.trim()) return "";
      const header = [title ? `# ${title}` : "", url ? `URL: ${url}` : ""].filter(Boolean).join("\n");
      return [header, body.trim()].filter(Boolean).join("\n\n");
    }).filter(Boolean);
    if (!formatted.length) throw new TargetPageError("Querit returned no content for the page");
    return { text: formatted.join("\n\n---\n\n"), pages };
  }
}

function checkedQuerit(data: Record<string, unknown>): Record<string, unknown> {
  // Querit reports some failures in a 200 body: 0 and 2xx indicate success.
  const errorCode = data.error_code;
  if (typeof errorCode === "number" && errorCode !== 0 && (errorCode < 200 || errorCode >= 300)) {
    const status = errorCode >= 400 && errorCode < 600 ? errorCode : 502;
    throw new HttpError(`HTTP ${status}: ${String(data.error_msg ?? "Querit error")} (error_code ${errorCode})`, status);
  }
  return data;
}
