import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { HttpError, InvalidRequestError, parseRetryAfter, statusFromError, TargetPageError } from "../errors.js";
import { callWithRotation, failureFlags } from "../keys.js";
import { dedupeItems } from "../merge.js";
import { cleanError, redact, routeBlock } from "../provenance.js";
import { renderPayload } from "../render.js";
import type { QuotaUnit, RotationStore } from "../rotation.js";
import type { CallOptions, KeySelection, ProviderConfig, SearchItem, ToolBinding } from "../types.js";

export const READ_ONLY_OPEN = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

export const KNOWN_ENDPOINT_SUFFIX = /\/(?:(?:res\/)?v\d+\/(?:web\/search|news\/search|images\/search|llm\/context|tools\/(?:search|fetch)|search-premier|search|extract|contents|scrape|fetch|chat\/completions|responses|ai\/language-model)|api\/v3\/contents\/search|web\/search|news\/search|images\/search|llm\/context|search-premier|search|extract|contents|scrape|fetch|chat\/completions|responses|(?:res\/)?v\d+)$/i;

export const DEFAULT_MAX_JSON_BYTES = 10 * 1024 * 1024;
export const MAX_FETCH_URL_LENGTH = 8_192;

export interface RestAdapterContext {
  signal?: AbortSignal;
  recordPassiveQuota?: (remaining: number, unit?: QuotaUnit) => void;
  recordFailure?: (error: unknown) => void;
}

export interface RestAdapter {
  tools(provider: string, config?: ProviderConfig): Tool[];
  call(
    tool: string,
    args: Record<string, unknown>,
    key: string,
    config: ProviderConfig,
    context?: RestAdapterContext,
  ): Promise<unknown>;
}

export class RestProvider {
  constructor(
    readonly name: string,
    private readonly config: ProviderConfig,
    private readonly rotation: RotationStore,
    private readonly adapter: RestAdapter,
  ) {}

  bindings(): ToolBinding[] {
    return this.adapter.tools(this.name, this.config).map((tool) => ({
      provider: this.name,
      upstreamName: tool.name,
      exposed: tool,
      call: async (arguments_: Record<string, unknown>, options?: CallOptions) => this.call(tool.name, arguments_, options),
    }));
  }

  private call(
    tool: string,
    args: Record<string, unknown>,
    options: CallOptions & { signal?: AbortSignal } = {},
  ): Promise<unknown> {
    if (this.config.keys.length === 0 && this.config.integration.kind === "rest" && this.config.integration.adapter === "direct_markdown") {
      return this.callWith({ provider: this.name, slot: 0, key: "", masked: "none", fingerprint: "keyless" }, tool, args, false, options.signal, false);
    }
    const allowExhausted = options.allowExhausted === true;
    return callWithRotation(
      this.rotation,
      this.name,
      this.config,
      {
        tools: [tool],
        ...(options.slot !== undefined ? { pin: options.slot } : {}),
        ...(allowExhausted ? { allowExhausted: true } : {}),
      },
      (selection) => this.callWith(selection, tool, args, true, options.signal, allowExhausted),
    );
  }

  private safeRecord(selection: KeySelection, outcome: Parameters<RotationStore["record"]>[1]): void {
    try {
      this.rotation.record(selection, outcome);
    } catch {
      // Rotation metrics are advisory; a busy or read-only SQLite file must never discard an upstream answer.
    }
  }

  private recordError(selection: KeySelection, error: unknown, latencyMs: number): void {
    const status = statusFromError(error);
    this.safeRecord(selection, {
      ok: false,
      latencyMs,
      ...(status ? { httpStatus: status } : {}),
      ...(error instanceof HttpError && error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}),
      ...failureFlags(error),
      error: cleanError(error),
    });
  }

  private async callWith(
    selection: KeySelection,
    tool: string,
    args: Record<string, unknown>,
    trackRotation: boolean,
    signal?: AbortSignal,
    preserveExhausted = false,
  ): Promise<unknown> {
    const started = performance.now();
    let partialFatalError: unknown;
    const context: RestAdapterContext = {
      ...(signal ? { signal } : {}),
      recordPassiveQuota: (remaining, unit) => {
        if (!trackRotation || !Number.isFinite(remaining)) return;
        try {
          this.rotation.recordQuota(this.name, selection.key, remaining, {
            exhaustOnZero: false,
            preserveStatusOnPositive: true,
            ...(unit ? { unit } : {}),
          });
        } catch {
          // Passive quota observation is advisory and must never break a live response.
        }
      },
      recordFailure: (error) => {
        if (partialFatalError === undefined) partialFatalError = error;
      },
    };
    try {
      const rawPayload = await this.adapter.call(tool, args, selection.key, this.config, context);
      const payload = rawPayload && typeof rawPayload === "object" && Array.isArray((rawPayload as { items?: unknown }).items)
        ? { ...(rawPayload as Record<string, unknown>), items: dedupeItems((rawPayload as { items: SearchItem[] }).items) }
        : rawPayload;
      const latencyMs = Math.round(performance.now() - started);
      if (trackRotation) {
        if (partialFatalError !== undefined) {
          this.recordError(selection, partialFatalError, latencyMs);
        } else {
          this.safeRecord(selection, {
            ok: true,
            latencyMs,
            httpStatus: 200,
            ...(preserveExhausted ? { preserveExhausted: true } : {}),
          });
        }
      }
      const route = { provider: this.name, tool, upstreamTool: tool };
      return {
        // Model-visible content: one compact route block, then readable text.
        content: [
          routeBlock(route),
          { type: "text", text: renderPayload(payload, { dedupe: false }) },
        ],
        structuredContent: {
          provider: this.name,
          tool,
          route,
          keySlot: selection.masked,
          latencyMs,
          data: payload,
        },
        _meta: {
          searchToolkit: { provider: this.name, upstreamTool: tool, keySlot: selection.masked, latencyMs, route },
        },
      };
    } catch (error) {
      const latencyMs = Math.round(performance.now() - started);
      if (trackRotation) {
        if (error instanceof InvalidRequestError) {
          // Local pre-request validation error: do not increment key failures or pollute key state.
        } else if (error instanceof TargetPageError) {
          // The upstream API worked, while the target page failed; record the call and last_error without counting a key failure.
          this.safeRecord(selection, {
            ok: true,
            latencyMs,
            httpStatus: 200,
            toolError: true,
            error: cleanError(error),
            ...(preserveExhausted ? { preserveExhausted: true } : {}),
          });
        } else {
          this.recordError(selection, error, latencyMs);
        }
      }
      throw error;
    }
  }
}

export function baseUrlOf(config: ProviderConfig | undefined, fallback: string): string {
  return config?.integration.kind === "rest" && config.integration.baseUrl ? config.integration.baseUrl : fallback;
}

/**
 * Resolve effective timeout for a REST adapter call, honoring `config.integration.timeoutMs`
 * whenever configured and falling back to `defaultMs`.
 */
export function timeoutOf(
  config: ProviderConfig | undefined,
  defaultMs: number,
  bounds?: { minMs?: number; maxMs?: number },
): number {
  const minMs = bounds?.minMs ?? 1_000;
  const maxMs = bounds?.maxMs ?? 300_000;
  const configured = config?.integration.kind === "rest" && typeof config.integration.timeoutMs === "number" && Number.isFinite(config.integration.timeoutMs)
    ? config.integration.timeoutMs
    : undefined;
  const value = configured ?? defaultMs;
  return Math.min(maxMs, Math.max(minMs, Math.round(value)));
}

/**
 * Full URL of one endpoint under a provider's API root. A configured baseUrl may be the
 * root ("https://proxy.example/parallel") or, as older configs have it, a full
 * /v1/... endpoint; either way the endpoint path is appended to the root while keeping
 * any reverse-proxy path prefix intact.
 */
export function endpointOf(config: ProviderConfig | undefined, root: string, path: string): string {
  const base = baseUrlOf(config, root).replace(/\/+$/, "").replace(KNOWN_ENDPOINT_SUFFIX, "");
  return `${base}${path}`;
}

/** Validate that a target URL is an absolute http(s) URL without embedded credentials. */
export function validateFetchTargetUrl(raw: string, toolName = "fetch"): URL {
  const trimmed = raw.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new InvalidRequestError(`${toolName} requires an absolute http(s) URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new InvalidRequestError(`${toolName} requires an http(s) URL`);
  }
  if (parsed.username || parsed.password) {
    throw new InvalidRequestError(`${toolName} rejects URLs with embedded credentials`);
  }
  if (trimmed.length > MAX_FETCH_URL_LENGTH) {
    throw new InvalidRequestError(`${toolName} URL exceeds ${MAX_FETCH_URL_LENGTH} characters`);
  }
  return parsed;
}

/** Collect, validate, deduplicate, and cap `url` + `urls` arguments while preserving original trimmed URL strings. */
export function collectValidatedUrls(args: Record<string, unknown>, toolName: string, maxUrls: number): string[] {
  const raw: string[] = [];
  if (typeof args.url === "string" && args.url.trim()) raw.push(args.url.trim());
  if (Array.isArray(args.urls)) {
    for (const entry of args.urls) {
      const value = String(entry ?? "").trim();
      if (value) raw.push(value);
    }
  }
  if (!raw.length) throw new InvalidRequestError(`${toolName} requires url or urls`);
  const seen = new Set<string>();
  const valid: string[] = [];
  for (const candidate of raw) {
    validateFetchTargetUrl(candidate, toolName);
    if (!seen.has(candidate)) {
      seen.add(candidate);
      valid.push(candidate);
      if (valid.length >= maxUrls) break;
    }
  }
  return valid;
}

/** Strip scheme, query, fragment, and trailing slashes from domain/path rules while keeping path prefixes. */
export function cleanDomains(values: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    const cleaned = raw
      .trim()
      .replace(/^https?:\/\//i, "")
      .replace(/[?#].*$/, "")
      .replace(/\/+$/, "")
      .replace(/\s+/g, "")
      .toLowerCase();
    if (cleaned && !seen.has(cleaned)) {
      seen.add(cleaned);
      out.push(cleaned);
    }
  }
  return out;
}

/** Strip scheme, path, query, fragment, and trailing slashes to bare hostnames. */
export function cleanHosts(values: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const domain of cleanDomains(values)) {
    const host = domain.replace(/\/.*$/, "");
    if (host && !seen.has(host)) {
      seen.add(host);
      out.push(host);
    }
  }
  return out;
}

/** Render one extracted page with a consistent Markdown heading, URL, optional date, and optional links list. */
export function formatExtractedPage(page: {
  title?: string;
  url?: string;
  date?: string;
  body: string;
  links?: readonly string[];
}): string {
  const title = page.title?.trim();
  const url = page.url?.trim();
  const rawDate = page.date?.trim();
  const date = rawDate ? (/^\d{4}-\d{2}-\d{2}/.test(rawDate) ? rawDate.slice(0, 10) : rawDate.slice(0, 40)) : undefined;
  const header = [
    title ? `# ${title}` : "",
    url ? `URL: ${url}${date ? ` (${date})` : ""}` : "",
  ].filter(Boolean).join("\n");
  const linksBlock = page.links && page.links.length
    ? `\n\nLinks:\n${page.links.join("\n")}`
    : "";
  return `${[header, page.body.trim()].filter(Boolean).join("\n\n")}${linksBlock}`;
}

/** Format one extracted link item (string or `{ url/href, text/title }`) as a Markdown bullet. */
export function formatExtractedLink(entry: unknown): string {
  if (typeof entry === "string") {
    const trimmed = entry.trim();
    return trimmed ? `- ${trimmed}` : "";
  }
  if (!entry || typeof entry !== "object") return "";
  const link = entry as Record<string, unknown>;
  const href = typeof link.url === "string" && link.url.trim()
    ? link.url.trim()
    : typeof link.href === "string" && link.href.trim()
      ? link.href.trim()
      : "";
  if (!href) return "";
  const label = typeof link.text === "string" && link.text.trim()
    ? link.text.trim()
    : typeof link.title === "string" && link.title.trim()
      ? link.title.trim()
      : "";
  return label ? `- ${label}: ${href}` : `- ${href}`;
}

export interface ReadLimitedTextOptions {
  /** When true (default), throw HttpError(502) if body exceeds maxBytes; when false, return the truncated prefix. */
  throwOnLimit?: boolean;
}

/** Read a Response body as UTF-8 while enforcing a strict streaming byte cap. */
export async function readLimitedText(
  response: Response,
  maxBytes: number,
  options: ReadLimitedTextOptions = {},
): Promise<string> {
  const throwOnLimit = options.throwOnLimit !== false;
  const contentLengthHeader = response.headers.get("content-length");
  const contentEncoding = response.headers.get("content-encoding");
  if (throwOnLimit && contentLengthHeader && !contentEncoding) {
    const declared = Number(contentLengthHeader);
    if (Number.isFinite(declared) && declared > maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw new HttpError(`HTTP 502: response body exceeded ${maxBytes}-byte limit`, 502);
    }
  }
  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) {
      if (throwOnLimit) throw new HttpError(`HTTP 502: response body exceeded ${maxBytes}-byte limit`, 502);
      return Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8");
    }
    return text;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let text = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        const overflow = totalBytes - maxBytes;
        const kept = value.subarray(0, Math.max(0, value.byteLength - overflow));
        await reader.cancel().catch(() => undefined);
        if (throwOnLimit) {
          throw new HttpError(`HTTP 502: response body exceeded ${maxBytes}-byte limit`, 502);
        }
        text += decoder.decode(kept, { stream: false });
        return text;
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    reader.releaseLock();
  }
}

/** Parse rate-limit reset duration from `Retry-After` or `X-RateLimit-Reset` / `RateLimit-Reset` headers. */
export function parseRateLimitResetMs(headers: Headers, now = Date.now()): number | undefined {
  const retryAfter = parseRetryAfter(headers.get("retry-after"), now);
  if (retryAfter !== undefined) return retryAfter;

  const rawReset = headers.get("x-ratelimit-reset")
    ?? headers.get("ratelimit-reset")
    ?? headers.get("x-ratelimit-reset-requests");
  if (!rawReset) return undefined;
  const trimmed = rawReset.trim();
  if (!trimmed) return undefined;

  // Brave sends comma-separated "<perSec>, <perMonth>" pairs in X-RateLimit-Reset and X-RateLimit-Remaining.
  if (trimmed.includes(",")) {
    const resetParts = trimmed.split(",").map((part) => Number(part.trim()));
    const rawRem = headers.get("x-ratelimit-remaining") ?? headers.get("ratelimit-remaining");
    const remParts = rawRem ? rawRem.split(",").map((part) => Number(part.trim())) : [];
    const perSecReset = resetParts[0];
    const perMonthReset = resetParts[1];
    const perSecRem = remParts[0];
    const perMonthRem = remParts[1];
    if (perSecRem === 0 && (perMonthRem === undefined || perMonthRem > 0) && perSecReset !== undefined && Number.isFinite(perSecReset) && perSecReset >= 0) {
      return Math.round(perSecReset * 1000);
    }
    if (perMonthRem === 0 && perMonthReset !== undefined && Number.isFinite(perMonthReset) && perMonthReset >= 0) {
      return Math.round(perMonthReset * 1000);
    }
    if (perSecReset !== undefined && Number.isFinite(perSecReset) && perSecReset >= 0) {
      return Math.round(perSecReset * 1000);
    }
    return undefined;
  }

  // OpenAI/xAI-style duration strings: "500ms", "2s", "1m30s", "2m".
  const durationMatch = trimmed.match(/^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m)?(?:(\d+(?:\.\d+)?)s)?(?:(\d+(?:\.\d+)?)ms)?$/i);
  if (durationMatch && (durationMatch[1] || durationMatch[2] || durationMatch[3] || durationMatch[4])) {
    const hours = durationMatch[1] ? Number(durationMatch[1]) * 3_600_000 : 0;
    const minutes = durationMatch[2] ? Number(durationMatch[2]) * 60_000 : 0;
    const seconds = durationMatch[3] ? Number(durationMatch[3]) * 1_000 : 0;
    const millis = durationMatch[4] ? Number(durationMatch[4]) : 0;
    const total = hours + minutes + seconds + millis;
    if (Number.isFinite(total) && total >= 0) return Math.round(total);
  }

  const numeric = Number(trimmed);
  if (Number.isFinite(numeric) && numeric >= 0) {
    if (numeric > 1e12) return Math.max(0, Math.round(numeric - now));
    if (numeric > 1e9) return Math.max(0, Math.round(numeric * 1000 - now));
    return Math.round(numeric * 1000);
  }

  const parsedDate = Date.parse(trimmed);
  return Number.isFinite(parsedDate) ? Math.max(0, parsedDate - now) : undefined;
}

export interface RequestJsonOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  maxBytes?: number;
  onHeaders?: (headers: Headers) => void;
  allowArray?: boolean;
}

export async function requestJson(
  url: string,
  init: RequestInit,
  timeoutOrOptions: number | RequestJsonOptions = 15_000,
): Promise<Record<string, unknown>> {
  const opts: RequestJsonOptions = typeof timeoutOrOptions === "number"
    ? { timeoutMs: timeoutOrOptions }
    : timeoutOrOptions;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_JSON_BYTES;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeoutSignal]) : timeoutSignal;

  const response = await fetch(url, { ...init, redirect: "error", signal });
  opts.onHeaders?.(response.headers);
  const text = await readLimitedText(response, maxBytes, { throwOnLimit: response.ok });
  if (!response.ok) {
    const safe = redact(text).slice(0, 500);
    throw new HttpError(`HTTP ${response.status}: ${safe}`, response.status, parseRateLimitResetMs(response.headers));
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    // A 200 with a non-JSON body is a gateway or captive-page problem, not a request error.
    throw new HttpError(`HTTP 502: non-JSON response (${redact(text.slice(0, 120).replace(/\s+/g, " "))})`, 502);
  }
  if (parsed === null || typeof parsed !== "object" || (!opts.allowArray && Array.isArray(parsed))) {
    throw new HttpError("HTTP 502: unexpected non-object JSON response", 502);
  }
  return parsed as Record<string, unknown>;
}

export function searchTool(name: string, title: string, description: string, extra: Record<string, unknown> = {}): Tool {
  return {
    name,
    title,
    description,
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1, description: "Search query" },
        limit: { type: "integer", minimum: 1, maximum: 20, default: 6 },
        ...extra,
      },
      required: ["query"],
      additionalProperties: false,
    },
    annotations: READ_ONLY_OPEN,
  };
}
