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
    const output = await adapter.call("parallel_search", {
      query: "Find current official web retrieval API changes",
      searchQueries: ["web retrieval API changes", "official search API changelog"],
      mode: "fast",
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
      mode: "fast",
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
  } finally {
    await toolkit.close();
    globalThis.fetch = originalFetch;
    rmSync(directory, { recursive: true, force: true });
  }
});
