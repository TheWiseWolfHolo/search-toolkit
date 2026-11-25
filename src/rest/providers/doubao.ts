import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { HttpError } from "../../errors.js";
import { redact } from "../../provenance.js";
import type { ProviderConfig } from "../../types.js";
import {
  baseUrlOf, cleanHosts, requestJson, searchTool, timeoutOf,
  type RestAdapter, type RestAdapterContext,
} from "../base.js";
import {
  arrayArg, DEFAULT_ITEM_TEXT_CHARS, formatEpochDate, normalizeItem, numberArg, objectRecord, objectValue, stringArg,
} from "../normalize.js";

const NEED_CONTENT_MAX_CHARS = 32_000;

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

  async call(
    _tool: string,
    args: Record<string, unknown>,
    key: string,
    config?: ProviderConfig,
    context?: RestAdapterContext,
  ): Promise<unknown> {
    const filter: Record<string, unknown> = { NeedUrl: true };
    const sites = cleanHosts(arrayArg(args, "sites"));
    const blockHosts = cleanHosts(arrayArg(args, "blockHosts"));
    if (sites.length) filter.Sites = sites.join("|");
    if (blockHosts.length) filter.BlockHosts = blockHosts.join("|");
    const limit = Math.max(1, Math.round(numberArg(args, "limit", 6)));
    const body: Record<string, unknown> = {
      Query: stringArg(args, "query"),
      SearchType: "web",
      Count: limit,
      NeedSummary: true,
      Filter: filter,
    };
    const timeRange = stringArg(args, "timeRange").trim();
    if (timeRange) body.TimeRange = timeRange;
    const preferContent = args.needContent === true;
    if (preferContent) body.NeedContent = true;
    const contentFormat = stringArg(args, "contentFormat");
    if (contentFormat) body.ContentFormat = contentFormat;
    const data = await requestJson(baseUrlOf(config, "https://open.feedcoopapi.com/search_api/web_search"), {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(body),
    }, {
      timeoutMs: timeoutOf(config, 15_000),
      ...(context?.signal ? { signal: context.signal } : {}),
    });
    const metaError = objectRecord(objectRecord(data.ResponseMetadata).Error);
    if (metaError.Code || metaError.CodeN || metaError.Message) {
      const codeN = typeof metaError.CodeN === "number" ? metaError.CodeN : Number(metaError.CodeN);
      const code = String(metaError.Code ?? "").trim();
      const rawMessage = String(metaError.Message ?? code ?? "Doubao error");
      const safeMessage = redact(rawMessage).slice(0, 500);
      const combined = `${code} ${safeMessage}`;
      const status = codeN === 10406 || /balance|quota|arrears|insufficient|余额不足|欠费|配额/i.test(combined)
        ? 402
        : codeN === 700429 || /rate[\s_-]?limit|qps|throttl|too[\s_-]?many[\s_-]?requests|concurrency|限流|并发|频率/i.test(combined)
          ? 429
          : /auth|token|signature|forbidden|invalid[\s_-]?api[\s_-]?key|access[\s_-]?denied|unauthorized|鉴权|密钥无效/i.test(combined)
            ? 401
            : /invalid[\s_-]?param(?:eter)?|missing[\s_-]?param(?:eter)?|bad[\s_-]?request|参数(?:错误|无效|缺失)/i.test(combined)
              ? 422
              : 502;
      throw new HttpError(`HTTP ${status}: ${safeMessage}${code ? ` (${code})` : ""}`, status);
    }
    const result = data.Result as Record<string, unknown> | undefined;
    const rows = result?.WebResults;
    const maxChars = preferContent ? NEED_CONTENT_MAX_CHARS : DEFAULT_ITEM_TEXT_CHARS;
    return {
      items: Array.isArray(rows)
        ? rows.slice(0, limit).map((item) => normalizeItem({
            title: objectValue(item, "Title"),
            url: objectValue(item, "Url"),
            text: preferContent
              ? (objectValue(item, "Content") || objectValue(item, "Summary") || objectValue(item, "Snippet"))
              : (objectValue(item, "Summary") || objectValue(item, "Content") || objectValue(item, "Snippet")),
            date: formatDoubaoDate(item),
          }, { maxChars }))
        : [],
    };
  }
}

function formatDoubaoDate(item: unknown): string {
  const record = objectRecord(item);
  const raw = record.PublishTime ?? record.PublishDate;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return formatEpochDate(raw) ?? "";
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (/^\d{10,19}$/.test(trimmed)) return formatEpochDate(Number(trimmed)) ?? "";
    return trimmed;
  }
  return "";
}
