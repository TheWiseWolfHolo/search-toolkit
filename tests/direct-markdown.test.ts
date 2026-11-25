import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { brotliCompressSync, deflateSync, gzipSync } from "node:zlib";
import { InvalidRequestError, TargetPageError } from "../src/errors.js";
import {
  createFetchTransport,
  DirectMarkdownAdapter,
  isPrivateIp,
  pinnedHttpGet,
  resolvePublicFetchTarget,
  type DirectHttpResponse,
  type DirectMarkdownTransport,
  type DnsLookupFn,
  type ResolvedPublicTarget,
} from "../src/rest/providers/direct-markdown.js";
import type { ProviderConfig } from "../src/types.js";

const VALID_MARKDOWN = "# Documentation Guide\n\nThis page serves clean native Markdown with enough content to pass the usable fetch threshold easily.";

function directConfig(options?: Record<string, unknown>): ProviderConfig {
  return {
    enabled: true,
    auto: ["fetch"],
    keys: ["direct"],
    integration: { kind: "rest", adapter: "direct_markdown" },
    ...(options ? { options } : {}),
  };
}

function makeResponse(
  body: string,
  extra: { status?: number; headers?: Record<string, string>; onDiscard?: () => void; bodyText?: () => Promise<string> } = {},
): DirectHttpResponse {
  return {
    status: extra.status ?? 200,
    headers: new Headers({ "content-type": "text/markdown; charset=utf-8", ...(extra.headers ?? {}) }),
    bodyText: extra.bodyText ?? (async () => body),
    discard: async () => {
      extra.onDiscard?.();
    },
  };
}

test("isPrivateIp blocks IPv4 and IPv6 special-use, mapped, translated, and private ranges while allowing public IPs", () => {
  const blocked = [
    // IPv4 private / loopback / CGNAT / link-local / TUN fake-ip / 6to4 relay / multicast
    "0.0.0.0",
    "10.0.0.1",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.0.0.1",
    "192.0.2.1",
    "192.88.99.1",
    "192.168.1.1",
    "198.18.0.1",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    // IPv6 loopback / ULA / link-local / site-local / NAT64 / discard / Teredo / docs / bench / ORCHID / mapped / translated / 6to4
    "::",
    "::1",
    "::ffff:127.0.0.1",
    "::ffff:10.0.0.1",
    "::ffff:192.88.99.1",
    "::ffff:0:0:1",
    "::ffff:0:93.184.216.34",
    "64:ff9b::1",
    "64:ff9b:1::1",
    "100::1",
    "2001::1",
    "2001:2::1",
    "2001:10::1",
    "2001:20::1",
    "2001:db8::1",
    "2002:7f00:0001::1",
    "fc00::1",
    "fe80::1",
    "fec0::1",
    "ff02::1",
    "not-an-ip",
  ];
  for (const ip of blocked) {
    assert.equal(isPrivateIp(ip), true, `expected ${ip} to be blocked`);
  }

  const allowed = [
    "1.1.1.1",
    "8.8.8.8",
    "93.184.216.34",
    "2606:2800:220:1:248:1893:25c8:1946",
    "::ffff:93.184.216.34",
  ];
  for (const ip of allowed) {
    assert.equal(isPrivateIp(ip), false, `expected ${ip} to be allowed`);
  }
});

test("resolvePublicFetchTarget rejects credentials, non-http schemes, local/internal hosts, and disallowed ports", async () => {
  const publicLookup: DnsLookupFn = async () => [{ address: "93.184.216.34" }];

  for (const bad of [
    "not a url",
    "file:///etc/passwd",
    "ftp://docs.example.com/guide",
    "https://user:pass@docs.example.com/guide",
    "https://localhost/docs",
    "https://sub.localhost/docs",
    "https://printer.local/docs",
    "https://metadata.internal/docs",
    "https://router.home.arpa/docs",
    "https://intranet/docs",
    "http://127.0.0.1/docs",
    "http://[fec0::1]/docs",
    "http://[::ffff:0:0:1]/docs",
    "https://docs.example.com:6379/guide",
    "http://93.184.216.34:8080/guide",
  ]) {
    await assert.rejects(
      resolvePublicFetchTarget(bad, publicLookup),
      (err: unknown) => err instanceof InvalidRequestError,
      `expected InvalidRequestError for ${bad}`,
    );
  }

  // Ports 80 and 443 (explicit or implicit) are permitted by default.
  const implicit = await resolvePublicFetchTarget("https://docs.example.com/guide", publicLookup);
  assert.deepEqual(implicit.addresses, [{ address: "93.184.216.34", family: 4 }]);
  await resolvePublicFetchTarget("http://docs.example.com:80/guide", publicLookup);
  await resolvePublicFetchTarget("https://docs.example.com:443/guide", publicLookup);

  // Explicit allowedPorts overrides permit listed ports without opening others.
  const custom = await resolvePublicFetchTarget("https://docs.example.com:8443/guide", publicLookup, {
    allowedPorts: new Set(["", "80", "443", "8443"]),
  });
  assert.equal(custom.url.port, "8443");

  // Mixed public + private DNS records fail closed with TargetPageError so remote readers can still try.
  await assert.rejects(
    resolvePublicFetchTarget("https://split.example.com/guide", async () => [
      { address: "93.184.216.34" },
      { address: "198.18.0.5" },
    ]),
    (err: unknown) => err instanceof TargetPageError && /non-public IP/.test(err.message),
  );

  // DNS failure fails closed with TargetPageError.
  await assert.rejects(
    resolvePublicFetchTarget("https://nxdomain.example.com/guide", async () => {
      throw new Error("ENOTFOUND");
    }),
    (err: unknown) => err instanceof TargetPageError && /could not resolve public IP/.test(err.message),
  );
});

test("DirectMarkdownAdapter pins resolved IPs per hop, follows safe redirects, and blocks redirect SSRF and loops", async () => {
  // 1. Safe redirect: DNS resolved once per hop, validated addresses handed to transport, metadata parsed.
  const dnsCalls: string[] = [];
  const seenTargets: ResolvedPublicTarget[] = [];
  const lookupFn: DnsLookupFn = async (hostname) => {
    dnsCalls.push(hostname);
    if (hostname === "start.example.com") return [{ address: "93.184.216.34" }];
    if (hostname === "final.example.com") return [{ address: "1.1.1.1" }];
    throw new Error(`unexpected lookup ${hostname}`);
  };
  let discarded = 0;
  const transport: DirectMarkdownTransport = async (target) => {
    seenTargets.push(target);
    if (target.url.hostname === "start.example.com") {
      return makeResponse("", {
        status: 302,
        headers: { location: "https://final.example.com/docs/intro" },
        onDiscard: () => { discarded += 1; },
      });
    }
    return makeResponse(VALID_MARKDOWN, {
      headers: {
        "x-markdown-tokens": "420",
        "content-signal": "ai-input=yes",
      },
    });
  };
  const adapter = new DirectMarkdownAdapter(lookupFn, transport);
  const result = await adapter.call(
    "direct_markdown_fetch",
    { url: "https://start.example.com/old" },
    "direct",
    directConfig(),
  ) as { text: string; url: string; markdownTokens?: number; contentSignal?: string };

  assert.deepEqual(dnsCalls, ["start.example.com", "final.example.com"]);
  assert.deepEqual(seenTargets[0]?.addresses, [{ address: "93.184.216.34", family: 4 }]);
  assert.deepEqual(seenTargets[1]?.addresses, [{ address: "1.1.1.1", family: 4 }]);
  assert.equal(discarded, 1);
  assert.equal(result.url, "https://final.example.com/docs/intro");
  assert.equal(result.markdownTokens, 420);
  assert.equal(result.contentSignal, "ai-input=yes");
  assert.match(result.text, /^URL: https:\/\/final\.example\.com\/docs\/intro\n\n# Documentation Guide/);

  // 2. Redirect to private literal IP is refused with InvalidRequestError and never invokes transport for hop 1.
  let transportCalls = 0;
  const ssrfLiteral = new DirectMarkdownAdapter(
    async () => [{ address: "93.184.216.34" }],
    async () => {
      transportCalls += 1;
      return makeResponse("", { status: 302, headers: { location: "http://127.0.0.1/admin" } });
    },
  );
  await assert.rejects(
    ssrfLiteral.call("direct_markdown_fetch", { url: "https://public.example.com/go" }, "direct", directConfig()),
    (err: unknown) => err instanceof InvalidRequestError,
  );
  assert.equal(transportCalls, 1);

  // 3. Redirect to hostname resolving to private IP fails closed before hop 1 transport.
  let dnsHopCalls = 0;
  let rebindTransportCalls = 0;
  const ssrfDns = new DirectMarkdownAdapter(
    async (host) => {
      dnsHopCalls += 1;
      return host === "internal-alias.example.com" ? [{ address: "10.0.0.8" }] : [{ address: "93.184.216.34" }];
    },
    async () => {
      rebindTransportCalls += 1;
      return makeResponse("", { status: 302, headers: { location: "https://internal-alias.example.com/secret" } });
    },
  );
  await assert.rejects(
    ssrfDns.call("direct_markdown_fetch", { url: "https://public.example.com/start" }, "direct", directConfig()),
    (err: unknown) => err instanceof TargetPageError && /non-public IP/.test(err.message),
  );
  assert.equal(dnsHopCalls, 2);
  assert.equal(rebindTransportCalls, 1);

  // 4. Redirect loop (>3 hops) stops and discards every intermediate response.
  let loopDiscards = 0;
  const loopAdapter = new DirectMarkdownAdapter(
    async () => [{ address: "93.184.216.34" }],
    async (target) => makeResponse("", {
      status: 302,
      headers: { location: `${target.url.origin}/hop-${loopDiscards + 1}` },
      onDiscard: () => { loopDiscards += 1; },
    }),
  );
  await assert.rejects(
    loopAdapter.call("direct_markdown_fetch", { url: "https://loop.example.com/hop-0" }, "direct", directConfig()),
    (err: unknown) => err instanceof TargetPageError && /exceeded redirect limit/.test(err.message),
  );
  assert.equal(loopDiscards, 4);

  // 5. Custom allowedPorts option is respected by the adapter.
  const customPortAdapter = new DirectMarkdownAdapter(
    async () => [{ address: "93.184.216.34" }],
    async () => makeResponse(VALID_MARKDOWN),
  );
  const customPortRes = await customPortAdapter.call(
    "direct_markdown_fetch",
    { url: "https://docs.example.com:8443/guide" },
    "direct",
    directConfig({ allowedPorts: [8443] }),
  ) as { url: string };
  assert.equal(customPortRes.url, "https://docs.example.com:8443/guide");
});

test("DirectMarkdownAdapter enforces one total deadline across DNS, redirects, and body reads", async () => {
  // 1. Signal aborted while waiting on DNS fails immediately.
  const dnsAbort = new AbortController();
  const slowDnsAdapter = new DirectMarkdownAdapter(
    async () => await new Promise(() => {
      setTimeout(() => dnsAbort.abort(), 15);
    }),
    async () => {
      throw new Error("transport must not run after DNS abort");
    },
  );
  await assert.rejects(
    slowDnsAdapter.call("direct_markdown_fetch", { url: "https://slow-dns.example.com/doc" }, "direct", directConfig(), { signal: dnsAbort.signal }),
    (err: unknown) => err instanceof TargetPageError && /could not resolve public IP/.test(err.message),
  );

  // 2. Signal aborted during redirect prevents the next hop from starting.
  const hopAbort = new AbortController();
  let hopTransportCalls = 0;
  const redirectAbortAdapter = new DirectMarkdownAdapter(
    async () => [{ address: "93.184.216.34" }],
    async () => {
      hopTransportCalls += 1;
      hopAbort.abort();
      return makeResponse("", { status: 302, headers: { location: "https://next.example.com/doc" } });
    },
  );
  await assert.rejects(
    redirectAbortAdapter.call("direct_markdown_fetch", { url: "https://first.example.com/doc" }, "direct", directConfig(), { signal: hopAbort.signal }),
    (err: unknown) => err instanceof TargetPageError,
  );
  assert.equal(hopTransportCalls, 1);

  // 3. Signal propagated to transport stays aborted during body streaming.
  const bodyAbort = new AbortController();
  const bodyAbortAdapter = new DirectMarkdownAdapter(
    async () => [{ address: "93.184.216.34" }],
    async (_target, _headers, signal) => makeResponse("", {
      bodyText: () => new Promise<string>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted while reading body")), { once: true });
        setTimeout(() => bodyAbort.abort(), 10);
      }),
    }),
  );
  await assert.rejects(
    bodyAbortAdapter.call("direct_markdown_fetch", { url: "https://slow-body.example.com/doc" }, "direct", directConfig(), { signal: bodyAbort.signal }),
    (err: unknown) => err instanceof TargetPageError && /body read failed/.test(err.message),
  );
});

test("DirectMarkdownAdapter rejects non-2xx, HTML, binary payloads, and thin or challenge markdown", async () => {
  const lookup: DnsLookupFn = async () => [{ address: "93.184.216.34" }];
  const cases: Array<{ name: string; response: DirectHttpResponse; pattern: RegExp }> = [
    {
      name: "3xx missing location",
      response: makeResponse("", { status: 301 }),
      pattern: /without Location header/,
    },
    {
      name: "non-2xx",
      response: makeResponse("forbidden", { status: 403 }),
      pattern: /got HTTP 403/,
    },
    {
      name: "non-markdown content-type",
      response: makeResponse("<html><body>hi</body></html>", { headers: { "content-type": "text/html; charset=utf-8" } }),
      pattern: /non-markdown content-type/,
    },
    {
      name: "binary null byte",
      response: makeResponse(`${VALID_MARKDOWN}\0binary`),
      pattern: /binary content/,
    },
    {
      name: "thin markdown",
      response: makeResponse("# Hi"),
      pattern: /thin or challenge markdown/,
    },
    {
      name: "cloudflare challenge markdown",
      response: makeResponse("# Just a moment...\n\nChecking your browser before accessing docs.example.com. Enable JavaScript and cookies to continue."),
      pattern: /thin or challenge markdown/,
    },
  ];
  for (const item of cases) {
    const adapter = new DirectMarkdownAdapter(lookup, async () => item.response);
    await assert.rejects(
      adapter.call("direct_markdown_fetch", { url: "https://docs.example.com/page" }, "direct", directConfig()),
      (err: unknown) => err instanceof TargetPageError && item.pattern.test(err.message),
      item.name,
    );
  }
});

test("pinnedHttpGet connects to the pinned IP while preserving Host, decompresses gzip/br/deflate, and enforces byte limits", async () => {
  const hugePayload = "a".repeat(1_300_000);
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = req.url ?? "/";
    if (path === "/pinned") {
      res.writeHead(200, { "content-type": "text/markdown; charset=utf-8" });
      res.end(`# Pinned\n\nhost=${req.headers.host ?? ""}\naccept-encoding=${req.headers["accept-encoding"] ?? ""}`);
      return;
    }
    if (path === "/gzip") {
      res.writeHead(200, { "content-type": "text/markdown", "content-encoding": "gzip" });
      res.end(gzipSync(Buffer.from(VALID_MARKDOWN, "utf8")));
      return;
    }
    if (path === "/br") {
      res.writeHead(200, { "content-type": "text/markdown", "content-encoding": "br" });
      res.end(brotliCompressSync(Buffer.from(VALID_MARKDOWN, "utf8")));
      return;
    }
    if (path === "/deflate") {
      res.writeHead(200, { "content-type": "text/markdown", "content-encoding": "deflate" });
      res.end(deflateSync(Buffer.from(VALID_MARKDOWN, "utf8")));
      return;
    }
    if (path === "/huge") {
      res.writeHead(200, { "content-type": "text/markdown; charset=utf-8" });
      res.end(hugePayload);
      return;
    }
    if (path === "/huge-gzip") {
      res.writeHead(200, { "content-type": "text/markdown; charset=utf-8", "content-encoding": "gzip" });
      res.end(gzipSync(Buffer.from("z".repeat(1_300_000), "utf8")));
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  const targetFor = (path: string): ResolvedPublicTarget => ({
    url: new URL(`http://rebind.example.test:${port}${path}`),
    addresses: [{ address: "127.0.0.1", family: 4 }],
  });

  try {
    const signal = AbortSignal.timeout(5_000);
    const pinnedRes = await pinnedHttpGet(targetFor("/pinned"), { Accept: "text/markdown" }, signal);
    assert.equal(pinnedRes.status, 200);
    const pinnedBody = await pinnedRes.bodyText();
    assert.match(pinnedBody, new RegExp(`host=rebind\\.example\\.test:${port}`));
    assert.match(pinnedBody, /accept-encoding=gzip, br, deflate/);

    for (const path of ["/gzip", "/br", "/deflate"]) {
      const encodedRes = await pinnedHttpGet(targetFor(path), { Accept: "text/markdown" }, signal);
      assert.equal(encodedRes.status, 200, path);
      assert.equal(await encodedRes.bodyText(), VALID_MARKDOWN, path);
    }

    const hugeRes = await pinnedHttpGet(targetFor("/huge"), { Accept: "text/markdown" }, signal);
    const hugeBody = await hugeRes.bodyText();
    assert.equal(Buffer.byteLength(hugeBody, "utf8"), 1_000_000);

    // Decompressed stream truncation resolves the capped prefix cleanly even after destroying gunzip + socket.
    const hugeGzipRes = await pinnedHttpGet(targetFor("/huge-gzip"), { Accept: "text/markdown" }, signal);
    const hugeGzipBody = await hugeGzipRes.bodyText();
    assert.equal(Buffer.byteLength(hugeGzipBody, "utf8"), 1_000_000);
    assert.equal(hugeGzipBody.startsWith("zzzzzz"), true);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("DirectMarkdownAdapter strictly uses pinnedHttpGet despite monkey-patched globalThis.fetch unless explicit transport is injected", async () => {
  const originalFetch = globalThis.fetch;
  let globalFetchCalls = 0;
  globalThis.fetch = async () => {
    globalFetchCalls += 1;
    return new Response(VALID_MARKDOWN, {
      status: 200,
      headers: { "content-type": "text/markdown; charset=utf-8" },
    });
  };
  const lookup: DnsLookupFn = async () => [{ address: "2606:2800:220:1:248:1893:25c8:1946" }];
  try {
    // 1. Default adapter (no explicit transport) ignores monkey-patched globalThis.fetch and attempts pinnedHttpGet.
    const defaultAdapter = new DirectMarkdownAdapter(lookup);
    await assert.rejects(
      defaultAdapter.call(
        "direct_markdown_fetch",
        { url: "http://docs.example.com:65535/guide" },
        "direct",
        directConfig({ allowedPorts: [65535] }),
        { signal: AbortSignal.timeout(40) },
      ),
      (err: unknown) => err instanceof TargetPageError,
    );
    assert.equal(globalFetchCalls, 0, "default DirectMarkdownAdapter must never silently fall back to globalThis.fetch");

    // 2. Explicit createFetchTransport(...) opt-in works cleanly for offline tests.
    let explicitCalls = 0;
    const explicitAdapter = new DirectMarkdownAdapter(
      lookup,
      createFetchTransport(async () => {
        explicitCalls += 1;
        return new Response(VALID_MARKDOWN, {
          status: 200,
          headers: { "content-type": "text/markdown; charset=utf-8" },
        });
      }),
    );
    const res = await explicitAdapter.call(
      "direct_markdown_fetch",
      { url: "https://docs.example.com/guide" },
      "direct",
      directConfig(),
    ) as { url: string; text: string };
    assert.equal(explicitCalls, 1);
    assert.equal(globalFetchCalls, 0);
    assert.equal(res.url, "https://docs.example.com/guide");
    assert.match(res.text, /# Documentation Guide/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
