import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { HttpError, TargetPageError } from "../../errors.js";
import { redact } from "../../provenance.js";
import type { ProviderConfig } from "../../types.js";
import {
  cleanHosts, collectValidatedUrls, endpointOf, formatExtractedPage, READ_ONLY_OPEN, requestJson, searchTool, timeoutOf,
  type RestAdapter, type RestAdapterContext,
} from "../base.js";
import {
  arrayArg, DEFAULT_ITEM_TEXT_CHARS, normalizeItem, numberArg, objectRecord, stringArg, stringValue,
} from "../normalize.js";

const FRESHNESS = ["day", "week", "month", "year"];
const FULL_CONTENT_MAX_CHARS = 32_000;

const SENTENCE_STARTERS = new Set([
  "The", "It", "Its", "In", "He", "She", "They", "We", "This", "That", "These", "Those",
  "There", "Here", "However", "Also", "After", "Before", "When", "While", "Since",
  "Although", "Though", "Because", "During", "But", "And", "Or", "Yet", "If", "Once",
  "Then", "Now", "Today", "Later", "Earlier", "Many", "Some", "Most", "All", "Both",
  "Each", "Such", "According", "Following", "Despite", "Between", "Under", "Over",
  "Through", "His", "Her", "Their", "Our", "No", "Not", "Only", "Still", "Even", "Just",
  "An", "One", "Two", "Three", "New", "Other", "Another", "Afterward", "Meanwhile",
]);

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
  annotations: READ_ONLY_OPEN,
};

const PROTECTED_SPAN = /(https?:\/\/[^\s)>"']+|`[^`]+`)/g;

function spaceSegment(segment: string, afterProtected: boolean): string {
  const leadingFixed = afterProtected
    ? segment
        .replace(/^([,;])([A-Za-z(])/, "$1 $2")
        .replace(/^([!?])([A-Z][a-z])/, "$1 $2")
        .replace(/^\.([A-Z][a-z]+)(?![.\w(/<:[_$-])/, ". $1")
    : segment;
  return leadingFixed
    .replace(/([A-Za-z)])([,;])([A-Za-z(])/g, "$1$2 $3")
    .replace(/([a-z0-9)])([!?])([A-Z][a-z])/g, "$1$2 $3")
    .replace(
      /(?<![.\w/])([A-Za-z0-9)]+)\.([A-Z][a-z]+)(?![.\w(/<:[_$-])/g,
      (match, left: string, right: string) => {
        if (left.endsWith(")") || /^(?:19|20)\d\d$/.test(left) || SENTENCE_STARTERS.has(right)) {
          return `${left}. ${right}`;
        }
        return match;
      },
    );
}

// Octen highlights drop the space after commas and sentence ends ("Shorncliffe,Brisbane", "2016.The").
// URLs, inline code spans, multi-dot domains (docs.Python.org), dotted identifiers (React.Component),
// numbers (1,000), and abbreviations (U.S.) are left intact.
export function spaced(text: string): string {
  const parts = text.split(PROTECTED_SPAN);
  return parts.map((part, index) => (index % 2 === 1 ? part : spaceSegment(part, index > 0))).join("");
}

export class OctenAdapter implements RestAdapter {
  tools(): Tool[] {
    return [searchTool(
      "octen_search",
      "Octen Search",
      "Search Octen's live web index; each result carries a query-relevant highlight. Fast per call.",
      {
        includeDomains: { type: "array", items: { type: "string" }, maxItems: 1200 },
        excludeDomains: { type: "array", items: { type: "string" }, maxItems: 1200 },
        freshness: { type: "string", enum: FRESHNESS },
        language: { type: "array", items: { type: "string", minLength: 2, maxLength: 2 }, description: "ISO 639-1 codes, such as [\"zh\"]" },
        fullContent: { type: "boolean", default: false, description: "Return each page's full content instead of a highlight" },
        fullContentMaxTokens: { type: "integer", minimum: 100, description: "Token cap per page when fullContent is on" },
        premier: { type: "boolean", default: false, description: "Use Octen's /search-premier endpoint for higher-precision ranking" },
      },
    ), EXTRACT_TOOL];
  }

  async call(
    tool: string,
    args: Record<string, unknown>,
    key: string,
    config: ProviderConfig,
    context?: RestAdapterContext,
  ): Promise<unknown> {
    if (tool === "octen_extract") return this.extract(args, key, config, context);
    const limit = Math.max(1, Math.round(numberArg(args, "limit", 6)));
    const body: Record<string, unknown> = { query: stringArg(args, "query"), count: limit };
    const includeDomains = cleanHosts(arrayArg(args, "includeDomains"));
    const excludeDomains = cleanHosts(arrayArg(args, "excludeDomains"));
    const language = arrayArg(args, "language");
    if (includeDomains.length) body.include_domains = includeDomains;
    if (excludeDomains.length) body.exclude_domains = excludeDomains;
    if (language.length) body.language = language;
    const freshness = stringArg(args, "freshness");
    if (FRESHNESS.includes(freshness)) body.time_range = freshness;
    const fullContent = args.fullContent === true;
    const premier = args.premier === true;
    if (fullContent) {
      body.full_content = {
        enable: true,
        ...(typeof args.fullContentMaxTokens === "number" && Number.isFinite(args.fullContentMaxTokens)
          ? { max_tokens: Math.round(args.fullContentMaxTokens) }
          : {}),
      };
    }
    const path = premier ? "/search-premier" : "/search";
    const data = checked(await requestJson(endpointOf(config, "https://api.octen.ai", path), {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Api-Key": key },
      body: JSON.stringify(body),
    }, {
      timeoutMs: timeoutOf(config, fullContent || premier ? 35_000 : 15_000),
      ...(context?.signal ? { signal: context.signal } : {}),
    }));
    const results = (data.data as { results?: unknown } | undefined)?.results;
    const maxChars = fullContent ? FULL_CONTENT_MAX_CHARS : DEFAULT_ITEM_TEXT_CHARS;
    return {
      items: Array.isArray(results)
        ? results.slice(0, limit).map((row) => {
            const record = objectRecord(row);
            const text = fullContent && typeof record.full_content === "string" && record.full_content.trim()
              ? record.full_content
              : spaced(String(record.highlight ?? ""));
            return normalizeItem({ ...record, text }, { dateKeys: ["time_published"], maxChars });
          })
        : [],
    };
  }

  private async extract(
    args: Record<string, unknown>,
    key: string,
    config: ProviderConfig,
    context?: RestAdapterContext,
  ): Promise<unknown> {
    const urls = collectValidatedUrls(args, "octen_extract", 20);
    const body: Record<string, unknown> = { urls };
    for (const [source, target] of [["mode", "mode"], ["query", "query"], ["format", "format"]] as const) {
      if (stringArg(args, source).trim()) body[target] = stringArg(args, source).trim();
    }
    if (typeof args.maxAgeSeconds === "number" && Number.isFinite(args.maxAgeSeconds)) body.max_age_seconds = args.maxAgeSeconds;
    const perUrlTimeout = typeof args.timeout === "number" && Number.isFinite(args.timeout) ? args.timeout : undefined;
    if (perUrlTimeout !== undefined) body.timeout = perUrlTimeout;
    const defaultTimeoutMs = Math.max(70_000, (perUrlTimeout ?? 30) * 1000 + 15_000);
    const data = checked(await requestJson(endpointOf(config, "https://api.octen.ai", "/extract"), {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Api-Key": key },
      body: JSON.stringify(body),
    }, {
      timeoutMs: timeoutOf(config, defaultTimeoutMs),
      ...(context?.signal ? { signal: context.signal } : {}),
    }));
    const rows = ((data.data as { results?: unknown } | undefined)?.results ?? []) as unknown[];
    const pages = Array.isArray(rows) ? rows.map(objectRecord) : [];
    const succeeded: Array<{ page: Record<string, unknown>; text: string }> = [];
    const failed: Array<{ url: unknown; error: unknown }> = [];
    for (const page of pages) {
      const content = pageText(page);
      if (page.status === "success" && content) {
        succeeded.push({ page, text: content });
      } else {
        failed.push({
          url: page.url,
          error: stringValue(page.error_message) ?? (page.status === "success" ? "empty content" : "extract failed"),
        });
      }
    }
    if (!succeeded.length) {
      // A batch answers 200 while every URL failed; the failure belongs to the page.
      const reason = stringValue(pages.find((page) => page.status === "failed")?.error_message) ?? "no content";
      const statusMatch = reason.match(/\b(404|410|451)\b/);
      const pageStatus = statusMatch ? Number(statusMatch[1]) : /page[\s_]+not[\s_]+found|404[\s_]+not[\s_]+found/i.test(reason) ? 404 : undefined;
      throw new TargetPageError(`Octen extract failed: ${reason}`, pageStatus);
    }
    const text = succeeded.map(({ page, text: bodyText }) => {
      const title = stringValue(page.title);
      const url = stringValue(page.url);
      const date = stringValue(page.time_published);
      return formatExtractedPage({
        ...(title ? { title } : {}),
        ...(url ? { url } : {}),
        ...(date ? { date } : {}),
        body: bodyText,
      });
    }).join("\n\n---\n\n");
    return { text, ...(failed.length ? { failed } : {}) };
  }
}

/** Octen reports some failures (balance, rate limit) as a business code inside a 200 body. */
function checked(data: Record<string, unknown>): Record<string, unknown> {
  if (data.code === 0) return data;
  const raw = typeof data.code === "number" ? data.code : Number(data.code);
  let code = 502;
  if (Number.isInteger(raw)) {
    if (raw >= 400 && raw < 600) code = raw;
    else if (raw >= 4_000) {
      const prefix = Number(String(raw).slice(0, 3));
      if (prefix >= 400 && prefix < 600) code = prefix;
    }
  }
  const safeMsg = redact(String(data.msg ?? "Octen error")).slice(0, 500);
  throw new HttpError(`HTTP ${code}: ${safeMsg}`, code);
}

function pageText(page: Record<string, unknown>): string {
  if (typeof page.full_content === "string" && page.full_content.trim()) return page.full_content.trim();
  return Array.isArray(page.highlights)
    ? page.highlights.map((item) => (typeof item === "string" ? spaced(item) : "")).filter(Boolean).join("\n\n")
    : "";
}
