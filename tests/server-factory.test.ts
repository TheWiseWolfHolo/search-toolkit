import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createProtocolServer } from "../src/server-factory.js";
import { SearchToolkit } from "../src/toolkit.js";

function nestedObject(depth: number): Record<string, unknown> {
  let node: Record<string, unknown> = { leaf: 1 };
  for (let i = 1; i < depth; i += 1) {
    node = { child: node };
  }
  return node;
}

test("shared MCP server enforces tool input schemas", async () => {
  const directory = mkdtempSync(join(tmpdir(), "search-toolkit-server-"));
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
  const toolkit = new SearchToolkit(configPath);
  await toolkit.initialize();
  const server = createProtocolServer(toolkit);
  const client = new Client({ name: "search-toolkit-validation-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    for (const arguments_ of [
      {},
      { query: "" },
      { query: "image", limit: "abc" },
      { query: "image", limit: 21 },
      { query: "image", bogusField: true },
    ]) {
      const result = await client.callTool({ name: "search_images", arguments: arguments_ });
      assert.equal(result.isError, true);
      const content = result.content as Array<{ type: string; text?: string }>;
      assert.match(String(content[0]?.text ?? ""), /Invalid arguments for search_images/);
    }
  } finally {
    await client.close();
    await server.close();
    await toolkit.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("results cross MCP as readable content only, because clients show structuredContent instead", async () => {
  const directory = mkdtempSync(join(tmpdir(), "search-toolkit-server-"));
  const configPath = join(directory, "providers.json");
  writeFileSync(configPath, JSON.stringify({
    version: 2,
    statePath: join(directory, "state.db"),
    providers: { brave: { enabled: true, auto: ["search"], keys: ["test-key"], integration: { kind: "rest", adapter: "brave" } } },
  }));
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    web: { results: [{ url: "https://example.com/", title: "Example", description: "Readable excerpt" }] },
  }), { status: 200 });
  const toolkit = new SearchToolkit(configPath);
  await toolkit.initialize();
  const server = createProtocolServer(toolkit);
  const client = new Client({ name: "search-toolkit-content-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const result = await client.callTool({ name: "search_auto", arguments: { query: "example" } });
    assert.equal(result.structuredContent, undefined);
    const content = result.content as Array<{ text?: string }>;
    assert.match(String(content[0]?.text), /"searchToolkitRoute":\{"provider":"brave"/);
    assert.match(String(content[1]?.text), /1\. Example\n {3}https:\/\/example\.com\/\n {3}Readable excerpt/);
    const status = await client.callTool({ name: "search_pool_status", arguments: {} });
    assert.equal((JSON.parse(String((status.content as Array<{ text?: string }>)[0]?.text)) as { version: number }).version, 2);
  } finally {
    globalThis.fetch = original;
    await client.close();
    await server.close();
    await toolkit.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("buildInstructions adapts dynamically to visible and accessible tools", async () => {
  const directory = mkdtempSync(join(tmpdir(), "search-toolkit-instr-"));
  const configPath = join(directory, "providers.json");
  writeFileSync(configPath, JSON.stringify({
    version: 2,
    statePath: join(directory, "state.db"),
    providers: {
      brave: { enabled: true, auto: ["search"], keys: ["k1"], integration: { kind: "rest", adapter: "brave" } },
      parallel: { enabled: true, auto: ["search"], keys: ["k2"], integration: { kind: "rest", adapter: "parallel" } },
      doubao: { enabled: true, auto: [], keys: ["k3"], integration: { kind: "rest", adapter: "doubao" } },
      grok: { enabled: true, auto: [], keys: ["k4"], integration: { kind: "rest", adapter: "grok" } },
    },
  }));
  const toolkit = new SearchToolkit(configPath);
  await toolkit.initialize();

  const connectWith = async (opts: Parameters<typeof createProtocolServer>[1]) => {
    const server = createProtocolServer(toolkit, opts);
    const client = new Client({ name: "instr-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return {
      instructions: client.getInstructions() ?? "",
      capabilities: client.getServerCapabilities(),
      close: async () => {
        await client.close();
        await server.close();
      },
    };
  };

  try {
    // Restricted client sees only search_auto: no hints about Brave/You/Parallel/Doubao/Grok/probe/writes.
    const restricted = await connectWith({ allowTool: (tool) => tool.name === "search_auto" });
    try {
      assert.match(restricted.instructions, /search_auto/);
      assert.doesNotMatch(restricted.instructions, /Brave LLM Context|You\.com|Parallel|Doubao|Grok|Rotation probes|create, update, delete/);
    } finally {
      await restricted.close();
    }

    // Full server with all 4 providers mentions their capabilities, manual warnings, and rotation probes.
    const full = await connectWith({ profile: "full" });
    try {
      assert.match(full.instructions, /Brave LLM Context/);
      assert.match(full.instructions, /Parallel suits semantic objectives/);
      assert.match(full.instructions, /Doubao is manual-only/);
      assert.match(full.instructions, /Grok/);
      assert.match(full.instructions, /Rotation probes consume quota/);
      assert.doesNotMatch(full.instructions, /You\.com/);
    } finally {
      await full.close();
    }

    // Lean profile mentions gateway (provider_tools + provider_call) and write/action warning.
    const lean = await connectWith({ profile: "lean" });
    try {
      assert.match(lean.instructions, /provider_tools \+ provider_call/);
      assert.match(lean.instructions, /create, update, delete/);
    } finally {
      await lean.close();
    }

    // Empty allowTool falls back to generic instructions.
    const empty = await connectWith({ allowTool: () => false });
    try {
      assert.match(empty.instructions, /Use the exposed Search Toolkit tools/);
    } finally {
      await empty.close();
    }
  } finally {
    await toolkit.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("listChanged:false disables capability and omits onToolsChanged subscription; maxToolInputDepth, isOwner, hooks, and _meta stripping work", async () => {
  const directory = mkdtempSync(join(tmpdir(), "search-toolkit-opts-"));
  const configPath = join(directory, "providers.json");
  writeFileSync(configPath, JSON.stringify({
    version: 2,
    statePath: join(directory, "state.db"),
    providers: {
      brave: { enabled: true, auto: ["search"], keys: ["k1"], integration: { kind: "rest", adapter: "brave" } },
    },
  }));
  const toolkit = new SearchToolkit(configPath);
  await toolkit.initialize();

  let subscribeCalls = 0;
  const origOnToolsChanged = toolkit.onToolsChanged.bind(toolkit);
  toolkit.onToolsChanged = (listener) => {
    subscribeCalls += 1;
    return origOnToolsChanged(listener);
  };

  let starts = 0;
  let ends = 0;
  const server = createProtocolServer(toolkit, {
    listChanged: false,
    isOwner: false,
    maxToolInputElements: 10_000,
    maxToolInputDepth: 5,
    onCallStart: () => { starts += 1; },
    onCallEnd: () => { ends += 1; },
  });
  const client = new Client({ name: "opts-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  try {
    assert.equal(subscribeCalls, 0, "listChanged:false must not subscribe to onToolsChanged");
    assert.equal(client.getServerCapabilities()?.tools?.listChanged, false);

    // Custom maxToolInputDepth rejects overly deep objects before AJV.
    const tooDeep = await client.callTool({
      name: "search_auto",
      arguments: { query: "test", nested: nestedObject(6) },
    });
    assert.equal(tooDeep.isError, true);
    assert.match(String((tooDeep.content as Array<{ text?: string }>)[0]?.text), /maximum nesting depth of 5/);

    // isOwner:false blocks search_pool_status({ refreshQuota: true }) while allowing normal status.
    const deniedRefresh = await client.callTool({ name: "search_pool_status", arguments: { refreshQuota: true } });
    assert.equal(deniedRefresh.isError, true);
    assert.match(String((deniedRefresh.content as Array<{ text?: string }>)[0]?.text), /refreshQuota requires owner access/);

    const okStatus = await client.callTool({ name: "search_pool_status", arguments: {} });
    assert.equal(okStatus.isError, undefined);

    // Unknown tool also balances onCallStart / onCallEnd.
    const unknown = await client.callTool({ name: "does_not_exist", arguments: {} });
    assert.equal(unknown.isError, true);
    assert.equal(starts, 4);
    assert.equal(ends, 4);

    // _meta boundary stripping removes upstream keys outside searchToolkit.
    const bindings = (toolkit as unknown as { bindings: Map<string, { call: (args: Record<string, unknown>) => Promise<unknown> }> }).bindings;
    const braveBinding = bindings.get("brave_web_search");
    assert.ok(braveBinding);
    const origCall = braveBinding.call;
    braveBinding.call = async () => ({
      content: [{ type: "text", text: "ok" }],
      _meta: { searchToolkit: { provider: "brave" }, upstreamSecretTrace: "drop-me" },
    });
    try {
      const stripped = await client.callTool({ name: "brave_web_search", arguments: { query: "meta test" } });
      assert.deepEqual(stripped._meta, { searchToolkit: { provider: "brave" } });
    } finally {
      braveBinding.call = origCall;
    }

    // Default maxToolInputDepth (64) rejects 65-deep input.
    const defaultServer = createProtocolServer(toolkit, { maxToolInputElements: 10_000 });
    const defaultClient = new Client({ name: "default-depth-test", version: "1.0.0" });
    const [ct2, st2] = InMemoryTransport.createLinkedPair();
    await defaultServer.connect(st2);
    await defaultClient.connect(ct2);
    try {
      assert.equal(subscribeCalls, 1, "default listChanged:true subscribes once");
      assert.equal(defaultClient.getServerCapabilities()?.tools?.listChanged, true);
      const deep65 = await defaultClient.callTool({
        name: "search_auto",
        arguments: { query: "test", nested: nestedObject(65) },
      });
      assert.equal(deep65.isError, true);
      assert.match(String((deep65.content as Array<{ text?: string }>)[0]?.text), /maximum nesting depth of 64/);
    } finally {
      await defaultClient.close();
      await defaultServer.close();
    }

    // Standalone maxToolInputDepth (without maxToolInputElements) still enforces nesting depth.
    const depthOnlyServer = createProtocolServer(toolkit, { maxToolInputDepth: 4 });
    const depthOnlyClient = new Client({ name: "depth-only-test", version: "1.0.0" });
    const [ct3, st3] = InMemoryTransport.createLinkedPair();
    await depthOnlyServer.connect(st3);
    await depthOnlyClient.connect(ct3);
    try {
      const deep5 = await depthOnlyClient.callTool({
        name: "search_auto",
        arguments: { query: "test", nested: nestedObject(5) },
      });
      assert.equal(deep5.isError, true);
      assert.match(String((deep5.content as Array<{ text?: string }>)[0]?.text), /maximum nesting depth of 4/);
    } finally {
      await depthOnlyClient.close();
      await depthOnlyServer.close();
    }
  } finally {
    await client.close();
    await server.close();
    await toolkit.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
