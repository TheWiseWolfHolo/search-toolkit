#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createSearchToolkitHttpApp, isLoopbackHost, parseHttpTokenPolicies } from "./http.js";
import { redact } from "./provenance.js";
import { SearchToolkit } from "./toolkit.js";
import type { ToolkitProfile } from "./types.js";
import { PACKAGE_VERSION } from "./version.js";

function parseServerArgs(argv: string[]): { configPath?: string; profile?: ToolkitProfile; help: boolean; version: boolean } {
  let configPath: string | undefined;
  let profile: string | undefined;
  let help = false;
  let version = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === "-h" || arg === "--help") {
      help = true;
      continue;
    }
    if (arg === "-v" || arg === "--version") {
      version = true;
      continue;
    }
    const eq = arg.indexOf("=");
    const name = eq >= 0 ? arg.slice(0, eq) : arg;
    const takeValue = (): string => {
      if (eq >= 0) {
        const value = arg.slice(eq + 1);
        if (!value) throw new Error(`${name} requires a value`);
        return value;
      }
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) throw new Error(`${name} requires a value`);
      i += 1;
      return next;
    };
    if (name === "--config") {
      configPath = takeValue();
    } else if (name === "--profile") {
      profile = takeValue();
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (profile !== undefined && profile !== "full" && profile !== "curated" && profile !== "lean") {
    throw new Error(`--profile must be "full", "curated", or "lean", got "${profile}"`);
  }
  return {
    ...(configPath ? { configPath } : {}),
    ...(profile ? { profile: profile as ToolkitProfile } : {}),
    help,
    version,
  };
}

function strictEnvInteger(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const trimmed = raw.trim();
  if (!trimmed) throw new Error(`${name} must not be empty; expected an integer from ${minimum} to ${maximum}`);
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}, got "${raw}"`);
  }
  return parsed;
}

function listEnv(name: string, lowercase = false): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((item) => (lowercase ? item.trim().toLowerCase() : item.trim()))
    .filter(Boolean);
}

let parsed: ReturnType<typeof parseServerArgs>;
try {
  parsed = parseServerArgs(process.argv.slice(2));
} catch (error) {
  console.error(redact(error instanceof Error ? error.message : String(error)));
  process.exit(2);
}

if (parsed.version) {
  console.log(PACKAGE_VERSION);
  process.exit(0);
}
if (parsed.help) {
  console.log(`search-toolkit-http ${PACKAGE_VERSION}

Usage: search-toolkit-http [--config <path>] [--profile full|curated|lean] [-v|--version] [-h|--help]

Environment:
  SEARCH_TOOLKIT_HTTP_HOST              Listen address (default: 127.0.0.1)
  SEARCH_TOOLKIT_HTTP_PORT              Listen port 1..65535 (default: 18473)
  SEARCH_TOOLKIT_HTTP_TOKENS            JSON array of token policies (or use SEARCH_TOOLKIT_HTTP_TOKENS_FILE)
  SEARCH_TOOLKIT_HTTP_ALLOWED_HOSTS     Comma-separated Host allowlist (case-insensitive)
  SEARCH_TOOLKIT_HTTP_ALLOWED_ORIGINS   Comma-separated CORS/Origin allowlist
  SEARCH_TOOLKIT_HTTP_STATELESS         1|true|yes for stateless per-request Streamable HTTP
  SEARCH_TOOLKIT_HTTP_SESSION_TTL_MS    Stateful idle session TTL in ms (default: 1800000)
  SEARCH_TOOLKIT_HTTP_MAX_SESSIONS      Global max concurrent stateful sessions (default: 256)`);
  process.exit(0);
}

try {
  const host = (process.env.SEARCH_TOOLKIT_HTTP_HOST ?? "127.0.0.1").trim() || "127.0.0.1";
  const port = strictEnvInteger("SEARCH_TOOLKIT_HTTP_PORT", 18_473, 1, 65_535);
  const rawTokens = process.env.SEARCH_TOOLKIT_HTTP_TOKENS
    ?? (process.env.SEARCH_TOOLKIT_HTTP_TOKENS_FILE
      ? readFileSync(process.env.SEARCH_TOOLKIT_HTTP_TOKENS_FILE, "utf8")
      : undefined);
  const tokens = parseHttpTokenPolicies(rawTokens);
  const allowedHosts = listEnv("SEARCH_TOOLKIT_HTTP_ALLOWED_HOSTS", true);
  const allowedOrigins = listEnv("SEARCH_TOOLKIT_HTTP_ALLOWED_ORIGINS");
  const stateless = /^(?:1|true|yes)$/i.test((process.env.SEARCH_TOOLKIT_HTTP_STATELESS ?? "").trim());
  const sessionTtlMs = strictEnvInteger("SEARCH_TOOLKIT_HTTP_SESSION_TTL_MS", 30 * 60_000, 1_000, 24 * 60 * 60_000);
  const maxTotalSessions = strictEnvInteger("SEARCH_TOOLKIT_HTTP_MAX_SESSIONS", 256, 1, 10_000);
  const loopbackOnly = isLoopbackHost(host);
  const adminEnabled = loopbackOnly && allowedHosts.every(isLoopbackHost);

  const buildToolkit = async () => {
    const next = new SearchToolkit(parsed.configPath, parsed.profile ? { profile: parsed.profile } : {});
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
      const closed = activeServer && activeServer.listening
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
    maxTotalSessions,
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
  // Exceed Grok depth=max (300s + concurrency retry) so Node does not abort long-running MCP calls.
  httpServer.requestTimeout = 360_000;
  httpServer.on("error", (error) => {
    console.error(`Search Toolkit HTTP server error: ${redact(error instanceof Error ? error.message : String(error))}`);
    void shutdown().finally(() => process.exit(1));
  });
  httpServer.listen(port, host, () => {
    console.log(`Search Toolkit Streamable HTTP (${stateless ? "stateless" : "stateful"}) listening on http://${host}:${port}/mcp`);
  });

  process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
  process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
} catch (error) {
  console.error(redact(error instanceof Error ? error.message : String(error)));
  process.exit(1);
}
