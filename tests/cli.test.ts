import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cliScript = fileURLToPath(new URL("../src/cli.js", import.meta.url));

function runCli(
  args: string[],
  options: { stdin?: string; env?: Record<string, string | undefined> } = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.SEARCH_TOOLKIT_CONFIG;
    delete env.SEARCH_TOOLKIT_PROFILE;
    delete env.SEARCH_TOOLKIT_CACHE;
    for (const [key, value] of Object.entries(options.env ?? {})) {
      if (value === undefined) delete env[key];
      else env[key] = value;
    }

    const child = spawn(process.execPath, [cliScript, ...args], {
      env,
      stdio: [options.stdin !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`CLI timed out (args=${args.join(" ")})\nstdout=${stdout}\nstderr=${stderr}`));
    }, 15_000);
    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    if (options.stdin !== undefined && child.stdin) {
      child.stdin.end(options.stdin);
    }
  });
}

interface MockHit {
  method: string;
  path: string;
  apiKey: string;
  body: Record<string, unknown>;
}

async function startMockSerper() {
  const hits: MockHit[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: Record<string, unknown> = {};
      if (raw) {
        try { body = JSON.parse(raw) as Record<string, unknown>; } catch { /* ignore */ }
      }
      const apiKey = String(req.headers["x-api-key"] ?? "");
      const path = (req.url ?? "/").split("?")[0] ?? "/";
      hits.push({ method: req.method ?? "GET", path, apiKey, body });

      if (apiKey === "bad-key-401") {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ message: "Unauthorized key" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      if (path === "/account") {
        res.end(JSON.stringify({ balance: 1234 }));
      } else if (path === "/search") {
        res.end(JSON.stringify({
          organic: [{ title: `Mock Result for ${String(body.q ?? "")}`, link: "https://example.com/mock", snippet: "Mock snippet text" }],
        }));
      } else if (path === "/images") {
        res.end(JSON.stringify({
          images: [{ title: "Mock Image", imageUrl: "https://example.com/img.jpg", link: "https://example.com/gallery", source: "Example" }],
        }));
      } else if (path === "/lens") {
        res.end(JSON.stringify({
          organic: [{ title: "Lens Match", link: "https://example.com/match", imageUrl: "https://example.com/thumb.jpg", source: "Example" }],
        }));
      } else {
        res.writeHead(404);
        res.end("{}");
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}/search`,
    hits,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test("CLI version, help at any position, unknown flag rejection, and -- separator handling", async () => {
  const ver = await runCli(["--version"]);
  assert.equal(ver.code, 0);
  assert.match(ver.stdout.trim(), /^\d+\.\d+\.\d+/);

  const verShort = await runCli(["-v"]);
  assert.equal(verShort.code, 0);
  assert.equal(verShort.stdout.trim(), ver.stdout.trim());

  const cmdHelp = await runCli(["search", "--help"]);
  assert.equal(cmdHelp.code, 0);
  assert.match(cmdHelp.stdout, /search-toolkit search <query>/);

  const helpTopic = await runCli(["help", "quota"]);
  assert.equal(helpTopic.code, 0);
  assert.match(helpTopic.stdout, /search-toolkit quota \[provider\]/);

  const unknownFlag = await runCli(["search", "hello", "--bogus-flag"]);
  assert.equal(unknownFlag.code, 1);
  assert.match(unknownFlag.stderr, /Unknown option --bogus-flag for "search"/);

  const badBool = await runCli(["migrate-config", "--write=maybe"]);
  assert.equal(badBool.code, 1);
  assert.match(badBool.stderr, /--write expects true or false/);

  // Value flags must reject the `--` separator instead of consuming it as a literal value.
  const limitDashDash = await runCli(["search", "hello", "--limit", "--"]);
  assert.equal(limitDashDash.code, 1);
  assert.match(limitDashDash.stderr, /--limit requires a value/);

  const inputDashDash = await runCli(["call", "serper_search", "--input", "--"]);
  assert.equal(inputDashDash.code, 1);
  assert.match(inputDashDash.stderr, /--input requires a value/);
});

test("CLI migrate-config respects --write=false dry-run and works offline with unset env:/file: refs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "search-toolkit-cli-mig-"));
  const configPath = join(dir, "providers.json");
  const originalDoc = {
    version: 1,
    statePath: join(dir, "state.db"),
    providers: {
      serper: {
        enabled: true,
        automatic: true,
        keys: ["env:TEST_CLI_UNSET_ENABLED_KEY_999", "file:/nonexistent/offline-mig.key"],
        integration: { kind: "rest", adapter: "serper" },
        options: { unusedFlag: true },
      },
      disabled_one: {
        enabled: false,
        automatic: false,
        keys: ["env:TEST_CLI_UNSET_DISABLED_KEY"],
        integration: { kind: "rest", adapter: "brave" },
      },
    },
  };
  writeFileSync(configPath, JSON.stringify(originalDoc, null, 2));

  try {
    const dryRun = await runCli(["migrate-config", "--config", configPath, "--write=false", "--json"]);
    assert.equal(dryRun.code, 0, dryRun.stderr);
    const dryJson = JSON.parse(dryRun.stdout) as { ok: boolean; dryRun: boolean; changes: string[] };
    assert.equal(dryJson.ok, true);
    assert.equal(dryJson.dryRun, true);
    assert.ok(dryJson.changes.length >= 1);
    assert.equal((JSON.parse(readFileSync(configPath, "utf8")) as { version: number }).version, 1, "--write=false must not modify file");
    assert.equal(readdirSync(dir).filter((f) => f.includes(".bak-")).length, 0);

    const written = await runCli(["migrate-config", "--config", configPath, "--write", "--json"]);
    assert.equal(written.code, 0, written.stderr);
    const writeJson = JSON.parse(written.stdout) as { ok: boolean; dryRun: boolean; backup?: string };
    assert.equal(writeJson.ok, true);
    assert.equal(writeJson.dryRun, false);
    assert.ok(writeJson.backup);
    assert.equal(readdirSync(dir).filter((f) => f.includes(".bak-")).length, 1);

    const updatedRaw = readFileSync(configPath, "utf8");
    const updated = JSON.parse(updatedRaw) as { version: number; providers: { serper: { keys: string[] } } };
    assert.equal(updated.version, 2);
    assert.deepEqual(updated.providers.serper.keys, ["env:TEST_CLI_UNSET_ENABLED_KEY_999", "file:/nonexistent/offline-mig.key"]);

    const clean = await runCli(["migrate-config", "--config", configPath, "--json"]);
    assert.equal(clean.code, 0, clean.stderr);
    assert.deepEqual((JSON.parse(clean.stdout) as { changes: string[] }).changes, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI search, images, call (inline/@file/--input/stdin), tools, config, reset, cache-clear, quota, and probe end-to-end offline", async () => {
  const dir = mkdtempSync(join(tmpdir(), "search-toolkit-cli-e2e-"));
  const mock = await startMockSerper();
  const configPath = join(dir, "providers.json");
  const argsFile = join(dir, "call-args.json");
  writeFileSync(argsFile, JSON.stringify({ query: "from-file", limit: 2 }));
  writeFileSync(configPath, JSON.stringify({
    version: 2,
    statePath: join(dir, "state.db"),
    providers: {
      serper: {
        enabled: true,
        auto: ["search", "images"],
        strategy: "drain",
        keys: ["good-key-123456", "bad-key-401"],
        integration: { kind: "rest", adapter: "serper", baseUrl: mock.baseUrl },
      },
      bad_serper: {
        enabled: true,
        auto: [],
        keys: ["bad-key-401"],
        integration: { kind: "rest", adapter: "serper", baseUrl: mock.baseUrl },
      },
      disabled_serper: {
        enabled: false,
        auto: [],
        keys: ["file:/nonexistent/private/serper.key"],
        integration: { kind: "rest", adapter: "serper", baseUrl: mock.baseUrl },
      },
      vercel_gateway: {
        enabled: true,
        auto: [],
        keys: ["vck-test-key-123456"],
        integration: { kind: "rest", adapter: "vercel_gateway" },
      },
    },
  }));

  try {
    // -- stops option parsing so query starting with -- works cleanly.
    const searched = await runCli(["search", "--config", configPath, "--no-cache", "--", "--not-a-flag"]);
    assert.equal(searched.code, 0, searched.stderr);
    assert.match(searched.stdout, /Mock Result for --not-a-flag/);

    // images: --query vs --image-url and mutual exclusion error.
    const imgQuery = await runCli(["images", "--config", configPath, "--no-cache", "--query", "alpine peaks"]);
    assert.equal(imgQuery.code, 0, imgQuery.stderr);
    assert.match(imgQuery.stdout, /Mock Image/);
    assert.equal(mock.hits.at(-1)?.path, "/images");

    const imgLens = await runCli(["images", "--config", configPath, "--no-cache", "--image-url", "https://example.com/pic.jpg"]);
    assert.equal(imgLens.code, 0, imgLens.stderr);
    assert.match(imgLens.stdout, /Lens Match/);
    assert.equal(mock.hits.at(-1)?.path, "/lens");

    const imgBoth = await runCli(["images", "--config", configPath, "--query", "a", "--image-url", "https://example.com/pic.jpg"]);
    assert.equal(imgBoth.code, 1);
    assert.match(imgBoth.stderr, /Provide either --query or --image-url, not both/);

    // call: inline JSON, @file, --input file, --input - (stdin).
    const callInline = await runCli(["call", "--config", configPath, "serper_search", '{"query":"inline-q","limit":1}']);
    assert.equal(callInline.code, 0, callInline.stderr);
    assert.match(callInline.stdout, /Mock Result for inline-q/);

    const callAtFile = await runCli(["call", "--config", configPath, "serper_search", `@${argsFile}`]);
    assert.equal(callAtFile.code, 0, callAtFile.stderr);
    assert.match(callAtFile.stdout, /Mock Result for from-file/);

    const callInputFile = await runCli(["call", "--config", configPath, "serper_search", "--input", argsFile]);
    assert.equal(callInputFile.code, 0, callInputFile.stderr);
    assert.match(callInputFile.stdout, /Mock Result for from-file/);

    const callStdin = await runCli(["call", "--config", configPath, "serper_search", "--input", "-"], {
      stdin: JSON.stringify({ query: "from-stdin", limit: 1 }),
    });
    assert.equal(callStdin.code, 0, callStdin.stderr);
    assert.match(callStdin.stdout, /Mock Result for from-stdin/);

    // Validation errors thrown by toolkit.callTool go to stderr and set exit code 1 in both human and --json modes.
    const badCallHuman = await runCli(["call", "--config", configPath, "serper_search", "{}"]);
    assert.equal(badCallHuman.code, 1);
    assert.equal(badCallHuman.stdout.trim(), "");
    assert.match(badCallHuman.stderr, /Invalid arguments for serper_search/);

    const badCallJson = await runCli(["call", "--config", configPath, "serper_search", "{}", "--json"]);
    assert.equal(badCallJson.code, 1);
    assert.equal(badCallJson.stdout.trim(), "");
    assert.match(badCallJson.stderr, /Invalid arguments for serper_search/);

    // tools: --profile lean --json, --provider, --describe.
    const leanTools = await runCli(["tools", "--config", configPath, "--profile", "lean", "--json"]);
    assert.equal(leanTools.code, 0, leanTools.stderr);
    const leanParsed = JSON.parse(leanTools.stdout) as { tools: Array<{ name: string }> };
    assert.equal(leanParsed.tools.length, 7);

    const providerTools = await runCli(["tools", "--config", configPath, "--provider", "serper"]);
    assert.equal(providerTools.code, 0, providerTools.stderr);
    assert.match(providerTools.stdout, /serper_search/);
    assert.match(providerTools.stdout, /serper_lens/);

    // tools --provider vercel_gateway --json must filter by provider membership (not `vercel_gateway_` prefix).
    const vgToolsJson = await runCli(["tools", "--config", configPath, "--provider", "vercel_gateway", "--json"]);
    assert.equal(vgToolsJson.code, 0, vgToolsJson.stderr);
    const vgParsed = JSON.parse(vgToolsJson.stdout) as { provider: string; tools: Array<{ name: string }> };
    assert.equal(vgParsed.provider, "vercel_gateway");
    assert.deepEqual(
      vgParsed.tools.map((t) => t.name).sort(),
      ["vercel_deepseek_fetch", "vercel_deepseek_search", "vercel_parallel_fast"],
    );

    const described = await runCli(["tools", "--config", configPath, "--describe", "search_auto"]);
    assert.equal(described.code, 0, described.stderr);
    assert.equal((JSON.parse(described.stdout) as { name: string }).name, "search_auto");

    // config, cache-clear, reset.
    const cfgOut = await runCli(["config", "--config", configPath]);
    assert.equal(cfgOut.code, 0, cfgOut.stderr);
    assert.ok(!cfgOut.stdout.includes("good-key-123456"));
    assert.equal((JSON.parse(cfgOut.stdout) as { providers: { serper: { keyCount: number } } }).providers.serper.keyCount, 2);

    const cacheCleared = await runCli(["cache-clear", "--config", configPath, "--json"]);
    assert.equal(cacheCleared.code, 0, cacheCleared.stderr);
    assert.equal((JSON.parse(cacheCleared.stdout) as { ok: boolean }).ok, true);

    const resetOut = await runCli(["reset", "--config", configPath, "serper", "0", "--json"]);
    assert.equal(resetOut.code, 0, resetOut.stderr);
    assert.equal((JSON.parse(resetOut.stdout) as { ok: boolean }).ok, true);

    const badSlot = await runCli(["reset", "--config", configPath, "serper", "9"]);
    assert.equal(badSlot.code, 1);
    assert.match(badSlot.stderr, /slot must be an integer/);

    // quota: success -> exit 0 (note slot 0 succeeds, slot 1 returns 401 -> overall exit 1); test single-key ok via separate check.
    const quotaFail = await runCli(["quota", "--config", configPath, "bad_serper"]);
    assert.equal(quotaFail.code, 1);
    assert.match(quotaFail.stderr, /HTTP 401/);

    const quotaMixed = await runCli(["quota", "--config", configPath, "serper"]);
    assert.equal(quotaMixed.code, 1);
    assert.match(quotaMixed.stdout, /remaining=1234 credits/);
    assert.match(quotaMixed.stderr, /HTTP 401/);

    const hitsBeforeDisabled = mock.hits.length;
    const quotaDisabled = await runCli(["quota", "--config", configPath, "disabled_serper"]);
    assert.equal(quotaDisabled.code, 1);
    assert.match(quotaDisabled.stderr, /provider is disabled/);
    assert.equal(mock.hits.length, hitsBeforeDisabled, "disabled provider quota must not hit network");

    // probe: slot 0 succeeds -> exit 0; slot 1 hits 401 -> stderr + exit 1.
    const probeOk = await runCli(["probe", "--config", configPath, "serper", "health check", "--slot", "0"]);
    assert.equal(probeOk.code, 0, probeOk.stderr);
    assert.match(probeOk.stdout, /serper .*slot 0: ok/);

    const probeFail = await runCli(["probe", "--config", configPath, "serper", "health check", "--slot", "1"]);
    assert.equal(probeFail.code, 1);
    assert.match(probeFail.stderr, /serper .*slot 1: error:/);
  } finally {
    await mock.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
