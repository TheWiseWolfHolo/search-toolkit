import { TargetPageError, textOfContent } from "./errors.js";
import { bodyBlocks, cleanError, isRouteContentBlock, routeBlock, updateAutoMetadata, type Route } from "./provenance.js";
import type { AutoQuality } from "./routes.js";

export interface TruncateOptions {
  offset?: number;
  section?: string;
}

interface FetchPage {
  status: "readable" | "partial";
  nextOffset?: number;
}

const MIN_FETCH_CHARS = 80;

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

export function bodyText(output: unknown): string {
  return textOfContent(bodyBlocks(output));
}

export function isUsableFetchText(text: string): boolean {
  // Some adapters prepend a Markdown title or `Title:` header and source URL. These are not page text.
  const trimmed = text.trim().replace(/^(?:(?:#|Title:)\s*[^\n]*\n+)?URL:\s*[^\n]*(?:\n+|$)/i, "");
  if (trimmed.length < MIN_FETCH_CHARS) return false;
  if (trimmed.length < 1_500 && INTERSTITIAL_PAGE_PATTERN.test(trimmed)) return false;
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
    const status = typeof (err as { status?: unknown })?.status === "number"
      ? (err as { status: number }).status
      : Number(message.match(/\b([45]\d\d)\b/)?.[1]);
    throw new TargetPageError(`reader could not get the page: ${message}`, Number.isFinite(status) ? status : undefined);
  }
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
    if (parsed.username || parsed.password) {
      throw new Error("fetch_auto rejects URLs with embedded credentials");
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

function filterTextBySection(text: string, sectionQuery: string): string {
  const normalized = text.replace(/\r\n?/g, "\n");
  const needle = sectionQuery.toLowerCase();
  const lines = normalized.split("\n");
  // Track fenced code blocks so `# comments` inside shell/python examples are never treated as headings.
  const headings: Array<{ line: number; level: number; title: string }> = [];
  let fenceChar: string | undefined;
  let fenceLen = 0;
  for (let i = 0; i < lines.length; i += 1) {
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
    const match = raw.match(/^(#{1,6})\s+(.+)$/);
    if (match?.[1] && match[2]) {
      headings.push({ line: i, level: match[1].length, title: match[2] });
    }
  }

  const matching = headings
    .map((heading, idx) => ({ heading, idx }))
    .filter(({ heading }) => heading.title.toLowerCase().includes(needle));

  if (matching.length > 0) {
    const sectionBounds = (idx: number, includeSiblingTabs: boolean): { start: number; end: number; bodyChars: number } => {
      const start = headings[idx]!;
      let endLine = lines.length;
      let sawBody = false;
      for (let j = idx + 1; j < headings.length; j += 1) {
        const next = headings[j]!;
        const between = lines.slice(headings[j - 1]!.line + 1, next.line).join("\n").trim();
        if (between.length > 0) sawBody = true;
        if (next.level <= start.level) {
          if (includeSiblingTabs && !sawBody && next.level === start.level && start.level >= 3) {
            continue;
          }
          endLine = next.line;
          break;
        }
      }
      const bodyChars = lines.slice(start.line + 1, endLine).join("\n").trim().length;
      return { start: start.line, end: endLine, bodyChars };
    };
    const evaluated = matching.map(({ heading, idx }) => ({
      heading,
      idx,
      strict: sectionBounds(idx, false),
    }));
    const chosen = evaluated.find((entry) => entry.strict.bodyChars > 0 && entry.heading.level >= 2)
      ?? evaluated.find((entry) => entry.strict.bodyChars > 0)
      ?? evaluated[0]!;
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

/** Cap the readable text of a result, supporting optional section filtering and character offset. */
export function truncateBody(output: unknown, maxChars: number, options: TruncateOptions = {}, status?: FetchPage["status"]): unknown {
  if (!output || typeof output !== "object") return output;
  const record = output as { content?: unknown };
  if (!Array.isArray(record.content)) return output;
  let skip = options.offset && options.offset > 0 ? Math.floor(options.offset) : 0;
  let remaining = maxChars;
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
  const content = sourceContent.map((block, index) => {
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
  const nextOffset = dropped > 0 && status !== "partial" ? Math.max(0, Math.floor(options.offset ?? 0)) + maxChars : undefined;
  if (dropped > 0) {
    content.push({
      type: "text",
      text: nextOffset !== undefined
        ? `…[truncated: ${dropped} more characters; pass offset=${nextOffset} or raise maxChars to read further]`
        : `…[partial response trimmed by ${dropped} characters]`,
    });
  }
  const clipped = { ...record, content };
  return status ? updateAutoMetadata(clipped, { page: { status, ...(nextOffset !== undefined ? { nextOffset } : {}) } }) : clipped;
}
