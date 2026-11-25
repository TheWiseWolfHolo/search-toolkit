import { TargetPageError, textOfContent } from "./errors.js";
import { bodyBlocks, cleanError, isRouteContentBlock, routeBlock, updateAutoMetadata, type Route } from "./provenance.js";
import type { AutoQuality } from "./routes.js";
import { safeSlice } from "./shape.js";

export interface TruncateOptions {
  offset?: number | undefined;
  section?: string | undefined;
}

export interface TruncateHintContext {
  isBatch?: boolean | undefined;
  section?: string | undefined;
}

interface FetchPage {
  status: "readable" | "partial";
  nextOffset?: number;
}

const MIN_FETCH_CHARS = 80;
const INTERSTITIAL_SHORT_MAX_CHARS = 1_500;
const INTERSTITIAL_EXTENDED_MAX_CHARS = 6_000;

const INTERSTITIAL_PAGE_PATTERN = new RegExp([
  "just a moment[\\s\\S]{0,160}enable javascript and cookies",
  "attention required!\\s*\\|\\s*cloudflare",
  "please enable js and disable any ad blocker",
  "verify you are human",
  "cf-browser-verification",
  "checking your browser before accessing",
  "vercel security checkpoint",
  "we(?:'|’)re verifying your browser",
  "access denied[\\s\\S]{0,120}(?:reference #|errors\\.edgesuite\\.net|akamai)",
  "px-captcha|datadome",
  "you need to enable javascript to run this app",
  "please enable javascript to view this (?:page|site)",
  "环境异常[\\s\\S]{0,80}(?:完成验证|继续访问|去验证)",
  "当前环境异常|百度安全验证|请完成安全验证",
].join("|"), "i");

const INTERSTITIAL_SECONDARY_SIGNALS: readonly RegExp[] = [
  /cloudflare\s+ray\s+id|\bray\s+id\s*:/i,
  /performance\s*(?:&|and)\s*security\s+by\s+cloudflare/i,
  /why\s+have\s+i\s+been\s+blocked/i,
  /security\s+service\s+to\s+protect\s+itself\s+from\s+online\s+attacks/i,
  /checking\s+if\s+the\s+site\s+connection\s+is\s+secure/i,
  /enable\s+javascript\s+and\s+cookies|javascript\s+is\s+required/i,
  /please\s+stand\s+by|ddos\s+protection|bot\s+protection/i,
  /reference\s*#[\da-f.]{6,}/i,
  /access\s+to\s+this\s+page\s+has\s+been\s+denied/i,
  /人机验证|安全验证|安全检测|请开启\s*javascript/i,
];

function substantiveProseChars(text: string): number {
  let total = 0;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine
      .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/https?:\/\/\S+/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (line.length >= 60 && /[a-z\u4e00-\u9fff]{3,}/i.test(line)) {
      total += line.length;
    }
  }
  return total;
}

export function bodyText(output: unknown): string {
  return textOfContent(bodyBlocks(output));
}

export function isUsableFetchText(text: string): boolean {
  // Some adapters prepend a Markdown title or `Title:` header and source URL. These are not page text.
  const trimmed = text.trim().replace(/^(?:(?:#|Title:)\s*[^\n]*\n+)?URL:\s*[^\n]*(?:\n+|$)/i, "");
  if (trimmed.length < MIN_FETCH_CHARS) return false;
  if (trimmed.length < INTERSTITIAL_SHORT_MAX_CHARS && INTERSTITIAL_PAGE_PATTERN.test(trimmed)) return false;
  if (trimmed.length < INTERSTITIAL_EXTENDED_MAX_CHARS && INTERSTITIAL_PAGE_PATTERN.test(trimmed)) {
    const secondaryHits = INTERSTITIAL_SECONDARY_SIGNALS.filter((re) => re.test(trimmed)).length;
    if (secondaryHits >= 2) return false;
    const proseChars = substantiveProseChars(trimmed);
    const proseRatio = proseChars / trimmed.length;
    if (secondaryHits >= 1 && (proseChars < 1_800 || proseRatio < 0.55)) return false;
    if (proseChars < 1_200 || proseRatio < 0.45) return false;
  }
  return true;
}

export function isUsableFetchResult(output: unknown): boolean {
  const structured = (output as {
    structuredContent?: { provider?: string; data?: { results?: Array<{ full_content?: unknown }> } };
  } | undefined)?.structuredContent;
  if (structured?.provider === "parallel") {
    // Extract returns excerpts separately; their length does not make them the page body.
    const body = structured.data?.results?.[0]?.full_content;
    return typeof body === "string" && isUsableFetchText(body);
  }
  return isUsableFetchText(bodyText(output));
}

/**
 * Some readers answer with their raw JSON envelope as text: Firecrawl's
 * `{"markdown": ...}`, Tavily's `{"results": [...], "failed_results": [...]}`.
 * Unwrap it into the page text so the model reads Markdown, not escaped JSON.
 * An envelope that holds only failures means the page was not read.
 */
export function readableFetchOutput(output: unknown): unknown {
  if (!output || typeof output !== "object" || !Array.isArray((output as { content?: unknown }).content)) return output;
  const record = output as { content: unknown[] };
  let changed = false;
  const content = record.content.map((block, index) => {
    if (index === 0 && isRouteContentBlock(block)) return block;
    const text = (block as { type?: string; text?: unknown })?.type === "text" ? (block as { text?: unknown }).text : undefined;
    if (typeof text !== "string" || !/^\s*[{[]/.test(text)) return block;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return block;
    }
    const unwrapped = envelopeText(parsed);
    if (unwrapped === undefined) return block;
    changed = true;
    return { ...(block as object), text: unwrapped };
  });
  return changed ? { ...record, content } : output;
}

const HTTP_STATUS_PREFIX = /(?:^|[\s([,])(?:http(?:\/\d(?:\.\d)?)?|status(?:[\s_-]?code)?|http[\s_-]?status(?:[\s_-]?code)?|crawl_http|scrape_http|error[\s_-]?code|returned|responded\s+with|failed\s+with)[\s_:=/-]+([45]\d\d)(?!\d)/i;
const LEADING_HTTP_STATUS = /^\s*([45]\d\d)(?=\s*(?:$|[:\-–—]|not\s+found|page\s+not\s+found|gone|forbidden|blocked|unauthorized|too\s+many|rate\s+limit|unavailable|bad\s+gateway|gateway|internal|server\s+error|service|client\s+error|access\s+denied|legal|error\b))/i;
const INLINE_HTTP_REASON = /\b(400\s+bad\s+request|401\s+unauthori[sz]ed|403\s+(?:forbidden|blocked|access\s+denied)|404\s+(?:page\s+)?not\s+found|408\s+request\s+timeout|410\s+gone|429\s+too\s+many\s+requests|451\s+unavailable|500\s+internal\s+server\s+error|502\s+bad\s+gateway|503\s+service\s+unavailable|504\s+gateway\s+timeout)\b/i;

function validErrorStatus(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 400 && value <= 599 ? value : undefined;
}

function extractPageStatus(source: unknown, message: string): number | undefined {
  if (source && typeof source === "object") {
    const obj = source as Record<string, unknown>;
    const direct = validErrorStatus(obj.status)
      ?? validErrorStatus(obj.statusCode)
      ?? validErrorStatus(obj.status_code)
      ?? validErrorStatus(obj.http_status_code);
    if (direct !== undefined) return direct;
  }
  const prefixed = message.match(HTTP_STATUS_PREFIX)?.[1];
  if (prefixed) return Number(prefixed);
  const leading = message.match(LEADING_HTTP_STATUS)?.[1];
  if (leading) return Number(leading);
  const inline = message.match(INLINE_HTTP_REASON)?.[1]?.slice(0, 3);
  if (inline) return Number(inline);
  return undefined;
}

function envelopeText(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (record.success === false && record.error) {
    const err = record.error;
    const message = typeof err === "string"
      ? err
      : typeof (err as { message?: unknown })?.message === "string"
        ? (err as { message: string }).message
        : JSON.stringify(err);
    const status = extractPageStatus(err, message);
    throw new TargetPageError(`reader could not get the page: ${message}`, status);
  }
  const pages = Array.isArray(record.results) ? record.results : Array.isArray(value) ? value : undefined;
  if (pages) {
    const texts = pages.map((page) => pageText(page)).filter((text): text is string => Boolean(text));
    if (texts.length) return texts.join("\n\n---\n\n");
    const failed = Array.isArray(record.failed_results) ? record.failed_results : Array.isArray(record.errors) ? record.errors : [];
    if (failed.length) {
      const first = failed[0] as Record<string, unknown>;
      const reason = String(first?.error ?? first?.message ?? "no content");
      const status = extractPageStatus(first, reason);
      throw new TargetPageError(`reader could not get the page: ${reason}`, status);
    }
    return undefined;
  }
  return pageText(record.data && typeof record.data === "object" ? record.data : record);
}

function pageText(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const page = value as Record<string, unknown>;
  const body = [page.markdown, page.raw_content, page.content, page.text].find((item) => typeof item === "string" && item.trim()) as string | undefined;
  if (!body) return undefined;
  const metadata = page.metadata && typeof page.metadata === "object" ? page.metadata as Record<string, unknown> : {};
  const title = typeof page.title === "string" ? page.title : typeof metadata.title === "string" ? metadata.title : undefined;
  const url = typeof page.url === "string" ? page.url : typeof metadata.sourceURL === "string" ? metadata.sourceURL : undefined;
  const header = [title ? `# ${title}` : "", url ? `URL: ${url}` : ""].filter(Boolean).join("\n");
  return [header, body.trim()].filter(Boolean).join("\n\n");
}

export function parseFetchUrls(args: Record<string, unknown>): string[] {
  const raw: string[] = [];
  if (typeof args.url === "string" && args.url.trim()) raw.push(args.url.trim());
  if (Array.isArray(args.urls)) {
    for (const item of args.urls) {
      const trimmed = String(item ?? "").trim();
      if (trimmed) raw.push(trimmed);
    }
  }
  if (raw.length === 0) throw new Error("fetch_auto requires an absolute http(s) URL");
  const normalized: string[] = [];
  for (const candidate of raw) {
    let parsed: URL;
    try {
      parsed = new URL(candidate);
    } catch {
      throw new Error("fetch_auto requires an absolute http(s) URL");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("fetch_auto requires an http(s) URL");
    }
    if (parsed.username || parsed.password) {
      throw new Error("fetch_auto rejects URLs with embedded credentials");
    }
    // Strip non-SPA #fragments (preserve #/ and #!) so url#a and url#b dedupe and hit cache cleanly.
    if (!parsed.hash.startsWith("#/") && !parsed.hash.startsWith("#!")) {
      parsed.hash = "";
    }
    const href = parsed.toString();
    if (!normalized.includes(href)) normalized.push(href);
  }
  return normalized.slice(0, 5);
}

export function combineBatchFetch(
  urls: string[],
  settled: PromiseSettledResult<unknown>[],
  quality: AutoQuality,
): unknown {
  const routes: Array<Route & { url: string }> = [];
  const failed: Array<{ url: string; error: string }> = [];
  const pages: Array<FetchPage & { url: string }> = [];
  const sections: string[] = [];
  settled.forEach((outcome, index) => {
    const url = urls[index] as string;
    if (outcome.status === "rejected") {
      failed.push({ url, error: cleanError(outcome.reason) });
      sections.push(`=== [${index + 1}/${urls.length}] ${url} [error] ===\n${cleanError(outcome.reason)}`);
      return;
    }
    const value = outcome.value as {
      content?: Array<{ type: string; text?: string }>;
      structuredContent?: { route?: Route; searchAuto?: { page?: FetchPage } };
    };
    const route: Route = value?.structuredContent?.route ?? { provider: "unknown", tool: "fetch_auto", upstreamTool: "fetch_auto" };
    routes.push({ url, ...route });
    const page = value.structuredContent?.searchAuto?.page ?? { status: "readable" };
    pages.push({ url, ...page });
    const text = bodyText(value).trim();
    sections.push(`=== [${index + 1}/${urls.length}] ${url} (${route.provider}, ${page.status}) ===\n${text}`);
  });
  if (routes.length === 0) {
    throw new Error(`fetch_auto failed for all ${urls.length} URLs: ${failed.map((f) => `${f.url}: ${f.error}`).join("; ")}`);
  }
  const primaryRoute = routes[0] as Route & { url: string };
  const partial = pages.filter((page) => page.status === "partial").map((page) => page.url);
  const auto = { mode: "fetch", quality, batch: { total: urls.length, succeeded: pages.length - partial.length, partial, routes, failed } };
  return {
    content: [
      routeBlock(primaryRoute, auto),
      { type: "text", text: sections.join("\n\n") },
    ],
    structuredContent: { route: primaryRoute, searchAuto: auto, result: { urls, routes, pages, failed } },
    _meta: { searchToolkit: { route: primaryRoute, auto } },
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeHeadingTitle(raw: string): string {
  return raw
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_`~]/g, "")
    .replace(/\s+(?:#+|¶)\s*$/, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function headingMatchTier(rawTitle: string, needle: string, boundaryRe: RegExp | undefined): number {
  const title = normalizeHeadingTitle(rawTitle);
  if (!title) return 0;
  if (title === needle) return 3;
  if (boundaryRe && boundaryRe.test(title)) return 2;
  if (title.includes(needle)) return 1;
  return 0;
}

function isSetextTitleCandidate(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (/^(?:#{1,6}\s|>|[-*+]\s|\d+\.\s|\||(?:[-*_]\s*){3,}$)/.test(trimmed)) return false;
  return true;
}

interface MarkdownHeading {
  line: number;
  bodyStart: number;
  level: number;
  title: string;
}

function filterTextBySection(text: string, sectionQuery: string): string {
  const normalized = text.replace(/\r\n?/g, "\n");
  const needle = sectionQuery.trim().toLowerCase().replace(/\s+/g, " ");
  const lines = normalized.split("\n");
  // Track fenced code blocks (and YAML frontmatter) so comments or dashes inside them are never headings.
  const headings: MarkdownHeading[] = [];
  let fenceChar: string | undefined;
  let fenceLen = 0;
  let startLine = 0;
  if (lines[0]?.trim() === "---") {
    for (let k = 1; k < lines.length; k += 1) {
      if (lines[k]?.trim() === "---") {
        startLine = k + 1;
        break;
      }
    }
  }
  for (let i = startLine; i < lines.length; i += 1) {
    const raw = lines[i] ?? "";
    const fence = raw.match(/^\s*(`{3,}|~{3,})/);
    if (fence?.[1]) {
      const marker = fence[1];
      if (!fenceChar) {
        fenceChar = marker[0];
        fenceLen = marker.length;
      } else if (marker[0] === fenceChar && marker.length >= fenceLen && /^\s*(?:`{3,}|~{3,})\s*$/.test(raw)) {
        fenceChar = undefined;
        fenceLen = 0;
      }
      continue;
    }
    if (fenceChar) continue;
    const atx = raw.match(/^\s{0,3}(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/);
    if (atx?.[1] && atx[2]) {
      headings.push({ line: i, bodyStart: i + 1, level: atx[1].length, title: atx[2] });
      continue;
    }
    const nextLine = lines[i + 1];
    if (nextLine !== undefined && isSetextTitleCandidate(raw)) {
      const setext = nextLine.match(/^\s{0,3}(={2,}|-{2,})\s*$/);
      if (setext?.[1]) {
        const level = setext[1][0] === "=" ? 1 : 2;
        headings.push({ line: i, bodyStart: i + 2, level, title: raw.trim() });
        i += 1;
      }
    }
  }

  const startsLatin = /^[a-z0-9]/.test(needle);
  const endsLatin = /[a-z0-9]$/.test(needle);
  const boundaryRe = needle && (startsLatin || endsLatin)
    ? new RegExp(`${startsLatin ? "(?<![a-z0-9])" : ""}${escapeRegExp(needle)}${endsLatin ? "(?![a-z0-9])" : ""}`, "i")
    : undefined;

  const matching = headings
    .map((heading, idx) => ({ heading, idx, tier: headingMatchTier(heading.title, needle, boundaryRe) }))
    .filter(({ tier }) => tier > 0);

  if (matching.length > 0) {
    const sectionBounds = (idx: number, includeSiblingTabs: boolean): { start: number; end: number; bodyChars: number } => {
      const start = headings[idx]!;
      let endLine = lines.length;
      let sawBody = false;
      for (let j = idx + 1; j < headings.length; j += 1) {
        const next = headings[j]!;
        const between = lines.slice(headings[j - 1]!.bodyStart, next.line).join("\n").trim();
        if (between.length > 0) sawBody = true;
        if (next.level <= start.level) {
          if (includeSiblingTabs && !sawBody && next.level === start.level && start.level >= 3) {
            continue;
          }
          endLine = next.line;
          break;
        }
      }
      const bodyChars = lines.slice(start.bodyStart, endLine).join("\n").trim().length;
      return { start: start.line, end: endLine, bodyChars };
    };
    const evaluated = matching.map(({ heading, idx, tier }) => ({
      heading,
      idx,
      tier,
      strict: sectionBounds(idx, false),
    }));
    // Prefer non-empty section, then higher match specificity (exact > word-boundary > substring),
    // then sub-headings (level >= 2) over H1 page titles, then document order.
    evaluated.sort((a, b) =>
      ((b.strict.bodyChars > 0 ? 1 : 0) - (a.strict.bodyChars > 0 ? 1 : 0))
      || (b.tier - a.tier)
      || ((b.heading.level >= 2 ? 1 : 0) - (a.heading.level >= 2 ? 1 : 0))
      || (a.idx - b.idx),
    );
    const chosen = evaluated[0]!;
    const bounds = chosen.strict.bodyChars > 0 ? chosen.strict : sectionBounds(chosen.idx, true);
    return lines.slice(bounds.start, bounds.end).join("\n").trim();
  }

  const blocks = normalized.split(/\n{2,}/);
  const matchingIndices: number[] = [];
  blocks.forEach((block, index) => {
    if (block.toLowerCase().includes(needle)) matchingIndices.push(index);
  });
  if (matchingIndices.length === 0) {
    return `[section "${sectionQuery}" not found; showing start of page]\n\n${normalized}`;
  }
  const picked = new Set<number>();
  for (const hit of matchingIndices) {
    for (let idx = Math.max(0, hit - 1); idx <= Math.min(blocks.length - 1, hit + 3); idx += 1) {
      picked.add(idx);
    }
  }
  return Array.from(picked)
    .sort((a, b) => a - b)
    .map((idx) => blocks[idx])
    .join("\n\n");
}

function buildTruncationHint(
  dropped: number,
  status: FetchPage["status"] | undefined,
  nextOffset: number | undefined,
  isBatch: boolean,
  section: string | undefined,
): string {
  if (status === "partial") {
    return `…[partial response trimmed by ${dropped} characters]`;
  }
  const sectionLabel = section ? ` in section "${section}"` : "";
  if (nextOffset === undefined) {
    return `…[truncated: ${dropped} more characters${sectionLabel}; raise maxChars to read further]`;
  }
  if (isBatch && section) {
    return `…[truncated: ${dropped} more characters${sectionLabel}; re-fetch this single URL with offset=${nextOffset} and section="${section}" or raise maxChars to read further]`;
  }
  if (isBatch) {
    return `…[truncated: ${dropped} more characters; re-fetch this single URL with offset=${nextOffset} or raise maxChars to read further]`;
  }
  if (section) {
    return `…[truncated: ${dropped} more characters${sectionLabel}; pass offset=${nextOffset} with section="${section}" or raise maxChars to read further]`;
  }
  return `…[truncated: ${dropped} more characters; pass offset=${nextOffset} or raise maxChars to read further]`;
}

/** Cap the readable text of a result, supporting optional section filtering and character offset. */
export function truncateBody(
  output: unknown,
  maxChars: number,
  options: TruncateOptions = {},
  status?: FetchPage["status"],
  hintContext?: TruncateHintContext,
): unknown {
  if (!output || typeof output !== "object") return output;
  const record = output as { content?: unknown };
  if (!Array.isArray(record.content)) return output;
  const baseOffset = options.offset && options.offset > 0 ? Math.floor(options.offset) : 0;
  let skip = baseOffset;
  let remaining = Math.max(0, Math.floor(maxChars));
  let emittedChars = 0;
  let dropped = 0;
  const sectionQuery = options.section?.trim();
  let sourceContent = record.content;
  if (sectionQuery) {
    const hasRoute = isRouteContentBlock(sourceContent[0]);
    const body = hasRoute ? sourceContent.slice(1) : sourceContent;
    const textBlocks = body.filter((block) => block && typeof block === "object" && (block as { type?: string }).type === "text" && typeof (block as { text?: unknown }).text === "string");
    if (textBlocks.length > 1) {
      const merged = textBlocks.map((block) => (block as { text: string }).text).join("\n\n");
      const nonText = body.filter((block) => !textBlocks.includes(block));
      sourceContent = [...(hasRoute ? [sourceContent[0]] : []), { type: "text", text: merged }, ...nonText];
    }
  }
  const content: unknown[] = [];
  for (let index = 0; index < sourceContent.length; index += 1) {
    const block = sourceContent[index];
    if (index === 0 && isRouteContentBlock(block)) {
      content.push(block);
      continue;
    }
    const text = block && typeof block === "object" ? (block as { type?: string; text?: unknown }) : undefined;
    if (text?.type !== "text" || typeof text.text !== "string") {
      content.push(block);
      continue;
    }
    const sourceText = sectionQuery ? filterTextBySection(text.text, sectionQuery) : text.text;
    if (skip >= sourceText.length) {
      skip -= sourceText.length;
      continue;
    }
    const sliced = skip > 0 ? safeSlice(sourceText, skip) : sourceText;
    skip = 0;
    if (remaining <= 0) {
      dropped += sliced.length;
      continue;
    }
    if (sliced.length <= remaining) {
      remaining -= sliced.length;
      emittedChars += sliced.length;
      if (sliced.length > 0) content.push({ ...text, text: sliced });
      continue;
    }
    const kept = safeSlice(sliced, 0, remaining);
    dropped += sliced.length - kept.length;
    emittedChars += kept.length;
    remaining = 0;
    if (kept.length > 0) content.push({ ...text, text: kept });
  }
  const nextOffset = dropped > 0 && status !== "partial" && emittedChars > 0
    ? baseOffset + emittedChars
    : undefined;
  const effectiveSection = hintContext?.section?.trim() || sectionQuery || undefined;
  if (dropped > 0) {
    content.push({
      type: "text",
      text: buildTruncationHint(dropped, status, nextOffset, hintContext?.isBatch === true, effectiveSection),
    });
  }
  const clipped = { ...record, content };
  return status ? updateAutoMetadata(clipped, { page: { status, ...(nextOffset !== undefined ? { nextOffset } : {}) } }) : clipped;
}
