import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
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

test("automatic route profiles keep their measured provider order", () => {
  const request = { query: "route contract", limit: 7 };
  const names = (mode: Parameters<typeof autoCandidates>[0], quality: Parameters<typeof autoCandidates>[1] = "balanced", extra = {}) =>
    autoCandidates(mode, quality, { ...request, ...extra }).map((item) => item.name);
  assert.deepEqual(names("general"), [
    "parallel_search", "serper_search", "exa_web_search_advanced_exa", "you_search", "octen_search", "brave_web_search", "tavily_tavily_search",
  ]);
  // Providers are asked for two extra results; duplicates are dropped before the list is capped.
  assert.deepEqual(autoCandidates("general", "balanced", request)[0]?.nativeArguments, {
    query: "route contract", maxResults: 9, mode: "fast",
  });
  assert.deepEqual(autoCandidates("general", "balanced", request)[2]?.nativeArguments, {
    query: "route contract", numResults: 9, type: "lite",
  });
  assert.deepEqual(names("general", "max"), [
    "exa_web_search_advanced_exa", "parallel_search", "serper_search", "you_search", "octen_search", "brave_web_search", "tavily_tavily_search",
  ]);
  assert.deepEqual(autoCandidates("general", "max", request)[0]?.nativeArguments, {
    query: "route contract", numResults: 9, type: "auto", enableHighlights: true,
  });
  assert.equal(autoCandidates("general", "max", request)[1]?.nativeArguments?.mode, "advanced");
  assert.equal(autoCandidates("general", "max", request)[3]?.nativeArguments?.contentLevel, "highlights");
  assert.deepEqual(names("exact"), ["parallel_search", "brave_web_search", "serper_search", "you_search", "tavily_tavily_search"]);
  assert.deepEqual(autoCandidates("exact", "max", request)[4]?.nativeArguments, {
    query: "route contract", max_results: 9, search_depth: "advanced", exact_match: true,
  });
  assert.deepEqual(names("official"), ["exa_web_search_advanced_exa", "brave_web_search", "serper_search", "you_search"]);
  assert.equal(autoCandidates("official", "balanced", request)[0]?.nativeArguments?.type, "lite");
  assert.equal(autoCandidates("official", "max", request)[0]?.nativeArguments?.type, "auto");
  assert.equal(autoCandidates("official", "max", request)[1]?.nativeArguments?.extraSnippets, true);
  assert.deepEqual(names("context"), ["brave_llm_context", "parallel_search", "you_search", "tavily_tavily_search"]);
  assert.deepEqual(autoCandidates("context", "balanced", request)[0]?.nativeArguments, {
    query: "route contract", count: 20, maximumNumberOfTokens: 4096,
  });
  assert.equal(autoCandidates("context", "max", request)[0]?.nativeArguments?.mode, "advanced");
  assert.deepEqual(names("current"), ["you_search", "exa_web_search_advanced_exa", "octen_search", "serper_news", "brave_news_search", "tavily_tavily_search"]);
  const weekAgo = new Date(Date.now() - 604_800_000).toISOString().slice(0, 10);
  assert.deepEqual(autoCandidates("current", "balanced", request).map((item) => item.nativeArguments), [
    { query: "route contract", limit: 9, contentLevel: "snippets", freshness: "week" },
    { query: "route contract", numResults: 9, type: "lite", category: "news", startPublishedDate: weekAgo },
    { query: "route contract", limit: 9, freshness: "week" },
    { query: "route contract", limit: 9, tbs: "qdr:w" },
    { query: "route contract", limit: 9, freshness: "pw" },
    { query: "route contract", max_results: 9, search_depth: "basic", topic: "news", time_range: "week" },
  ]);
  assert.equal(autoCandidates("current", "max", { ...request, freshness: "month" })[5]?.nativeArguments?.time_range, "month");
  assert.deepEqual(names("scholar"), ["exa_web_search_advanced_exa", "parallel_search", "you_search", "serper_scholar"]);
  assert.equal(autoCandidates("scholar", "balanced", request)[0]?.nativeArguments?.type, "lite");
  assert.match(String(autoCandidates("scholar", "max", request)[0]?.nativeArguments?.objective), /Research papers.*route contract/);
  assert.deepEqual(names("code"), ["exa_web_search_advanced_exa", "parallel_search", "serper_search", "exa_web_search_advanced_exa"]);
  assert.equal(autoCandidates("code", "balanced", request)[0]?.nativeArguments?.category, "github");
  assert.equal(autoCandidates("code", "balanced", request)[0]?.nativeArguments?.type, "lite");
  assert.equal(autoCandidates("code", "max", request)[0]?.nativeArguments?.type, undefined);
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
  assert.equal(isChineseQuery("node 中"), false, "one character is not enough");
  const general = autoCandidates("general", "balanced", { query: "深圳地铁16号线", limit: 6 });
  assert.deepEqual(general.map((item) => item.name), [
    "brave_web_search", "serper_search", "you_search", "parallel_search", "tavily_tavily_search",
  ]);
  assert.deepEqual(general[0]?.nativeArguments, { query: "深圳地铁16号线", limit: 8, searchLang: "zh-hans", country: "CN" });
  assert.deepEqual(general[1]?.nativeArguments, { query: "深圳地铁16号线", limit: 8, gl: "cn", hl: "zh-cn" });
  assert.deepEqual(autoCandidates("exact", "balanced", { query: "报错 内存不足" }).map((item) => item.name), [
    "brave_web_search", "serper_search", "you_search", "parallel_search",
  ]);
  assert.deepEqual(autoCandidates("official", "balanced", { query: "微信小程序 开发文档" }).map((item) => item.name), [
    "exa_web_search_advanced_exa", "serper_search", "parallel_search", "brave_web_search",
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
  assert.deepEqual(autoCandidates("current", "balanced", { query: "台风 预警" })[1]?.nativeArguments, {
    query: "台风 预警", limit: 8, language: "zh-hans", country: "CN", contentLevel: "snippets", freshness: "week",
  });
});

test("autoCandidates translates domain filters, freshness, and maxCharsPerResult across providers", () => {
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
    maxAgeSeconds: 2592000,
    maxCharsPerResult: 900,
    includeDomains: ["modelcontextprotocol.io", "github.com"],
    excludeDomains: ["reddit.com"],
  });
  // Exa Lite takes native domain and publish-date filters, but not contextMaxCharacters.
  assert.deepEqual(byName.get("exa_web_search_advanced_exa"), {
    query: "mcp transport",
    numResults: 7,
    type: "lite",
    includeDomains: ["modelcontextprotocol.io", "github.com"],
    excludeDomains: ["reddit.com"],
    startPublishedDate: new Date(Date.now() - 2_592_000_000).toISOString().slice(0, 10),
  });
  assert.deepEqual(byName.get("brave_web_search"), {
    query: "mcp transport (site:modelcontextprotocol.io OR site:github.com) -site:reddit.com",
    limit: 7,
    freshness: "pm",
  });
  assert.deepEqual(byName.get("serper_search"), {
    query: "mcp transport (site:modelcontextprotocol.io OR site:github.com) -site:reddit.com",
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
