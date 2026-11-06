import { TargetPageError, textOfContent } from "./errors.js";
import { bodyBlocks, cleanError, isRouteContentBlock, routeBlock, type Route } from "./provenance.js";
import type { AutoQuality } from "./routes.js";

export interface TruncateOptions {
  offset?: number;
  section?: string;
}

const MIN_FETCH_CHARS = 80;

const INTERSTITIAL_PAGE_PATTERN = /just a moment[\s\S]{0,160}enable javascript and cookies|attention required!\s*\|\s*cloudflare|please enable js and disable any ad blocker|verify you are human|cf-browser-verification|checking your browser before accessing/i;

export function bodyText(output: unknown): string {
  return textOfContent(bodyBlocks(output));
}

export function isUsableFetchText(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < MIN_FETCH_CHARS) return false;
  if (trimmed.length < 1_200 && INTERSTITIAL_PAGE_PATTERN.test(trimmed)) return false;
  return true;
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

function envelopeText(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const pages = Array.isArray(record.results) ? record.results : Array.isArray(value) ? value : undefined;
  if (pages) {
    const texts = pages.map((page) => pageText(page)).filter((text): text is string => Boolean(text));
    if (texts.length) return texts.join("\n\n---\n\n");
    const failed = Array.isArray(record.failed_results) ? record.failed_results : Array.isArray(record.errors) ? record.errors : [];
    if (failed.length) {
      const first = failed[0] as Record<string, unknown>;
      const reason = String(first?.error ?? first?.message ?? "no content");
      const status = Number(reason.match(/\b([45]\d\d)\b/)?.[1]);
      throw new TargetPageError(`reader could not get the page: ${reason}`, Number.isFinite(status) ? status : undefined);
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
      structuredContent?: { route?: Route };
    };
    const route: Route = value?.structuredContent?.route ?? { provider: "unknown", tool: "fetch_auto", upstreamTool: "fetch_auto" };
    routes.push({ url, ...route });
    const text = bodyText(value).trim();
    sections.push(`=== [${index + 1}/${urls.length}] ${url} (${String(route.provider ?? "unknown")}) ===\n${text}`);
  });
  if (routes.length === 0) {
    throw new Error(`fetch_auto failed for all ${urls.length} URLs: ${failed.map((f) => `${f.url}: ${f.error}`).join("; ")}`);
  }
  const primaryRoute = routes[0] as Route & { url: string };
  const auto = { mode: "fetch", quality, batch: { total: urls.length, succeeded: routes.length, routes, failed } };
  return {
    content: [
      routeBlock(primaryRoute, auto),
      { type: "text", text: sections.join("\n\n") },
    ],
    structuredContent: { route: primaryRoute, searchAuto: auto, result: { urls, routes, failed } },
    _meta: { searchToolkit: { route: primaryRoute, auto } },
  };
}

function filterTextBySection(text: string, sectionQuery: string): string {
  const needle = sectionQuery.toLowerCase();
  const lines = text.split("\n");
  let startLine = -1;
  let startLevel = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const match = (lines[i] ?? "").match(/^(#{1,6})\s+(.+)$/);
    if (match && (match[2] ?? "").toLowerCase().includes(needle)) {
      startLine = i;
      startLevel = (match[1] ?? "#").length;
      break;
    }
  }
  if (startLine >= 0) {
    let endLine = lines.length;
    for (let i = startLine + 1; i < lines.length; i += 1) {
      const match = (lines[i] ?? "").match(/^(#{1,6})\s+/);
      if (match && (match[1] ?? "#").length <= startLevel) {
        endLine = i;
        break;
      }
    }
    return lines.slice(startLine, endLine).join("\n").trim();
  }
  const blocks = text.split(/\n{2,}/);
  const matchingIndices: number[] = [];
  blocks.forEach((block, index) => {
    if (block.toLowerCase().includes(needle)) matchingIndices.push(index);
  });
  if (matchingIndices.length === 0) {
    return `[section "${sectionQuery}" not found; showing start of page]\n\n${text}`;
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

/** Cap the readable text of a result, supporting optional section filtering and character offset. */
export function truncateBody(output: unknown, maxChars: number, options: TruncateOptions = {}): unknown {
  if (!output || typeof output !== "object") return output;
  const record = output as { content?: unknown };
  if (!Array.isArray(record.content)) return output;
  let skip = options.offset && options.offset > 0 ? Math.floor(options.offset) : 0;
  let remaining = maxChars;
  let dropped = 0;
  const sectionQuery = options.section?.trim();
  const content = record.content.map((block, index) => {
    if (index === 0 && isRouteContentBlock(block)) return block;
    const text = block && typeof block === "object" ? (block as { type?: string; text?: unknown }) : undefined;
    if (text?.type !== "text" || typeof text.text !== "string") return block;
    const sourceText = sectionQuery ? filterTextBySection(text.text, sectionQuery) : text.text;
    if (skip >= sourceText.length) {
      skip -= sourceText.length;
      return { ...text, text: "" };
    }
    const sliced = skip > 0 ? sourceText.slice(skip) : sourceText;
    skip = 0;
    if (sliced.length <= remaining) {
      remaining -= sliced.length;
      return { ...text, text: sliced };
    }
    dropped += sliced.length - remaining;
    const kept = sliced.slice(0, Math.max(remaining, 0));
    remaining = 0;
    return { ...text, text: kept };
  });
  if (dropped > 0) {
    const nextOffset = (options.offset && options.offset > 0 ? Math.floor(options.offset) : 0) + maxChars;
    content.push({
      type: "text",
      text: `…[truncated: ${dropped} more characters; pass offset=${nextOffset} or raise maxChars to read further]`,
    });
  }
  return { ...(output as object), content };
}
