import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { boundedInteger, createSearchToolkitHttpApp, isLoopbackHost, parseHttpTokenPolicies } from "../src/http.js";
import { SearchToolkit } from "../src/toolkit.js";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

function initPayload(id = 1) {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "http-test", version: "1.0.0" },
    },
  });
}

test("Streamable HTTP serves the shared toolkit behind bearer authentication", async () => {
  const directory = mkdtempSync(join(tmpdir(), "search-toolkit-http-"));
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
  const ownerToken = "owner-test-token";
  const guestToken = "guest-test-token";
  const limitedToken = "limited-test-token";
  const toolkit = new SearchToolkit(configPath);
  await toolkit.initialize();
  const runtime = createSearchToolkitHttpApp(toolkit, {
    tokens: [
      { hash: sha256(ownerToken) },
      {
        hash: sha256(guestToken),
        tools: ["search_auto", "search_images"],
        requestsPerMinute: 30,
        maxSessions: 1,
      },
      {
        hash: sha256(limitedToken),
        tools: ["search_pool_status"],
        requestsPerMinute: 1,
      },
    ],
  });
  const listener = runtime.app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => listener.once("listening", resolve));
  const port = (listener.address() as AddressInfo).port;
  const url = new URL(`http://127.0.0.1:${port}/mcp`);
  try {
    // Unauthenticated oversized body returns 401 (auth runs BEFORE express.json body parsing).
    const unauthOversized = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ padding: "x".repeat(110 * 1024) }),
    });
    assert.equal(unauthOversized.status, 401);

    // Case-insensitive Bearer scheme is accepted.
    const lowercaseInit = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `bearer ${ownerToken}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: initPayload(10),
    });
    assert.equal(lowercaseInit.status, 200);
    await lowercaseInit.body?.cancel();

    // Stateful 404 on unknown session ID and 400 on non-initialize without session ID.
    const unknownSession = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ownerToken}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Session-Id": "does-not-exist",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 11, method: "tools/list", params: {} }),
    });
    assert.equal(unknownSession.status, 404);

    const noInit = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ownerToken}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 12, method: "tools/list", params: {} }),
    });
    assert.equal(noInit.status, 400);

    const owner = new Client({ name: "search-toolkit-http-owner-test", version: "1.0.0" });
    const ownerTransport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { Authorization: `Bearer ${ownerToken}` } },
    });
    await owner.connect(ownerTransport as unknown as Parameters<typeof owner.connect>[0]);
    const ownerTools = await owner.listTools();
    assert.ok(ownerTools.tools.some((tool) => tool.name === "search_pool_status"));
    assert.ok(ownerTransport.sessionId);

    const excessiveInput = await owner.callTool({
      name: "search_auto",
      arguments: { query: "example", padding: Array(10_001).fill(null) },
    });
    assert.equal(excessiveInput.isError, true);
    assert.match(String((excessiveInput.content as Array<{ text?: string }>)[0]?.text), /Tool input exceeds 10000/);

    // Authenticated oversized body returns 413.
    const excessiveBody = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({ padding: "x".repeat(100 * 1024) }),
    });
    assert.equal(excessiveBody.status, 413);
    assert.ok((await owner.listTools()).tools.length > 0);

    const ownerSecond = new Client({ name: "search-toolkit-http-owner-second-test", version: "1.0.0" });
    const ownerSecondTransport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { Authorization: `Bearer ${ownerToken}` } },
    });
    await ownerSecond.connect(ownerSecondTransport as unknown as Parameters<typeof ownerSecond.connect>[0]);
    assert.ok((await ownerSecond.listTools()).tools.length > 0);

    const crossTokenSession = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${guestToken}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Session-Id": ownerTransport.sessionId ?? "",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    });
    assert.equal(crossTokenSession.status, 403);

    const guest = new Client({ name: "search-toolkit-http-guest-test", version: "1.0.0" });
    const guestTransport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { Authorization: `Bearer ${guestToken}` } },
    });
    await guest.connect(guestTransport as unknown as Parameters<typeof guest.connect>[0]);
    const guestTools = await guest.listTools();
    assert.deepEqual(guestTools.tools.map((tool) => tool.name), ["search_auto", "search_images"]);
    const excessSession = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${guestToken}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: initPayload(3),
    });
    assert.equal(excessSession.status, 429);
    const denied = await guest.callTool({ name: "search_pool_status", arguments: {} });
    assert.equal(denied.isError, true);
    const invalidArguments = [
      {},
      { query: "" },
      { query: "image", limit: "abc" },
      { query: "image", limit: 21 },
      { query: "image", bogusField: true },
    ];
    for (const arguments_ of invalidArguments) {
      const invalid = await guest.callTool({ name: "search_images", arguments: arguments_ });
      assert.equal(invalid.isError, true);
      const invalidContent = invalid.content as Array<{ type: string; text?: string }>;
      assert.match(String(invalidContent[0]?.text ?? ""), /Invalid arguments for search_images/);
    }

    const limited = new Client({ name: "search-toolkit-http-limit-test", version: "1.0.0" });
    const limitedTransport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { Authorization: `Bearer ${limitedToken}` } },
    });
    await limited.connect(limitedTransport as unknown as Parameters<typeof limited.connect>[0]);
    assert.equal((await limited.callTool({ name: "search_pool_status", arguments: {} })).isError, undefined);
    const rateLimited = await limited.callTool({ name: "search_pool_status", arguments: {} });
    assert.equal(rateLimited.isError, true);
    const rateContent = rateLimited.content as Array<{ type: string; text?: string }>;
    assert.match(String(rateContent[0]?.text ?? ""), /Rate limit exceeded .*retry in \d+s/);

    await Promise.all([owner.close(), ownerSecond.close(), guest.close(), limited.close()]);
  } finally {
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    await runtime.close();
    await toolkit.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("HTTP numeric settings, loopback helper, and token policy parsing validate roles and scoped rules", () => {
  assert.equal(boundedInteger(Number.NaN, 18_473, 1, 65_535), 18_473);
  assert.equal(boundedInteger(-1, 1_800_000, 1_000, 86_400_000), 1_800_000);
  assert.equal(isLoopbackHost("127.0.0.1"), true);
  assert.equal(isLoopbackHost("LOCALHOST"), true);
  assert.equal(isLoopbackHost("::1"), true);
  assert.equal(isLoopbackHost("[::1]"), true);
  assert.equal(isLoopbackHost("0.0.0.0"), false);

  const parsed = parseHttpTokenPolicies(JSON.stringify([{
    hash: "a".repeat(64),
    role: "client",
    tools: ["search_auto"],
    requestsPerMinute: 30,
    maxSessions: 8,
    allowedToolArguments: { "grok_*": { depth: ["fast", "deep"] } },
  }]));
  assert.deepEqual(parsed, [{
    hash: "a".repeat(64),
    role: "client",
    tools: ["search_auto"],
    requestsPerMinute: 30,
    maxSessions: 8,
    allowedToolArguments: { "grok_*": { depth: ["fast", "deep"] } },
  }]);
  assert.throws(
    () => parseHttpTokenPolicies(JSON.stringify([{ hash: "a".repeat(64), role: "superadmin" }])),
    /role/,
  );
  assert.throws(
    () => parseHttpTokenPolicies(JSON.stringify([{ hash: "a".repeat(64), allowedToolArguments: { "grok_*": { depth: "fast" } } }])),
    /must map tool patterns to argument allowlists/,
  );
});

test("HTTP token policies enforce allowedArgumentValues, tool-scoped allowedToolArguments, and search_rotation_probe ACLs", async () => {
  const directory = mkdtempSync(join(tmpdir(), "search-toolkit-http-args-"));
  const configPath = join(directory, "providers.json");
  writeFileSync(configPath, JSON.stringify({
    version: 2,
    statePath: join(directory, "state.db"),
    profile: "curated",
    providers: {
      brave: { enabled: true, auto: ["search"], keys: ["test-key-1"], integration: { kind: "rest", adapter: "brave" } },
      grok: { enabled: true, auto: [], keys: ["test-key-2"], integration: { kind: "rest", adapter: "grok" } },
    },
  }));
  const friendToken = "friend-scoped-args-token";
  const probeRestrictedToken = "probe-restricted-token";
  const toolkit = new SearchToolkit(configPath, { profile: "curated" });
  await toolkit.initialize();
  const runtime = createSearchToolkitHttpApp(toolkit, {
    tokens: parseHttpTokenPolicies(JSON.stringify([
      {
        hash: sha256(friendToken),
        role: "client",
        allowedArgumentValues: { quality: ["balanced"] },
        allowedToolArguments: { "grok_*": { depth: ["fast", "deep"] } },
      },
      {
        hash: sha256(probeRestrictedToken),
        role: "client",
        tools: ["search_rotation_probe", "search_auto"],
      },
    ])),
  });
  const listener = runtime.app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => listener.once("listening", resolve));
  const url = new URL(`http://127.0.0.1:${(listener.address() as AddressInfo).port}/mcp`);
  const originalFetch = globalThis.fetch;
  let providerCalls = 0;
  const friend = new Client({ name: "friend-args-test", version: "1.0.0" });
  const probeClient = new Client({ name: "probe-acl-test", version: "1.0.0" });
  try {
    await friend.connect(new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { Authorization: `Bearer ${friendToken}` } },
    }) as unknown as Parameters<typeof friend.connect>[0]);
    await probeClient.connect(new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { Authorization: `Bearer ${probeRestrictedToken}` } },
    }) as unknown as Parameters<typeof probeClient.connect>[0]);

    globalThis.fetch = async (input, init) => {
      if (String(input).startsWith("http://127.0.0.1")) return originalFetch(input, init);
      providerCalls += 1;
      if (String(input).includes("api.x.ai")) {
        return Response.json({ output: [{ type: "message", content: [{ type: "output_text", text: "grok ok" }] }] });
      }
      return Response.json({ web: { results: [{ url: "https://example.com", title: "Ex", description: "Body" }] } });
    };

    // Global allowedArgumentValues blocks quality=max on search_auto.
    const deniedQuality = await friend.callTool({ name: "search_auto", arguments: { query: "example", quality: "max" } });
    assert.equal(deniedQuality.isError, true);
    assert.match(String((deniedQuality.content as Array<{ text?: string }>)[0]?.text), /quality=max is not allowed for this token \(allowed: balanced\)/);
    assert.equal(providerCalls, 0);

    // Tool-scoped allowedToolArguments blocks grok_* depth=max directly AND via provider_call.
    const deniedGrokDirect = await friend.callTool({ name: "grok_x_search", arguments: { query: "x", depth: "max" } });
    assert.equal(deniedGrokDirect.isError, true);
    assert.match(String((deniedGrokDirect.content as Array<{ text?: string }>)[0]?.text), /depth=max is not allowed/);

    const deniedGrokGateway = await friend.callTool({
      name: "provider_call",
      arguments: { name: "grok_web_search", arguments: { query: "w", depth: "max" } },
    });
    assert.equal(deniedGrokGateway.isError, true);
    assert.match(String((deniedGrokGateway.content as Array<{ text?: string }>)[0]?.text), /depth=max is not allowed/);
    assert.equal(providerCalls, 0);

    // Allowed grok_* depth=fast passes policy and reaches the provider.
    const allowedGrok = await friend.callTool({ name: "grok_x_search", arguments: { query: "x", depth: "fast" } });
    assert.equal(allowedGrok.isError, undefined);
    assert.equal(providerCalls, 1);

    // Non-matching tool (search_auto) is unaffected by grok_* rule.
    const okSearch = await friend.callTool({ name: "search_auto", arguments: { query: "example", quality: "balanced" } });
    assert.equal(okSearch.isError, undefined);
    assert.equal(providerCalls, 2);

    // search_rotation_probe enforces ACL both when `tool` is omitted and when explicitly disallowed.
    const callsBeforeProbe = providerCalls;
    const probeOmitted = await probeClient.callTool({
      name: "search_rotation_probe",
      arguments: { provider: "brave", query: "ping" },
    });
    assert.equal(probeOmitted.isError, true);
    assert.match(String((probeOmitted.content as Array<{ text?: string }>)[0]?.text), /not available for this token/);

    const probeExplicit = await probeClient.callTool({
      name: "search_rotation_probe",
      arguments: { provider: "brave", query: "ping", tool: "brave_web_search" },
    });
    assert.equal(probeExplicit.isError, true);
    assert.match(String((probeExplicit.content as Array<{ text?: string }>)[0]?.text), /not available for this token/);
    assert.equal(providerCalls, callsBeforeProbe, "blocked probes must never invoke upstream providers");
  } finally {
    globalThis.fetch = originalFetch;
    await Promise.all([friend.close(), probeClient.close()]);
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    await runtime.close();
    await toolkit.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Stateless Streamable HTTP supports per-token profiles, fast 405 on GET/PUT, 200 on DELETE, and deterministic concurrent reload coalescing", async () => {
  const directory = mkdtempSync(join(tmpdir(), "search-toolkit-http-stateless-"));
  const configPath = join(directory, "providers.json");
  writeFileSync(configPath, JSON.stringify({
    version: 2,
    statePath: join(directory, "state.db"),
    providers: {
      brave: { enabled: true, auto: ["search"], keys: ["test-key"], integration: { kind: "rest", adapter: "brave" } },
      serper: { enabled: true, auto: ["search"], keys: ["test-key-2"], integration: { kind: "rest", adapter: "serper" } },
    },
  }));
  const fullToken = "owner-full-token";
  const leanToken = "owner-lean-token";
  const scopedToken = "scoped-guest-token";
  const toolkit = new SearchToolkit(configPath, { profile: "full" });
  await toolkit.initialize();
  let reloads = 0;
  const reloadEntered = deferred();
  const reloadRelease = deferred();
  const runtime = createSearchToolkitHttpApp(toolkit, {
    stateless: true,
    tokens: parseHttpTokenPolicies(JSON.stringify([
      { hash: sha256(fullToken), role: "owner", profile: "full" },
      { hash: sha256(leanToken), role: "owner", profile: "lean" },
      { hash: sha256(scopedToken), role: "client", tools: ["search_auto"] },
    ])),
    onReload: async () => {
      reloads += 1;
      reloadEntered.resolve();
      await reloadRelease.promise;
      const next = new SearchToolkit(configPath, { profile: "full" });
      await next.initialize();
      return next;
    },
  });
  const listener = runtime.app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => listener.once("listening", resolve));
  const port = (listener.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    const health = await fetch(`${baseUrl}/healthz`).then((r) => r.json()) as { ok: boolean; mode: string };
    assert.deepEqual(health, { ok: true, mode: "stateless" });

    // Stateless GET and PUT return 405; DELETE returns 200.
    const getResp = await fetch(`${baseUrl}/mcp`, {
      method: "GET",
      headers: { Authorization: `Bearer ${fullToken}`, Accept: "text/event-stream" },
    });
    assert.equal(getResp.status, 405);

    const putResp = await fetch(`${baseUrl}/mcp`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${fullToken}` },
    });
    assert.equal(putResp.status, 405);

    const delResp = await fetch(`${baseUrl}/mcp`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${fullToken}` },
    });
    assert.equal(delResp.status, 200);
    assert.deepEqual(await delResp.json(), { ok: true });

    const fullClient = new Client({ name: "full-client", version: "1.0.0" });
    await fullClient.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${fullToken}` } },
    }) as unknown as Parameters<typeof fullClient.connect>[0]);
    const fullNames = (await fullClient.listTools()).tools.map((t) => t.name);
    assert.ok(fullNames.includes("brave_web_search"));
    assert.ok(!fullNames.includes("provider_call"));

    const leanClient = new Client({ name: "lean-client", version: "1.0.0" });
    await leanClient.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${leanToken}` } },
    }) as unknown as Parameters<typeof leanClient.connect>[0]);
    const leanNames = (await leanClient.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(leanNames, [
      "fetch_auto", "provider_call", "provider_tools", "search_auto",
      "search_images", "search_pool_status", "search_rotation_probe",
    ]);
    const leanStatusRaw = await leanClient.callTool({ name: "search_pool_status", arguments: { verbose: true } });
    const leanStatus = JSON.parse(String((leanStatusRaw.content as Array<{ text?: string }>)[0]?.text ?? "{}")) as {
      profile?: string;
      tools?: string[];
    };
    assert.equal(leanStatus.profile, "lean");
    assert.deepEqual(leanStatus.tools?.slice().sort(), leanNames);

    const deniedReload = await fetch(`${baseUrl}/admin/reload`, {
      method: "POST",
      headers: { Authorization: `Bearer ${scopedToken}` },
    });
    assert.equal(deniedReload.status, 403);

    // Deterministic concurrent reload coalescing: hold A inside onReload until B reaches the server, then release.
    const reloadA = fetch(`${baseUrl}/admin/reload`, { method: "POST", headers: { Authorization: `Bearer ${fullToken}` } });
    await reloadEntered.promise;
    const reloadB = fetch(`${baseUrl}/admin/reload`, { method: "POST", headers: { Authorization: `Bearer ${fullToken}` } });
    // Give reloadB's local TCP request time to reach Express and attach to reloadInFlight while A is parked.
    await new Promise((resolve) => setTimeout(resolve, 100));
    reloadRelease.resolve();
    const [okReloadA, okReloadB] = await Promise.all([reloadA, reloadB]);
    assert.equal(okReloadA.status, 200);
    assert.equal(okReloadB.status, 200);
    assert.equal(reloads, 1);

    await Promise.all([fullClient.close(), leanClient.close()]);
  } finally {
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    await runtime.close();
    await runtime.currentToolkit().close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Stateful /admin/reload keeps retired toolkit alive until in-flight calls finish and evicts old sessions", async () => {
  const directory = mkdtempSync(join(tmpdir(), "search-toolkit-http-reload-"));
  const configPath = join(directory, "providers.json");
  writeFileSync(configPath, JSON.stringify({
    version: 2,
    statePath: join(directory, "state.db"),
    providers: {
      brave: { enabled: true, auto: ["search"], keys: ["test-key"], integration: { kind: "rest", adapter: "brave" } },
    },
  }));
  const ownerToken = "stateful-owner-token";
  const toolkit = new SearchToolkit(configPath, { cache: false });
  await toolkit.initialize();

  let oldToolkitClosed = false;
  const origClose = toolkit.close.bind(toolkit);
  toolkit.close = async () => {
    oldToolkitClosed = true;
    return origClose();
  };

  const runtime = createSearchToolkitHttpApp(toolkit, {
    tokens: [{ hash: sha256(ownerToken), role: "owner" }],
    onReload: async () => {
      const next = new SearchToolkit(configPath, { cache: false });
      await next.initialize();
      return next;
    },
  });
  const listener = runtime.app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => listener.once("listening", resolve));
  const baseUrl = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;

  const originalFetch = globalThis.fetch;
  const callEntered = deferred();
  const releaseCall = deferred();
  const client = new Client({ name: "inflight-reload-client", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${ownerToken}` } },
  });
  try {
    await client.connect(transport as unknown as Parameters<typeof client.connect>[0]);
    const oldSessionId = transport.sessionId!;

    globalThis.fetch = async (input, init) => {
      if (String(input).startsWith(baseUrl)) return originalFetch(input, init);
      callEntered.resolve();
      await releaseCall.promise;
      return Response.json({
        web: { results: [{ url: "https://example.com/ok", title: "Inflight OK", description: "Completed cleanly" }] },
      });
    };

    const inflightCall = client.callTool({ name: "search_auto", arguments: { query: "inflight" } });
    inflightCall.catch(() => undefined);
    await callEntered.promise;

    // Trigger reload while the stateful tool call is still in-flight.
    const reloadResp = await fetch(`${baseUrl}/admin/reload`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(reloadResp.status, 200);
    assert.equal(oldToolkitClosed, false, "retired toolkit must remain open while an in-flight call holds a reference");

    // Old session ID was evicted by reload.
    const staleSession = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ownerToken}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Session-Id": oldSessionId,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 99, method: "tools/list", params: {} }),
    });
    assert.equal(staleSession.status, 404);

    // Release the in-flight provider fetch -> call finishes cleanly and retires old toolkit.
    releaseCall.resolve();
    const out = await inflightCall;
    assert.equal(out.isError, undefined);
    assert.match(String((out.content as Array<{ text?: string }>)[1]?.text), /Inflight OK/);

    // Give the async retire close microtask a tick to run.
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(oldToolkitClosed, true, "retired toolkit closes immediately after last in-flight call drains");
  } finally {
    releaseCall.resolve();
    globalThis.fetch = originalFetch;
    await client.close().catch(() => undefined);
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    await runtime.close();
    await runtime.currentToolkit().close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Origin/CORS preflight, allowedHosts case-insensitivity, explicit owner vs client role, and /admin/shutdown", async () => {
  const directory = mkdtempSync(join(tmpdir(), "search-toolkit-http-cors-"));
  const configPath = join(directory, "providers.json");
  writeFileSync(configPath, JSON.stringify({
    version: 2,
    statePath: join(directory, "state.db"),
    providers: {
      serper: { enabled: true, auto: ["search"], keys: ["k1"], integration: { kind: "rest", adapter: "serper" } },
    },
  }));
  const restrictedOwnerToken = "restricted-owner-token";
  const unrestrictedClientToken = "hermes-like-client-token";
  const toolkit = new SearchToolkit(configPath);
  await toolkit.initialize();
  let shutdownCalled = false;
  const shutdownFired = deferred();
  const runtime = createSearchToolkitHttpApp(toolkit, {
    allowedHosts: ["127.0.0.1", "Example.COM", "::1"],
    allowedOrigins: ["https://allowed.example"],
    tokens: [
      { hash: sha256(restrictedOwnerToken), role: "owner", requestsPerMinute: 60, maxSessions: 8 },
      { hash: sha256(unrestrictedClientToken), role: "client" },
    ],
    onReload: async () => toolkit,
    onShutdown: async () => {
      shutdownCalled = true;
      shutdownFired.resolve();
    },
  });
  const listener = runtime.app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => listener.once("listening", resolve));
  const port = (listener.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const originalFetch = globalThis.fetch;
  try {
    // Disallowed Origin returns 403 on /mcp, /admin/reload, and /admin/shutdown.
    for (const path of ["/mcp", "/admin/reload", "/admin/shutdown"]) {
      const badOrigin = await fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: { Origin: "https://evil.example", Authorization: `Bearer ${restrictedOwnerToken}` },
      });
      assert.equal(badOrigin.status, 403, `${path} rejects disallowed Origin`);
    }

    // Allowed Origin OPTIONS preflight returns 204 with CORS headers.
    const preflight = await fetch(`${baseUrl}/mcp`, {
      method: "OPTIONS",
      headers: { Origin: "https://allowed.example" },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), "https://allowed.example");
    assert.equal(preflight.headers.get("vary"), "Origin");
    assert.equal(preflight.headers.get("access-control-expose-headers"), "MCP-Session-Id");
    assert.match(preflight.headers.get("access-control-allow-headers") ?? "", /Authorization/);

    // OPTIONS without Origin returns 405.
    const bareOptions = await fetch(`${baseUrl}/mcp`, { method: "OPTIONS" });
    assert.equal(bareOptions.status, 405);

    // Host header validation is case-insensitive and rejects unknown Host with 403.
    const { request: httpRequest } = await import("node:http");
    const rawHostCheck = (hostHeader: string) => new Promise<number>((resolve, reject) => {
      const req = httpRequest({ host: "127.0.0.1", port, path: "/healthz", method: "GET", headers: { Host: hostHeader } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.once("error", reject);
      req.end();
    });
    assert.equal(await rawHostCheck("example.com"), 200);
    assert.equal(await rawHostCheck("EXAMPLE.COM:18473"), 200);
    assert.equal(await rawHostCheck("[::1]:18473"), 200);
    assert.equal(await rawHostCheck("evil.example"), 403);

    // Explicit role:"client" (even with no tool/rate restrictions) is NOT owner -> 403 on admin endpoints & refreshQuota rejected.
    const clientReload = await fetch(`${baseUrl}/admin/reload`, {
      method: "POST",
      headers: { Authorization: `Bearer ${unrestrictedClientToken}` },
    });
    assert.equal(clientReload.status, 403);

    const clientShutdown = await fetch(`${baseUrl}/admin/shutdown`, {
      method: "POST",
      headers: { Authorization: `Bearer ${unrestrictedClientToken}` },
    });
    assert.equal(clientShutdown.status, 403);

    const unauthShutdown = await fetch(`${baseUrl}/admin/shutdown`, { method: "POST" });
    assert.equal(unauthShutdown.status, 401);

    const clientMcp = new Client({ name: "client-role-test", version: "1.0.0" });
    await clientMcp.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${unrestrictedClientToken}` } },
    }) as unknown as Parameters<typeof clientMcp.connect>[0]);
    const clientRefresh = await clientMcp.callTool({ name: "search_pool_status", arguments: { refreshQuota: true } });
    assert.equal(clientRefresh.isError, true);
    assert.match(String((clientRefresh.content as Array<{ text?: string }>)[0]?.text), /refreshQuota requires owner access/);
    await clientMcp.close();

    // Explicit role:"owner" (even with requestsPerMinute/maxSessions) IS owner -> reload 200 & refreshQuota works & shutdown 200.
    const ownerReload = await fetch(`${baseUrl}/admin/reload`, {
      method: "POST",
      headers: { Authorization: `Bearer ${restrictedOwnerToken}`, Origin: "https://allowed.example" },
    });
    assert.equal(ownerReload.status, 200);
    assert.equal(ownerReload.headers.get("access-control-allow-origin"), "https://allowed.example");

    const ownerMcp = new Client({ name: "owner-role-test", version: "1.0.0" });
    await ownerMcp.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${restrictedOwnerToken}` } },
    }) as unknown as Parameters<typeof ownerMcp.connect>[0]);
    globalThis.fetch = async (input, init) => {
      if (String(input).startsWith(baseUrl)) return originalFetch(input, init);
      return Response.json({ balance: 500 });
    };
    const ownerRefresh = await ownerMcp.callTool({ name: "search_pool_status", arguments: { refreshQuota: true } });
    assert.equal(ownerRefresh.isError, undefined);
    await ownerMcp.close();
    globalThis.fetch = originalFetch;

    const ownerShutdown = await fetch(`${baseUrl}/admin/shutdown`, {
      method: "POST",
      headers: { Authorization: `Bearer ${restrictedOwnerToken}` },
    });
    assert.equal(ownerShutdown.status, 200);
    await Promise.race([shutdownFired.promise, new Promise((r) => setTimeout(r, 1_000))]);
    assert.equal(shutdownCalled, true);
  } finally {
    globalThis.fetch = originalFetch;
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    await runtime.close();
    await toolkit.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("HTTP enforces maxTotalSessions, authFailuresPerMinute, and initsPerMinute limits", async () => {
  const directory = mkdtempSync(join(tmpdir(), "search-toolkit-http-caps-"));
  const configPath = join(directory, "providers.json");
  writeFileSync(configPath, JSON.stringify({
    version: 2,
    statePath: join(directory, "state.db"),
    providers: {
      brave: { enabled: true, auto: ["search"], keys: ["k1"], integration: { kind: "rest", adapter: "brave" } },
    },
  }));
  const tokenA = "cap-token-a";
  const tokenB = "cap-token-b";
  const toolkit = new SearchToolkit(configPath);
  await toolkit.initialize();
  const runtime = createSearchToolkitHttpApp(toolkit, {
    tokens: [
      { hash: sha256(tokenA), role: "client" },
      { hash: sha256(tokenB), role: "client" },
    ],
    maxTotalSessions: 2,
    authFailuresPerMinute: 2,
    initsPerMinute: 2,
  });
  const listener = runtime.app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => listener.once("listening", resolve));
  const url = `http://127.0.0.1:${(listener.address() as AddressInfo).port}/mcp`;
  try {
    // initsPerMinute: 2 on tokenA -> 2 succeed, 3rd returns 429 with Retry-After.
    const initA1 = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${tokenA}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: initPayload(1),
    });
    assert.equal(initA1.status, 200);
    await initA1.body?.cancel();

    const initA2 = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${tokenA}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: initPayload(2),
    });
    assert.equal(initA2.status, 200);
    await initA2.body?.cancel();

    const initA3 = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${tokenA}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: initPayload(3),
    });
    assert.equal(initA3.status, 429);
    assert.ok(Number(initA3.headers.get("retry-after")) >= 1);
    assert.match(await initA3.text(), /Too many session initializations; retry in \d+s/);

    // maxTotalSessions: 2 already reached by tokenA's 2 sessions -> tokenB initialize hits global cap 429.
    const initB1 = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${tokenB}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: initPayload(4),
    });
    assert.equal(initB1.status, 429);
    assert.match(await initB1.text(), /Too many active sessions on this server/);

    // authFailuresPerMinute: 2 -> two 401s, then 429 with Retry-After.
    for (let i = 0; i < 2; i += 1) {
      const fail = await fetch(url, {
        method: "POST",
        headers: { Authorization: "Bearer wrong-token", "Content-Type": "application/json" },
        body: initPayload(10 + i),
      });
      assert.equal(fail.status, 401);
    }
    const blocked = await fetch(url, {
      method: "POST",
      headers: { Authorization: "Bearer wrong-token", "Content-Type": "application/json" },
      body: initPayload(12),
    });
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers.get("retry-after")) >= 1);
    assert.match(await blocked.text(), /Too many failed authentication attempts; retry in \d+s/);
  } finally {
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    await runtime.close();
    await toolkit.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Session TTL reaper skips sessions with in-flight calls and evicts idle sessions", async () => {
  const directory = mkdtempSync(join(tmpdir(), "search-toolkit-http-ttl-"));
  const configPath = join(directory, "providers.json");
  writeFileSync(configPath, JSON.stringify({
    version: 2,
    statePath: join(directory, "state.db"),
    providers: {
      brave: { enabled: true, auto: ["search"], keys: ["k1"], integration: { kind: "rest", adapter: "brave" } },
    },
  }));
  const token = "ttl-test-token";
  const toolkit = new SearchToolkit(configPath, { cache: false });
  await toolkit.initialize();
  const runtime = createSearchToolkitHttpApp(toolkit, {
    tokens: [{ hash: sha256(token), role: "owner" }],
    sessionTtlMs: 1_000,
  });
  const listener = runtime.app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => listener.once("listening", resolve));
  const baseUrl = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
  const originalFetch = globalThis.fetch;

  const busyClient = new Client({ name: "ttl-busy", version: "1.0.0" });
  const busyTransport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const idleClient = new Client({ name: "ttl-idle", version: "1.0.0" });
  const idleTransport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const callEntered = deferred();
  const releaseCall = deferred();

  try {
    await busyClient.connect(busyTransport as unknown as Parameters<typeof busyClient.connect>[0]);
    await idleClient.connect(idleTransport as unknown as Parameters<typeof idleClient.connect>[0]);
    const idleSessionId = idleTransport.sessionId!;

    globalThis.fetch = async (input, init) => {
      if (String(input).startsWith(baseUrl)) return originalFetch(input, init);
      callEntered.resolve();
      await releaseCall.promise;
      return Response.json({
        web: { results: [{ url: "https://example.com/alive", title: "Still Alive", description: "Body" }] },
      });
    };

    const busyCall = busyClient.callTool({ name: "search_auto", arguments: { query: "keep alive" } });
    busyCall.catch(() => undefined);
    await callEntered.promise;

    // Wait >2x the 1000ms session TTL so the interval reaper runs at least twice.
    await new Promise((resolve) => setTimeout(resolve, 2_250));

    // Idle session must have been reaped -> 404.
    const idleCheck = await originalFetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Session-Id": idleSessionId,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 50, method: "tools/list", params: {} }),
    });
    assert.equal(idleCheck.status, 404, "idle session should be evicted after TTL");

    // Busy session survived the reaper while inFlight > 0 and completes cleanly.
    releaseCall.resolve();
    const result = await busyCall;
    assert.equal(result.isError, undefined);
    assert.match(String((result.content as Array<{ text?: string }>)[1]?.text), /Still Alive/);
  } finally {
    releaseCall.resolve();
    globalThis.fetch = originalFetch;
    await Promise.allSettled([busyClient.close(), idleClient.close()]);
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    await runtime.close();
    await toolkit.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
