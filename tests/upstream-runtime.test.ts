import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { RotationStore } from "../src/rotation.js";
import { SearchToolkit } from "../src/toolkit.js";
import type { ProviderConfig } from "../src/types.js";
import { UpstreamMcpProvider } from "../src/upstream.js";

const fakeServer = fileURLToPath(new URL("./fixtures/fake-mcp.js", import.meta.url));

function fakeProvider(keys: string[], marker: string, extraEnv: Record<string, string> = {}): ProviderConfig {
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
    assert.ok(existsSync(join(directory, "tool-catalog.json")));

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
    // Age the snapshot and give it a tool the live upstream no longer has.
    const cachePath = join(directory, "tool-catalog.json");
    const cache = JSON.parse(readFileSync(cachePath, "utf8")) as { providers: Record<string, { fetchedAt: number; tools: unknown[] }> };
    const entry = cache.providers.fake as { fetchedAt: number; tools: Array<Record<string, unknown>> };
    entry.fetchedAt = 0;
    entry.tools = [{ name: "gone", inputSchema: { type: "object" } }];
    writeFileSync(cachePath, JSON.stringify(cache));

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
