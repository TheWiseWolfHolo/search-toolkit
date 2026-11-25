import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { cacheKey, ResultCache } from "../src/cache.js";
import { TargetPageError } from "../src/errors.js";
import { cleanExcerpt, focusExcerpt, queryTerms } from "../src/excerpt.js";
import { isUsableFetchText, readableFetchOutput, truncateBody } from "../src/fetching.js";
import { dedupeItems, nearDuplicateKey } from "../src/merge.js";
import { extractUpstreamSearchItems } from "../src/rest/normalize.js";
import { autoCandidates } from "../src/routes.js";
import { safeSlice } from "../src/shape.js";
import { SearchToolkit } from "../src/toolkit.js";

type Json = Record<string, unknown>;

test("excerpts lose page furniture but keep their words", () => {
  const raw = [
    "SQLite #",
    "copy",
    "| --- | --- |",
    "import  sqlite  from 'node:sqlite';",
    "![logo](https://x/logo.png) See the [docs](https://nodejs.org/api) for details.",
    "Table of contents",
  ].join("\n");
  assert.equal(cleanExcerpt(raw), "SQLite\nimport sqlite from 'node:sqlite';\nSee the docs for details.");
});

test("query terms cover Latin words and Chinese character pairs, without operators", () => {
  assert.deepEqual(queryTerms('"database is locked" sqlite site:stackoverflow.com'), ["database", "locked", "sqlite"]);
  assert.deepEqual(queryTerms("地铁开通"), ["地铁", "铁开", "开通"]);
});

test("a long excerpt keeps the sentences that mention the query", () => {
  const text = [
    "Node.js ships a built-in database module.",
    "Filler sentence about unrelated release logistics.",
    "Another filler sentence about governance and meetings.",
    "WAL mode lets readers proceed while one writer commits.",
    "Closing remarks about the documentation site.",
  ].join(" ");
  const focused = focusExcerpt(text, "sqlite WAL readers", 110);
  assert.match(focused, /WAL mode lets readers/);
  assert.doesNotMatch(focused, /governance/);
  assert.ok(focused.length <= 120, focused);
  // Without a matching term it falls back to the head.
  assert.match(focusExcerpt(text, "kubernetes", 60), /^Node\.js ships/);
});

test("the same page in another release or mirror collapses; different questions do not", () => {
  const items = dedupeItems([
    { title: "SQLite | Node.js v24.13.1 Documentation", url: "https://nodejs.org/download/release/v24.13.1/docs/api/sqlite.html", text: "a" },
    { title: "SQLite | Node.js v24.17.0 Documentation", url: "https://nodejs.org/dist/v24.17.0/docs/api/sqlite.html", text: "b" },
    { title: "如何评价 DeepSeek V4.1 Flash？", url: "https://www.zhihu.com/question/1", text: "c" },
    { title: "如何评价 DeepSeek V4.2 Flash？", url: "https://www.zhihu.com/question/2", text: "d" },
  ]);
  assert.deepEqual(items.map((item) => item.text), ["a", "c", "d"]);
  assert.notEqual(nearDuplicateKey({ title: "Pricing", url: "https://a.com/x" }), nearDuplicateKey({ title: "Pricing", url: "https://a.com/y" }));
});

test("AnySearch Markdown results are parsed into items with dates", () => {
  const items = extractUpstreamSearchItems("search", {
    content: [{ type: "text", text: "## Search Results (2 results, 10ms)\n\n### 1. 深圳地铁16号线二期年内开通\n- **URL**: https://www.lg.gov.cn/a.html\n- 工程将于年内开通 date: Aug 25, 2025\n\n### 2. Second\n- **URL**: https://example.com/b\n- body text\n" }],
  });
  assert.deepEqual(items, [
    { title: "深圳地铁16号线二期年内开通", url: "https://www.lg.gov.cn/a.html", text: "工程将于年内开通", date: "Aug 25, 2025" },
    { title: "Second", url: "https://example.com/b", text: "body text" },
  ]);
});

test("cache keys ignore argument order and undefined fields", () => {
  assert.equal(cacheKey("search_auto", { query: "q", mode: "general", freshness: undefined }), cacheKey("search_auto", { mode: "general", query: "q" }));
  assert.notEqual(cacheKey("search_auto", { query: "q" }), cacheKey("search_auto", { query: "r" }));
});

async function withRest(
  providers: Record<string, string>,
  respond: (host: string) => Response,
  run: (toolkit: SearchToolkit, hits: Record<string, number>) => Promise<void>,
  extra: Json = {},
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "search-toolkit-quality-"));
  const configPath = join(directory, "providers.json");
  writeFileSync(configPath, JSON.stringify({
    version: 2,
    statePath: join(directory, "state.db"),
    ...extra,
    providers: Object.fromEntries(Object.entries(providers).map(([name, adapter]) => [name, {
      enabled: true, auto: ["search", "fetch"], keys: ["k1-123456"], integration: { kind: "rest", adapter },
    }])),
  }));
  const original = globalThis.fetch;
  const hits: Record<string, number> = {};
  globalThis.fetch = async (input) => {
    const host = new URL(String(input)).hostname;
    hits[host] = (hits[host] ?? 0) + 1;
    return respond(host);
  };
  const toolkit = new SearchToolkit(configPath);
  try {
    await toolkit.initialize();
    await run(toolkit, hits);
  } finally {
    globalThis.fetch = original;
    await toolkit.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

const braveOk = () => new Response(JSON.stringify({ web: { results: [{ url: "https://ok.example/", title: "OK result", description: "d" }] } }), { status: 200 });

test("a repeated search is answered from the cache and says how old it is", async () => {
  await withRest({ brave: "brave" }, braveOk, async (toolkit, hits) => {
    const first = await toolkit.callTool("search_auto", { query: "same question" }) as { content: Array<{ text: string }> };
    const second = await toolkit.callTool("search_auto", { query: "same question" }) as { content: Array<{ text: string }> };
    assert.equal(hits["api.search.brave.com"], 1);
    assert.equal((JSON.parse(first.content[0]?.text ?? "{}") as { searchToolkitAuto: Json }).searchToolkitAuto.cached, undefined);
    assert.match(String((JSON.parse(second.content[0]?.text ?? "{}") as { searchToolkitAuto: Json }).searchToolkitAuto.cached), /^\d+s$/);
    assert.equal(second.content[1]?.text, first.content[1]?.text);
    await toolkit.callTool("search_auto", { query: "same question", limit: 3 });
    assert.equal(hits["api.search.brave.com"], 2, "different arguments are a different answer");
  });
});

test("the cache can be turned off in config", async () => {
  await withRest({ brave: "brave" }, braveOk, async (toolkit, hits) => {
    await toolkit.callTool("search_auto", { query: "q" });
    await toolkit.callTool("search_auto", { query: "q" });
    assert.equal(hits["api.search.brave.com"], 2);
    assert.deepEqual((toolkit.status() as { cache: Json }).cache, { enabled: false });
  }, { cache: { enabled: false } });
});

test("a cached page serves the next offset without fetching again", async () => {
  const page = "readable sentence. ".repeat(400);
  await withRest({ parallel: "parallel" }, () => new Response(JSON.stringify({
    results: [{ url: "https://doc.example/", title: "Doc", full_content: page }], errors: [],
  }), { status: 200 }), async (toolkit, hits) => {
    await toolkit.callTool("fetch_auto", { url: "https://doc.example/", maxChars: 1000 });
    const next = await toolkit.callTool("fetch_auto", { url: "https://doc.example/", maxChars: 1000, offset: 1000 }) as { content: Array<{ text: string }> };
    assert.equal(hits["api.parallel.ai"], 1);
    assert.match(next.content[0]?.text ?? "", /"cached":"\d+s"/);
  });
});

test("a provider failing repeatedly right now is tried after its healthy peers", async () => {
  await withRest({ parallel: "parallel", brave: "brave" }, (host) => {
    if (host === "api.parallel.ai") {
      return new Response("unavailable", { status: 503 });
    }
    return braveOk();
  }, async (toolkit, hits) => {
    await toolkit.callTool("search_auto", { query: "one" });
    await toolkit.callTool("search_auto", { query: "two" });
    assert.equal(hits["api.parallel.ai"], 2);
    // Two failures in a row: Parallel is now flaky, so Brave answers without Parallel being called.
    const third = await toolkit.callTool("search_auto", { query: "three" }) as { structuredContent: { route: Json } };
    assert.equal(third.structuredContent.route.provider, "brave");
    assert.equal(hits["api.parallel.ai"], 2);
    const status = toolkit.status() as { providers: Array<{ name: string; recentFailure?: number }> };
    assert.ok((status.providers.find((item) => item.name === "parallel")?.recentFailure ?? 0) >= 0.5);
  });
});

test("Octen sends its native filters, restores spacing, and treats a business error code as a failure", async () => {
  const { OctenAdapter, spaced } = await import("../src/rest/providers/octen.js");
  assert.equal(spaced("Shorncliffe,Brisbane,Queensland.The pier is 1,000 m; U.S. law.It"), "Shorncliffe, Brisbane, Queensland. The pier is 1,000 m; U.S. law. It");
  const original = globalThis.fetch;
  const bodies: Array<Record<string, unknown>> = [];
  let reply: Record<string, unknown> = {
    code: 0,
    data: { results: [{ title: "Pier", url: "https://example.com/pier", highlight: "Reopened in 2016.It hosts a dinner.", time_published: "2024-10-15T00:00:00Z" }] },
  };
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(JSON.stringify(reply), { status: 200 });
  };
  try {
    const adapter = new OctenAdapter();
    const config = { enabled: true, auto: [], keys: ["k"], integration: { kind: "rest", adapter: "octen" } } as never;
    const result = await adapter.call("octen_search", { query: "pier", limit: 3, freshness: "week", includeDomains: ["example.com"], language: ["zh"] }, "k", config) as { items: Array<{ text: string; date?: string }> };
    assert.deepEqual(bodies[0], { query: "pier", count: 3, include_domains: ["example.com"], language: ["zh"], time_range: "week" });
    assert.equal(result.items[0]?.text, "Reopened in 2016. It hosts a dinner.");
    assert.equal(result.items[0]?.date, "2024-10-15");
    reply = { code: 403, msg: "Insufficient balance in account" };
    await assert.rejects(adapter.call("octen_search", { query: "pier" }, "k", config), (error: { status?: number }) => error.status === 403);
  } finally {
    globalThis.fetch = original;
  }
});

test("search_images searches by image through Google Lens and explains an empty answer", async () => {
  const { imageCandidates } = await import("../src/routes.js");
  assert.deepEqual(imageCandidates({ imageUrl: " https://example.com/a.jpg ", limit: 5 }), [
    { name: "serper_lens", nativeArguments: { url: "https://example.com/a.jpg", limit: 5 } },
  ]);
  assert.equal(imageCandidates({ query: "pier" })[0]?.name, "brave_image_search");
  const { SerperAdapter, LENS_NO_MATCHES } = await import("../src/rest/providers/serper.js");
  const original = globalThis.fetch;
  const sent: Array<{ url: string; body: Record<string, unknown> }> = [];
  let organic: unknown[] = [
    { title: "Pier at dusk", source: "Example News", link: "https://news.example/pier", imageUrl: "x-raw-image:///abc", thumbnailUrl: "https://gstatic.example/t.jpg" },
    { title: "Pier photo", source: "Photos", link: "https://photos.example/p", imageUrl: "https://photos.example/p.jpg", thumbnailUrl: "https://gstatic.example/u.jpg" },
  ];
  globalThis.fetch = async (url, init) => {
    sent.push({ url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    return new Response(JSON.stringify({ organic, credits: 3 }), { status: 200 });
  };
  try {
    const adapter = new SerperAdapter();
    assert.ok(adapter.tools().some((tool) => tool.name === "serper_lens"));
    const found = await adapter.call("serper_lens", { url: "https://example.com/a.jpg", limit: 5 }, "k") as { items: Array<{ url: string; imageUrl: string; source?: string }> };
    assert.deepEqual(sent[0], { url: "https://google.serper.dev/lens", body: { url: "https://example.com/a.jpg" } });
    assert.deepEqual(found.items.map((item) => [item.url, item.imageUrl, item.source]), [
      ["https://news.example/pier", "https://gstatic.example/t.jpg", "Example News"],
      ["https://photos.example/p", "https://photos.example/p.jpg", "Photos"],
    ]);
    organic = [];
    assert.deepEqual(await adapter.call("serper_lens", { url: "https://example.com/b.jpg" }, "k"), { items: [], warnings: [LENS_NO_MATCHES] });
  } finally {
    globalThis.fetch = original;
  }
});

test("a time-bounded request sends Exa to its advanced tool with a publish-date filter", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-15T12:00:00Z") });
  const since = "2026-10-08";
  const official = autoCandidates("official", "balanced", { query: "Node.js release schedule", freshness: "week" });
  assert.equal(official[0]?.name, "exa_web_search_advanced_exa");
  assert.equal(official[0]?.nativeArguments?.startPublishedDate, since);
  assert.equal(official[0]?.nativeArguments?.objective, undefined);
  const scholarMax = autoCandidates("scholar", "max", { query: "retrieval augmented generation", freshness: "year" });
  assert.equal(scholarMax[0]?.name, "exa_web_search_advanced_exa");
  assert.equal(scholarMax[0]?.nativeArguments?.type, "auto");
  assert.equal(scholarMax[0]?.nativeArguments?.category, "publication");
  assert.equal(scholarMax[0]?.nativeArguments?.startPublishedDate, "2025-10-15");
  assert.equal(scholarMax[0]?.nativeArguments?.objective, undefined);
  const plain = autoCandidates("scholar", "max", { query: "retrieval augmented generation" });
  assert.equal(plain[0]?.name, "exa_web_search_exa");
  assert.equal(plain[0]?.nativeArguments?.startPublishedDate, undefined);
});

function assertNoLoneSurrogates(value: string): void {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      assert.ok(next >= 0xdc00 && next <= 0xdfff, `lone high surrogate at index ${i}`);
      i += 1;
    } else {
      assert.ok(code < 0xdc00 || code > 0xdfff, `lone low surrogate at index ${i}`);
    }
  }
}

test("queryTerms keeps 2-char technical terms and strips search operators while focusExcerpt uses word boundaries and windowAroundMatch", () => {
  assert.deepEqual(
    queryTerms("Go AI TS C# v2 is in to after:2025-01-01 filetype:pdf lang:zh"),
    ["go", "ai", "ts", "c#", "v2"],
  );

  // Word-boundary matching: "log" must not match "blog" or "technology".
  const boundaryText = [
    "Our engineering blog explores modern web technology trends in depth.",
    "Another long blog post about distributed systems and cloud technology.",
    "Enable structured log rotation to prevent disk exhaustion on production nodes.",
  ].join(" ");
  const focusedBoundary = focusExcerpt(boundaryText, "log", 95);
  assert.match(focusedBoundary, /structured log rotation/);
  assert.doesNotMatch(focusedBoundary, /engineering blog/);

  // Short 0-hit opening segment + long matching segment (> max) must trigger windowAroundMatch around the densest cluster.
  const longMatch = [
    "Intro header.",
    `${"unrelated preamble words ".repeat(15)}WAL checkpoint latency drops sharply with SQLite synchronous normal mode${" trailing filler text".repeat(15)}.`,
  ].join(" ");
  const windowed = focusExcerpt(longMatch, "SQLite WAL checkpoint", 120);
  assert.match(windowed, /WAL checkpoint/);
  assert.match(windowed, /SQLite/);

  // Surrogate-pair safety on safeSlice and focusExcerpt.
  const emojiText = `${"alpha 🚀 ".repeat(12)}target 🚀 keyword ${"beta 🚀 ".repeat(12)}`;
  for (let cut = 1; cut < 30; cut += 1) {
    assertNoLoneSurrogates(safeSlice(emojiText, 0, cut));
    assertNoLoneSurrogates(safeSlice(emojiText, cut));
  }
  assertNoLoneSurrogates(focusExcerpt(emojiText, "target keyword", 55));
});

test("truncateBody and filterTextBySection parse Setext headings, skip frontmatter/code fences, prioritize exact headings, and avoid empty blocks", () => {
  const doc = [
    "---",
    "title: Auth",
    "---",
    "Auth Overview",
    "=============",
    "Top-level intro.",
    "",
    "## Authentication Setup",
    "Substring heading body.",
    "",
    "```bash",
    "## Auth",
    "# comment inside code fence",
    "```",
    "",
    "Auth",
    "----",
    "Exact Setext auth section body with token details.",
    "",
    "## Next Topic",
    "Unrelated footer.",
  ].join("\n");

  const exact = truncateBody({ content: [{ type: "text", text: doc }] }, 500, { section: "Auth" }) as {
    content: Array<{ text: string }>;
  };
  assert.equal(exact.content[0]?.text, "Auth\n----\nExact Setext auth section body with token details.");

  // Surrogate-pair safety and no empty text blocks emitted when offset lands on a block boundary.
  const emojiPage = `${"hello 🚀 world ".repeat(10)}`;
  const cut = truncateBody({ content: [{ type: "text", text: emojiPage }] }, 25, { offset: 7 }) as {
    content: Array<{ text: string }>;
  };
  assertNoLoneSurrogates(cut.content[0]?.text ?? "");
  assert.ok((cut.content[0]?.text ?? "").length > 0);

  // When offset skips block 0 completely, block 0 is omitted rather than emitting an empty text block.
  const multiBlock = truncateBody({
    content: [
      { type: "text", text: "0123456789" },
      { type: "text", text: "abcdefghij" },
    ],
  }, 5, { offset: 10 }, "readable", { section: "API" }) as { content: Array<{ text: string }> };
  assert.equal(multiBlock.content[0]?.text, "abcde");
  assert.match(multiBlock.content[1]?.text ?? "", /pass offset=15 with section="API"/);
});

test("isUsableFetchText rejects 2-4KB Cloudflare/WAF interstitials while passing substantive articles that quote challenge phrases", () => {
  const wafPage = [
    "Just a moment... Enable JavaScript and cookies to continue.",
    "Checking if the site connection is secure.",
    "Performance & security by Cloudflare.",
    "Cloudflare Ray ID: 8a1b2c3d4e5f6789",
    "Why have I been blocked? This website is using a security service to protect itself from online attacks.",
    "nav ".repeat(500),
  ].join("\n");
  assert.ok(wafPage.length > 1_500 && wafPage.length < 6_000);
  assert.equal(isUsableFetchText(wafPage), false);

  const realArticle = [
    "# Debugging HTTP Clients Behind Edge Firewalls",
    "",
    'When testing resilient web fetchers, you may occasionally encounter interstitial shells containing "Just a moment... Enable JavaScript and cookies" returned by edge proxies.',
    "",
    ...Array.from({ length: 24 }, (_, idx) =>
      `Paragraph ${idx + 1}: Production crawlers distinguish real documentation pages from edge challenges by checking substantive prose density across multiple coherent paragraphs.`,
    ),
  ].join("\n");
  assert.ok(realArticle.length > 2_000 && realArticle.length < 6_000);
  assert.equal(isUsableFetchText(realArticle), true);
});

test("readableFetchOutput ignores bare numeric counts while extracting explicit HTTP page statuses", () => {
  assert.throws(
    () => readableFetchOutput({
      content: [{ type: "text", text: JSON.stringify({ success: false, error: "failed to parse 404 items in payload" }) }],
    }),
    (err: unknown) => err instanceof TargetPageError && err.pageStatus === undefined,
  );

  assert.throws(
    () => readableFetchOutput({
      content: [{ type: "text", text: JSON.stringify({ success: false, error: "HTTP 404 Not Found" }) }],
    }),
    (err: unknown) => err instanceof TargetPageError && err.pageStatus === 404,
  );
});

test("ResultCache enforces maxEntries and maxTotalBytes eviction, deletes corrupt rows, and clamps backward clock skew", (t) => {
  const baseNow = Date.parse("2026-10-15T12:00:00Z");
  t.mock.timers.enable({ apis: ["Date"], now: baseNow });
  const dir = mkdtempSync(join(tmpdir(), "search-toolkit-cache-limits-"));
  const dbPath = join(dir, "cache.db");
  const cache = new ResultCache(dbPath, { maxEntries: 2, maxTotalBytes: 200 });
  try {
    cache.set("k1", { v: "a".repeat(30) }, 60_000);
    t.mock.timers.tick(10);
    cache.set("k2", { v: "b".repeat(30) }, 60_000);
    t.mock.timers.tick(10);
    cache.set("k3", { v: "c".repeat(30) }, 60_000);
    // maxEntries=2 evicts oldest key k1.
    assert.equal(cache.get("k1"), undefined);
    assert.ok(cache.get("k2"));
    assert.ok(cache.get("k3"));

    // maxTotalBytes=200 evicts oldest entries while preserving the newly written key.
    t.mock.timers.tick(10);
    cache.set("k4", { v: "d".repeat(160) }, 60_000);
    assert.equal(cache.get("k2"), undefined);
    assert.equal(cache.get("k3"), undefined);
    assert.deepEqual(cache.get("k4")?.value, { v: "d".repeat(160) });
    cache.close();

    // Corrupt JSON row is deleted on read, and future created_at clamps ageMs to 0.
    const rawDb = new DatabaseSync(dbPath);
    try {
      rawDb.prepare("INSERT INTO result_cache(key, value, created_at, expires_at) VALUES (?, ?, ?, ?)")
        .run("corrupt", "{bad-json", baseNow, baseNow + 60_000);
      rawDb.prepare("INSERT INTO result_cache(key, value, created_at, expires_at) VALUES (?, ?, ?, ?)")
        .run("future", JSON.stringify({ ok: true }), baseNow + 50_000, baseNow + 120_000);
    } finally {
      rawDb.close();
    }

    const reopened = new ResultCache(dbPath);
    try {
      assert.equal(reopened.get("corrupt"), undefined);
      const futureHit = reopened.get("future");
      assert.equal(futureHit?.ageMs, 0);
      assert.deepEqual(futureHit?.value, { ok: true });
      const checkDb = new DatabaseSync(dbPath);
      try {
        assert.equal(checkDb.prepare("SELECT key FROM result_cache WHERE key = ?").get("corrupt"), undefined);
      } finally {
        checkDb.close();
      }
      reopened.close();
      assert.doesNotThrow(() => reopened.close());
    } finally {
      reopened.close();
    }
  } finally {
    cache.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("coversRequest refetches for capped readers (parallel) on section/offset while serving uncapped readers (you) from cache", async () => {
  const fullDoc = [
    "# Full Document",
    "Intro paragraph with plenty of readable content to pass the usable fetch threshold easily. ".repeat(12),
    "",
    "## Details",
    "Detailed section content that lives well past the first 800 characters of the page. ".repeat(12),
  ].join("\n");

  // 1. Capped reader (parallel): honors max_chars_per_result so initial cache entry does NOT cover section or later offset.
  const dir1 = mkdtempSync(join(tmpdir(), "search-toolkit-capped-"));
  const config1 = join(dir1, "providers.json");
  writeFileSync(config1, JSON.stringify({
    version: 2,
    statePath: join(dir1, "state.db"),
    providers: {
      parallel: { enabled: true, auto: ["fetch"], keys: ["k1-123456"], integration: { kind: "rest", adapter: "parallel" } },
    },
  }));
  const original = globalThis.fetch;
  let parallelHits = 0;
  globalThis.fetch = async (_input, init) => {
    parallelHits += 1;
    const body = JSON.parse(String(init?.body)) as { advanced_settings?: { full_content?: { max_chars_per_result?: number } } };
    const cap = body.advanced_settings?.full_content?.max_chars_per_result ?? fullDoc.length;
    return Response.json({
      results: [{ url: "https://doc.example/capped", title: "Capped Doc", full_content: fullDoc.slice(0, cap) }],
      errors: [],
    });
  };
  const cappedToolkit = new SearchToolkit(config1);
  try {
    await cappedToolkit.initialize();
    await cappedToolkit.callTool("fetch_auto", { url: "https://doc.example/capped", maxChars: 600 });
    assert.equal(parallelHits, 1);
    await cappedToolkit.callTool("fetch_auto", { url: "https://doc.example/capped", maxChars: 600, offset: 900 });
    assert.equal(parallelHits, 2, "capped reader must refetch when offset exceeds cached slice");
    await cappedToolkit.callTool("fetch_auto", { url: "https://doc.example/capped", maxChars: 600, section: "Details" });
    assert.equal(parallelHits, 3, "capped reader must refetch when section requests full document");
  } finally {
    globalThis.fetch = original;
    await cappedToolkit.close();
    rmSync(dir1, { recursive: true, force: true });
  }

  // 2. Uncapped reader (you_contents): single fetch covers subsequent section and offset reads from cache.
  let youHits = 0;
  await withRest({ you: "you" }, () => {
    youHits += 1;
    return Response.json({
      url: "https://doc.example/uncapped",
      title: "Uncapped Doc",
      contents: { markdown: fullDoc },
    });
  }, async (toolkit) => {
    await toolkit.callTool("fetch_auto", { url: "https://doc.example/uncapped", maxChars: 600 });
    const sectioned = await toolkit.callTool("fetch_auto", {
      url: "https://doc.example/uncapped", maxChars: 600, section: "Details",
    }) as { content: Array<{ text: string }> };
    const paged = await toolkit.callTool("fetch_auto", {
      url: "https://doc.example/uncapped", maxChars: 600, offset: 900,
    }) as { content: Array<{ text: string }> };
    assert.equal(youHits, 1, "uncapped reader serves section and offset directly from cache");
    assert.match(sectioned.content[1]?.text ?? "", /## Details/);
    assert.match(paged.content[0]?.text ?? "", /"cached":"\d+s"/);
  });
});
