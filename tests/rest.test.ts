import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RestProvider, searchTool, type RestAdapter } from "../src/rest/base.js";
import { BraveAdapter, GrokAdapter, SerperAdapter } from "../src/rest/adapters.js";
import { RotationStore } from "../src/rotation.js";
import type { ProviderConfig } from "../src/types.js";

test("REST direct results expose the same route provenance shape", async () => {
  const directory = mkdtempSync(join(tmpdir(), "search-toolkit-rest-"));
  const rotation = new RotationStore(join(directory, "state.db"));
  const config: ProviderConfig = {
    enabled: true,
    auto: ["search"],
    keys: ["test-key"],
    integration: { kind: "rest", adapter: "brave" },
  };
  const adapter: RestAdapter = {
    tools: () => [searchTool("brave_web_search", "Brave", "Search")],
    call: async () => ({ items: [{ title: "Example", url: "https://example.com", text: "Line one" + String.fromCharCode(10) + "Line two", date: "2026-09-30" }] }),
  };
  try {
    const provider = new RestProvider("brave", config, rotation, adapter);
    const binding = provider.bindings()[0];
    assert.ok(binding);
    const output = await binding.call({ query: "example" }) as Record<string, unknown>;
    const expectedRoute = {
      provider: "brave",
      tool: "brave_web_search",
      upstreamTool: "brave_web_search",
    };
    assert.deepEqual((output.structuredContent as Record<string, unknown>).route, expectedRoute);
    assert.deepEqual(
      ((output._meta as Record<string, unknown>).searchToolkit as Record<string, unknown>).route,
      expectedRoute,
    );
    const content = output.content as Array<{ text: string }>;
    assert.equal(content.length, 2);
    // The model sees provider and exposed tool; the upstream name stays in structured metadata.
    assert.deepEqual(JSON.parse(content[0]?.text ?? "{}").searchToolkitRoute, { provider: "brave", tool: "brave_web_search" });
    // Model-visible text is a compact rendering, not an escaped JSON dump.
    assert.equal(content[1]?.text, ["1. Example (2026-09-30)", "   https://example.com", "   Line one", "   Line two"].join(String.fromCharCode(10)));
  } finally {
    rotation.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Serper enforces the requested result limit when News ignores num", async () => {
  const originalFetch = globalThis.fetch;
  let requestBody: Record<string, unknown> = {};
  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({
      news: Array.from({ length: 8 }, (_, index) => ({
        title: `News ${index + 1}`,
        link: `https://example.com/news-${index + 1}`,
      })),
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const output = await new SerperAdapter().call("serper_news", {
      query: "latest agent news",
      limit: 3,
      tbs: "qdr:w",
    }, "test-key") as { items: Array<Record<string, unknown>> };
    assert.deepEqual(requestBody, { q: "latest agent news", num: 3, tbs: "qdr:w" });
    assert.equal(output.items.length, 3);
    assert.deepEqual(output.items.map((item) => item.title), ["News 1", "News 2", "News 3"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("image adapters preserve image URLs, dimensions, and source pages", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("google.serper.dev/images")) {
      return new Response(JSON.stringify({
        images: [{
          title: "Serper image",
          imageUrl: "https://cdn.example.com/serper.jpg",
          imageWidth: 1600,
          imageHeight: 900,
          thumbnailUrl: "https://cdn.example.com/serper-thumb.jpg",
          thumbnailWidth: 320,
          thumbnailHeight: 180,
          source: "Example Images",
          domain: "example.com",
          link: "https://example.com/serper-source",
          position: 1,
        }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({
      results: [{
        title: "Brave image",
        url: "https://example.com/brave-source",
        description: "An independently indexed image",
        source: "Example Publisher",
        thumbnail: { src: "https://img.search.brave.com/thumb.jpg" },
        properties: { url: "https://cdn.example.com/brave.jpg", width: 2048, height: 1365 },
      }],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const serper = await new SerperAdapter().call("serper_images", { query: "image", limit: 1 }, "key") as { items: Array<Record<string, unknown>> };
    const brave = await new BraveAdapter().call("brave_image_search", { query: "image", limit: 1 }, "key") as { items: Array<Record<string, unknown>> };
    assert.deepEqual(serper.items[0], {
      title: "Serper image", url: "https://example.com/serper-source", text: "Example Images",
      imageUrl: "https://cdn.example.com/serper.jpg", thumbnailUrl: "https://cdn.example.com/serper-thumb.jpg",
      width: 1600, height: 900, thumbnailWidth: 320, thumbnailHeight: 180,
      source: "Example Images", domain: "example.com", position: 1,
    });
    assert.deepEqual(brave.items[0], {
      title: "Brave image", url: "https://example.com/brave-source", text: "An independently indexed image",
      imageUrl: "https://cdn.example.com/brave.jpg", thumbnailUrl: "https://img.search.brave.com/thumb.jpg",
      width: 2048, height: 1365, source: "Example Publisher",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Serper Scholar, Brave extraSnippets, and Grok Web+X pass native provider features", async () => {
  const originalFetch = globalThis.fetch;
  let lastUrl = "";
  let lastBody: Record<string, unknown> = {};
  globalThis.fetch = async (input, init) => {
    lastUrl = String(input);
    lastBody = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    if (lastUrl.includes("google.serper.dev/scholar")) {
      return new Response(JSON.stringify({
        organic: [{
          title: "Attention Is All You Need",
          link: "https://arxiv.org/abs/1706.03762",
          publicationInfo: "A Vaswani - Advances in neural information processing systems, 2017",
          year: 2017,
          citedBy: 120000,
          snippet: "The dominant sequence transduction models are based on complex recurrent or convolutional neural networks.",
        }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({
      web: {
        results: [{
          title: "Brave Result",
          url: "https://example.com/brave",
          description: "Main snippet.",
          extra_snippets: ["Extra snippet one.", "Extra snippet two."],
        }],
      },
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const scholar = await new SerperAdapter().call("serper_scholar", {
      query: "transformer attention",
      limit: 1,
      page: 2,
    }, "key") as { items: Array<Record<string, unknown>> };
    assert.equal(lastUrl, "https://google.serper.dev/scholar");
    assert.equal(lastBody.page, 2);
    assert.equal(scholar.items[0]?.date, "2017");
    assert.match(String(scholar.items[0]?.text), /Cited by 120000/);

    const brave = await new BraveAdapter().call("brave_web_search", {
      query: "extra snippets test",
      extraSnippets: true,
      offset: 1,
    }, "key") as { items: Array<Record<string, unknown>> };
    assert.match(lastUrl, /extra_snippets=true/);
    assert.match(lastUrl, /offset=1/);
    assert.match(String(brave.items[0]?.text), /Main snippet\.\nExtra snippet one\.\nExtra snippet two\./);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Grok adapter targets grok2api Console: default model, filter hints, citations and tool-usage notes", async () => {
  const originalFetch = globalThis.fetch;
  let body: Record<string, unknown> = {};
  let usage: Record<string, unknown> = { server_side_tool_usage_details: { web_search_calls: 2, x_search_calls: 1, x_posts_fetched: 5 } };
  globalThis.fetch = async (_input, init) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({
      id: "resp_1",
      usage,
      output: [{
        type: "message",
        content: [{
          type: "output_text",
          text: "Node 24 is LTS.[[1]](https://www.nodejs.org/en/download)[[2]](https://x.com/nodejs/status/1) Done.",
          annotations: [
            { type: "url_citation", url: "https://www.nodejs.org/en/download", title: "1" },
            { type: "url_citation", url: "https://x.com/nodejs/status/1", title: "2" },
            { type: "url_citation", url: "https://x.com/nodejs/status/1", title: "3" },
          ],
        }],
      }],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  const config = { enabled: true, keys: ["k"], integration: { kind: "rest", adapter: "grok", baseUrl: "https://grok.example/v1/responses" } } as never;
  try {
    const both = await new GrokAdapter().call("grok_web_x_search", {
      query: "node lts",
      allowedDomains: ["nodejs.org"],
      allowedXHandles: ["@nodejs"],
      fromDate: "2026-10-01",
    }, "k", config) as { text: string; citations: Array<{ url: string; title?: string }>; toolUsage: Record<string, number> };
    assert.equal(body.model, "grok-4.20-0309-non-reasoning");
    assert.equal(body.reasoning, undefined);
    assert.match(String((body.input as Array<{ content: string }>)[0]?.content), /Only use web sources from these domains: nodejs\.org\./);
    assert.match(String((body.input as Array<{ content: string }>)[0]?.content), /Only use X posts from these accounts: @nodejs\./);
    assert.deepEqual((body.tools as Array<Record<string, unknown>>).map((tool) => tool.type), ["web_search", "x_search"]);
    assert.equal(both.text, "Node 24 is LTS.[nodejs.org][x.com] Done.\n\n(Grok fast, single model: 2 web searches, 1 X search over 5 posts)");
    assert.match(String(body.instructions), /^You are the search backend for another AI agent\./);
    assert.match(String(body.instructions), /Today's date is \d{4}-\d{2}-\d{2} \(UTC\)\.$/);
    assert.deepEqual(both.citations, [{ url: "https://www.nodejs.org/en/download" }, { url: "https://x.com/nodejs/status/1" }]);
    assert.deepEqual(both.toolUsage, { webSearches: 2, xSearches: 1, xPosts: 5 });

    usage = { server_side_tool_usage_details: { web_search_calls: 0, x_search_calls: 0 } };
    const silent = await new GrokAdapter().call("grok_x_search", { query: "q" }, "k", config) as { text: string };
    assert.match(silent.text, /^\[Grok no X search was run;/);
    assert.deepEqual((body.tools as Array<Record<string, unknown>>).map((tool) => tool.type), ["x_search"]);

    await new GrokAdapter().call("grok_web_x_search", { query: "q", depth: "max" }, "k", config);
    assert.equal(body.model, "grok-4.20-multi-agent-0309");
    assert.deepEqual(body.reasoning, { effort: "high" });
    await new GrokAdapter().call("grok_web_search", { query: "q", depth: "deep" }, "k", config);
    assert.deepEqual(body.reasoning, { effort: "low" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Grok adapter retries once when grok2api reports the key's concurrency limit", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return new Response(JSON.stringify({ code: "concurrency_limit_exceeded", message: "客户端 API Key 已达到并发上限", type: "invalid_request_error" }), { status: 429 });
    }
    return new Response(JSON.stringify({
      usage: { server_side_tool_usage_details: { web_search_calls: 1 } },
      output: [{ type: "message", content: [{ type: "output_text", text: "ok", annotations: [] }] }],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  const config = { enabled: true, keys: ["k"], integration: { kind: "rest", adapter: "grok", baseUrl: "https://grok.example/v1/responses" } } as never;
  try {
    const out = await new GrokAdapter().call("grok_web_search", { query: "q" }, "k", config) as { text: string };
    assert.equal(calls, 2);
    assert.match(out.text, /^ok\n\n\(Grok fast/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
