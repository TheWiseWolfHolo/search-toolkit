import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { TargetPageError } from "../../errors.js";
import { isUsableFetchText } from "../../fetching.js";
import type { ProviderConfig } from "../../types.js";
import { PACKAGE_VERSION } from "../../version.js";
import type { RestAdapter } from "../base.js";
import { stringArg } from "../normalize.js";

const READ_ONLY_OPEN = { readOnlyHint: true, destructiveHint: false, openWorldHint: true } as const;
const DEFAULT_TIMEOUT_MS = 4_000;
const MAX_REDIRECTS = 3;
const MAX_BODY_BYTES = 1_000_000;
const MARKDOWN_CONTENT_TYPE = /^text\/(?:x-)?markdown(?:\s*;|$)/i;

export type DnsLookupFn = (hostname: string) => Promise<Array<{ address: string }>>;

const defaultLookup: DnsLookupFn = (hostname) => lookup(hostname, { all: true });

const DIRECT_MARKDOWN_TOOL: Tool = {
  name: "direct_markdown_fetch",
  title: "Direct Markdown Fetch",
  description: "Zero-cost HTTP GET with `Accept: text/markdown` for sites (such as Cloudflare Markdown for Agents, Vercel Docs, Stripe, Mintlify) that natively serve clean Markdown. Fails over cleanly when the server responds with HTML.",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", minLength: 1, maxLength: 8192, description: "Public http(s) URL to probe for native text/markdown" },
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
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmark 198.18.0.0/15
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  if (a >= 224) return true; // multicast / reserved
  return false;
}

/** Reject loopback, link-local, RFC1918, CGNAT, cloud-metadata, NAT64/6to4/Teredo, and ULA IPv4/IPv6 addresses. */
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
    // NAT64 well-known (64:ff9b::/96) and local-use (64:ff9b:1::/48)
    if (g0 === 0x0064 && g1 === 0xff9b) return true;
    // Discard-only 100::/64
    if (g0 === 0x0100 && g1 === 0 && g2 === 0 && g3 === 0) return true;
    // 6to4 2002::/16 (embeds IPv4 in g1:g2)
    if (g0 === 0x2002) return isPrivateIpv4Octets(g1 >> 8, g1 & 0xff, g2 >> 8);
    // Teredo 2001:0000::/32 and documentation 2001:db8::/32
    if (g0 === 0x2001 && (g1 === 0x0000 || g1 === 0x0db8)) return true;
    // Unique local fc00::/7, link-local fe80::/10, multicast ff00::/8
    if ((g0 & 0xfe00) === 0xfc00) return true;
    if ((g0 & 0xffc0) === 0xfe80) return true;
    if ((g0 & 0xff00) === 0xff00) return true;
    return false;
  }
  return true;
}

/** Validate that a URL points to a public http(s) host without embedded credentials or internal/private targets. */
export async function assertPublicFetchUrl(rawUrl: string, lookupFn: DnsLookupFn = defaultLookup): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new Error("direct_markdown_fetch requires an absolute http(s) URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("direct_markdown_fetch requires an http(s) URL");
  }
  if (parsed.username || parsed.password) {
    throw new Error("direct_markdown_fetch rejects URLs with embedded credentials");
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
    throw new Error(`direct_markdown_fetch refused private or local host: ${bareHost || rawUrl}`);
  }
  if (isIP(bareHost) !== 0) {
    if (isPrivateIp(bareHost)) throw new Error(`direct_markdown_fetch refused private IP: ${bareHost}`);
    return parsed;
  }
  let records: Array<{ address: string }>;
  try {
    records = await lookupFn(bareHost);
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
  return parsed;
}

async function readLimitedText(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) {
    const text = await response.text();
    return text.slice(0, maxBytes);
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
        text += decoder.decode(value.subarray(0, Math.max(0, value.byteLength - overflow)), { stream: false });
        await reader.cancel().catch(() => undefined);
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

export class DirectMarkdownAdapter implements RestAdapter {
  constructor(private readonly lookupFn: DnsLookupFn = defaultLookup) {}

  tools(): Tool[] {
    return [DIRECT_MARKDOWN_TOOL];
  }

  async call(_tool: string, args: Record<string, unknown>, _key: string, config: ProviderConfig): Promise<unknown> {
    let current = await assertPublicFetchUrl(stringArg(args, "url"), this.lookupFn);
    const optionTimeout = typeof config.options?.timeoutMs === "number" && Number.isFinite(config.options.timeoutMs)
      ? config.options.timeoutMs
      : undefined;
    const integrationTimeout = config.integration.kind === "rest" && typeof config.integration.timeoutMs === "number" && Number.isFinite(config.integration.timeoutMs)
      ? config.integration.timeoutMs
      : undefined;
    const timeoutMs = Math.min(15_000, Math.max(1_000, Math.round(optionTimeout ?? integrationTimeout ?? DEFAULT_TIMEOUT_MS)));

    let response: Response | undefined;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      try {
        response = await fetch(current.toString(), {
          method: "GET",
          headers: {
            Accept: "text/markdown, text/html;q=0.9",
            "User-Agent": `search-toolkit/${PACKAGE_VERSION}`,
          },
          redirect: "manual",
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        throw new TargetPageError(`direct_markdown_fetch network failure: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        await response.body?.cancel().catch(() => undefined);
        if (!location || hop === MAX_REDIRECTS) {
          throw new TargetPageError("direct_markdown_fetch exceeded redirect limit");
        }
        let nextUrl: string;
        try {
          nextUrl = new URL(location, current).toString();
        } catch {
          throw new TargetPageError("direct_markdown_fetch received malformed redirect URL");
        }
        current = await assertPublicFetchUrl(nextUrl, this.lookupFn);
        continue;
      }
      break;
    }

    if (!response) throw new TargetPageError("direct_markdown_fetch received no response");
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      // Omit pageStatus so a site rejecting lightweight direct GETs still falls over to full fetchers.
      throw new TargetPageError(`direct_markdown_fetch got HTTP ${response.status}`);
    }
    const contentType = (response.headers.get("content-type") ?? "").trim();
    if (!MARKDOWN_CONTENT_TYPE.test(contentType)) {
      await response.body?.cancel().catch(() => undefined);
      throw new TargetPageError(`direct_markdown_fetch skipped non-markdown content-type: ${contentType || "unknown"}`);
    }
    const body = (await readLimitedText(response, MAX_BODY_BYTES)).trim();
    if (!isUsableFetchText(body)) {
      throw new TargetPageError("direct_markdown_fetch returned thin or challenge markdown");
    }
    const tokensHeader = response.headers.get("x-markdown-tokens");
    const markdownTokens = tokensHeader && /^\d+$/.test(tokensHeader.trim()) ? Number(tokensHeader.trim()) : undefined;
    const contentSignal = response.headers.get("content-signal")?.trim();
    const finalUrl = current.toString();
    return {
      text: `URL: ${finalUrl}\n\n${body}`,
      url: finalUrl,
      ...(markdownTokens !== undefined ? { markdownTokens } : {}),
      ...(contentSignal ? { contentSignal } : {}),
    };
  }
}
