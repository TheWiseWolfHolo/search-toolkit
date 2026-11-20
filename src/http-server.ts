#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { boundedInteger, createSearchToolkitHttpApp, parseHttpTokenPolicies } from "./http.js";
import { SearchToolkit } from "./toolkit.js";
import type { ToolkitProfile } from "./types.js";

const configPath = flagValue("--config");
const profile = flagValue("--profile");
if (profile !== undefined && profile !== "full" && profile !== "curated" && profile !== "lean") {
  console.error(`--profile must be "full", "curated", or "lean", got "${profile}"`);
  process.exit(2);
}
const host = process.env.SEARCH_TOOLKIT_HTTP_HOST ?? "127.0.0.1";
const port = boundedInteger(Number(process.env.SEARCH_TOOLKIT_HTTP_PORT ?? 18_473), 18_473, 1, 65_535);
const rawTokens = process.env.SEARCH_TOOLKIT_HTTP_TOKENS
  ?? (process.env.SEARCH_TOOLKIT_HTTP_TOKENS_FILE
    ? readFileSync(process.env.SEARCH_TOOLKIT_HTTP_TOKENS_FILE, "utf8")
    : undefined);
const tokens = parseHttpTokenPolicies(rawTokens);
const allowedHosts = listEnv("SEARCH_TOOLKIT_HTTP_ALLOWED_HOSTS");
const allowedOrigins = listEnv("SEARCH_TOOLKIT_HTTP_ALLOWED_ORIGINS");
const stateless = /^(?:1|true|yes)$/i.test((process.env.SEARCH_TOOLKIT_HTTP_STATELESS ?? "").trim());
const sessionTtlMs = boundedInteger(
  Number(process.env.SEARCH_TOOLKIT_HTTP_SESSION_TTL_MS ?? 30 * 60_000),
  30 * 60_000,
  1_000,
  24 * 60 * 60_000,
);
const loopbackOnly = host === "127.0.0.1" || host === "::1" || host === "localhost";
const adminEnabled = loopbackOnly && allowedHosts.length === 0;

const buildToolkit = async () => {
  const next = new SearchToolkit(configPath, profile ? { profile: profile as ToolkitProfile } : {});
  await next.initialize();
  return next;
};

const initialToolkit = await buildToolkit();

let shutdownPromise: Promise<void> | undefined;
let httpServer: ReturnType<typeof createServer> | undefined;
let runtime: ReturnType<typeof createSearchToolkitHttpApp> | undefined;

const shutdown = (): Promise<void> => {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    const activeServer = httpServer;
    const closed = activeServer
      ? new Promise<void>((resolve) => activeServer.close(() => resolve()))
      : Promise.resolve();
    await runtime?.close().catch(() => undefined);
    activeServer?.closeIdleConnections?.();
    await Promise.race([
      closed,
      new Promise<void>((resolve) => setTimeout(() => {
        activeServer?.closeAllConnections?.();
        resolve();
      }, 2_000).unref()),
    ]);
    const activeToolkit = runtime?.currentToolkit() ?? initialToolkit;
    await activeToolkit.close().catch(() => undefined);
  })();
  return shutdownPromise;
};

runtime = createSearchToolkitHttpApp(initialToolkit, {
  tokens,
  host,
  ...(allowedHosts.length ? { allowedHosts } : {}),
  allowedOrigins,
  sessionTtlMs,
  stateless,
  ...(adminEnabled
    ? {
      onReload: buildToolkit,
      onShutdown: async () => {
        await shutdown();
        process.exit(0);
      },
    }
    : {}),
});
httpServer = createServer(runtime.app);
httpServer.keepAliveTimeout = 65_000;
httpServer.headersTimeout = 66_000;
httpServer.listen(port, host, () => {
  console.log(`Search Toolkit Streamable HTTP (${stateless ? "stateless" : "stateful"}) listening on http://${host}:${port}/mcp`);
});

process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));

function listEnv(name: string): string[] {
  return (process.env[name] ?? "").split(",").map((item) => item.trim()).filter(Boolean);
}

function flagValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
