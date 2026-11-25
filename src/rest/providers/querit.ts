import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { HttpError, keyFaultStatusFromToolText, TargetPageError } from "../../errors.js";
import { redact } from "../../provenance.js";
import type { ProviderConfig } from "../../types.js";
import {
  cleanHosts, collectValidatedUrls, endpointOf, formatExtractedPage, READ_ONLY_OPEN, requestJson, searchTool, timeoutOf,
  type RestAdapter, type RestAdapterContext,
} from "../base.js";
import {
  arrayArg, DEFAULT_ITEM_TEXT_CHARS, normalizeItem, numberArg, objectRecord, stringArg, stringValue,
} from "../normalize.js";

// Querit's filters.timeRange.date takes d1/w1/m1/y1; the toolkit's freshness words map onto them.
const QUERIT_TIME: Record<string, string> = { day: "d1", week: "w1", month: "m1", year: "y1" };
const NEED_CONTENT_MAX_CHARS = 32_000;

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
  annotations: READ_ONLY_OPEN,
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

  async call(
    tool: string,
    args: Record<string, unknown>,
    key: string,
    config: ProviderConfig,
    context?: RestAdapterContext,
  ): Promise<unknown> {
    if (tool === "querit_contents") return this.callContents(args, key, config, context);
    const limit = Math.max(1, Math.round(numberArg(args, "limit", 6)));
    const body: Record<string, unknown> = { query: stringArg(args, "query"), count: limit };
    const filters: Record<string, unknown> = {};
    const include = cleanHosts(arrayArg(args, "sitesInclude"));
    const exclude = cleanHosts(arrayArg(args, "sitesExclude"));
    if (include.length || exclude.length) filters.sites = { ...(include.length ? { include } : {}), ...(exclude.length ? { exclude } : {}) };
    const countries = arrayArg(args, "countries");
    const languages = arrayArg(args, "languages");
    if (countries.length) filters.geo = { countries: { include: countries } };
    if (languages.length) filters.languages = { include: languages };
    const timeRange = stringArg(args, "timeRange").trim();
    if (timeRange) filters.timeRange = { date: QUERIT_TIME[timeRange.toLowerCase()] ?? timeRange };
    if (Object.keys(filters).length) body.filters = filters;
    const vertical = stringArg(args, "vertical");
    if (vertical) body.vertical = vertical;
    const needContent = args.needContent === true;
    if (needContent) body.need_content = true;
    if (typeof args.chunksPerDoc === "number" && Number.isFinite(args.chunksPerDoc)) body.chunks_per_doc = Math.round(args.chunksPerDoc);
    const data = checkedQuerit(await requestJson(endpointOf(config, "https://api.querit.ai", "/v1/search"), {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }, {
      timeoutMs: timeoutOf(config, needContent ? 30_000 : 15_000),
      ...(context?.signal ? { signal: context.signal } : {}),
    }));
    const results = (data.results as Record<string, unknown> | undefined)?.result;
    const maxChars = needContent ? NEED_CONTENT_MAX_CHARS : DEFAULT_ITEM_TEXT_CHARS;
    return {
      items: Array.isArray(results)
        ? results.slice(0, limit).map((row) => {
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
                return normalizeItem({ ...rec, text: chunkText }, { dateKeys: ["page_time", "page_age", "published", "date"], maxChars });
              }
            }
            return normalizeItem(row, { dateKeys: ["page_time", "page_age", "published", "date"], maxChars });
          })
        : [],
    };
  }

  private async callContents(
    args: Record<string, unknown>,
    key: string,
    config: ProviderConfig,
    context?: RestAdapterContext,
  ): Promise<unknown> {
    const urls = collectValidatedUrls(args, "querit_contents", 10);
    const data = checkedQuerit(await requestJson(endpointOf(config, "https://api.querit.ai", "/v1/contents"), {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ urls }),
    }, {
      timeoutMs: timeoutOf(config, 30_000),
      ...(context?.signal ? { signal: context.signal } : {}),
    }));
    const rawResults = (data.results as Record<string, unknown> | undefined)?.result ?? data.results ?? data.data;
    const pages = Array.isArray(rawResults) ? rawResults.map(objectRecord) : [];
    const formatted = pages.map((page) => {
      const title = stringValue(page.title);
      const url = stringValue(page.url);
      const body = stringValue(page.markdown) ?? stringValue(page.content) ?? stringValue(page.text) ?? "";
      if (!body.trim()) return "";
      return formatExtractedPage({
        ...(title ? { title } : {}),
        ...(url ? { url } : {}),
        body,
      });
    }).filter(Boolean);
    if (!formatted.length) throw new TargetPageError("Querit returned no content for the page");
    return { text: formatted.join("\n\n---\n\n"), pages };
  }
}

function checkedQuerit(data: Record<string, unknown>): Record<string, unknown> {
  // Querit reports some failures in a 200 body: 0 and 2xx indicate success.
  const rawCode = data.error_code;
  const errorCode = typeof rawCode === "number"
    ? rawCode
    : typeof rawCode === "string" && /^\d+$/.test(rawCode.trim())
      ? Number(rawCode.trim())
      : undefined;
  if (errorCode !== undefined && errorCode !== 0 && (errorCode < 200 || errorCode >= 300)) {
    const safeMsg = redact(String(data.error_msg ?? "Querit error")).slice(0, 500);
    let status: number | undefined;
    if (errorCode >= 400 && errorCode < 600) {
      status = errorCode;
    } else if (errorCode >= 4_000) {
      const prefix = Number(String(errorCode).slice(0, 3));
      if (prefix >= 400 && prefix < 600) status = prefix;
    }
    if (status === undefined) {
      status = keyFaultStatusFromToolText(safeMsg, "search")
        ?? (/balance|quota|insufficient|credit/i.test(safeMsg)
          ? 402
          : /rate[\s_-]?limit|too[\s_-]?many|qps|throttl/i.test(safeMsg)
            ? 429
            : /auth|api[\s_-]?key|unauthorized|forbidden|invalid[\s_-]?token/i.test(safeMsg)
              ? 401
              : /invalid[\s_-]?param|missing[\s_-]?param|bad[\s_-]?request/i.test(safeMsg)
                ? 422
                : 502);
    }
    throw new HttpError(`HTTP ${status}: ${safeMsg} (error_code ${errorCode})`, status);
  }
  return data;
}
