import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import type { Readable } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { InvalidRequestError, TargetPageError } from "../../errors.js";
import { isUsableFetchText } from "../../fetching.js";
import type { ProviderConfig } from "../../types.js";
import { PACKAGE_VERSION } from "../../version.js";
import {
  MAX_FETCH_URL_LENGTH, READ_ONLY_OPEN, readLimitedText, type RestAdapter, type RestAdapterContext,
} from "../base.js";
import { stringArg } from "../normalize.js";

const DEFAULT_TIMEOUT_MS = 4_000;
const MAX_REDIRECTS = 3;
const MAX_BODY_BYTES = 1_000_000;
const MAX_RAW_BODY_BYTES = 2 * MAX_BODY_BYTES;
const MARKDOWN_CONTENT_TYPE = /^text\/(?:x-)?markdown(?:\s*;|$)/i;
const DEFAULT_ALLOWED_PORTS = new Set(["", "80", "443"]);

export type DnsLookupFn = (hostname: string) => Promise<Array<{ address: string }>>;

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export interface ResolvedPublicTarget {
  url: URL;
  addresses: ResolvedAddress[];
}

export interface PublicUrlOptions {
  allowedPorts?: ReadonlySet<string>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface DirectHttpResponse {
  status: number;
  headers: Headers;
  bodyText: () => Promise<string>;
  discard: () => Promise<void>;
}

export type DirectMarkdownTransport = (
  target: ResolvedPublicTarget,
  headers: Record<string, string>,
  signal: AbortSignal,
) => Promise<DirectHttpResponse>;

const defaultLookup: DnsLookupFn = (hostname) => lookup(hostname, { all: true });

const DIRECT_MARKDOWN_TOOL: Tool = {
  name: "direct_markdown_fetch",
  title: "Direct Markdown Fetch",
  description: "Zero-cost HTTP GET with `Accept: text/markdown` for sites (such as Cloudflare Markdown for Agents, Vercel Docs, Stripe, Mintlify) that natively serve clean Markdown. Fails over cleanly when the server responds with HTML.",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", minLength: 1, maxLength: MAX_FETCH_URL_LENGTH, description: "Public http(s) URL to probe for native text/markdown" },
    },
    required: ["url"],
    additionalProperties: false,
  },
  annotations: READ_ONLY_OPEN,
};

function expandIpv6(ip: string): number[] | undefined {
  const withoutZone = ip.split("%")[0] ?? ip;
  const halves = withoutZone.split("::");
  if (halves.length > 2) return undefined;
  const parseSide = (side: string): number[] | undefined => {
    if (!side) return [];
    const parts = side.split(":");
    const groups: number[] = [];
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i] ?? "";
      if (part.includes(".") && i === parts.length - 1 && isIP(part) === 4) {
        const octets = part.split(".").map(Number);
        if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return undefined;
        groups.push(((octets[0] ?? 0) << 8) | (octets[1] ?? 0), ((octets[2] ?? 0) << 8) | (octets[3] ?? 0));
      } else {
        if (!/^[0-9a-f]{1,4}$/i.test(part)) return undefined;
        groups.push(Number.parseInt(part, 16));
      }
    }
    return groups;
  };
  const left = parseSide(halves[0] ?? "");
  const right = halves.length === 2 ? parseSide(halves[1] ?? "") : [];
  if (!left || !right) return undefined;
  if (halves.length === 1) return left.length === 8 ? left : undefined;
  const missing = 8 - (left.length + right.length);
  if (missing < 1) return undefined;
  return [...left, ...Array<number>(missing).fill(0), ...right];
}

function isPrivateIpv4Octets(a: number, b: number, c: number): boolean {
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  if (a === 169 && b === 254) return true; // link-local / cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // 192.0.0.0/24, TEST-NET-1
  if (a === 192 && b === 88 && c === 99) return true; // 6to4 relay anycast 192.88.99.0/24
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmark / TUN fake-ip 198.18.0.0/15
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  if (a >= 224) return true; // multicast / reserved
  return false;
}

/** Reject loopback, link-local, RFC1918, CGNAT, cloud-metadata, NAT64/6to4/Teredo, site-local, and ULA IPv4/IPv6 addresses. */
export function isPrivateIp(address: string): boolean {
  const ip = address.trim().toLowerCase().replace(/^\[|\]$/g, "");
  const version = isIP(ip);
  if (version === 4) {
    const parts = ip.split(".").map(Number);
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
    return isPrivateIpv4Octets(parts[0]!, parts[1]!, parts[2]!);
  }
  if (version === 6) {
    const groups = expandIpv6(ip);
    if (!groups) return true;
    const [g0, g1, g2, g3, g4, g5, g6, g7] = groups as [number, number, number, number, number, number, number, number];
    const allZeroPrefix = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;
    // :: (unspecified), ::1 (loopback), ::/96 (IPv4-compatible), ::ffff:0:0/96 (IPv4-mapped)
    if (allZeroPrefix && g5 === 0) {
      if (g6 === 0 && (g7 === 0 || g7 === 1)) return true;
      return isPrivateIpv4Octets(g6 >> 8, g6 & 0xff, g7 >> 8);
    }
    if (allZeroPrefix && g5 === 0xffff) {
      return isPrivateIpv4Octets(g6 >> 8, g6 & 0xff, g7 >> 8);
    }
    // RFC 2765 IPv4-translated ::ffff:0:0:0/96
    if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0xffff && g5 === 0) return true;
    // NAT64 well-known (64:ff9b::/96) and local-use (64:ff9b:1::/48)
    if (g0 === 0x0064 && g1 === 0xff9b) return true;
    // Discard-only 100::/64
    if (g0 === 0x0100 && g1 === 0 && g2 === 0 && g3 === 0) return true;
    // 6to4 2002::/16 (embeds IPv4 in g1:g2)
    if (g0 === 0x2002) return isPrivateIpv4Octets(g1 >> 8, g1 & 0xff, g2 >> 8);
    // Teredo 2001:0000::/32, documentation 2001:db8::/32, benchmarking 2001:2::/48, ORCHID(v2) 2001:10::/28 & 2001:20::/28
    if (g0 === 0x2001) {
      if (g1 === 0x0000 || g1 === 0x0db8) return true;
      if (g1 === 0x0002 && g2 === 0x0000) return true;
      if ((g1 & 0xfff0) === 0x0010 || (g1 & 0xfff0) === 0x0020) return true;
    }
    // Unique local fc00::/7, link-local fe80::/10, deprecated site-local fec0::/10, multicast ff00::/8
    if ((g0 & 0xfe00) === 0xfc00) return true;
    if ((g0 & 0xffc0) === 0xfe80) return true;
    if ((g0 & 0xffc0) === 0xfec0) return true;
    if ((g0 & 0xff00) === 0xff00) return true;
    return false;
  }
  return true;
}

async function lookupWithBudget(
  bareHost: string,
  lookupFn: DnsLookupFn,
  timeoutMs?: number,
  signal?: AbortSignal,
): Promise<Array<{ address: string }>> {
  if (signal?.aborted) throw new Error("DNS lookup aborted");
  const hasTimeout = timeoutMs !== undefined && Number.isFinite(timeoutMs) && timeoutMs > 0;
  if (!hasTimeout && !signal) return lookupFn(bareHost);

  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await new Promise<Array<{ address: string }>>((resolve, reject) => {
      if (hasTimeout) {
        timer = setTimeout(() => reject(new Error("DNS lookup timed out")), Math.max(1, Math.round(timeoutMs)));
      }
      if (signal) {
        onAbort = () => reject(new Error("DNS lookup aborted"));
        signal.addEventListener("abort", onAbort, { once: true });
      }
      lookupFn(bareHost).then(resolve, reject);
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
  }
}

/** Validate a URL and resolve its verified public IP addresses once so callers can pin the socket connection. */
export async function resolvePublicFetchTarget(
  rawUrl: string,
  lookupFn: DnsLookupFn = defaultLookup,
  options: PublicUrlOptions = {},
): Promise<ResolvedPublicTarget> {
  const trimmed = rawUrl.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new InvalidRequestError("direct_markdown_fetch requires an absolute http(s) URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new InvalidRequestError("direct_markdown_fetch requires an http(s) URL");
  }
  if (parsed.username || parsed.password) {
    throw new InvalidRequestError("direct_markdown_fetch rejects URLs with embedded credentials");
  }
  if (trimmed.length > MAX_FETCH_URL_LENGTH) {
    throw new InvalidRequestError(`direct_markdown_fetch URL exceeds ${MAX_FETCH_URL_LENGTH} characters`);
  }
  const bareHost = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");
  if (
    !bareHost
    || bareHost === "localhost"
    || bareHost.endsWith(".localhost")
    || bareHost.endsWith(".local")
    || bareHost.endsWith(".internal")
    || bareHost.endsWith(".home.arpa")
    || (!bareHost.includes(".") && isIP(bareHost) === 0)
  ) {
    throw new InvalidRequestError(`direct_markdown_fetch refused private or local host: ${bareHost || rawUrl}`);
  }
  const literalVersion = isIP(bareHost);
  if (literalVersion !== 0) {
    if (isPrivateIp(bareHost)) throw new InvalidRequestError(`direct_markdown_fetch refused private IP: ${bareHost}`);
    const allowedPorts = options.allowedPorts ?? DEFAULT_ALLOWED_PORTS;
    if (!allowedPorts.has(parsed.port)) {
      throw new InvalidRequestError(`direct_markdown_fetch refused disallowed port: ${parsed.port}`);
    }
    return { url: parsed, addresses: [{ address: bareHost, family: literalVersion as 4 | 6 }] };
  }
  const allowedPorts = options.allowedPorts ?? DEFAULT_ALLOWED_PORTS;
  if (!allowedPorts.has(parsed.port)) {
    throw new InvalidRequestError(`direct_markdown_fetch refused disallowed port: ${parsed.port}`);
  }
  let records: Array<{ address: string }>;
  try {
    records = await lookupWithBudget(bareHost, lookupFn, options.timeoutMs, options.signal);
  } catch {
    // Fail closed so proxy/split-horizon internal hosts never bypass SSRF checks,
    // while using TargetPageError so fetch_auto still fails over cleanly to remote readers.
    throw new TargetPageError(`direct_markdown_fetch could not resolve public IP for host: ${bareHost}`);
  }
  if (!records.length || records.some((record) => isPrivateIp(record.address))) {
    // Fail closed locally (never connect to private or TUN fake-ip addresses such as 198.18.0.0/15),
    // while throwing TargetPageError so fetch_auto still falls over cleanly to remote cloud readers.
    throw new TargetPageError(`direct_markdown_fetch refused host resolving to non-public IP: ${bareHost}`);
  }
  const addresses: ResolvedAddress[] = [];
  const seen = new Set<string>();
  for (const record of records) {
    const clean = record.address.trim().toLowerCase().replace(/^\[|\]$/g, "");
    const family = isIP(clean);
    if ((family === 4 || family === 6) && !seen.has(clean)) {
      seen.add(clean);
      addresses.push({ address: clean, family });
    }
  }
  if (!addresses.length) {
    throw new TargetPageError(`direct_markdown_fetch refused host resolving to non-public IP: ${bareHost}`);
  }
  return { url: parsed, addresses };
}

/** Validate that a URL points to a public http(s) host without embedded credentials or internal/private targets. */
export async function assertPublicFetchUrl(
  rawUrl: string,
  lookupFn: DnsLookupFn = defaultLookup,
  options: PublicUrlOptions = {},
): Promise<URL> {
  return (await resolvePublicFetchTarget(rawUrl, lookupFn, options)).url;
}

function toHeaders(raw: Record<string, string | string[] | undefined>): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(raw)) {
    if (Array.isArray(value)) {
      for (const entry of value) headers.append(key, entry);
    } else if (typeof value === "string") {
      headers.set(key, value);
    }
  }
  return headers;
}

function readStreamLimited(
  rawStream: Readable,
  encoding: string,
  maxBytes: number,
  signal: AbortSignal,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const normalized = encoding.toLowerCase().trim();
    const decompressor = normalized === "gzip" || normalized === "x-gzip"
      ? createGunzip()
      : normalized === "br"
        ? createBrotliDecompress()
        : normalized === "deflate"
          ? createInflate()
          : undefined;
    const output: Readable = decompressor ? rawStream.pipe(decompressor) : rawStream;
    const decoder = new TextDecoder();
    let rawBytes = 0;
    let decodedBytes = 0;
    let text = "";
    let settled = false;

    const noop = () => undefined;
    const cleanup = () => {
      signal.removeEventListener("abort", onAbort);
      rawStream.removeListener("data", onRawData);
      output.removeListener("data", onOutputData);
      output.removeListener("end", onEnd);
      // Keep inert error handlers attached so deferred post-destroy stream errors never go unhandled.
      rawStream.removeListener("error", onError);
      rawStream.on("error", noop);
      if (decompressor) {
        decompressor.removeListener("error", onError);
        decompressor.on("error", noop);
      }
      output.removeListener("error", onError);
      output.on("error", noop);
    };

    const destroyStreams = () => {
      rawStream.destroy();
      decompressor?.destroy();
    };

    const finish = (value: string, shouldDestroy = false) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (shouldDestroy) destroyStreams();
      resolve(value);
    };

    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      destroyStreams();
      reject(err instanceof Error ? err : new Error(String(err)));
    };

    const onAbort = () => fail(new Error("direct_markdown_fetch aborted while reading body"));
    const onError = (err: Error) => fail(err);
    const onRawData = (chunk: Buffer) => {
      if (settled) return;
      rawBytes += chunk.byteLength;
      if (rawBytes > MAX_RAW_BODY_BYTES) {
        finish(text + decoder.decode(), true);
      }
    };
    const onOutputData = (chunk: Buffer) => {
      if (settled) return;
      decodedBytes += chunk.byteLength;
      if (decodedBytes > maxBytes) {
        const overflow = decodedBytes - maxBytes;
        const kept = chunk.subarray(0, Math.max(0, chunk.byteLength - overflow));
        text += decoder.decode(kept, { stream: false });
        finish(text, true);
        return;
      }
      text += decoder.decode(chunk, { stream: true });
    };
    const onEnd = () => {
      text += decoder.decode();
      finish(text);
    };

    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    if (decompressor) {
      rawStream.on("data", onRawData);
      rawStream.on("error", onError);
      decompressor.on("error", onError);
    }
    output.on("data", onOutputData);
    output.on("end", onEnd);
    output.on("error", onError);
  });
}

/**
 * Perform a single HTTP(S) GET pinned directly to the already-validated IP addresses
 * (eliminating DNS rebinding TOCTOU while keeping TLS SNI and Host verification intact).
 */
export function pinnedHttpGet(
  target: ResolvedPublicTarget,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<DirectHttpResponse> {
  return new Promise<DirectHttpResponse>((resolve, reject) => {
    const bareHost = target.url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    const first = target.addresses[0];
    if (!first) {
      reject(new TargetPageError(`direct_markdown_fetch has no resolved IP for host: ${bareHost}`));
      return;
    }
    const pinnedLookup = (
      _hostname: string,
      options: unknown,
      callback: (err: NodeJS.ErrnoException | null, address: string | Array<{ address: string; family: number }>, family?: number) => void,
    ) => {
      const all = typeof options === "object" && options !== null && (options as { all?: boolean }).all === true;
      if (all) {
        callback(null, target.addresses.map((entry) => ({ address: entry.address, family: entry.family })));
      } else {
        callback(null, first.address, first.family);
      }
    };

    const requestHeaders: Record<string, string> = {
      ...headers,
      "Accept-Encoding": "gzip, br, deflate",
    };
    const isHttps = target.url.protocol === "https:";
    const req = isHttps
      ? httpsRequest(target.url, {
          method: "GET",
          headers: requestHeaders,
          signal,
          lookup: pinnedLookup as never,
          ...(isIP(bareHost) === 0 ? { servername: bareHost } : {}),
        })
      : httpRequest(target.url, {
          method: "GET",
          headers: requestHeaders,
          signal,
          lookup: pinnedLookup as never,
        });

    let settled = false;
    req.once("response", (res) => {
      if (settled) {
        res.destroy();
        return;
      }
      settled = true;
      const respHeaders = toHeaders(res.headers);
      resolve({
        status: res.statusCode ?? 0,
        headers: respHeaders,
        bodyText: () => readStreamLimited(res, respHeaders.get("content-encoding") ?? "", MAX_BODY_BYTES, signal),
        discard: async () => {
          res.destroy();
        },
      });
    });
    req.once("error", (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
    req.end();
  });
}

/** Wrap a Fetch-compatible function into an explicit DirectMarkdownTransport (for offline unit tests). */
export function createFetchTransport(fetchFn: typeof fetch = globalThis.fetch): DirectMarkdownTransport {
  return async (target, headers, signal) => {
    const response = await fetchFn(target.url.toString(), {
      method: "GET",
      headers,
      redirect: "manual",
      signal,
    });
    return {
      status: response.status,
      headers: response.headers,
      bodyText: () => readLimitedText(response, MAX_BODY_BYTES, { throwOnLimit: false }),
      discard: async () => {
        await response.body?.cancel().catch(() => undefined);
      },
    };
  };
}

function allowedPortsFromConfig(config: ProviderConfig | undefined): ReadonlySet<string> {
  const configured = config?.options?.allowedPorts;
  if (!Array.isArray(configured) || !configured.length) return DEFAULT_ALLOWED_PORTS;
  const set = new Set<string>(DEFAULT_ALLOWED_PORTS);
  for (const entry of configured) {
    const port = String(entry ?? "").trim();
    if (/^\d+$/.test(port)) {
      const n = Number(port);
      if (n >= 1 && n <= 65_535) set.add(port);
    }
  }
  return set;
}

export class DirectMarkdownAdapter implements RestAdapter {
  constructor(
    private readonly lookupFn: DnsLookupFn = defaultLookup,
    private readonly transport?: DirectMarkdownTransport,
  ) {}

  tools(): Tool[] {
    return [DIRECT_MARKDOWN_TOOL];
  }

  async call(
    _tool: string,
    args: Record<string, unknown>,
    _key: string,
    config: ProviderConfig,
    context?: RestAdapterContext,
  ): Promise<unknown> {
    const optionTimeout = typeof config.options?.timeoutMs === "number" && Number.isFinite(config.options.timeoutMs)
      ? config.options.timeoutMs
      : undefined;
    const integrationTimeout = config.integration.kind === "rest" && typeof config.integration.timeoutMs === "number" && Number.isFinite(config.integration.timeoutMs)
      ? config.integration.timeoutMs
      : undefined;
    const timeoutMs = Math.min(15_000, Math.max(1_000, Math.round(optionTimeout ?? integrationTimeout ?? DEFAULT_TIMEOUT_MS)));
    const allowedPorts = allowedPortsFromConfig(config);
    const deadlineAt = Date.now() + timeoutMs;
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const totalSignal = context?.signal ? AbortSignal.any([context.signal, timeoutSignal]) : timeoutSignal;
    const remainingMs = () => Math.max(1, deadlineAt - Date.now());

    const activeTransport: DirectMarkdownTransport = this.transport ?? pinnedHttpGet;

    let current = await resolvePublicFetchTarget(stringArg(args, "url"), this.lookupFn, {
      allowedPorts,
      timeoutMs: remainingMs(),
      signal: totalSignal,
    });

    const requestHeaders = {
      Accept: "text/markdown, text/html;q=0.9",
      "User-Agent": `search-toolkit/${PACKAGE_VERSION}`,
    };

    let response: DirectHttpResponse | undefined;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      if (totalSignal.aborted || Date.now() >= deadlineAt) {
        throw new TargetPageError("direct_markdown_fetch network failure: request timed out");
      }
      try {
        response = await activeTransport(current, requestHeaders, totalSignal);
      } catch (error) {
        if (error instanceof TargetPageError || error instanceof InvalidRequestError) throw error;
        throw new TargetPageError(`direct_markdown_fetch network failure: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        await response.discard();
        if (!location) {
          throw new TargetPageError(`direct_markdown_fetch received HTTP ${response.status} without Location header`);
        }
        if (hop === MAX_REDIRECTS) {
          throw new TargetPageError("direct_markdown_fetch exceeded redirect limit");
        }
        let nextUrl: string;
        try {
          nextUrl = new URL(location, current.url).toString();
        } catch {
          throw new TargetPageError("direct_markdown_fetch received malformed redirect URL");
        }
        current = await resolvePublicFetchTarget(nextUrl, this.lookupFn, {
          allowedPorts,
          timeoutMs: remainingMs(),
          signal: totalSignal,
        });
        continue;
      }
      break;
    }

    if (!response) throw new TargetPageError("direct_markdown_fetch received no response");
    if (response.status < 200 || response.status >= 300) {
      await response.discard();
      // Omit pageStatus so a site rejecting lightweight direct GETs still falls over to full fetchers.
      throw new TargetPageError(`direct_markdown_fetch got HTTP ${response.status}`);
    }
    const contentType = (response.headers.get("content-type") ?? "").trim();
    if (!MARKDOWN_CONTENT_TYPE.test(contentType)) {
      await response.discard();
      throw new TargetPageError(`direct_markdown_fetch skipped non-markdown content-type: ${contentType || "unknown"}`);
    }
    let body: string;
    try {
      body = (await response.bodyText()).trim();
    } catch (error) {
      throw new TargetPageError(`direct_markdown_fetch body read failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (body.includes("\0")) {
      throw new TargetPageError("direct_markdown_fetch returned binary content");
    }
    if (!isUsableFetchText(body)) {
      throw new TargetPageError("direct_markdown_fetch returned thin or challenge markdown");
    }
    const tokensHeader = response.headers.get("x-markdown-tokens");
    const markdownTokens = tokensHeader && /^\d+$/.test(tokensHeader.trim()) ? Number(tokensHeader.trim()) : undefined;
    const contentSignal = response.headers.get("content-signal")?.trim();
    const finalUrl = current.url.toString();
    return {
      text: `URL: ${finalUrl}\n\n${body}`,
      url: finalUrl,
      ...(markdownTokens !== undefined ? { markdownTokens } : {}),
      ...(contentSignal ? { contentSignal } : {}),
    };
  }
}
