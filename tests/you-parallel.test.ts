import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ParallelAdapter, YouAdapter } from "../src/rest/adapters.js";
import { SearchToolkit } from "../src/toolkit.js";

test("You.com exposes unified Web/News search with opt-in highlights", () => {
  const tool = new YouAdapter().tools()[0];
  assert.equal(tool?.name, "you_search");
  assert.equal(tool?.annotations?.readOnlyHint, true);
  const schema = tool?.inputSchema as { properties?: Record<string, Record<string, unknown>> };
  assert.deepEqual(schema.properties?.contentLevel?.enum, ["snippets", "highlights"]);
  assert.equal(schema.properties?.includeDomains?.maxItems, 500);
});

test("You.com uses the current POST Search contract and normalizes Web plus News", async () => {
  const originalFetch = globalThis.fetch;
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;
  globalThis.fetch = async (input, init) => {
    capturedUrl = String(input);
    capturedInit = init;
    return new Response(JSON.stringify({
      results: {
        web: [{ title: "Web", url: "https://example.com/web", contents: { highlights: ["Web highlight"] } }],
        news: [{ title: "News", url: "https://example.com/news", snippets: ["News snippet"] }],
      },
      metadata: { search_uuid: "search-id" },
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const output = await new YouAdapter().call("you_search", {
      query: "latest retrieval APIs",
      limit: 4,
      freshness: "week",
      offset: 1,
      country: "SG",
      language: "EN",
      safesearch: "strict",
      includeDomains: ["example.com"],
      contentLevel: "highlights",
    }, "test-key", {
      enabled: true,
      automatic: true,
      keys: ["test-key"],
      integration: { kind: "rest", adapter: "you" },
    }) as Record<string, unknown>;
    assert.equal(capturedUrl, "https://ydc-index.io/v1/search");
    assert.equal(capturedInit?.method, "POST");
    assert.equal(new Headers(capturedInit?.headers).get("X-API-Key"), "test-key");
    assert.deepEqual(JSON.parse(String(capturedInit?.body)), {
      query: "latest retrieval APIs",
      count: 4,
      freshness: "week",
      offset: 1,
      country: "SG",
      language: "EN",
      safesearch: "strict",
      include_domains: ["example.com"],
      extraction: { extraction_mode: "highlights", highlights: {} },
    });
    assert.deepEqual((output.items as Array<Record<string, unknown>>).map((item) => item.section), ["web", "news"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Parallel uses the v1 semantic Search contract and advanced settings", async () => {
  const originalFetch = globalThis.fetch;
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;
  globalThis.fetch = async (input, init) => {
    capturedUrl = String(input);
    capturedInit = init;
    return new Response(JSON.stringify({
      search_id: "search-id",
      session_id: "session-id",
      results: [{ title: "Result", url: "https://example.com", excerpts: ["Dense excerpt"] }],
      usage: [{ name: "search", count: 1 }],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const adapter = new ParallelAdapter();
    const tool = adapter.tools()[0];
    assert.equal(tool?.name, "parallel_search");
    assert.equal(tool?.annotations?.readOnlyHint, true);
    const schema = tool?.inputSchema as { properties?: Record<string, Record<string, unknown>> };
    assert.equal(schema.properties?.mode?.default, "basic");
    const output = await adapter.call("parallel_search", {
      query: "Find current official web retrieval API changes",
      searchQueries: ["web retrieval API changes", "official search API changelog"],
      mode: "turbo",
      maxCharsTotal: 12000,
      maxResults: 5,
      maxCharsPerResult: 2000,
      includeDomains: ["example.com"],
      maxAgeSeconds: 3600,
      location: "SG",
      sessionId: "session-input",
      clientModel: "gpt-5.6",
    }, "test-key", {
      enabled: true,
      automatic: true,
      keys: ["test-key"],
      integration: { kind: "rest", adapter: "parallel" },
    }) as Record<string, unknown>;
    assert.equal(capturedUrl, "https://api.parallel.ai/v1/search");
    assert.equal(capturedInit?.method, "POST");
    assert.equal(new Headers(capturedInit?.headers).get("x-api-key"), "test-key");
    assert.deepEqual(JSON.parse(String(capturedInit?.body)), {
      objective: "Find current official web retrieval API changes",
      search_queries: ["web retrieval API changes", "official search API changelog"],
      mode: "turbo",
      max_chars_total: 12000,
      session_id: "session-input",
      client_model: "gpt-5.6",
      advanced_settings: {
        source_policy: { include_domains: ["example.com"] },
        fetch_policy: { max_age_seconds: 3600 },
        excerpt_settings: { max_chars_per_result: 2000 },
        max_results: 5,
        location: "sg",
      },
    });
    assert.equal((output.items as Array<Record<string, unknown>>)[0]?.text, "Dense excerpt");
    assert.equal(output.searchId, "search-id");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("search_auto context mode falls back to Parallel when Brave is unavailable", async () => {
  const directory = mkdtempSync(join(tmpdir(), "search-toolkit-parallel-auto-"));
  const configPath = join(directory, "providers.json");
  writeFileSync(configPath, JSON.stringify({
    version: 1,
    statePath: join(directory, "state.db"),
    providers: {
      parallel: {
        enabled: true,
        automatic: true,
        keys: ["test-key"],
        integration: { kind: "rest", adapter: "parallel" },
      },
    },
  }));
  const originalFetch = globalThis.fetch;
  let requestBody: Record<string, unknown> = {};
  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({
      search_id: "search-id",
      session_id: "session-id",
      results: [],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  const toolkit = new SearchToolkit(configPath);
  try {
    await toolkit.initialize();
    const output = await toolkit.callTool("search_auto", {
      query: "ground this answer",
      mode: "context",
      limit: 4,
    }) as Record<string, unknown>;
    assert.deepEqual((output.structuredContent as Record<string, unknown>).route, {
      provider: "parallel",
      tool: "parallel_search",
      upstreamTool: "parallel_search",
    });
    assert.equal((requestBody.advanced_settings as Record<string, unknown>).max_results, 4);
    assert.equal(requestBody.mode, "basic");
  } finally {
    await toolkit.close();
    globalThis.fetch = originalFetch;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("search_auto honors automatic and manualOnly provider policy", async () => {
  const directory = mkdtempSync(join(tmpdir(), "search-toolkit-auto-policy-"));
  const configPath = join(directory, "providers.json");
  writeFileSync(configPath, JSON.stringify({
    version: 1,
    statePath: join(directory, "state.db"),
    providers: {
      brave: {
        enabled: true,
        automatic: false,
        keys: ["test-key"],
        integration: { kind: "rest", adapter: "brave" },
      },
      parallel: {
        enabled: true,
        automatic: true,
        manualOnly: true,
        keys: ["test-key"],
        integration: { kind: "rest", adapter: "parallel" },
      },
      you: {
        enabled: true,
        automatic: true,
        keys: ["test-key"],
        integration: { kind: "rest", adapter: "you" },
      },
    },
  }));
  const originalFetch = globalThis.fetch;
  let requestBody: Record<string, unknown> = {};
  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ results: { web: [], news: [] } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  const toolkit = new SearchToolkit(configPath);
  try {
    await toolkit.initialize();
    const output = await toolkit.callTool("search_auto", {
      query: "respect automatic policy",
      mode: "context",
      limit: 2,
    }) as Record<string, unknown>;
    assert.deepEqual((output.structuredContent as Record<string, unknown>).route, {
      provider: "you",
      tool: "you_search",
      upstreamTool: "you_search",
    });
    assert.deepEqual(requestBody.extraction, { extraction_mode: "highlights", highlights: {} });
  } finally {
    await toolkit.close();
    globalThis.fetch = originalFetch;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("search_auto max quality uses Parallel Advanced and reports the auto route", async () => {
  const directory = mkdtempSync(join(tmpdir(), "search-toolkit-parallel-quality-"));
  const configPath = join(directory, "providers.json");
  writeFileSync(configPath, JSON.stringify({
    version: 1,
    statePath: join(directory, "state.db"),
    providers: {
      parallel: {
        enabled: true,
        automatic: true,
        keys: ["test-key"],
        integration: { kind: "rest", adapter: "parallel" },
      },
    },
  }));
  const originalFetch = globalThis.fetch;
  let requestBody: Record<string, unknown> = {};
  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ search_id: "search-id", results: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  const toolkit = new SearchToolkit(configPath);
  try {
    await toolkit.initialize();
    const output = await toolkit.callTool("search_auto", {
      query: "compare several retrieval architectures",
      mode: "general",
      quality: "max",
      limit: 5,
    }) as Record<string, unknown>;
    assert.equal(requestBody.mode, "advanced");
    assert.equal((requestBody.advanced_settings as Record<string, unknown>).max_results, 5);
    assert.deepEqual((output.structuredContent as Record<string, unknown>).searchAuto, {
      mode: "general",
      quality: "max",
      candidateRank: 1,
      providerAttempt: 1,
      attempts: [{
        provider: "parallel",
        tool: "parallel_search",
        candidateRank: 1,
        outcome: "success",
      }],
    });
  } finally {
    await toolkit.close();
    globalThis.fetch = originalFetch;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("search_auto tries one compatible retrieval provider after an availability failure", async () => {
  const directory = mkdtempSync(join(tmpdir(), "search-toolkit-provider-failover-"));
  const configPath = join(directory, "providers.json");
  writeFileSync(configPath, JSON.stringify({
    version: 1,
    statePath: join(directory, "state.db"),
    providers: {
      parallel: {
        enabled: true,
        automatic: true,
        keys: ["parallel-key"],
        integration: { kind: "rest", adapter: "parallel" },
      },
      you: {
        enabled: true,
        automatic: true,
        keys: ["you-key"],
        integration: { kind: "rest", adapter: "you" },
      },
    },
  }));
  const originalFetch = globalThis.fetch;
  const urls: string[] = [];
  let youBody: Record<string, unknown> = {};
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    urls.push(url);
    if (url.includes("parallel.ai")) return new Response("temporary", { status: 503 });
    youBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ results: { web: [], news: [] } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  const toolkit = new SearchToolkit(configPath);
  try {
    await toolkit.initialize();
    const output = await toolkit.callTool("search_auto", {
      query: "current retrieval platforms",
      mode: "general",
      limit: 4,
    }) as Record<string, unknown>;
    assert.deepEqual(urls, ["https://api.parallel.ai/v1/search", "https://ydc-index.io/v1/search"]);
    assert.equal(youBody.count, 4);
    assert.equal(youBody.extraction, undefined);
    assert.deepEqual((output.structuredContent as Record<string, unknown>).route, {
      provider: "you",
      tool: "you_search",
      upstreamTool: "you_search",
    });
    const auto = (output.structuredContent as Record<string, unknown>).searchAuto as Record<string, unknown>;
    assert.equal(auto.providerAttempt, 2);
    assert.deepEqual(auto.attempts, [
      { provider: "parallel", tool: "parallel_search", candidateRank: 1, outcome: "error", status: 503 },
      { provider: "you", tool: "you_search", candidateRank: 2, outcome: "success" },
    ]);

    urls.length = 0;
    globalThis.fetch = async (input) => {
      urls.push(String(input));
      return new Response("temporary", { status: 503 });
    };
    await assert.rejects(toolkit.callTool("search_auto", {
      query: "both providers unavailable",
      mode: "general",
    }), /parallel\/parallel_search\[503\] -> you\/you_search\[503\]/);
    assert.deepEqual(urls, ["https://api.parallel.ai/v1/search", "https://ydc-index.io/v1/search"]);
  } finally {
    await toolkit.close();
    globalThis.fetch = originalFetch;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("search_auto does not fail over on request-shape errors", async () => {
  const directory = mkdtempSync(join(tmpdir(), "search-toolkit-provider-terminal-"));
  const configPath = join(directory, "providers.json");
  writeFileSync(configPath, JSON.stringify({
    version: 1,
    statePath: join(directory, "state.db"),
    providers: {
      parallel: {
        enabled: true,
        automatic: true,
        keys: ["parallel-key"],
        integration: { kind: "rest", adapter: "parallel" },
      },
      you: {
        enabled: true,
        automatic: true,
        keys: ["you-key"],
        integration: { kind: "rest", adapter: "you" },
      },
    },
  }));
  const originalFetch = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = async (input) => {
    urls.push(String(input));
    return new Response("invalid request", { status: 422 });
  };
  const toolkit = new SearchToolkit(configPath);
  try {
    await toolkit.initialize();
    await assert.rejects(toolkit.callTool("search_auto", {
      query: "invalid provider request",
      mode: "general",
    }), /parallel\/parallel_search\[422\].*HTTP 422/);
    assert.deepEqual(urls, ["https://api.parallel.ai/v1/search"]);
  } finally {
    await toolkit.close();
    globalThis.fetch = originalFetch;
    rmSync(directory, { recursive: true, force: true });
  }
});
