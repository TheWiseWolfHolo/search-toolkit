import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { cacheKey } from "../src/cache.js";
import { cleanExcerpt, focusExcerpt, queryTerms } from "../src/excerpt.js";
import { dedupeItems, nearDuplicateKey } from "../src/merge.js";
import { extractUpstreamSearchItems } from "../src/rest/normalize.js";
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
    assert.equal((JSON.parse(second.content[0]?.text ?? "{}") as { searchToolkitAuto: Json }).searchToolkitAuto.cached, "0s");
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
    assert.match(next.content[0]?.text ?? "", /"cached":"0s"/);
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
