import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { HttpError, InvalidRequestError, keyFaultStatusFromToolText, TargetPageError } from "../../errors.js";
import type { ProviderConfig, SearchItem } from "../../types.js";
import {
  cleanDomains, endpointOf, formatExtractedPage, READ_ONLY_OPEN, requestJson, searchTool, timeoutOf,
  validateFetchTargetUrl as validateBaseFetchTargetUrl,
  type RestAdapter, type RestAdapterContext,
} from "../base.js";
import {
  arrayArg, DEFAULT_ITEM_TEXT_CHARS, numberArg, objectRecord, pickDate, stringArg, stringValue,
} from "../normalize.js";

export const DEEPSEEK_MAX_QUERY_CODEPOINTS = 128;
const NEED_CONTENT_MAX_CHARS = 32_000;

const KEY_AUTH_OR_QUOTA_TEXT = /(?:invalid|missing|expired|revoked)\s+(?:api[\s_-]?key|access[\s_-]?token)|api[\s_-]?key\s+(?:is\s+)?(?:invalid|missing|not\s+(?:valid|found))|account\s+(?:suspended|disabled|banned)|authentication\s+(?:failed|required)|insufficient[\s_-]+(?:balance|credits?|funds)|balance\s+(?:is\s+)?(?:insufficient|too\s+low|exhausted)|out[\s_-]+of[\s_-]+credits?|payment[\s_-]+required/i;

export const DEEPSEEK_SEARCH_PROPERTIES: Record<string, unknown> = {
  limit: { type: "integer", minimum: 1, maximum: 50, default: 10, description: "Number of results (1-50)" },
  oriQuestion: { type: "string", maxLength: 128, description: "Optional original user question (<=128 chars) for reranking" },
  needContent: { type: "boolean", default: false, description: "Include fuller page text alongside summaries when available" },
  localization: { type: "string", description: "Optional IPv4/IPv6 address for regional search localization" },
  includeDomains: { type: "array", maxItems: 10, items: { type: "string" }, description: "Compiled into site: operators (within 128-char query limit)" },
  excludeDomains: { type: "array", maxItems: 10, items: { type: "string" }, description: "Compiled into -site: operators (within 128-char query limit)" },
  languages: { type: "array", maxItems: 5, items: { type: "string" }, description: "Compiled into lang: operators (e.g. [\"zh\"], [\"en\"])" },
  afterDate: { type: "string", format: "date", description: "Compiled into after:YYYY-MM-DD" },
  beforeDate: { type: "string", format: "date", description: "Compiled into before:YYYY-MM-DD" },
};

export interface DeepSeekSearchItem extends SearchItem {
  rerankScore?: number;
  authority?: number;
  siteName?: string;
}

export interface PreparedDeepSeekSearch {
  query: string;
  count: number;
  needContent: boolean;
  oriQuestion?: string;
  localization?: string;
}

const FETCH_TOOL: Tool = {
  name: "deepseek_fetch",
  title: "DeepSeek Fetch",
  description: "Read one public http(s) URL as clean Markdown through DeepSeek's official /v1/tools/fetch API.",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", minLength: 1, maxLength: 8192, description: "Public http(s) URL without embedded credentials" },
    },
    required: ["url"],
    additionalProperties: false,
  },
  annotations: READ_ONLY_OPEN,
};

/** Count Unicode code points (DeepSeek enforces a 128 code-point limit on search queries). */
export function unicodeLength(text: string): number {
  return Array.from(text).length;
}

/** Build a DeepSeek search query with optional native site:/lang:/after:/before: operators. */
export function buildDeepSeekQuery(args: Record<string, unknown>): string {
  const parts = [stringArg(args, "query").trim()];
  const include = cleanDomains(arrayArg(args, "includeDomains"));
  const exclude = cleanDomains(arrayArg(args, "excludeDomains"));
  if (include.length === 1) parts.push(`site:${include[0]}`);
  else if (include.length > 1) parts.push(`(${include.map((d) => `site:${d}`).join(" OR ")})`);
  for (const domain of exclude) parts.push(`-site:${domain}`);
  const languages = arrayArg(args, "languages")
    .map((lang) => lang.replace(/\s+/g, "").toLowerCase())
    .filter(Boolean);
  if (languages.length === 1) parts.push(`lang:${languages[0]}`);
  else if (languages.length > 1) parts.push(`(${languages.map((lang) => `lang:${lang}`).join(" OR ")})`);
  const afterDate = stringArg(args, "afterDate").trim();
  const beforeDate = stringArg(args, "beforeDate").trim();
  if (afterDate) parts.push(`after:${afterDate}`);
  if (beforeDate) parts.push(`before:${beforeDate}`);
  return parts.filter(Boolean).join(" ").trim();
}

/** Validate and normalize DeepSeek search arguments shared by direct DeepSeek and Vercel Gateway adapters. */
export function prepareDeepSeekSearch(
  args: Record<string, unknown>,
  config: ProviderConfig | undefined,
  toolName: string,
): PreparedDeepSeekSearch {
  const query = buildDeepSeekQuery(args);
  if (!query) throw new InvalidRequestError(`${toolName} requires a non-empty query`);
  if (unicodeLength(query) > DEEPSEEK_MAX_QUERY_CODEPOINTS) {
    throw new InvalidRequestError(
      `${toolName} query exceeds DeepSeek's ${DEEPSEEK_MAX_QUERY_CODEPOINTS}-character limit (${unicodeLength(query)} chars)`,
    );
  }
  const count = Math.min(50, Math.max(1, Math.round(numberArg(args, "limit", 10))));
  const needContent = args.needContent === true;
  const rawOri = stringArg(args, "oriQuestion").trim();
  const oriQuestion = rawOri ? Array.from(rawOri).slice(0, DEEPSEEK_MAX_QUERY_CODEPOINTS).join("") : undefined;
  const localization = stringArg(args, "localization").trim()
    || (typeof config?.options?.localization === "string" ? config.options.localization.trim() : "")
    || undefined;
  return {
    query,
    count,
    needContent,
    ...(oriQuestion ? { oriQuestion } : {}),
    ...(localization ? { localization } : {}),
  };
}

export function normalizeDeepSeekItems(
  results: unknown,
  needContent: boolean,
  maxChars = needContent ? NEED_CONTENT_MAX_CHARS : DEFAULT_ITEM_TEXT_CHARS,
): DeepSeekSearchItem[] {
  if (!Array.isArray(results)) return [];
  return results.map((row) => {
    const item = objectRecord(row);
    const content = stringValue(item.content)?.trim() ?? "";
    const summary = stringValue(item.summary)?.trim() ?? "";
    const snippet = stringValue(item.snippet)?.trim() ?? "";
    const text = (needContent && content ? content : summary || snippet || content).slice(0, maxChars);
    const url = stringValue(item.url)?.trim() ?? "";
    const siteName = stringValue(item.site_name)?.trim() ?? stringValue(item.siteName)?.trim();
    const title = stringValue(item.title)?.trim() || siteName || url;
    const date = pickDate(item, ["date", "publish_date", "published_date"]);
    const rawRerank = item.rerank_score ?? item.rerankScore;
    const rerankScore = typeof rawRerank === "number" && Number.isFinite(rawRerank)
      ? rawRerank
      : undefined;
    const authority = typeof item.authority === "number" && Number.isFinite(item.authority)
      ? item.authority
      : undefined;
    return {
      title,
      url,
      text,
      ...(date ? { date } : {}),
      ...(rerankScore !== undefined ? { rerankScore } : {}),
      ...(authority !== undefined ? { authority } : {}),
      ...(siteName ? { siteName } : {}),
    };
  }).filter((item) => Boolean(item.url));
}

export function validateFetchTargetUrl(rawUrl: string, toolName: string): string {
  return validateBaseFetchTargetUrl(rawUrl, toolName).toString();
}

export function formatDeepSeekFetchResult(url: string, data: Record<string, unknown>): { text: string; title?: string; url: string } {
  const title = stringValue(data.title)?.trim();
  const content = stringValue(data.content)?.trim() ?? "";
  if (!content) {
    throw new TargetPageError("DeepSeek fetch returned no content for the page");
  }
  return {
    text: formatExtractedPage({
      ...(title ? { title } : {}),
      url,
      body: content,
    }),
    ...(title ? { title } : {}),
    url,
  };
}

export class DeepSeekAdapter implements RestAdapter {
  tools(): Tool[] {
    const search = searchTool(
      "deepseek_search",
      "DeepSeek Search",
      "Search the web through DeepSeek's official /v1/tools/search API. Strong on Chinese and bilingual queries with summaries, rerank scores, and native site:/lang:/after:/before: operators (max 128 characters).",
      DEEPSEEK_SEARCH_PROPERTIES,
    );
    return [search, FETCH_TOOL];
  }

  async call(
    tool: string,
    args: Record<string, unknown>,
    key: string,
    config: ProviderConfig,
    context?: RestAdapterContext,
  ): Promise<unknown> {
    if (tool === "deepseek_fetch") return this.callFetch(args, key, config, context);
    return this.callSearch(args, key, config, context);
  }

  private async callSearch(
    args: Record<string, unknown>,
    key: string,
    config: ProviderConfig,
    context?: RestAdapterContext,
  ): Promise<unknown> {
    const prepared = prepareDeepSeekSearch(args, config, "deepseek_search");
    const body: Record<string, unknown> = {
      query: prepared.query,
      count: prepared.count,
      ...(prepared.needContent ? { need_content: true } : {}),
      ...(prepared.oriQuestion ? { ori_question: prepared.oriQuestion } : {}),
      ...(prepared.localization ? { localization: prepared.localization } : {}),
    };
    const data = await requestJson(endpointOf(config, "https://api.deepseek.com", "/v1/tools/search"), {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }, {
      timeoutMs: timeoutOf(config, 20_000),
      ...(context?.signal ? { signal: context.signal } : {}),
    });
    return { items: normalizeDeepSeekItems(data.results, prepared.needContent).slice(0, prepared.count) };
  }

  private async callFetch(
    args: Record<string, unknown>,
    key: string,
    config: ProviderConfig,
    context?: RestAdapterContext,
  ): Promise<unknown> {
    const url = validateBaseFetchTargetUrl(stringArg(args, "url"), "deepseek_fetch").toString();
    try {
      const data = await requestJson(endpointOf(config, "https://api.deepseek.com", "/v1/tools/fetch"), {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      }, {
        timeoutMs: timeoutOf(config, 30_000),
        ...(context?.signal ? { signal: context.signal } : {}),
      });
      return formatDeepSeekFetchResult(url, data);
    } catch (error) {
      if (error instanceof HttpError) {
        // DeepSeek /v1/tools/fetch returns 403 when target URL violates its security policy;
        // do NOT disable the API key unless the body actually describes an auth/credit fault.
        const isKeyFault = KEY_AUTH_OR_QUOTA_TEXT.test(error.message)
          || keyFaultStatusFromToolText(error.message, "fetch") !== undefined;
        if (error.status === 403 && !isKeyFault) {
          throw new TargetPageError(`DeepSeek fetch blocked target URL: ${error.message}`, 403);
        }
        // DeepSeek /v1/tools/fetch conflates 404 for both dead URLs and unextractable/SPA pages;
        // omit pageStatus so fetch_auto still fails over to browser-capable readers.
        if (error.status === 404) {
          throw new TargetPageError(`DeepSeek fetch could not extract page: ${error.message}`);
        }
      }
      throw error;
    }
  }
}
