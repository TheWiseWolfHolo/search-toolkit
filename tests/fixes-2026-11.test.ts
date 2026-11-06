import assert from "node:assert/strict";
import test from "node:test";
import { migrateConfig, normalizeConfig, sanitizedConfig } from "../src/config.js";
import { HttpError, isPageFailure, TargetPageError, ToolResultError } from "../src/errors.js";
import { readableFetchOutput } from "../src/fetching.js";
import { OctenAdapter } from "../src/rest/providers/octen.js";
import { QueritAdapter } from "../src/rest/providers/querit.js";
import { SerperAdapter } from "../src/rest/providers/serper.js";
import { TinyfishAdapter } from "../src/rest/providers/tinyfish.js";
import { YouAdapter } from "../src/rest/providers/you.js";
import { autoCandidates } from "../src/routes.js";
import { quotaFields } from "../src/quota.js";
import { filterUpstreamTools, structuredKeyFault } from "../src/upstream.js";
import type { ProviderConfig } from "../src/types.js";

const REST = (adapter: string): ProviderConfig => ({
  enabled: true, auto: [], keys: ["k-123456789"], integration: { kind: "rest", adapter } as ProviderConfig["integration"],
});

type Captured = { url: string; body: Record<string, unknown> };

async function withFetch<T>(reply: (url: string) => unknown, run: (captured: Captured[]) => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  const captured: Captured[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    captured.push({ url, body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {} });
    const value = reply(url);
    if (value instanceof Response) return value;
    return new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  try {
    return await run(captured);
  } finally {
    globalThis.fetch = original;
  }
}

test("keys may be strings or annotated objects, and migration keeps both", () => {
  const raw = {
    version: 2,
    statePath: "state.db",
    providers: {
      parallel: {
        enabled: true,
        auto: ["search"],
        strategy: "drain",
        defaultTier: "paid",
        keys: ["plain-key-123", { key: "object-key-456", tier: "free", label: "trial" }],
        integration: { kind: "rest", adapter: "parallel" },
      },
    },
  };
  const { config, notes } = normalizeConfig(raw);
  assert.deepEqual(notes, []);
  const parallel = config.providers.parallel as ProviderConfig;
  assert.deepEqual(parallel.keys, ["plain-key-123", "object-key-456"]);
  assert.deepEqual(parallel.keyMeta, [{}, { tier: "free", label: "trial" }]);
  assert.equal(parallel.strategy, "drain");
  const migrated = migrateConfig(raw).document as { providers: { parallel: Record<string, unknown> } };
  assert.deepEqual(migrated.providers.parallel.keys, ["plain-key-123", { key: "object-key-456", tier: "free", label: "trial" }]);
  assert.equal(migrated.providers.parallel.strategy, "drain");
  const summary = JSON.stringify(sanitizedConfig(config));
  assert.ok(!summary.includes("plain-key-123") && !summary.includes("object-key-456"));
  assert.match(summary, /"tiers":\{"paid":1,"free":1\}/);
});

test("duplicate keys are caught across string and object forms; bad fields are rejected", () => {
  const base = (keys: unknown, extra: Record<string, unknown> = {}) => ({
    version: 2, statePath: "s", providers: { p: { enabled: true, auto: [], keys, integration: { kind: "rest", adapter: "serper" }, ...extra } },
  });
  assert.throws(() => normalizeConfig(base(["dup-key", { key: " dup-key" }])), /blanks or duplicates/);
  assert.throws(() => normalizeConfig(base([{ key: "k", tier: "gold" }])), /tier must be/);
  assert.throws(() => normalizeConfig(base(["k"], { strategy: "random" })), /strategy must be one of/);
  assert.throws(() => normalizeConfig(base([{ tier: "free" }])), /string key/);
});

test("fetch chains move past Exa crawl codes and Firecrawl unsupported sites", () => {
  const exa = (code: string) => new ToolResultError(`Error fetching URL(s): https://example.com/a: ${code}`, []);
  assert.equal(isPageFailure(exa("CRAWL_HTTP_403")), true);
  assert.equal(isPageFailure(exa("CRAWL_EMPTY_CONTENT")), true);
  assert.equal(isPageFailure(exa("CRAWL_UNKNOWN_ERROR")), true);
  assert.equal(isPageFailure(exa("CRAWL_HTTP_404")), false, "a missing page stays missing");
  assert.equal(isPageFailure(new ToolResultError("unsupported_site: this site is not supported", [])), true);
  assert.equal(isPageFailure(new ToolResultError("SCRAPE_DNS_RESOLUTION_ERROR", [])), true);
});

test("reader JSON envelopes are unwrapped, and an all-failed envelope is a page failure", () => {
  const wrap = (text: string) => ({ content: [{ type: "text", text }] });
  const firecrawl = readableFetchOutput(wrap(JSON.stringify({ markdown: "# Title\n\nBody text", metadata: { title: "T", sourceURL: "https://a.example" } }))) as { content: Array<{ text: string }> };
  assert.equal(firecrawl.content[0]?.text, "# T\nURL: https://a.example\n\n# Title\n\nBody text");
  const tavily = readableFetchOutput(wrap(JSON.stringify({ results: [{ url: "https://b.example", raw_content: "Page body" }], failed_results: [] }))) as { content: Array<{ text: string }> };
  assert.equal(tavily.content[0]?.text, "URL: https://b.example\n\nPage body");
  assert.throws(
    () => readableFetchOutput(wrap(JSON.stringify({ results: [], failed_results: [{ url: "https://c.example", error: "404 page not found" }] }))),
    (error: unknown) => error instanceof TargetPageError && error.pageStatus === 404,
  );
  const plain = wrap("Not JSON at all");
  assert.equal(readableFetchOutput(plain), plain);
});

test("a long site: list skips Brave and Serper instead of failing the route", () => {
  const includeDomains = Array.from({ length: 18 }, (_, index) => `docs${index}.example-vendor.com`);
  const names = autoCandidates("general", "balanced", { query: "rate limits", includeDomains }).map((item) => item.name);
  assert.ok(!names.includes("brave_web_search"));
  assert.ok(!names.includes("serper_search"));
  assert.ok(names.includes("parallel_search"));
  const short = autoCandidates("general", "balanced", { query: "rate limits", includeDomains: ["a.com"] }).map((item) => item.name);
  assert.ok(short.includes("brave_web_search") && short.includes("serper_search"));
});

test("scholar gets no web time filter and keeps open-access PDF links", async () => {
  const scholar = autoCandidates("scholar", "balanced", { query: "attention", freshness: "year" }).find((item) => item.name === "serper_scholar");
  assert.equal(scholar?.nativeArguments?.tbs, undefined);
  await withFetch(() => ({ organic: [{ title: "Paper", link: "https://p.example", snippet: "s", pdfUrl: "https://p.example/a.pdf", year: 2024 }] }), async (captured) => {
    const result = await new SerperAdapter().call("serper_scholar", { query: "attention", tbs: "qdr:y", limit: 3 }, "k") as { items: Array<{ text: string }> };
    assert.equal(captured[0]?.body.tbs, undefined);
    assert.match(result.items[0]?.text ?? "", /PDF: https:\/\/p\.example\/a\.pdf/);
  });
});

test("Querit maps freshness words and surfaces business errors", async () => {
  await withFetch(() => ({ error_code: 200, results: { result: [] } }), async (captured) => {
    await new QueritAdapter().call("querit_search", { query: "q", timeRange: "week" }, "k", REST("querit"));
    assert.deepEqual((captured[0]?.body.filters as Record<string, unknown>).timeRange, { date: "w1" });
  });
  await withFetch(() => ({ error_code: 429, error_msg: "too many requests" }), async () => {
    await assert.rejects(new QueritAdapter().call("querit_search", { query: "q" }, "k", REST("querit")),
      (error: unknown) => error instanceof HttpError && error.status === 429);
  });
});

test("You.com sends crawl_timeout only for full pages and treats empty contents as a page failure", async () => {
  await withFetch(() => ({ results: {} }), async (captured) => {
    await new YouAdapter().call("you_search", { query: "q", contentLevel: "highlights", crawlTimeout: 5 }, "k", REST("you"));
    await new YouAdapter().call("you_search", { query: "q", contentLevel: "full_page", crawlTimeout: 5 }, "k", REST("you"));
    assert.equal(captured[0]?.body.crawl_timeout, undefined);
    assert.equal(captured[1]?.body.crawl_timeout, 5);
  });
  await withFetch(() => [{ url: "https://a.example", markdown: null, html: null }], async () => {
    await assert.rejects(new YouAdapter().call("you_contents", { url: "https://a.example" }, "k", REST("you")),
      (error: unknown) => error instanceof TargetPageError);
  });
  await withFetch(() => new Response('{"detail":"pdf_too_large"}', { status: 422 }), async () => {
    await assert.rejects(new YouAdapter().call("you_contents", { url: "https://a.example/x.pdf" }, "k", REST("you")),
      (error: unknown) => error instanceof TargetPageError);
  });
});

test("TinyFish fetch returns page text and reports per-URL failures as page failures", async () => {
  await withFetch(() => ({ results: [{ url: "https://a.example", title: "A", text: "Body of A" }], errors: [] }), async (captured) => {
    const result = await new TinyfishAdapter().call("tinyfish_fetch", { url: "https://a.example" }, "k", REST("tinyfish")) as { text: string };
    assert.equal(captured[0]?.url, "https://api.fetch.tinyfish.ai");
    assert.deepEqual(captured[0]?.body.urls, ["https://a.example"]);
    assert.equal(result.text, "# A\nURL: https://a.example\n\nBody of A");
  });
  await withFetch(() => ({ results: [], errors: [{ url: "https://a.example", error: "page_not_found", status: 404 }] }), async () => {
    await assert.rejects(new TinyfishAdapter().call("tinyfish_fetch", { url: "https://a.example" }, "k", REST("tinyfish")),
      (error: unknown) => error instanceof TargetPageError && error.pageStatus === 404);
  });
});

test("Octen extract reads successful pages and fails when every URL failed inside a 200", async () => {
  await withFetch(() => ({ code: 0, data: { results: [{ url: "https://a.example", status: "success", title: "A", full_content: "Body" }] } }), async (captured) => {
    const result = await new OctenAdapter().call("octen_extract", { url: "https://a.example" }, "k", REST("octen")) as { text: string };
    assert.equal(captured[0]?.url, "https://api.octen.ai/extract");
    assert.equal(result.text, "# A\nURL: https://a.example\n\nBody");
  });
  await withFetch(() => ({ code: 0, data: { results: [{ url: "https://a.example", status: "failed", error_message: "blocked" }] } }), async () => {
    await assert.rejects(new OctenAdapter().call("octen_extract", { url: "https://a.example" }, "k", REST("octen")),
      (error: unknown) => error instanceof TargetPageError);
  });
  await withFetch(() => ({ code: 0, data: { results: [{ url: "https://a.example", title: "A", highlight: "h", full_content: "Full page" }] } }), async (captured) => {
    const result = await new OctenAdapter().call("octen_search", { query: "q", fullContent: true }, "k", REST("octen")) as { items: Array<{ text: string }> };
    assert.deepEqual(captured[0]?.body.full_content, { enable: true });
    assert.equal(result.items[0]?.text, "Full page");
  });
});

test("Firecrawl structured errors name key faults; a site's 403 is not one", () => {
  assert.equal(structuredKeyFault({ success: false, error: { code: "insufficient_credits", status: 402 } }), 402);
  assert.equal(structuredKeyFault({ success: false, error: { code: "rate_limited", status: 429 } }), 429);
  assert.equal(structuredKeyFault({ success: false, error: { code: "forbidden", status: 403 } }), undefined);
});

test("AnySearch score is hidden unless allowed explicitly", () => {
  const tools = ["search", "extract", "score"].map((name) => ({ name, inputSchema: { type: "object" as const } }));
  const base: ProviderConfig = { enabled: true, auto: [], keys: ["k"], integration: { kind: "remote_mcp", url: "https://x", auth: { kind: "bearer" } } };
  assert.deepEqual(filterUpstreamTools("anysearch", base, tools).map((tool) => tool.name), ["search", "extract"]);
  assert.deepEqual(filterUpstreamTools("anysearch", { ...base, toolPolicy: { allow: ["*", "score"] } }, tools).map((tool) => tool.name), ["search", "extract", "score"]);
});

test("quota fields keep balances and limits, not ids", () => {
  assert.deepEqual(quotaFields({ id: "abc", balance: 12, account: { plan_limit: 1000, plan_usage: 18, name: "x" } }), {
    balance: 12, "account.plan_limit": 1000, "account.plan_usage": 18,
  });
});
