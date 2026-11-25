import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, McpError, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { integrationFingerprint } from "../src/catalog.js";
import { isTimeout, TargetPageError } from "../src/errors.js";
import { RotationStore } from "../src/rotation.js";
import { SearchToolkit } from "../src/toolkit.js";
import type { ProviderConfig } from "../src/types.js";
import { UpstreamMcpProvider } from "../src/upstream.js";

const fakeServer = fileURLToPath(new URL("./fixtures/fake-mcp.js", import.meta.url));

function fakeProvider(
  keys: string[],
  marker: string,
  extraEnv: Record<string, string> = {},
  idleTimeoutMs?: number,
): ProviderConfig {
  return {
    enabled: true,
    auto: [],
    keys,
    integration: {
      kind: "stdio_mcp",
      command: process.execPath,
      args: [fakeServer],
      envKey: "FAKE_KEY",
      env: { FAKE_MARKER: marker, ...extraEnv },
      ...(idleTimeoutMs !== undefined ? { idleTimeoutMs } : {}),
    },
  };
}

function lines(path: string): string[] {
  return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean) : [];
}

function bodyText(output: unknown): string {
  return (output as { content: Array<{ text: string }> }).content.map((block) => block.text).join("\n");
}

async function withUpstream(
  keys: string[],
  run: (context: { provider: UpstreamMcpProvider; rotation: RotationStore; marker: string; call: (tool: string) => Promise<unknown> }) => Promise<void>,
) {
  const directory = mkdtempSync(join(tmpdir(), "search-toolkit-upstream-"));
  const marker = join(directory, "marker.log");
  const rotation = new RotationStore(join(directory, "state.db"));
  const provider = new UpstreamMcpProvider("fake", fakeProvider(keys, marker), rotation);
  try {
    const tools = await provider.discover();
    const bindings = provider.bindingsFor(tools);
    const call = (tool: string) => {
      const binding = bindings.find((item) => item.upstreamName === tool);
      assert.ok(binding, `fake tool ${tool}`);
      return binding.call({});
    };
    await run({ provider, rotation, marker, call });
  } finally {
    await provider.close();
    rotation.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

test("a tool-level error does not blame the key or burn a second key", async () => {
  await withUpstream(["good-1", "good-2"], async ({ rotation, marker, call }) => {
    const output = await call("tool_error") as { isError?: boolean };
    // The upstream's own answer is passed through for the model to read.
    assert.equal(output.isError, true);
    assert.match(bodyText(output), /Status code: 403/);
    assert.equal(lines(marker).filter((line) => line.startsWith("call tool_error")).length, 1);
    const status = rotation.status("fake", ["good-1", "good-2"]);
    const used = status.keys.find((key) => (key.status.requests as number) > 0);
    assert.equal(used?.status.status, "healthy");
    assert.equal(used?.status.tool_errors, 1);
    assert.equal(used?.status.failures, 0);
  });
});

test("an invalid-key tool error disables only that key and retries on the next", async () => {
  await withUpstream(["bad-key", "good-key"], async ({ rotation, marker, call }) => {
    const output = await call("keyed");
    assert.equal(bodyText(output).includes("ok:good-key"), true);
    const status = rotation.status("fake", ["bad-key", "good-key"]);
    assert.equal(status.keys[0]?.status.status, "disabled");
    assert.equal(status.keys[1]?.status.status, "healthy");
    assert.ok(lines(marker).includes("call keyed bad-key"));
  });
});

test("a rate-limit tool error cools the key down instead of leaving it healthy", async () => {
  await withUpstream(["bad-key", "good-key"], async ({ rotation, call }) => {
    const output = await call("limited");
    assert.equal(bodyText(output).includes("ok:good-key"), true);
    assert.equal(rotation.status("fake", ["bad-key", "good-key"]).keys[0]?.status.status, "cooldown");
  });
});

test("a dead upstream process is rebuilt on the next call", async () => {
  await withUpstream(["good-1"], async ({ marker, call }) => {
    await call("crash");
    await sleep(150);
    const output = await call("echo");
    assert.match(bodyText(output), /echo:good-1/);
    assert.ok(lines(marker).filter((line) => line.startsWith("start")).length >= 2, "server restarted");
  });
});

test("discovery falls through a failing key instead of hiding the provider", async () => {
  const directory = mkdtempSync(join(tmpdir(), "search-toolkit-discover-"));
  const rotation = new RotationStore(join(directory, "state.db"));
  // The first key's upstream process exits at startup; the second is healthy.
  const provider = new UpstreamMcpProvider("fake", fakeProvider(["broken", "good-1"], join(directory, "m.log")), rotation);
  try {
    const tools = await provider.discover();
    assert.ok(tools.some((tool) => tool.name === "echo"));
  } finally {
    await provider.close();
    rotation.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

function writeToolkitConfig(directory: string, marker: string, extra: Record<string, unknown> = {}): string {
  const path = join(directory, "providers.json");
  writeFileSync(path, JSON.stringify({
    version: 2,
    statePath: join(directory, "state.db"),
    ...extra,
    providers: {
      fake: {
        enabled: true,
        auto: [],
        keys: ["good-1", "good-2"],
        integration: {
          kind: "stdio_mcp", command: process.execPath, args: [fakeServer], envKey: "FAKE_KEY", env: { FAKE_MARKER: marker },
        },
      },
    },
  }));
  return path;
}

test("startup discovers once, then starts from the cached catalog without spawning the upstream", async () => {
  const directory = mkdtempSync(join(tmpdir(), "search-toolkit-catalog-"));
  const marker = join(directory, "marker.log");
  const configPath = writeToolkitConfig(directory, marker);
  try {
    const first = new SearchToolkit(configPath);
    await first.initialize();
    assert.ok(first.listTools().some((tool) => tool.name === "fake_echo"));
    await first.close();
    const startsAfterFirst = lines(marker).filter((line) => line.startsWith("start")).length;
    assert.ok(startsAfterFirst >= 1);
    assert.equal(existsSync(join(directory, "tool-catalog.json")), false);
    const db = new DatabaseSync(join(directory, "state.db"));
    try {
      const row = db.prepare("SELECT provider FROM tool_catalog WHERE provider = ?").get("fake") as { provider: string } | undefined;
      assert.equal(row?.provider, "fake");
    } finally {
      db.close();
    }

    const second = new SearchToolkit(configPath);
    await second.initialize();
    assert.ok(second.listTools().some((tool) => tool.name === "fake_echo"));
    assert.equal(lines(marker).filter((line) => line.startsWith("start")).length, startsAfterFirst, "no upstream spawned at startup");
    // First real use connects lazily.
    const output = await second.callTool("fake_echo", {});
    assert.match(bodyText(output), /echo:/);
    assert.ok(lines(marker).filter((line) => line.startsWith("start")).length > startsAfterFirst);
    await second.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a stale catalog is served immediately, refreshed in the background, and announced", async () => {
  const directory = mkdtempSync(join(tmpdir(), "search-toolkit-refresh-"));
  const marker = join(directory, "marker.log");
  const configPath = writeToolkitConfig(directory, marker);
  try {
    const seed = new SearchToolkit(configPath);
    await seed.initialize();
    await seed.close();
    // Age the snapshot in SQLite and give it a tool the live upstream no longer has.
    const db = new DatabaseSync(join(directory, "state.db"));
    try {
      db.prepare("UPDATE tool_catalog SET fetched_at = 0, tools = ? WHERE provider = ?")
        .run(JSON.stringify([{ name: "gone", inputSchema: { type: "object" } }]), "fake");
    } finally {
      db.close();
    }

    const toolkit = new SearchToolkit(configPath);
    let changed = 0;
    toolkit.onToolsChanged(() => { changed += 1; });
    await toolkit.initialize();
    assert.ok(toolkit.listTools().some((tool) => tool.name === "fake_gone"), "served from the stale snapshot");
    for (let attempt = 0; attempt < 60 && changed === 0; attempt += 1) await sleep(100);
    assert.equal(changed, 1);
    const names = toolkit.listTools().map((tool) => tool.name);
    assert.ok(names.includes("fake_echo"));
    assert.equal(names.includes("fake_gone"), false);
    await toolkit.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("legacy tool-catalog.json is transparently migrated into SQLite tool_catalog without spawning upstream", async () => {
  const directory = mkdtempSync(join(tmpdir(), "search-toolkit-catalog-migrate-"));
  const marker = join(directory, "marker.log");
  const configPath = writeToolkitConfig(directory, marker);
  const integration: ProviderConfig["integration"] = {
    kind: "stdio_mcp",
    command: process.execPath,
    args: [fakeServer],
    envKey: "FAKE_KEY",
    env: { FAKE_MARKER: marker },
  };
  writeFileSync(join(directory, "tool-catalog.json"), JSON.stringify({
    version: 1,
    providers: {
      fake: {
        fingerprint: integrationFingerprint(integration),
        fetchedAt: Date.now(),
        tools: [{ name: "echo", description: "Legacy cached echo", inputSchema: { type: "object" } }],
      },
    },
  }));
  try {
    const toolkit = new SearchToolkit(configPath);
    await toolkit.initialize();
    assert.ok(toolkit.listTools().some((tool) => tool.name === "fake_echo"));
    assert.equal(lines(marker).length, 0, "migrated catalog avoided spawning upstream at startup");
    await toolkit.close();

    const db = new DatabaseSync(join(directory, "state.db"));
    try {
      const row = db.prepare("SELECT provider, tools FROM tool_catalog WHERE provider = ?").get("fake") as { provider: string; tools: string } | undefined;
      assert.equal(row?.provider, "fake");
      assert.match(row?.tools ?? "", /"echo"/);
    } finally {
      db.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("exposed descriptions are shaped but input schemas stay intact", async () => {
  const directory = mkdtempSync(join(tmpdir(), "search-toolkit-shape-"));
  const configPath = writeToolkitConfig(directory, join(directory, "m.log"));
  try {
    const toolkit = new SearchToolkit(configPath);
    await toolkit.initialize();
    const echo = toolkit.listTools().find((tool) => tool.name === "fake_echo");
    assert.ok(echo);
    assert.ok((echo.description ?? "").length <= 705, `description ${echo.description?.length}`);
    const properties = (echo.inputSchema as unknown as { properties: { query: { type: string; description: string } } }).properties;
    assert.equal(properties.query.type, "string");
    assert.ok(properties.query.description.length <= 225);
    await toolkit.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an idle stdio_mcp child closes after idleTimeoutMs and respawns transparently on the next call", async () => {
  const directory = mkdtempSync(join(tmpdir(), "search-toolkit-idle-"));
  const marker = join(directory, "marker.log");
  const rotation = new RotationStore(join(directory, "state.db"));
  const provider = new UpstreamMcpProvider("fake", fakeProvider(["good-1"], marker, {}, 120), rotation);
  try {
    const tools = await provider.discover();
    const echo = provider.bindingsFor(tools).find((item) => item.upstreamName === "echo");
    assert.ok(echo);
    const first = await echo.call({});
    assert.match(bodyText(first), /echo:good-1/);
    const startsBeforeIdle = lines(marker).filter((line) => line.startsWith("start")).length;
    assert.equal(startsBeforeIdle, 1);

    await sleep(280);
    const second = await echo.call({});
    assert.match(bodyText(second), /echo:good-1/);
    const startsAfterIdle = lines(marker).filter((line) => line.startsWith("start")).length;
    assert.ok(startsAfterIdle >= 2, `expected idle child to close and respawn, starts=${startsAfterIdle}`);
  } finally {
    await provider.close();
    rotation.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

interface RemoteMcpHandler {
  listTools?: (cursor: string | undefined, req: IncomingMessage) => Promise<{ tools: Tool[]; nextCursor?: string }> | { tools: Tool[]; nextCursor?: string };
  callTool?: (name: string, args: Record<string, unknown>, req: IncomingMessage, signal: AbortSignal) => Promise<Record<string, unknown>>;
}

async function startRemoteMcp(handler: RemoteMcpHandler): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const parsedBody = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    const abortController = new AbortController();
    res.on("close", () => abortController.abort());

    const mcpServer = new Server({ name: "test-remote-mcp", version: "1.0.0" }, { capabilities: { tools: {} } });
    mcpServer.setRequestHandler(ListToolsRequestSchema, async (request) => {
      if (handler.listTools) return handler.listTools(request.params?.cursor, req);
      return { tools: [{ name: "ping", inputSchema: { type: "object" as const } }] };
    });
    mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
      if (handler.callTool) {
        return handler.callTool(
          request.params.name,
          (request.params.arguments ?? {}) as Record<string, unknown>,
          req,
          abortController.signal,
        );
      }
      return { content: [{ type: "text", text: "pong" }] };
    });

    const transport = new StreamableHTTPServerTransport({});
    await mcpServer.connect(transport);
    res.on("close", () => {
      void transport.close();
      void mcpServer.close();
    });
    await transport.handleRequest(req, res, parsedBody);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test("remote_mcp supports bearer, header, query, and keyless auth plus paginated tools/list", async () => {
  const seenAuth: string[] = [];
  const remote = await startRemoteMcp({
    listTools: (cursor, req) => {
      const parsed = new URL(req.url ?? "/mcp", "http://127.0.0.1");
      seenAuth.push(
        req.headers.authorization
          ?? (typeof req.headers["x-custom-key"] === "string" ? `header:${req.headers["x-custom-key"]}` : undefined)
          ?? (parsed.searchParams.get("apiKey") ? `query:${parsed.searchParams.get("apiKey")}` : "none"),
      );
      if (!cursor) {
        return {
          tools: [{ name: "tool_page_1", inputSchema: { type: "object" as const } }],
          nextCursor: "page-2",
        };
      }
      return {
        tools: [{ name: "tool_page_2", inputSchema: { type: "object" as const } }],
      };
    },
    callTool: async (name) => ({ content: [{ type: "text", text: `called:${name}` }] }),
  });

  const directory = mkdtempSync(join(tmpdir(), "search-toolkit-remote-auth-"));
  const rotation = new RotationStore(join(directory, "state.db"));
  const authCases: Array<{
    name: string;
    keys: string[];
    auth: Extract<ProviderConfig["integration"], { kind: "remote_mcp" }>["auth"];
    expected: string;
  }> = [
    { name: "r_bearer", keys: ["tok-bearer"], auth: { kind: "bearer" }, expected: "Bearer tok-bearer" },
    { name: "r_header", keys: ["tok-header"], auth: { kind: "header", name: "X-Custom-Key" }, expected: "header:tok-header" },
    { name: "r_query", keys: ["tok-query"], auth: { kind: "query", name: "apiKey" }, expected: "query:tok-query" },
    { name: "r_none", keys: [], auth: { kind: "none" }, expected: "none" },
  ];

  try {
    for (const item of authCases) {
      seenAuth.length = 0;
      const provider = new UpstreamMcpProvider(item.name, {
        enabled: true,
        auto: [],
        keys: item.keys,
        integration: { kind: "remote_mcp", url: remote.url, auth: item.auth },
      }, rotation);
      try {
        const discovered = await provider.discover();
        assert.deepEqual(discovered.map((t) => t.name), ["tool_page_1", "tool_page_2"], `${item.name} pagination`);
        assert.ok(seenAuth.length >= 2 && seenAuth.every((val) => val === item.expected), `${item.name} auth ${JSON.stringify(seenAuth)}`);
        const binding = provider.bindingsFor(discovered)[0];
        assert.ok(binding);
        assert.match(bodyText(await binding.call({})), /called:tool_page_1/);
      } finally {
        await provider.close();
      }
    }
  } finally {
    rotation.close();
    await remote.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("remote_mcp enforces integration.timeoutMs, protects fetch keys on 401/429, maps Firecrawl index_daily_limit to 402, and defers dropClient while sibling calls are inFlight", async () => {
  let flakyAttempts = 0;
  let rpcFetchCalls = 0;
  const remote = await startRemoteMcp({
    listTools: () => ({
      tools: [
        { name: "slow_op", inputSchema: { type: "object" as const } },
        { name: "web_fetch_exa", inputSchema: { type: "object" as const } },
        { name: "firecrawl_search", inputSchema: { type: "object" as const } },
        { name: "flaky_conn", inputSchema: { type: "object" as const } },
        { name: "sibling_slow", inputSchema: { type: "object" as const } },
      ],
    }),
    callTool: async (name, args, req, signal) => {
      const auth = req.headers.authorization ?? "";
      if (name === "slow_op") {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 4_000);
          signal.addEventListener("abort", () => {
            clearTimeout(timer);
            resolve();
          }, { once: true });
        });
        return { content: [{ type: "text", text: "too late" }] };
      }
      if (name === "web_fetch_exa") {
        if (args.mode === "tool_401") {
          return { isError: true, content: [{ type: "text", text: "Error: Unauthorized (401)" }] };
        }
        rpcFetchCalls += 1;
        throw new McpError(-32_603, "Target site responded with HTTP 429 Too Many Requests");
      }
      if (name === "firecrawl_search") {
        if (auth === "Bearer fc-key-1") {
          return {
            isError: true,
            content: [{ type: "text", text: "Daily index limit reached" }],
            structuredContent: { error: { code: "index_daily_limit" } },
          };
        }
        return { content: [{ type: "text", text: "ok:fc-key-2" }] };
      }
      if (name === "flaky_conn") {
        flakyAttempts += 1;
        if (flakyAttempts === 1) throw new McpError(-32_000, "Connection closed");
        return { content: [{ type: "text", text: "flaky-recovered" }] };
      }
      if (name === "sibling_slow") {
        await sleep(120);
        return { content: [{ type: "text", text: "sibling-ok" }] };
      }
      return { content: [{ type: "text", text: "ok" }] };
    },
  });

  const directory = mkdtempSync(join(tmpdir(), "search-toolkit-remote-runtime-"));
  const rotation = new RotationStore(join(directory, "state.db"));
  try {
    // 1. Configurable integration.timeoutMs enforced on invoke().
    const timed = new UpstreamMcpProvider("timed", {
      enabled: true,
      auto: [],
      keys: [],
      integration: { kind: "remote_mcp", url: remote.url, auth: { kind: "none" }, timeoutMs: 1_000 },
    }, rotation);
    try {
      const tools = await timed.discover();
      const slow = timed.bindingsFor(tools).find((b) => b.upstreamName === "slow_op");
      assert.ok(slow);
      const started = performance.now();
      await assert.rejects(slow.call({}), (err: unknown) => isTimeout(err));
      assert.ok(performance.now() - started < 3_000, "call should time out near integration.timeoutMs");
    } finally {
      await timed.close();
    }

    // 2. Fetch tool target-site 401 (isError) and 429 (JSON-RPC -32603 -> TargetPageError) leave healthy keys intact.
    const fetcher = new UpstreamMcpProvider("exa", {
      enabled: true,
      auto: ["fetch"],
      keys: ["exa-key-1", "exa-key-2"],
      integration: { kind: "remote_mcp", url: remote.url, auth: { kind: "bearer" } },
    }, rotation);
    try {
      const tools = await fetcher.discover();
      const fetchBinding = fetcher.bindingsFor(tools).find((b) => b.upstreamName === "web_fetch_exa");
      assert.ok(fetchBinding);
      const errOut = await fetchBinding.call({ mode: "tool_401" }) as { isError?: boolean };
      assert.equal(errOut.isError, true);
      await assert.rejects(
        fetchBinding.call({ mode: "rpc_429" }),
        (err: unknown) => err instanceof TargetPageError && err.pageStatus === 429,
      );
      assert.equal(rpcFetchCalls, 1, "TargetPageError must not retry a second key");
      const exaStatus = rotation.status("exa", ["exa-key-1", "exa-key-2"]);
      for (const slot of exaStatus.keys) {
        assert.equal(slot.status.status, "healthy");
        assert.equal(slot.status.failures, 0);
      }
    } finally {
      await fetcher.close();
    }

    // 3. Firecrawl structuredKeyFault maps index_daily_limit -> 402 exhausted and retries key 2.
    const firecrawl = new UpstreamMcpProvider("firecrawl", {
      enabled: true,
      auto: ["search"],
      keys: ["fc-key-1", "fc-key-2"],
      integration: { kind: "remote_mcp", url: remote.url, auth: { kind: "bearer" } },
    }, rotation);
    try {
      const tools = await firecrawl.discover();
      const fcSearch = firecrawl.bindingsFor(tools).find((b) => b.upstreamName === "firecrawl_search");
      assert.ok(fcSearch);
      const res = await fcSearch.call({});
      assert.match(bodyText(res), /ok:fc-key-2/);
      const fcStatus = rotation.status("firecrawl", ["fc-key-1", "fc-key-2"]);
      assert.equal(fcStatus.keys[0]?.status.status, "exhausted");
      assert.equal(fcStatus.keys[0]?.status.last_http_status, 402);
      assert.equal(fcStatus.keys[1]?.status.status, "healthy");
    } finally {
      await firecrawl.close();
    }

    // 4. dropClient defers transport close while a sibling request is still in-flight on the same key.
    const concurrent = new UpstreamMcpProvider("conc", {
      enabled: true,
      auto: [],
      keys: ["shared-key"],
      integration: { kind: "remote_mcp", url: remote.url, auth: { kind: "bearer" } },
    }, rotation);
    try {
      const tools = await concurrent.discover();
      const bindings = concurrent.bindingsFor(tools);
      const sibling = bindings.find((b) => b.upstreamName === "sibling_slow");
      const flaky = bindings.find((b) => b.upstreamName === "flaky_conn");
      assert.ok(sibling && flaky);
      const siblingPromise = sibling.call({});
      await sleep(20);
      const flakyPromise = flaky.call({});
      const [siblingOut, flakyOut] = await Promise.all([siblingPromise, flakyPromise]);
      assert.match(bodyText(siblingOut), /sibling-ok/);
      assert.match(bodyText(flakyOut), /flaky-recovered/);
      assert.equal(flakyAttempts, 2);
    } finally {
      await concurrent.close();
    }
  } finally {
    rotation.close();
    await remote.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
