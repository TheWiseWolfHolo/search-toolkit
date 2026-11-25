import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { InvalidRequestError } from "../src/errors.js";
import { isChineseQuery } from "../src/routes.js";
import { attachRouteMetadata, autoCandidates, filterBindings, imageCandidates, SearchToolkit } from "../src/toolkit.js";
import type { ProviderConfig, ToolBinding } from "../src/types.js";

const binding: ToolBinding = {
  provider: "exa",
  upstreamName: "web_search_exa",
  exposed: { name: "exa_web_search_exa", inputSchema: { type: "object" } },
  call: async () => ({}),
};

test("search_auto results preserve content and expose an auditable route", () => {
  const output = attachRouteMetadata(binding, {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          searchToolkitRoute: {
            provider: "exa",
            tool: "exa_web_search_exa",
            upstreamTool: "web_search_exa",
          },
        }),
      },
      { type: "text", text: "result body" },
    ],
    structuredContent: { items: [1] },
    _meta: { searchToolkit: { keySlot: "masked" } },
  }) as Record<string, unknown>;
  assert.deepEqual(output.structuredContent, {
    route: { provider: "exa", tool: "exa_web_search_exa", upstreamTool: "web_search_exa" },
    result: { items: [1] },
  });
  assert.deepEqual((output._meta as Record<string, unknown>).searchToolkit, {
    keySlot: "masked",
    route: { provider: "exa", tool: "exa_web_search_exa", upstreamTool: "web_search_exa" },
  });
  assert.equal((output.content as Array<{ text: string }>).length, 2);
  assert.equal((output.content as Array<{ text: string }>)[1]?.text, "result body");
});

test("provider tool policies also filter REST bindings", () => {
  const config: ProviderConfig = {
    enabled: true,
    auto: ["search"],
    keys: ["key"],
    integration: { kind: "rest", adapter: "brave" },
    toolPolicy: { allow: ["brave_web_search"], deny: [] },
  };
  const news: ToolBinding = {
    ...binding,
    provider: "brave",
    upstreamName: "brave_news_search",
    exposed: { name: "brave_news_search", inputSchema: { type: "object" } },
  };
  const web: ToolBinding = {
    ...binding,
    provider: "brave",
    upstreamName: "brave_web_search",
    exposed: { name: "brave_web_search", inputSchema: { type: "object" } },
  };
  assert.deepEqual(filterBindings(config, [web, news]).map((item) => item.exposed.name), ["brave_web_search"]);
});

test("search_pool_status is compact by default and verbose on request", async () => {
  const directory = mkdtempSync(join(tmpdir(), "search-toolkit-status-"));
  const configPath = join(directory, "providers.json");
  const keys = ["key-one-123456", "key-two-123456"];
  writeFileSync(configPath, JSON.stringify({
    version: 1,
    statePath: join(directory, "state.db"),
    providers: {
      brave: {
        enabled: true,
        automatic: true,
        keys,
        integration: { kind: "rest", adapter: "brave" },
      },
    },
  }));
  const toolkit = new SearchToolkit(configPath);
  try {
    await toolkit.initialize();
    const disabled = toolkit.rotation.select("brave", keys, true);
    toolkit.rotation.record(disabled, { ok: false, latencyMs: 10, httpStatus: 401 });

    const compact = await toolkit.callTool("search_pool_status", {}) as Record<string, unknown>;
    const compactBody = compact.structuredContent as Record<string, unknown>;
    const compactProvider = (compactBody.providers as Array<Record<string, unknown>>)[0];
    const compactRotation = compactProvider?.rotation as Record<string, unknown>;
    assert.equal(compactBody.verbose, false);
    assert.equal(compactBody.toolCount, toolkit.listTools().length);
    assert.equal("tools" in compactBody, false);
    assert.deepEqual(
      {
        keyCount: compactRotation.keyCount,
        healthy: compactRotation.healthy,
        disabled: compactRotation.disabled,
      },
      { keyCount: 2, healthy: 1, disabled: 1 },
    );
    assert.equal("keys" in compactRotation, false);
    assert.equal((compactRotation.unhealthySlots as unknown[]).length, 1);

    const verbose = await toolkit.callTool("search_pool_status", { verbose: true }) as Record<string, unknown>;
    const verboseBody = verbose.structuredContent as Record<string, unknown>;
    const verboseProvider = (verboseBody.providers as Array<Record<string, unknown>>)[0];
    assert.equal(verboseBody.verbose, true);
    assert.equal((verboseBody.tools as unknown[]).length, toolkit.listTools().length);
    assert.equal(((verboseProvider?.rotation as Record<string, unknown>).keys as unknown[]).length, 2);
  } finally {
    await toolkit.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("automatic route profiles keep their measured provider order", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-15T12:00:00Z") });
  const request = { query: "route contract", limit: 7 };
  const names = (mode: Parameters<typeof autoCandidates>[0], quality: Parameters<typeof autoCandidates>[1] = "balanced", extra = {}) =>
    autoCandidates(mode, quality, { ...request, ...extra }).map((item) => item.name);
  assert.deepEqual(names("general"), [
    "parallel_search", "serper_search", "exa_web_search_advanced_exa", "you_search", "octen_search", "brave_web_search", "tavily_tavily_search", "deepseek_search", "vercel_deepseek_search", "vercel_parallel_fast",
  ]);
  // Providers are asked for two extra results; duplicates are dropped before the list is capped.
  assert.deepEqual(autoCandidates("general", "balanced", request)[0]?.nativeArguments, {
    query: "route contract", maxResults: 9, mode: "fast",
  });
  assert.deepEqual(autoCandidates("general", "balanced", request)[2]?.nativeArguments, {
    query: "route contract", numResults: 9, type: "lite",
  });
  assert.deepEqual(names("general", "max"), [
    "exa_web_search_advanced_exa", "parallel_search", "serper_search", "you_search", "octen_search", "brave_web_search", "tavily_tavily_search", "deepseek_search", "vercel_deepseek_search", "vercel_parallel_fast",
  ]);
  assert.deepEqual(autoCandidates("general", "max", request)[0]?.nativeArguments, {
    query: "route contract", numResults: 9, type: "auto", enableHighlights: true,
  });
  assert.equal(autoCandidates("general", "max", request)[1]?.nativeArguments?.mode, "advanced");
  assert.equal(autoCandidates("general", "max", request)[3]?.nativeArguments?.contentLevel, "highlights");
  assert.deepEqual(names("exact"), [
    "parallel_search", "brave_web_search", "serper_search", "you_search", "tavily_tavily_search", "deepseek_search", "vercel_deepseek_search",
  ]);
  assert.deepEqual(autoCandidates("exact", "max", request)[4]?.nativeArguments, {
    query: "route contract", max_results: 9, search_depth: "advanced", exact_match: true,
  });
  assert.deepEqual(names("official"), [
    "exa_web_search_advanced_exa", "brave_web_search", "serper_search", "you_search", "deepseek_search", "vercel_deepseek_search", "vercel_parallel_fast",
  ]);
  assert.equal(autoCandidates("official", "balanced", request)[0]?.nativeArguments?.type, "lite");
  assert.equal(autoCandidates("official", "max", request)[0]?.nativeArguments?.type, "auto");
  assert.equal(autoCandidates("official", "max", request)[1]?.nativeArguments?.extraSnippets, true);
  assert.deepEqual(names("context"), [
    "brave_llm_context", "parallel_search", "you_search", "tavily_tavily_search", "deepseek_search", "vercel_deepseek_search",
  ]);
  assert.deepEqual(autoCandidates("context", "balanced", request)[0]?.nativeArguments, {
    query: "route contract", count: 20, maximumNumberOfTokens: 4096,
  });
  assert.equal(autoCandidates("context", "max", request)[0]?.nativeArguments?.mode, "advanced");
  assert.deepEqual(names("current"), [
    "you_search", "exa_web_search_advanced_exa", "octen_search", "serper_news", "brave_news_search", "tavily_tavily_search", "deepseek_search", "vercel_deepseek_search",
  ]);
  const weekAgo = new Date(Date.now() - 604_800_000).toISOString().slice(0, 10);
  assert.deepEqual(autoCandidates("current", "balanced", request).slice(0, 6).map((item) => item.nativeArguments), [
    { query: "route contract", limit: 9, contentLevel: "snippets", freshness: "week", preferNews: true },
    { query: "route contract", numResults: 9, type: "lite", category: "news", startPublishedDate: weekAgo },
    { query: "route contract", limit: 9, freshness: "week" },
    { query: "route contract", limit: 9, tbs: "qdr:w" },
    { query: "route contract", limit: 9, freshness: "pw" },
    { query: "route contract", max_results: 9, search_depth: "basic", topic: "news", time_range: "week" },
  ]);
  assert.equal(autoCandidates("current", "max", { ...request, freshness: "month" })[1]?.nativeArguments?.type, "auto");
  assert.equal(autoCandidates("current", "max", { ...request, freshness: "month" })[5]?.nativeArguments?.time_range, "month");
  assert.deepEqual(names("scholar"), ["exa_web_search_advanced_exa", "parallel_search", "you_search", "serper_scholar", "vercel_parallel_fast"]);
  assert.equal(autoCandidates("scholar", "balanced", request)[0]?.nativeArguments?.type, "lite");
  assert.equal(autoCandidates("scholar", "balanced", request)[0]?.nativeArguments?.category, "publication");
  assert.match(String(autoCandidates("scholar", "max", request)[0]?.nativeArguments?.objective), /Research papers.*route contract/);
  assert.deepEqual(names("code"), ["exa_web_search_advanced_exa", "parallel_search", "serper_search", "deepseek_search", "vercel_deepseek_search", "vercel_parallel_fast"]);
  assert.deepEqual(autoCandidates("code", "balanced", request)[0]?.nativeArguments?.includeDomains, ["github.com"]);
  assert.equal(autoCandidates("code", "balanced", request)[0]?.nativeArguments?.category, undefined);
  assert.equal(autoCandidates("code", "balanced", request)[0]?.nativeArguments?.type, "lite");
  assert.equal(autoCandidates("code", "max", request)[0]?.nativeArguments?.type, "auto");
  assert.deepEqual(imageCandidates({ query: "route contract", limit: 9 }).map((item) => item.name), [
    "brave_image_search", "serper_images", "parallel_image_search",
  ]);
  assert.deepEqual(imageCandidates({ query: "route contract", limit: 9 })[0]?.nativeArguments, {
    query: "route contract", limit: 9, country: "ALL", safesearch: "strict",
  });
  assert.deepEqual(imageCandidates({ query: "route contract", country: "SG" }), imageCandidates({ query: "route contract" }));
});

test("Chinese queries lead with Brave and Serper in Chinese-market settings", () => {
  assert.equal(isChineseQuery("深圳地铁16号线二期开通时间"), true);
  assert.equal(isChineseQuery("MySQL 联合索引"), true);
  assert.equal(isChineseQuery("東京の天気"), false, "kana marks Japanese");
  assert.equal(isChineseQuery("漢字 한글"), false, "Hangul marks Korean");
  assert.equal(isChineseQuery("node 中"), false, "one character is not enough");
  const general = autoCandidates("general", "balanced", { query: "深圳地铁16号线", limit: 6 });
  assert.deepEqual(general.map((item) => item.name), [
    "brave_web_search", "serper_search", "deepseek_search", "vercel_deepseek_search", "you_search", "parallel_search", "vercel_parallel_fast", "tavily_tavily_search",
  ]);
  assert.deepEqual(general[0]?.nativeArguments, { query: "深圳地铁16号线", limit: 8, searchLang: "zh-hans", country: "CN" });
  assert.deepEqual(general[1]?.nativeArguments, { query: "深圳地铁16号线", limit: 8, gl: "cn", hl: "zh-cn" });
  assert.deepEqual(autoCandidates("exact", "balanced", { query: "报错 内存不足" }).map((item) => item.name), [
    "brave_web_search", "serper_search", "deepseek_search", "vercel_deepseek_search", "you_search", "parallel_search",
  ]);
  assert.deepEqual(autoCandidates("official", "balanced", { query: "微信小程序 开发文档" }).map((item) => item.name), [
    "exa_web_search_advanced_exa", "serper_search", "deepseek_search", "vercel_deepseek_search", "parallel_search", "brave_web_search",
  ]);
  // Chinese news leads with Exa news filtered by publish date (2026-10 eval), then You.com.
  assert.equal(autoCandidates("current", "balanced", { query: "台风 预警" })[0]?.nativeArguments?.category, "news");
  assert.deepEqual(autoCandidates("current", "balanced", { query: "台风 预警" })[2]?.nativeArguments, {
    query: "台风 预警", limit: 8, freshness: "week", language: ["zh"],
  });
  assert.deepEqual(autoCandidates("current", "balanced", { query: "台风 预警" })[3]?.nativeArguments, {
    query: "台风 预警", limit: 8, tbs: "qdr:w", gl: "cn", hl: "zh-cn",
  });
  assert.equal(autoCandidates("context", "balanced", { query: "大模型 评测" })[0]?.nativeArguments?.searchLang, "zh-hans");
  assert.equal(autoCandidates("context", "balanced", { query: "大模型 评测" })[0]?.nativeArguments?.country, "CN");
  assert.deepEqual(autoCandidates("current", "balanced", { query: "台风 预警" })[1]?.nativeArguments, {
    query: "台风 预警", limit: 8, language: "zh-hans", country: "CN", contentLevel: "snippets", freshness: "week", preferNews: true,
  });
});

test("autoCandidates translates domain filters, freshness, and maxCharsPerResult across providers", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-15T12:00:00Z") });
  const filtered = autoCandidates("general", "balanced", {
    query: "mcp transport",
    limit: 5,
    freshness: "month",
    includeDomains: ["modelcontextprotocol.io", "https://github.com/modelcontextprotocol"],
    excludeDomains: ["reddit.com"],
    maxCharsPerResult: 900,
  });
  const byName = new Map(filtered.map((item) => [item.name, item.nativeArguments]));
  assert.deepEqual(byName.get("parallel_search"), {
    query: "mcp transport",
    maxResults: 7,
    mode: "fast",
    // A publish-date filter; maxAgeSeconds would only bound cache staleness.
    afterDate: new Date(Date.now() - 2_592_000_000).toISOString().slice(0, 10),
    maxCharsPerResult: 900,
    includeDomains: ["modelcontextprotocol.io", "github.com/modelcontextprotocol"],
    excludeDomains: ["reddit.com"],
  });
  // Exa Lite takes native domain (with path prefixes) and publish-date filters, but not contextMaxCharacters.
  assert.deepEqual(byName.get("exa_web_search_advanced_exa"), {
    query: "mcp transport",
    numResults: 7,
    type: "lite",
    includeDomains: ["modelcontextprotocol.io", "github.com/modelcontextprotocol"],
    excludeDomains: ["reddit.com"],
    startPublishedDate: new Date(Date.now() - 2_592_000_000).toISOString().slice(0, 10),
  });
  assert.deepEqual(byName.get("brave_web_search"), {
    // site: keeps the path prefix; native filters get the host.
    query: "mcp transport (site:modelcontextprotocol.io OR site:github.com/modelcontextprotocol) -site:reddit.com",
    limit: 7,
    freshness: "pm",
  });
  assert.deepEqual(byName.get("serper_search"), {
    query: "mcp transport (site:modelcontextprotocol.io OR site:github.com/modelcontextprotocol) -site:reddit.com",
    limit: 7,
    tbs: "qdr:m",
  });
  assert.deepEqual(byName.get("tavily_tavily_search"), {
    query: "mcp transport",
    max_results: 7,
    search_depth: "basic",
    include_domains: ["modelcontextprotocol.io", "github.com"],
    exclude_domains: ["reddit.com"],
    time_range: "month",
  });

  const officialMax = autoCandidates("official", "max", {
    query: "StreamableHTTPServerTransport",
    limit: 4,
    includeDomains: ["modelcontextprotocol.io"],
    excludeDomains: ["legacy.example.com"],
    maxCharsPerResult: 1200,
  });
  assert.deepEqual(officialMax[0]?.nativeArguments, {
    query: "StreamableHTTPServerTransport",
    numResults: 6,
    includeDomains: ["modelcontextprotocol.io"],
    excludeDomains: ["legacy.example.com"],
    contextMaxCharacters: 4800,
    type: "auto",
  });
});

test("capSearchOutput caps both content and structuredContent to limit, preserves warnings, and caps context item fallbacks", async () => {
  const directory = mkdtempSync(join(tmpdir(), "search-toolkit-cap-"));
  const configPath = join(directory, "providers.json");
  writeFileSync(configPath, JSON.stringify({
    version: 2,
    statePath: join(directory, "state.db"),
    providers: {
      parallel: { enabled: true, auto: ["search"], keys: ["k1-123456"], integration: { kind: "rest", adapter: "parallel" } },
    },
  }));
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    search_id: "s1",
    warnings: ["upstream note"],
    results: Array.from({ length: 6 }, (_, i) => ({
      url: `https://cap.example/${i + 1}`,
      title: `Result ${i + 1}`,
      excerpts: [`Excerpt ${i + 1}`],
    })),
  }), { status: 200, headers: { "Content-Type": "application/json" } });
  const toolkit = new SearchToolkit(configPath);
  try {
    await toolkit.initialize();
    const general = await toolkit.callTool("search_auto", { query: "cap test", limit: 2 }) as {
      content: Array<{ text: string }>;
      structuredContent: { result: { data: { items: unknown[] } } };
    };
    assert.equal(general.structuredContent.result.data.items.length, 2);
    assert.match(general.content[1]?.text ?? "", /1\. Result 1/);
    assert.match(general.content[1]?.text ?? "", /2\. Result 2/);
    assert.doesNotMatch(general.content[1]?.text ?? "", /3\. Result 3/);
    assert.match(general.content[1]?.text ?? "", /Warnings: upstream note/);

    // Context mode falling back to item-based parallel_search also respects limit.
    const context = await toolkit.callTool("search_auto", { query: "cap context", mode: "context", limit: 3 }) as {
      structuredContent: { result: { data: { items: unknown[] } } };
    };
    assert.equal(context.structuredContent.result.data.items.length, 3);
  } finally {
    globalThis.fetch = original;
    await toolkit.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("singleflight coalesces concurrent identical search_auto and fetch_auto requests", async () => {
  const directory = mkdtempSync(join(tmpdir(), "search-toolkit-sf-"));
  const configPath = join(directory, "providers.json");
  writeFileSync(configPath, JSON.stringify({
    version: 2,
    statePath: join(directory, "state.db"),
    providers: {
      brave: { enabled: true, auto: ["search"], keys: ["k1-123456"], integration: { kind: "rest", adapter: "brave" } },
      you: { enabled: true, auto: ["fetch"], keys: ["k1-123456"], integration: { kind: "rest", adapter: "you" } },
    },
  }));
  const original = globalThis.fetch;
  let searchHits = 0;
  let fetchHits = 0;
  globalThis.fetch = async (input) => {
    const url = String(input);
    await new Promise((resolve) => setTimeout(resolve, 35));
    if (url.includes("api.search.brave.com")) {
      searchHits += 1;
      return Response.json({ web: { results: [{ url: "https://sf.example/", title: "SF", description: "singleflight hit" }] } });
    }
    fetchHits += 1;
    return Response.json({
      url: "https://sf.example/doc",
      title: "SF Doc",
      contents: { markdown: "Readable page body for singleflight deduplication test. ".repeat(10) },
    });
  };
  const toolkit = new SearchToolkit(configPath);
  try {
    await toolkit.initialize();
    const [s1, s2] = await Promise.all([
      toolkit.callTool("search_auto", { query: "same concurrent query" }),
      toolkit.callTool("search_auto", { query: "same concurrent query" }),
    ]);
    assert.equal(searchHits, 1);
    assert.deepEqual((s1 as { content: unknown }).content, (s2 as { content: unknown }).content);

    const [f1, f2] = await Promise.all([
      toolkit.callTool("fetch_auto", { url: "https://sf.example/doc", maxChars: 1000 }),
      toolkit.callTool("fetch_auto", { url: "https://sf.example/doc", maxChars: 1000 }),
    ]);
    assert.equal(fetchHits, 1);
    assert.deepEqual((f1 as { content: unknown }).content, (f2 as { content: unknown }).content);
  } finally {
    globalThis.fetch = original;
    await toolkit.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("cooling providers are excluded from crossCheck and local no-healthy-slots errors do not penalize EWMA", async () => {
  const directory = mkdtempSync(join(tmpdir(), "search-toolkit-cooling-"));
  const configPath = join(directory, "providers.json");
  const rest = (adapter: string) => ({ enabled: true, auto: ["search"], keys: ["k1-123456"], integration: { kind: "rest", adapter } });
  writeFileSync(configPath, JSON.stringify({
    version: 2,
    statePath: join(directory, "state.db"),
    providers: { parallel: rest("parallel"), serper: rest("serper"), brave: rest("brave") },
  }));
  const original = globalThis.fetch;
  const hosts: string[] = [];
  globalThis.fetch = async (input) => {
    const host = new URL(String(input)).hostname;
    hosts.push(host);
    if (host === "google.serper.dev") return Response.json({ organic: [{ title: "S", link: "https://shared.example/", snippet: "s" }] });
    if (host === "api.search.brave.com") return Response.json({ web: { results: [{ title: "B", url: "https://shared.example/", description: "b" }] } });
    throw new Error(`unexpected host ${host}`);
  };
  const toolkit = new SearchToolkit(configPath);
  try {
    await toolkit.initialize();
    // Bench parallel's only key so it is cooling.
    toolkit.rotation.record(toolkit.rotation.select("parallel", ["k1-123456"], true), { ok: false, latencyMs: 5, httpStatus: 429 });

    // crossCheck picks active serper + brave and skips cooling parallel.
    const checked = await toolkit.callTool("search_auto", { query: "cooling test", crossCheck: true }) as {
      structuredContent: { searchAuto: { crossCheck: { status: string; routes: Array<{ provider: string }> } } };
    };
    assert.equal(checked.structuredContent.searchAuto.crossCheck.status, "complete");
    assert.deepEqual(checked.structuredContent.searchAuto.crossCheck.routes.map((r) => r.provider), ["serper", "brave"]);
    assert.equal(hosts.includes("api.parallel.ai"), false);

    // Bench serper & brave too so every provider is cooling; local slot exhaustion must NOT poison recentFailure EWMA.
    toolkit.rotation.record(toolkit.rotation.select("serper", ["k1-123456"], true), { ok: false, latencyMs: 5, httpStatus: 429 });
    toolkit.rotation.record(toolkit.rotation.select("brave", ["k1-123456"], true), { ok: false, latencyMs: 5, httpStatus: 429 });
    await assert.rejects(toolkit.callTool("search_auto", { query: "all cooling" }), /no healthy key slots available/);
    const status = toolkit.status() as { providers: Array<{ name: string; recentFailure?: number }> };
    for (const provider of status.providers) {
      assert.equal(provider.recentFailure, undefined, `${provider.name} should not be EWMA-penalized for local cooldown`);
    }
  } finally {
    globalThis.fetch = original;
    await toolkit.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("vercel_gateway 5xx on vercel_deepseek_search skips sibling vercel_parallel_fast in runChain", async () => {
  const directory = mkdtempSync(join(tmpdir(), "search-toolkit-vercel-sibling-"));
  const configPath = join(directory, "providers.json");
  writeFileSync(configPath, JSON.stringify({
    version: 2,
    statePath: join(directory, "state.db"),
    providers: {
      vercel: { enabled: true, auto: ["search"], keys: ["v-key-123456"], integration: { kind: "rest", adapter: "vercel_gateway" } },
      you: { enabled: true, auto: ["search"], keys: ["y-key-123456"], integration: { kind: "rest", adapter: "you" } },
    },
  }));
  const original = globalThis.fetch;
  let vercelHits = 0;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("ai-gateway.vercel.sh")) {
      vercelHits += 1;
      return new Response("gateway overloaded", { status: 503 });
    }
    return new Response("you unavailable", { status: 503 });
  };
  const toolkit = new SearchToolkit(configPath);
  try {
    await toolkit.initialize();
    // Chinese general route orders vercel_deepseek_search -> you_search -> vercel_parallel_fast.
    await assert.rejects(
      toolkit.callTool("search_auto", { query: "深圳地铁16号线" }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /vercel\/vercel_deepseek_search\[503\] -> you\/you_search\[503\]/);
        assert.doesNotMatch(err.message, /vercel_parallel_fast/);
        return true;
      },
    );
    assert.equal(vercelHits, 1, "sibling vercel_parallel_fast must be skipped after 5xx on vercel_deepseek_search");
  } finally {
    globalThis.fetch = original;
    await toolkit.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("vercel_deepseek_search 402 on a 1-key pool still allows $0 vercel_parallel_fast while keeping key exhausted for paid tools, whereas 401/429 blocks both", async () => {
  const directory = mkdtempSync(join(tmpdir(), "search-toolkit-vercel-promo-"));
  const configPath = join(directory, "providers.json");
  const keys = ["v-promo-key-123456"];
  writeFileSync(configPath, JSON.stringify({
    version: 2,
    statePath: join(directory, "state.db"),
    providers: {
      vercel: { enabled: true, auto: ["search"], keys, integration: { kind: "rest", adapter: "vercel_gateway" } },
    },
  }));
  const original = globalThis.fetch;
  let deepseekCalls = 0;
  let parallelCalls = 0;
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { tools?: Array<{ name?: string }> };
    const toolName = body.tools?.[0]?.name;
    if (toolName === "deepseek_search") {
      deepseekCalls += 1;
      return new Response(JSON.stringify({ error: { code: "insufficient_credits", message: "Out of credits" } }), {
        status: 402,
        headers: { "Content-Type": "application/json" },
      });
    }
    parallelCalls += 1;
    return Response.json({
      content: [{
        type: "tool-result",
        toolName: "parallel_search",
        result: { results: [{ title: "Promo Result", url: "https://promo.example/1", excerpts: ["$0 parallel fast"] }] },
      }],
    });
  };
  const toolkit = new SearchToolkit(configPath);
  try {
    await toolkit.initialize();
    // 1. First search_auto hits 402 on vercel_deepseek_search, then immediately succeeds via $0 vercel_parallel_fast.
    const first = await toolkit.callTool("search_auto", { query: "promo fallback one" }) as {
      structuredContent: {
        route: { tool: string };
        searchAuto: { attempts: Array<{ tool: string; outcome: string; status?: number }> };
      };
    };
    assert.equal(first.structuredContent.route.tool, "vercel_parallel_fast");
    assert.deepEqual(
      first.structuredContent.searchAuto.attempts.map((a) => `${a.tool}:${a.status ?? a.outcome}`),
      ["vercel_deepseek_search:402", "vercel_parallel_fast:success"],
    );
    assert.equal(deepseekCalls, 1);
    assert.equal(parallelCalls, 1);
    // Exhausted status must remain preserved on the key for paid tools even though $0 promo succeeded.
    assert.equal(toolkit.rotation.status("vercel", keys).keys[0]?.status.status, "exhausted");

    // 2. Subsequent search_auto skips exhausted vercel_deepseek_search and goes directly to $0 vercel_parallel_fast.
    const second = await toolkit.callTool("search_auto", { query: "promo fallback two" }) as {
      structuredContent: { route: { tool: string } };
    };
    assert.equal(second.structuredContent.route.tool, "vercel_parallel_fast");
    assert.equal(deepseekCalls, 1, "paid vercel_deepseek_search stays bypassed while exhausted");
    assert.equal(parallelCalls, 2);
    assert.equal(toolkit.rotation.status("vercel", keys).keys[0]?.status.status, "exhausted");

    // Direct paid call is still blocked; direct $0 promo call still succeeds and preserves exhausted status.
    await assert.rejects(toolkit.callTool("vercel_deepseek_search", { query: "paid direct" }), /no healthy key slots/);
    const directPromo = await toolkit.callTool("vercel_parallel_fast", { query: "promo direct" }) as {
      structuredContent: { tool: string };
    };
    assert.equal(directPromo.structuredContent.tool, "vercel_parallel_fast");
    assert.equal(toolkit.rotation.status("vercel", keys).keys[0]?.status.status, "exhausted");

    // 3. 429 cooldown and 401 disabled still block BOTH paid and $0 promo tools.
    toolkit.rotation.reset("vercel", keys);
    toolkit.rotation.record(toolkit.rotation.select("vercel", keys, true), { ok: false, latencyMs: 5, httpStatus: 429 });
    await assert.rejects(toolkit.callTool("vercel_parallel_fast", { query: "blocked 429" }), /no healthy key slots/);
    await assert.rejects(toolkit.callTool("search_auto", { query: "blocked 429 auto" }), /no healthy key slots/);

    toolkit.rotation.reset("vercel", keys);
    toolkit.rotation.record(toolkit.rotation.select("vercel", keys, true), { ok: false, latencyMs: 5, httpStatus: 401 });
    await assert.rejects(toolkit.callTool("vercel_parallel_fast", { query: "blocked 401" }), /no healthy key slots/);
    await assert.rejects(toolkit.callTool("search_auto", { query: "blocked 401 auto" }), /no healthy key slots/);
  } finally {
    globalThis.fetch = original;
    await toolkit.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("allowTool is enforced inside SearchToolkit.callTool for provider_call and search_rotation_probe", async () => {
  const directory = mkdtempSync(join(tmpdir(), "search-toolkit-allow-"));
  const configPath = join(directory, "providers.json");
  writeFileSync(configPath, JSON.stringify({
    version: 2,
    statePath: join(directory, "state.db"),
    providers: {
      brave: { enabled: true, auto: ["search"], keys: ["k1-123456"], integration: { kind: "rest", adapter: "brave" } },
    },
  }));
  const original = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ web: { results: [{ url: "https://ok.example/", title: "OK", description: "d" }] } });
  const toolkit = new SearchToolkit(configPath, { profile: "lean" });
  try {
    await toolkit.initialize();
    const denyBraveWeb = (tool: { name: string }) => tool.name !== "brave_web_search";

    await assert.rejects(
      toolkit.callTool("provider_call", { name: "brave_web_search", arguments: { query: "q" } }, { allowTool: denyBraveWeb }),
      /not available for this token/,
    );
    await assert.rejects(
      toolkit.callTool("search_rotation_probe", { provider: "brave", query: "probe", tool: "brave_web_search" }, { allowTool: denyBraveWeb }),
      /not available for this token/,
    );
    // Omitted args.tool auto-selects brave_web_search and must also be blocked by allowTool.
    await assert.rejects(
      toolkit.callTool("search_rotation_probe", { provider: "brave", query: "probe" }, { allowTool: denyBraveWeb }),
      /not available for this token/,
    );
    // Explicitly allowed tool succeeds.
    const allowedProbe = await toolkit.callTool(
      "search_rotation_probe",
      { provider: "brave", query: "probe", tool: "brave_news_search", calls: 1 },
      { allowTool: denyBraveWeb },
    ) as { structuredContent: { tool: string } };
    assert.equal(allowedProbe.structuredContent.tool, "brave_news_search");
  } finally {
    globalThis.fetch = original;
    await toolkit.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("search_images rejects contradictory or invalid arguments with InvalidRequestError and SearchToolkit.close is idempotent", async () => {
  const directory = mkdtempSync(join(tmpdir(), "search-toolkit-images-close-"));
  const configPath = join(directory, "providers.json");
  writeFileSync(configPath, JSON.stringify({
    version: 2,
    statePath: join(directory, "state.db"),
    providers: {
      brave: { enabled: true, auto: ["images"], keys: ["k1-123456"], integration: { kind: "rest", adapter: "brave" } },
    },
  }));
  const toolkit = new SearchToolkit(configPath);
  try {
    await toolkit.initialize();
    for (const badArgs of [
      { query: "cat", imageUrl: "https://example.com/cat.jpg" },
      {},
      { imageUrl: "file:///etc/passwd" },
      { imageUrl: "https://user:pass@example.com/cat.jpg" },
    ]) {
      await assert.rejects(
        toolkit.callTool("search_images", badArgs),
        (err: unknown) => err instanceof InvalidRequestError,
        JSON.stringify(badArgs),
      );
    }
    // Calling close() concurrently and sequentially must resolve cleanly without ERR_INVALID_STATE.
    await Promise.all([toolkit.close(), toolkit.close()]);
    await toolkit.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
