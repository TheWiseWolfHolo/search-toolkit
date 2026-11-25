import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const httpServerScript = fileURLToPath(new URL("../src/http-server.js", import.meta.url));

function cleanEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("SEARCH_TOOLKIT_")) delete env[key];
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

function runServerOnce(
  args: string[],
  envOverrides: Record<string, string | undefined> = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [httpServerScript, ...args], {
      env: cleanEnv(envOverrides),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`http-server timed out (args=${args.join(" ")})\nstdout=${stdout}\nstderr=${stderr}`));
    }, 10_000);
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as AddressInfo).port;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

function startServer(
  args: string[],
  envOverrides: Record<string, string | undefined>,
): Promise<{ child: ChildProcess; stdout: () => string; stderr: () => string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [httpServerScript, ...args], {
      env: cleanEnv(envOverrides),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`http-server did not start listening within 10s\nstdout=${stdout}\nstderr=${stderr}`));
    }, 10_000);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (!settled && /listening on http:\/\//.test(stdout)) {
        settled = true;
        clearTimeout(timer);
        resolve({ child, stdout: () => stdout, stderr: () => stderr });
      }
    });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.once("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.once("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`http-server exited prematurely with code ${String(code)}\nstdout=${stdout}\nstderr=${stderr}`));
    });
  });
}

test("http-server handles --version, --help, unknown options, and invalid --profile", async () => {
  const ver = await runServerOnce(["--version"]);
  assert.equal(ver.code, 0);
  assert.match(ver.stdout.trim(), /^\d+\.\d+\.\d+/);

  const help = await runServerOnce(["-h"]);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /search-toolkit-http/);
  assert.match(help.stdout, /SEARCH_TOOLKIT_HTTP_TOKENS_FILE/);

  const unknown = await runServerOnce(["--bogus"]);
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /Unknown option: --bogus/);

  const badProfile = await runServerOnce(["--profile=invalid"]);
  assert.equal(badProfile.code, 2);
  assert.match(badProfile.stderr, /--profile must be "full", "curated", or "lean"/);
});

test("http-server strictly validates numeric environment variables before binding", async () => {
  const validTokens = JSON.stringify([{ hash: "a".repeat(64), role: "owner" }]);
  for (const [envVar, value, expectedPattern] of [
    ["SEARCH_TOOLKIT_HTTP_PORT", "not-a-port", /SEARCH_TOOLKIT_HTTP_PORT must be an integer/],
    ["SEARCH_TOOLKIT_HTTP_PORT", "   ", /SEARCH_TOOLKIT_HTTP_PORT must not be empty/],
    ["SEARCH_TOOLKIT_HTTP_PORT", "0", /SEARCH_TOOLKIT_HTTP_PORT must be an integer/],
    ["SEARCH_TOOLKIT_HTTP_SESSION_TTL_MS", "500", /SEARCH_TOOLKIT_HTTP_SESSION_TTL_MS must be an integer/],
    ["SEARCH_TOOLKIT_HTTP_MAX_SESSIONS", "abc", /SEARCH_TOOLKIT_HTTP_MAX_SESSIONS must be an integer/],
  ] as const) {
    const result = await runServerOnce([], {
      SEARCH_TOOLKIT_HTTP_TOKENS: validTokens,
      [envVar]: value,
    });
    assert.equal(result.code, 1, `${envVar}=${value} should exit 1`);
    assert.match(result.stderr, expectedPattern);
  }
});

test("http-server loads tokens from file, normalizes allowedHosts, exposes loopback admin reload, and exits cleanly on /admin/shutdown", async () => {
  const dir = mkdtempSync(join(tmpdir(), "search-toolkit-http-srv-"));
  const configPath = join(dir, "providers.json");
  const tokensPath = join(dir, "tokens.json");
  const ownerToken = "srv-owner-token-1234";
  const clientToken = "srv-client-token-5678";
  writeFileSync(configPath, JSON.stringify({
    version: 2,
    statePath: join(dir, "state.db"),
    providers: {
      brave: { enabled: true, auto: ["search"], keys: ["k-test-1"], integration: { kind: "rest", adapter: "brave" } },
    },
  }));
  writeFileSync(tokensPath, JSON.stringify([
    { hash: createHash("sha256").update(ownerToken).digest("hex"), role: "owner" },
    { hash: createHash("sha256").update(clientToken).digest("hex"), role: "client" },
  ]));

  const port = await freePort();
  const { child } = await startServer(["--config", configPath, "--profile=lean"], {
    SEARCH_TOOLKIT_HTTP_HOST: "127.0.0.1",
    SEARCH_TOOLKIT_HTTP_PORT: String(port),
    SEARCH_TOOLKIT_HTTP_TOKENS_FILE: tokensPath,
    SEARCH_TOOLKIT_HTTP_ALLOWED_HOSTS: "127.0.0.1,LOCALHOST",
    SEARCH_TOOLKIT_HTTP_STATELESS: "1",
  });

  try {
    const health = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true, mode: "stateless" });

    // Lowercased Host header against uppercase-configured LOCALHOST succeeds.
    const hostOk = await fetch(`http://localhost:${port}/healthz`);
    assert.equal(hostOk.status, 200);

    // Client role cannot invoke loopback admin endpoints.
    const clientReload = await fetch(`http://127.0.0.1:${port}/admin/reload`, {
      method: "POST",
      headers: { Authorization: `Bearer ${clientToken}` },
    });
    assert.equal(clientReload.status, 403);

    // Owner role can trigger loopback /admin/reload.
    const ownerReload = await fetch(`http://127.0.0.1:${port}/admin/reload`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(ownerReload.status, 200);
    const reloadBody = await ownerReload.json() as { ok: boolean; tools: number };
    assert.equal(reloadBody.ok, true);
    assert.ok(reloadBody.tools >= 7);

    // POST /admin/shutdown replies 200 and shuts the process down with exit code 0.
    const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
    const shutdownResp = await fetch(`http://127.0.0.1:${port}/admin/shutdown`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(shutdownResp.status, 200);
    assert.deepEqual(await shutdownResp.json(), { ok: true });
    const exitCode = await Promise.race([
      exited,
      new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), 5_000)),
    ]);
    assert.equal(exitCode, 0);
  } finally {
    if (child.exitCode === null) child.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("http-server disables admin routes when SEARCH_TOOLKIT_HTTP_ALLOWED_HOSTS contains a non-loopback host", async () => {
  const dir = mkdtempSync(join(tmpdir(), "search-toolkit-http-pub-"));
  const configPath = join(dir, "providers.json");
  const ownerToken = "pub-owner-token-1234";
  writeFileSync(configPath, JSON.stringify({
    version: 2,
    statePath: join(dir, "state.db"),
    providers: {
      brave: { enabled: true, auto: ["search"], keys: ["k-test-1"], integration: { kind: "rest", adapter: "brave" } },
    },
  }));

  const port = await freePort();
  const { child } = await startServer(["--config", configPath], {
    SEARCH_TOOLKIT_HTTP_HOST: "127.0.0.1",
    SEARCH_TOOLKIT_HTTP_PORT: String(port),
    SEARCH_TOOLKIT_HTTP_TOKENS: JSON.stringify([
      { hash: createHash("sha256").update(ownerToken).digest("hex"), role: "owner" },
    ]),
    SEARCH_TOOLKIT_HTTP_ALLOWED_HOSTS: "127.0.0.1,search-mcp.example.com",
  });

  try {
    const reload = await fetch(`http://127.0.0.1:${port}/admin/reload`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(reload.status, 404);

    const shutdown = await fetch(`http://127.0.0.1:${port}/admin/shutdown`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(shutdown.status, 404);
  } finally {
    if (child.exitCode === null) {
      const done = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.kill();
      await Promise.race([done, new Promise((r) => setTimeout(r, 3_000))]);
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
