import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { HttpError } from "../../errors.js";
import type { ProviderConfig } from "../../types.js";
import { baseUrlOf, requestJson, searchTool, type RestAdapter } from "../base.js";
import { arrayArg, normalizeItem, numberArg, objectRecord, objectValue, stringArg } from "../normalize.js";

export class DoubaoAdapter implements RestAdapter {
  tools(): Tool[] {
    return [searchTool(
      "doubao_search",
      "Doubao Web Search (manual only)",
      "Search the Chinese web through Doubao (Volcengine Fusion Search). This provider is manual-only to preserve the monthly free quota.",
      {
        timeRange: { type: "string", description: "Time window: OneDay, OneWeek, OneMonth, OneYear, or YYYY-MM-DD..YYYY-MM-DD" },
        sites: { type: "array", maxItems: 5, items: { type: "string" }, description: "Restrict to up to 5 hostnames" },
        blockHosts: { type: "array", maxItems: 5, items: { type: "string" }, description: "Exclude up to 5 hostnames" },
        needContent: { type: "boolean", default: false, description: "Include full extracted text content alongside summaries" },
        contentFormat: { type: "string", enum: ["text", "markdown"], description: "Format for extracted content when needContent=true" },
      },
    )];
  }

  async call(_tool: string, args: Record<string, unknown>, key: string, config?: ProviderConfig): Promise<unknown> {
    const filter: Record<string, unknown> = { NeedUrl: true };
    const sites = arrayArg(args, "sites");
    const blockHosts = arrayArg(args, "blockHosts");
    if (sites.length) filter.Sites = sites.join("|");
    if (blockHosts.length) filter.BlockHosts = blockHosts.join("|");
    const body: Record<string, unknown> = {
      Query: stringArg(args, "query"),
      SearchType: "web",
      Count: numberArg(args, "limit", 6),
      NeedSummary: true,
      Filter: filter,
    };
    const timeRange = stringArg(args, "timeRange").trim();
    if (timeRange) body.TimeRange = timeRange;
    if (args.needContent === true) body.NeedContent = true;
    const contentFormat = stringArg(args, "contentFormat");
    if (contentFormat) body.ContentFormat = contentFormat;
    const data = await requestJson(baseUrlOf(config, "https://open.feedcoopapi.com/search_api/web_search"), {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(body),
    });
    const metaError = objectRecord(objectRecord(data.ResponseMetadata).Error);
    if (metaError.Code || metaError.CodeN || metaError.Message) {
      const codeN = typeof metaError.CodeN === "number" ? metaError.CodeN : Number(metaError.CodeN);
      const code = String(metaError.Code ?? "");
      const message = String(metaError.Message ?? code ?? "Doubao error");
      const status = codeN === 10406 || /balance|quota|arrears|insufficient/i.test(`${code} ${message}`)
        ? 402
        : codeN === 700429 || /rate[\s_-]?limit|qps|throttl|too[\s_-]?many[\s_-]?requests|concurrency/i.test(`${code} ${message}`)
          ? 429
          : /auth|token|signature|forbidden/i.test(`${code} ${message}`)
            ? 401
            : 502;
      throw new HttpError(`HTTP ${status}: ${message}${code ? ` (${code})` : ""}`, status);
    }
    const result = data.Result as Record<string, unknown> | undefined;
    const rows = result?.WebResults;
    const preferContent = args.needContent === true;
    return { items: Array.isArray(rows) ? rows.map((item) => normalizeItem({
      title: objectValue(item, "Title"),
      url: objectValue(item, "Url"),
      text: preferContent
        ? (objectValue(item, "Content") || objectValue(item, "Summary") || objectValue(item, "Snippet"))
        : (objectValue(item, "Summary") || objectValue(item, "Content") || objectValue(item, "Snippet")),
      date: formatDoubaoDate(item),
    })) : [] };
  }
}

function formatDoubaoDate(item: unknown): string {
  const record = objectRecord(item);
  const raw = record.PublishTime ?? record.PublishDate;
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 1e8) {
    const ms = raw > 1e12 ? raw : raw * 1000;
    return new Date(ms).toISOString().slice(0, 10);
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (/^\d{10}$/.test(trimmed)) return new Date(Number(trimmed) * 1000).toISOString().slice(0, 10);
    if (/^\d{13}$/.test(trimmed)) return new Date(Number(trimmed)).toISOString().slice(0, 10);
    return trimmed;
  }
  return "";
}
