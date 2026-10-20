import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  HttpError, isPageFailure, isTimeout, shouldFailoverProvider, statusFromError, TargetPageError, ToolResultError,
} from "../src/errors.js";
import { callWithRotation } from "../src/keys.js";
import { isRouteContentBlock, routeBlock } from "../src/provenance.js";
import { RotationStore } from "../src/rotation.js";
import { trimText } from "../src/shape.js";
import { SearchToolkit } from "../src/toolkit.js";

type Json = Record<string, unknown>;

function withStore(run: (store: RotationStore) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(resolve(tmpdir(), "search-toolkit-resilience-"));
  const store = new RotationStore(resolve(dir, "state.db"));
  return run(store).finally(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
}

const KEYS = ["key-one-123456", "key-two-123456", "key-three-123456"];

async function countAttempts(store: RotationStore, error: unknown): Promise<number> {
  let calls = 0;
  await assert.rejects(callWithRotation(store, "exa", KEYS, async () => {
    calls += 1;
    throw error;
  }));
  return calls;
}

test("key faults try every key, transient faults one more, timeouts and page failures none", async () => {
  await withStore(async (store) => {
    assert.equal(await countAttempts(store, new HttpError("HTTP 429: slow down", 429)), 3);
    assert.equal(await countAttempts(store, new HttpError("HTTP 503: unavailable", 503)), 2);
    assert.equal(await countAttempts(store, new TypeError("fetch failed")), 2);
    assert.equal(await countAttempts(store, Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" })), 1);
    assert.equal(await countAttempts(store, new TargetPageError("page answered 403", 403)), 1);
    assert.equal(await countAttempts(store, new HttpError("HTTP 422: bad", 422)), 1);
  });
});

test("a status number inside an upstream tool's JSON-RPC error is not read as a key fault", () => {
  const pageError = Object.assign(new Error("MCP error -32603: Failed to scrape: status 403"), { code: -32_603 });
  assert.equal(statusFromError(pageError), undefined);
  const keyError = Object.assign(new Error("MCP error -32603: Invalid API key"), { code: -32_603 });
  assert.equal(statusFromError(keyError), 401);
  // The transport's own HTTP status still counts.
  assert.equal(statusFromError(Object.assign(new Error("Streamable HTTP error"), { code: 401 })), 401);
  assert.equal(isTimeout(Object.assign(new Error("Request timed out"), { code: -32_001 })), true);
});

test("page failures fail over unless the page is gone", () => {
  assert.equal(statusFromError(new TargetPageError("blocked", 403)), undefined);
  assert.equal(shouldFailoverProvider(new TargetPageError("blocked", 403)), true);
  assert.equal(shouldFailoverProvider(new TargetPageError("missing", 404)), false);
  assert.equal(isPageFailure(new ToolResultError("Failed to scrape URL. Status code: 403 Forbidden", [])), true);
  assert.equal(isPageFailure(new ToolResultError("Failed to scrape URL. Status code: 404 Not Found", [])), false);
  assert.equal(isPageFailure(new ToolResultError("Invalid URL format", [])), false);
  assert.equal(isPageFailure(new Error("Status code: 403")), false);
});

test("a page that blocks Parallel extract leaves every Parallel key healthy", async () => {
  const directory = mkdtempSync(join(tmpdir(), "search-toolkit-parallel-page-"));
  const configPath = join(directory, "providers.json");
  writeFileSync(configPath, JSON.stringify({
    version: 2,
    statePath: join(directory, "state.db"),
    providers: {
      parallel: { enabled: true, auto: ["fetch"], keys: KEYS, integration: { kind: "rest", adapter: "parallel" } },
    },
  }));
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({
      results: [],
      errors: [{ url: "https://blocked.example/", error_type: "fetch_error", http_status_code: 403, content: "Forbidden" }],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  const toolkit = new SearchToolkit(configPath);
  try {
    await toolkit.initialize();
    await assert.rejects(toolkit.callTool("parallel_extract", { url: "https://blocked.example/" }), /page answered 403/);
    assert.equal(calls, 1, "one key is enough to learn the page is blocked");
    const status = toolkit.rotation.status("parallel", KEYS);
    for (const key of status.keys) assert.equal(key.status.status, "healthy");
    const used = status.keys.find((key) => Number(key.status.requests) > 0);
    assert.match(String(used?.status.last_error), /page answered 403/);
  } finally {
    globalThis.fetch = original;
    await toolkit.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the last error stays visible after the key recovers", async () => {
  await withStore(async (store) => {
    const selection = store.select("brave", ["key-one-123456"], true);
    store.record(selection, { ok: false, latencyMs: 5, httpStatus: 503, error: "HTTP 503: unavailable" });
    store.record(selection, { ok: true, latencyMs: 5 });
    const [key] = store.status("brave", ["key-one-123456"]).keys;
    assert.equal(key?.status.last_error, "HTTP 503: unavailable");
    assert.equal(typeof key?.status.last_error_at, "number");
  });
});

test("the model-visible route block is compact and keeps the details for fallbacks only", () => {
  const route = { provider: "exa", tool: "exa_web_fetch_exa", upstreamTool: "web_fetch_exa" };
  const quiet = routeBlock(route, {
    mode: "fetch", quality: "balanced", candidateRank: 1, providerAttempt: 1,
    attempts: [{ provider: "exa", tool: "exa_web_fetch_exa", candidateRank: 1, outcome: "success" }],
  });
  assert.equal(quiet.text, '{"searchToolkitRoute":{"provider":"exa","tool":"exa_web_fetch_exa"},"searchToolkitAuto":{"mode":"fetch","quality":"balanced"}}');
  assert.equal(isRouteContentBlock(quiet), true);
  const noisy = JSON.parse(routeBlock(route, {
    mode: "general",
    attempts: [
      { provider: "parallel", tool: "parallel_search", outcome: "error", status: 429 },
      { provider: "exa", tool: "exa_web_fetch_exa", outcome: "success" },
    ],
  }).text) as { searchToolkitAuto: Json };
  assert.deepEqual(noisy.searchToolkitAuto.attempts, ["parallel_search:429", "exa_web_fetch_exa:success"]);
  // A large JSON body is not mistaken for a route block, and is not parsed to find out.
  assert.equal(isRouteContentBlock({ type: "text", text: JSON.stringify({ results: [], searchToolkitRoute: {} }) }), false);
});

test("crossCheck does not call a failed side again when it falls back to the chain", async () => {
  const directory = mkdtempSync(join(tmpdir(), "search-toolkit-crosscheck-"));
  const configPath = join(directory, "providers.json");
  const rest = (adapter: string) => ({ enabled: true, auto: ["search"], keys: ["k1-123456"], integration: { kind: "rest", adapter } });
  writeFileSync(configPath, JSON.stringify({
    version: 2,
    statePath: join(directory, "state.db"),
    providers: { parallel: rest("parallel"), you: rest("you"), brave: rest("brave") },
  }));
  const original = globalThis.fetch;
  const hits: Record<string, number> = {};
  globalThis.fetch = async (input) => {
    const host = new URL(String(input)).hostname;
    hits[host] = (hits[host] ?? 0) + 1;
    if (host === "api.search.brave.com") {
      return new Response(JSON.stringify({ web: { results: [{ url: "https://ok.example/", title: "OK", description: "d" }] } }), { status: 200 });
    }
    return new Response("unavailable", { status: 503 });
  };
  const toolkit = new SearchToolkit(configPath);
  try {
    await toolkit.initialize();
    const output = await toolkit.callTool("search_auto", { query: "q", crossCheck: true }) as { structuredContent: { route: Json } };
    assert.equal(output.structuredContent.route.provider, "brave");
    assert.deepEqual(hits, { "api.parallel.ai": 1, "ydc-index.io": 1, "api.search.brave.com": 1 });
  } finally {
    globalThis.fetch = original;
    await toolkit.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("search_auto reaches a third provider when the first two are unavailable", async () => {
  const directory = mkdtempSync(join(tmpdir(), "search-toolkit-third-"));
  const configPath = join(directory, "providers.json");
  const rest = (adapter: string) => ({ enabled: true, auto: ["search"], keys: ["k1-123456"], integration: { kind: "rest", adapter } });
  writeFileSync(configPath, JSON.stringify({
    version: 2,
    statePath: join(directory, "state.db"),
    providers: { parallel: rest("parallel"), you: rest("you"), brave: rest("brave") },
  }));
  const original = globalThis.fetch;
  globalThis.fetch = async (input) => new URL(String(input)).hostname === "api.search.brave.com"
    ? new Response(JSON.stringify({ web: { results: [{ url: "https://ok.example/", title: "OK", description: "d" }] } }), { status: 200 })
    : new Response("unavailable", { status: 503 });
  const toolkit = new SearchToolkit(configPath);
  try {
    await toolkit.initialize();
    const output = await toolkit.callTool("search_auto", { query: "q" }) as { content: Array<{ text: string }> };
    const visible = JSON.parse(output.content[0]?.text ?? "{}") as { searchToolkitAuto: Json };
    assert.deepEqual(visible.searchToolkitAuto.attempts, ["parallel_search:503", "you_search:503", "brave_web_search:success"]);
  } finally {
    globalThis.fetch = original;
    await toolkit.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Chinese excerpts are cut at a sentence end", () => {
  const text = `${"这是一句完整的话。".repeat(6)}后面还有很长很长的一段没有标点的内容会被截断掉`;
  const trimmed = trimText(text, 60);
  assert.ok(trimmed.endsWith("。 …"), trimmed);
});
