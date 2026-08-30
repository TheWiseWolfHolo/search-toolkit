import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
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
    automatic: true,
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

test("automatic route profiles keep their intentional provider order", () => {
  const request = { query: "route contract", limit: 7 };
  assert.deepEqual(autoCandidates("general", "balanced", request).map((item) => item.name), [
    "parallel_search", "you_search", "brave_web_search", "exa_web_search_exa", "querit_search", "tavily_tavily_search",
  ]);
  assert.deepEqual(autoCandidates("general", "balanced", request)[0]?.nativeArguments, {
    query: "route contract", maxResults: 7, mode: "fast",
  });
  assert.equal(autoCandidates("general", "max", request)[0]?.nativeArguments?.mode, "advanced");
  assert.equal(autoCandidates("general", "max", request)[1]?.nativeArguments?.contentLevel, "highlights");
  assert.equal(autoCandidates("general", "max", request)[5]?.nativeArguments?.search_depth, "advanced");
  assert.equal(autoCandidates("exact", "balanced", request)[0]?.name, "exa_web_search_exa");
  assert.equal(autoCandidates("exact", "max", request)[0]?.name, "exa_web_search_advanced_exa");
  assert.deepEqual(autoCandidates("exact", "max", request)[2]?.nativeArguments, {
    query: "route contract", max_results: 7, search_depth: "advanced", exact_match: true,
  });
  assert.deepEqual(autoCandidates("context", "balanced", request).map((item) => item.name), [
    "brave_llm_context", "parallel_search", "you_search", "tavily_tavily_search",
  ]);
  assert.deepEqual(autoCandidates("context", "balanced", request)[0]?.nativeArguments, {
    query: "route contract", count: 20, maximumNumberOfTokens: 4096,
  });
  assert.equal(autoCandidates("context", "balanced", request)[1]?.nativeArguments?.mode, "basic");
  assert.equal(autoCandidates("context", "max", request)[0]?.nativeArguments?.mode, "advanced");
  assert.equal(autoCandidates("context", "max", request)[3]?.nativeArguments?.search_depth, "advanced");
  assert.deepEqual(autoCandidates("current", "balanced", request).map((item) => item.name), [
    "brave_news_search", "serper_news", "you_search", "tavily_tavily_search",
  ]);
  assert.deepEqual(autoCandidates("current", "balanced", request).map((item) => item.nativeArguments), [
    { query: "route contract", limit: 7, freshness: "pw" },
    { query: "route contract", limit: 7, tbs: "qdr:w" },
    { query: "route contract", limit: 7, contentLevel: "snippets", freshness: "week" },
    { query: "route contract", max_results: 7, search_depth: "basic", time_range: "week" },
  ]);
  assert.deepEqual(autoCandidates("current", "max", { ...request, freshness: "month" })[3]?.nativeArguments, {
    query: "route contract",
    max_results: 7,
    search_depth: "advanced",
    time_range: "month",
  });
  assert.equal(autoCandidates("official", "balanced", request)[0]?.name, "serper_search");
  assert.equal(autoCandidates("official", "max", request)[2]?.name, "exa_web_search_advanced_exa");
  assert.deepEqual(imageCandidates({ query: "route contract", limit: 9 }).map((item) => item.name), [
    "brave_image_search", "serper_images",
  ]);
  assert.deepEqual(imageCandidates({ query: "route contract", limit: 9 })[0]?.nativeArguments, {
    query: "route contract", limit: 9, country: "ALL", safesearch: "strict",
  });
  assert.deepEqual(imageCandidates({ query: "route contract", country: "SG" }), imageCandidates({ query: "route contract" }));
});
