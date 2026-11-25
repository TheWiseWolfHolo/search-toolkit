import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HttpError } from "../src/errors.js";
import { BraveAdapter } from "../src/rest/adapters.js";
import { RestProvider } from "../src/rest/base.js";
import { cleanHighlightText } from "../src/rest/normalize.js";
import { RotationStore } from "../src/rotation.js";
import { SearchToolkit } from "../src/toolkit.js";

test("Brave exposes Web, News, Images, and LLM Context as distinct tools", () => {
  const tools = new BraveAdapter().tools();
  assert.deepEqual(tools.map((tool) => tool.name), [
    "brave_web_search",
    "brave_news_search",
    "brave_image_search",
    "brave_llm_context",
  ]);
  const context = tools[3];
  assert.ok(context);
  const schema = context.inputSchema as { properties?: Record<string, Record<string, unknown>> };
  assert.equal(schema.properties?.maximumNumberOfTokens?.minimum, 1024);
  assert.equal(schema.properties?.maximumNumberOfTokens?.maximum, 32768);
  assert.equal(schema.properties?.maximumNumberOfTokens?.default, 8192);
  assert.equal(schema.properties?.query?.maxLength, 600);
  assert.deepEqual(schema.properties?.contextThresholdMode?.enum, ["disabled", "strict", "balanced", "lenient"]);
  assert.equal(context.annotations?.readOnlyHint, true);
});

test("Brave LLM Context uses the official POST contract", async () => {
  const originalFetch = globalThis.fetch;
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;
  globalThis.fetch = async (input, init) => {
    capturedUrl = String(input);
    capturedInit = init;
    return new Response(JSON.stringify({
      grounding: {
        generic: [{
          url: "https://example.com/docs",
          title: "Example",
          snippets: ["Relevant context"],
        }],
        map: [],
      },
      sources: {
        "https://example.com/docs": { title: "Example", hostname: "example.com", age: [] },
      },
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const output = await new BraveAdapter().call("brave_llm_context", {
      query: "How should agents ground technical answers?",
      country: "US",
      searchLang: "en",
      count: 12,
      maximumNumberOfUrls: 6,
      maximumNumberOfSnippets: 24,
      contextThresholdMode: "strict",
      maximumNumberOfTokensPerUrl: 1024,
      maximumNumberOfSnippetsPerUrl: 8,
      goggles: ["https://example.com/goggle"],
      freshness: "pw",
      safesearch: "moderate",
      spellcheck: false,
      enableLocal: false,
      enableSourceMetadata: true,
      locationCity: "Singapore",
      locationCountry: "SG",
    }, "test-key") as Record<string, unknown>;

    assert.equal(capturedUrl, "https://api.search.brave.com/res/v1/llm/context");
    assert.equal(capturedInit?.method, "POST");
    const headers = new Headers(capturedInit?.headers);
    assert.equal(headers.get("X-Subscription-Token"), "test-key");
    assert.equal(headers.get("X-Loc-City"), "Singapore");
    assert.equal(headers.get("X-Loc-Country"), "SG");
    assert.deepEqual(JSON.parse(String(capturedInit?.body)), {
      q: "How should agents ground technical answers?",
      country: "US",
      search_lang: "en",
      count: 12,
      maximum_number_of_urls: 6,
      maximum_number_of_tokens: 8192,
      maximum_number_of_snippets: 24,
      context_threshold_mode: "strict",
      maximum_number_of_tokens_per_url: 1024,
      maximum_number_of_snippets_per_url: 8,
      goggles: ["https://example.com/goggle"],
      freshness: "pw",
      safesearch: "moderate",
      spellcheck: false,
      enable_local: false,
      enable_source_metadata: true,
    });
    assert.equal(((output.grounding as Record<string, unknown>).generic as unknown[]).length, 1);
    assert.ok(output.sources);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("search_auto context mode routes to Brave LLM Context", async () => {
  const directory = mkdtempSync(join(tmpdir(), "search-toolkit-brave-auto-"));
  const configPath = join(directory, "providers.json");
  writeFileSync(configPath, JSON.stringify({
    version: 1,
    statePath: join(directory, "state.db"),
    providers: {
      brave: {
        enabled: true,
        automatic: true,
        keys: ["test-key"],
        integration: { kind: "rest", adapter: "brave" },
      },
    },
  }));
  const originalFetch = globalThis.fetch;
  let requestBody: Record<string, unknown> = {};
  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ grounding: { generic: [], map: [] }, sources: {} }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  const toolkit = new SearchToolkit(configPath);
  try {
    await toolkit.initialize();
    const auto = toolkit.listTools().find((tool) => tool.name === "search_auto");
    const mode = (auto?.inputSchema as { properties?: Record<string, { enum?: string[] }> }).properties?.mode;
    assert.ok(mode?.enum?.includes("context"));
    const tokenBudget = (auto?.inputSchema as { properties?: Record<string, Record<string, unknown>> }).properties?.maximumNumberOfTokens;
    assert.equal(tokenBudget?.default, 4096);
    const output = await toolkit.callTool("search_auto", {
      query: "ground this answer",
      mode: "context",
      limit: 4,
    }) as Record<string, unknown>;
    assert.equal(requestBody.q, "ground this answer");
    assert.equal(requestBody.count, 20);
    assert.equal(requestBody.maximum_number_of_tokens, 4096);
    assert.deepEqual((output.structuredContent as Record<string, unknown>).route, {
      provider: "brave",
      tool: "brave_llm_context",
      upstreamTool: "brave_llm_context",
    });
  } finally {
    await toolkit.close();
    globalThis.fetch = originalFetch;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Brave malformed numeric HTML entities do not throw RangeError and web search uppercases country and slices to limit", async () => {
  assert.doesNotThrow(() => cleanHighlightText("Bad &#9999999; &#x110000; &#xD800; and good &#65; &#x42;"));
  assert.equal(cleanHighlightText("Good &#65;&#x42; and bad &#9999999;"), "Good AB and bad &#9999999;");

  const originalFetch = globalThis.fetch;
  let capturedUrl = "";
  globalThis.fetch = async (input) => {
    capturedUrl = String(input);
    return new Response(JSON.stringify({
      web: {
        results: [
          { title: "One &#9999999;", url: "https://a.example/1", description: "Entity &#x110000; ok" },
          { title: "Two", url: "https://a.example/2", description: "second" },
          { title: "Three", url: "https://a.example/3", description: "third" },
        ],
      },
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const out = await new BraveAdapter().call("brave_web_search", {
      query: "entities",
      country: "sg",
      limit: 2,
    }, "test-key") as { items: Array<{ title: string; text: string }> };
    assert.match(capturedUrl, /country=SG/);
    assert.equal(out.items.length, 2);
    assert.equal(out.items[0]?.title, "One &#9999999;");
    assert.equal(out.items[0]?.text, "Entity &#x110000; ok");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Brave captures passive monthly X-RateLimit-Remaining quota via RestProvider and rejects missing LLM Context grounding with 502", async () => {
  const originalFetch = globalThis.fetch;
  const dir = mkdtempSync(join(tmpdir(), "search-toolkit-brave-quota-"));
  const rotation = new RotationStore(join(dir, "state.db"));
  const config = {
    enabled: true,
    auto: ["search"] as Array<"search">,
    keys: ["brave-key-123456"],
    integration: { kind: "rest" as const, adapter: "brave" as const },
  };
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("/llm/context")) {
      return new Response(JSON.stringify({ sources: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({
      web: { results: [{ title: "Hit", url: "https://hit.example/", description: "ok" }] },
    }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "X-RateLimit-Remaining": "1, 1450",
        "X-RateLimit-Limit": "1, 2000",
      },
    });
  };
  try {
    const provider = new RestProvider("brave", config, rotation, new BraveAdapter());
    const web = provider.bindings().find((b) => b.upstreamName === "brave_web_search");
    const llm = provider.bindings().find((b) => b.upstreamName === "brave_llm_context");
    assert.ok(web && llm);
    await web.call({ query: "quota test" });
    const status = rotation.status("brave", config.keys).keys[0]?.status;
    assert.equal(status?.quota_remaining, 1450);
    assert.equal(status?.quota_unit, "credits");

    await assert.rejects(
      llm.call({ query: "missing grounding" }),
      (err: unknown) => err instanceof HttpError && err.status === 502 && /no grounding payload/.test(err.message),
    );
  } finally {
    globalThis.fetch = originalFetch;
    rotation.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
