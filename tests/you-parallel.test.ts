import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ParallelAdapter, YouAdapter } from "../src/rest/adapters.js";
import { SearchToolkit } from "../src/toolkit.js";

test("You.com exposes unified Web/News/Knowledge search and Contents extraction", () => {
  const tools = new YouAdapter().tools();
  assert.deepEqual(tools.map((t) => t.name), ["you_search", "you_contents"]);
  const tool = tools[0];
  assert.equal(tool?.name, "you_search");
  assert.equal(tool?.annotations?.readOnlyHint, true);
  const schema = tool?.inputSchema as { properties?: Record<string, Record<string, unknown>> };
  assert.deepEqual(schema.properties?.contentLevel?.enum, ["snippets", "highlights", "full_page"]);
  assert.equal(schema.properties?.includeDomains?.maxItems, 500);
  assert.equal(schema.properties?.knowledge?.type, "boolean");
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
        web: Array.from({ length: 4 }, (_, index) => ({
          title: `Web ${index + 1}`,
          url: `https://example.com/web-${index + 1}`,
          contents: { highlights: [`Web highlight ${index + 1}`] },
        })),
        news: Array.from({ length: 4 }, (_, index) => ({
          title: `News ${index + 1}`,
          url: `https://example.com/news-${index + 1}`,
          snippets: [`News snippet ${index + 1}`],
        })),
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
      auto: ["search"],
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
    assert.deepEqual((output.items as Array<Record<string, unknown>>).map((item) => item.section), ["web", "news", "web", "news"]);
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
    assert.deepEqual(schema.properties?.mode?.enum, ["turbo", "fast", "basic", "advanced"]);
    assert.equal(schema.properties?.mode?.default, "fast");
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
      auto: ["search"],
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

test("Parallel exposes v1 Extract and Image Search and normalizes their payloads", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requests.push({ url, body });
    if (url.endsWith("/v1/extract")) {
      return new Response(JSON.stringify({
        extract_id: "ext-1",
        session_id: "sess-1",
        results: [{
          url: "https://example.com/guide",
          title: "Parallel Guide",
          publish_date: "2026-10-01",
          excerpts: ["Excerpt one"],
          full_content: "## Getting Started\nFull markdown content.",
        }],
        errors: [],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({
      search_id: "img-1",
      session_id: "sess-1",
      results: [{
        title: "Architecture diagram",
        image_url: "https://cdn.example.com/arch.png",
        source_page_url: "https://example.com/arch",
        width: 1200,
        height: 800,
      }],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const adapter = new ParallelAdapter();
    assert.deepEqual(adapter.tools().map((t) => t.name), ["parallel_search", "parallel_extract", "parallel_image_search"]);
    const config = {
      enabled: true,
      auto: ["search", "images", "fetch"] as Array<"search" | "images" | "fetch">,
      keys: ["test-key"],
      integration: { kind: "rest" as const, adapter: "parallel" as const },
    };
    const extracted = await adapter.call("parallel_extract", {
      url: "https://example.com/guide",
      objective: "Read setup instructions",
      maxCharsPerResult: 8000,
    }, "test-key", config) as { text: string; extractId: string };
    assert.equal(requests[0]?.url, "https://api.parallel.ai/v1/extract");
    assert.deepEqual(requests[0]?.body, {
      urls: ["https://example.com/guide"],
      objective: "Read setup instructions",
      advanced_settings: { full_content: { max_chars_per_result: 8000 } },
    });
    assert.match(extracted.text, /# Parallel Guide/);
    assert.match(extracted.text, /## Getting Started\nFull markdown content\./);

    const images = await adapter.call("parallel_image_search", {
      query: "system architecture diagram",
      limit: 3,
      mode: "advanced",
      location: "US",
    }, "test-key", config) as { items: Array<Record<string, unknown>> };
    assert.equal(requests[1]?.url, "https://api.parallel.ai/v1/images/search");
    assert.deepEqual(requests[1]?.body, {
      objective: "system architecture diagram",
      search_queries: ["system architecture diagram"],
      mode: "advanced",
      advanced_settings: { max_results: 3, location: "us" },
    });
    assert.deepEqual(images.items[0], {
      title: "Architecture diagram",
      url: "https://example.com/arch",
      text: "Architecture diagram",
      imageUrl: "https://cdn.example.com/arch.png",
      width: 1200,
      height: 800,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("You.com supports knowledge cards and Contents API extraction", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requests.push({ url, body });
    if (url.endsWith("/v1/contents")) {
      return new Response(JSON.stringify([{
        url: "https://you.com/docs",
        title: "You Docs",
        markdown: "## Overview\nClean markdown from You.com.",
      }]), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({
      results: {
        knowledge: [{
          type: "answer",
          title: "Bitcoin Price",
          description: "$95,000 USD",
          as_of: "2026-10-18",
          attribution: [{ name: "CoinGecko" }],
        }],
        web: [{ title: "Market News", url: "https://example.com/market", snippets: ["BTC update"] }],
        news: [],
      },
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const adapter = new YouAdapter();
    const config = {
      enabled: true,
      auto: ["search", "fetch"] as Array<"search" | "fetch">,
      keys: ["test-key"],
      integration: { kind: "rest" as const, adapter: "you" as const },
    };
    const searchOut = await adapter.call("you_search", {
      query: "bitcoin price",
      knowledge: true,
      includeDomains: ["example.com"],
      excludeDomains: ["ignored-when-include-present.com"],
    }, "test-key", config) as { items: Array<Record<string, unknown>> };
    assert.equal(requests[0]?.body.knowledge, "core");
    assert.deepEqual(requests[0]?.body.include_domains, ["example.com"]);
    assert.equal(requests[0]?.body.exclude_domains, undefined);
    assert.equal(searchOut.items[0]?.section, "knowledge");
    assert.match(String(searchOut.items[0]?.text), /\$95,000 USD \(Source: CoinGecko\)/);

    const contentsOut = await adapter.call("you_contents", {
      url: "https://you.com/docs",
    }, "test-key", config) as { text: string };
    assert.equal(requests[1]?.url, "https://ydc-index.io/v1/contents");
    assert.match(contentsOut.text, /# You Docs/);
    assert.match(contentsOut.text, /## Overview\nClean markdown from You\.com\./);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
