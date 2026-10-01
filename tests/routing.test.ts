import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { fetchCandidates, SearchToolkit } from "../src/toolkit.js";

const fakeServer = fileURLToPath(new URL("./fixtures/fake-mcp.js", import.meta.url));

type Json = Record<string, unknown>;

function upstream(tool: string, reply: string, auto: string[] = ["fetch"], env: Record<string, string> = {}): Json {
  return {
    enabled: true,
    auto,
    keys: ["good-1"],
    integration: {
      kind: "stdio_mcp", command: process.execPath, args: [fakeServer], envKey: "FAKE_KEY",
      env: { FAKE_TOOLS: JSON.stringify([tool]), FAKE_REPLY: reply, ...env },
    },
  };
}

async function withToolkit(
  providers: Json,
  run: (toolkit: SearchToolkit) => Promise<void>,
  extra: Json = {},
  options: ConstructorParameters<typeof SearchToolkit>[1] = {},
) {
  const directory = mkdtempSync(join(tmpdir(), "search-toolkit-routing-"));
  const configPath = join(directory, "providers.json");
  writeFileSync(configPath, JSON.stringify({ version: 2, statePath: join(directory, "state.db"), ...extra, providers }));
  const toolkit = new SearchToolkit(configPath, options);
  try {
    await toolkit.initialize();
    await run(toolkit);
  } finally {
    await toolkit.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

function text(output: unknown): string {
  return (output as { content: Array<{ text: string }> }).content.map((block) => block.text).join("\n");
}

function route(output: unknown): Json {
  return JSON.parse((output as { content: Array<{ text: string }> }).content[0]?.text ?? "{}") as Json;
}

const LONG = "readable page content. ".repeat(40);

test("fetch_auto uses the first reader that returns real content and skips the rest", async () => {
  await withToolkit({
    exa: upstream("web_fetch_exa", LONG),
    tavily: upstream("tavily_extract", "never reached"),
  }, async (toolkit) => {
    const output = await toolkit.callTool("fetch_auto", { url: "https://example.com/page" });
    assert.equal((route(output).searchToolkitRoute as Json).tool, "exa_web_fetch_exa");
    assert.match(text(output), /readable page content/);
    assert.deepEqual((route(output).searchToolkitAuto as Json).attempts, [
      { provider: "exa", tool: "exa_web_fetch_exa", candidateRank: 1, outcome: "success" },
    ]);
  });
});

test("fetch_auto falls through a reader that answers with almost nothing", async () => {
  await withToolkit({
    exa: upstream("web_fetch_exa", "tiny"),
    tavily: upstream("tavily_extract", LONG),
  }, async (toolkit) => {
    const output = await toolkit.callTool("fetch_auto", { url: "https://example.com/page" });
    const auto = route(output).searchToolkitAuto as { attempts: Array<Json> };
    assert.equal((route(output).searchToolkitRoute as Json).provider, "tavily");
    assert.deepEqual(auto.attempts.map((attempt) => attempt.outcome), ["empty", "success"]);
  });
});

test("fetch_auto returns the fullest thin answer rather than failing when nothing is substantial", async () => {
  await withToolkit({
    exa: upstream("web_fetch_exa", "ab"),
    tavily: upstream("tavily_extract", "a bit more text"),
  }, async (toolkit) => {
    const output = await toolkit.callTool("fetch_auto", { url: "https://example.com/page" });
    assert.match(text(output), /a bit more text/);
    assert.equal((route(output).searchToolkitRoute as Json).provider, "tavily");
  });
});

test("fetch_auto truncates long pages and says so", async () => {
  await withToolkit({ exa: upstream("web_fetch_exa", "x".repeat(2_000)) }, async (toolkit) => {
    const output = await toolkit.callTool("fetch_auto", { url: "https://example.com/page", maxChars: 500 });
    assert.match(text(output), /truncated: 1500 more characters/);
  });
});

test("fetch_auto rejects non-http URLs and respects provider eligibility", async () => {
  await withToolkit({ exa: upstream("web_fetch_exa", LONG, []) }, async (toolkit) => {
    await assert.rejects(toolkit.callTool("fetch_auto", { url: "file:///etc/passwd" }), /http\(s\)/);
    await assert.rejects(toolkit.callTool("fetch_auto", { url: "https://example.com" }), /No automatic fetch provider/);
  });
});

test("max quality leads the fetch chain with Firecrawl", () => {
  assert.equal(fetchCandidates("balanced", { url: "https://e.com" })[0]?.name, "exa_web_fetch_exa");
  const max = fetchCandidates("max", { url: "https://e.com" });
  assert.equal(max[0]?.name, "firecrawl_firecrawl_scrape");
  assert.equal(max.find((item) => item.name === "tavily_tavily_extract")?.nativeArguments?.extract_depth, "advanced");
});

test("a tool-level error is handed back to a direct caller as the upstream's own result", async () => {
  await withToolkit({ exa: upstream("tool_error", "unused") }, async (toolkit) => {
    const output = await toolkit.callTool("exa_tool_error", {}) as { isError?: boolean };
    assert.equal(output.isError, true);
    assert.match(text(output), /Status code: 403/);
  });
});

test("fetch_auto stops at a request-level tool error but fails over on an availability error", async () => {
  await withToolkit({
    exa: upstream("web_fetch_exa", "unused", ["fetch"], { FAKE_ERROR: "Failed to scrape URL. Status code: 403 Forbidden" }),
    tavily: upstream("tavily_extract", LONG),
  }, async (toolkit) => {
    await assert.rejects(
      toolkit.callTool("fetch_auto", { url: "https://example.com/page" }),
      /fetch_auto failed after exa\/exa_web_fetch_exa\[error\]: .*Status code: 403/,
    );
  });
  await withToolkit({
    exa: upstream("web_fetch_exa", "unused", ["fetch"], { FAKE_ERROR: "Service temporarily unavailable" }),
    tavily: upstream("tavily_extract", LONG),
  }, async (toolkit) => {
    const output = await toolkit.callTool("fetch_auto", { url: "https://example.com/page" });
    assert.equal((route(output).searchToolkitRoute as Json).provider, "tavily");
    const auto = route(output).searchToolkitAuto as { attempts: Json[] };
    assert.deepEqual(auto.attempts.map((attempt) => attempt.outcome), ["error", "success"]);
  });
});

function stubSearchFetch(handlers: Record<string, unknown>) {
  const original = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    const hit = Object.entries(handlers).find(([fragment]) => url.includes(fragment));
    return hit
      ? new Response(JSON.stringify(hit[1]), { status: 200, headers: { "Content-Type": "application/json" } })
      : new Response("{}", { status: 404 });
  };
  return () => { globalThis.fetch = original; };
}

const restProvider = (adapter: string, auto: string[] = ["search"]): Json => ({
  enabled: true, auto, keys: ["k1"], integration: { kind: "rest", adapter },
});

test("crossCheck merges two independent indexes and reports which provider found what", async () => {
  const restore = stubSearchFetch({
    "api.parallel.ai": { results: [
      { url: "https://example.com/a/", title: "Shared A", excerpts: ["parallel text"], publish_date: "2026-09-30" },
      { url: "https://parallel-only.example/", title: "P only", excerpts: ["p"] },
    ] },
    "api.search.brave.com": { web: { results: [
      { url: "https://www.example.com/a?utm_source=x", title: "Shared A", description: "brave <strong>text</strong> that is longer" },
      { url: "https://brave-only.example/", title: "B only", description: "b" },
    ] } },
  });
  try {
    await withToolkit({ parallel: restProvider("parallel"), brave: restProvider("brave") }, async (toolkit) => {
      const output = await toolkit.callTool("search_auto", { query: "q", limit: 3, crossCheck: true });
      const auto = route(output).searchToolkitAuto as { crossCheck: { routes: Json[]; failed: string[]; corroborated: number } };
      assert.deepEqual(auto.crossCheck.routes.map((item) => item.provider), ["parallel", "brave"]);
      assert.equal(auto.crossCheck.corroborated, 1);
      assert.deepEqual(auto.crossCheck.failed, []);
      const rendered = text(output);
      assert.match(rendered, /1\. Shared A \(2026-09-30\)/);
      assert.match(rendered, /found by: parallel, brave/);
      assert.match(rendered, /brave text that is longer/);
      assert.doesNotMatch(rendered, /<strong>/);
      assert.equal((output as { structuredContent: { result: { items: unknown[] } } }).structuredContent.result.items.length, 3);
    });
  } finally { restore(); }
});

test("crossCheck degrades to the surviving provider when one index fails", async () => {
  const restore = stubSearchFetch({
    "api.search.brave.com": { web: { results: [{ url: "https://only.example/", title: "Only", description: "d" }] } },
  });
  try {
    await withToolkit({ parallel: restProvider("parallel"), brave: restProvider("brave") }, async (toolkit) => {
      const output = await toolkit.callTool("search_auto", { query: "q", crossCheck: true });
      const auto = route(output).searchToolkitAuto as { crossCheck: { routes: Json[]; failed: string[] } };
      assert.deepEqual(auto.crossCheck.failed, ["parallel"]);
      assert.deepEqual(auto.crossCheck.routes.map((item) => item.provider), ["brave"]);
      assert.match(text(output), /Only/);
    });
  } finally { restore(); }
});

test("crossCheck with a single eligible provider is just a normal search", async () => {
  const restore = stubSearchFetch({ "api.search.brave.com": { web: { results: [{ url: "https://x.example/", title: "X", description: "d" }] } } });
  try {
    await withToolkit({ brave: restProvider("brave") }, async (toolkit) => {
      const output = await toolkit.callTool("search_auto", { query: "q", crossCheck: true });
      assert.equal((route(output).searchToolkitAuto as Json).crossCheck, undefined);
      assert.match(text(output), /X/);
    });
  } finally { restore(); }
});

test("the lean profile exposes the unified tools and a gateway instead of every provider tool", async () => {
  const restore = stubSearchFetch({ "api.search.brave.com": { web: { results: [{ url: "https://x.example/", title: "X", description: "d" }] } } });
  try {
    await withToolkit({ brave: restProvider("brave"), serper: restProvider("serper") }, async (toolkit) => {
      assert.equal(toolkit.profile, "lean");
      assert.deepEqual(toolkit.listTools().map((tool) => tool.name).sort(), [
        "fetch_auto", "provider_call", "provider_tools", "search_auto", "search_images", "search_pool_status", "search_rotation_probe",
      ]);
      const listing = text(await toolkit.callTool("provider_tools", { provider: "brave" }));
      assert.match(listing, /^brave_web_search \[read\] /m);
      assert.doesNotMatch(listing, /serper_/);
      const described = await toolkit.callTool("provider_tools", { name: "brave_web_search" }) as { structuredContent: { inputSchema: { properties: Json } } };
      assert.ok("query" in described.structuredContent.inputSchema.properties);
      const called = await toolkit.callTool("provider_call", { name: "brave_web_search", arguments: { query: "q" } });
      assert.match(text(called), /1\. X/);
      await assert.rejects(toolkit.callTool("provider_call", { name: "brave_web_search", arguments: { limit: 3 } }), /Invalid arguments for brave_web_search/);
      await assert.rejects(toolkit.callTool("provider_call", { name: "search_auto", arguments: { query: "q" } }), /Unknown provider tool/);
      await assert.rejects(toolkit.callTool("provider_tools", { name: "nope" }), /Unknown provider tool/);
    }, {}, { profile: "lean" });
  } finally { restore(); }
});

test("the full profile hides the gateway and keeps every provider tool", async () => {
  await withToolkit({ brave: restProvider("brave") }, async (toolkit) => {
    const names = toolkit.listTools().map((tool) => tool.name);
    assert.equal(toolkit.profile, "full");
    assert.ok(names.includes("brave_web_search"));
    assert.equal(names.includes("provider_call"), false);
  });
});
