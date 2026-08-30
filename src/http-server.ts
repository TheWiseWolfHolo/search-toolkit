#!/usr/bin/env node
import { createServer } from "node:http";
import { boundedInteger, createSearchToolkitHttpApp, parseHttpTokenPolicies } from "./http.js";
import { SearchToolkit } from "./toolkit.js";

const configIndex = process.argv.indexOf("--config");
const configPath = configIndex >= 0 ? process.argv[configIndex + 1] : undefined;
const host = process.env.SEARCH_TOOLKIT_HTTP_HOST ?? "127.0.0.1";
const port = boundedInteger(Number(process.env.SEARCH_TOOLKIT_HTTP_PORT ?? 18_473), 18_473, 1, 65_535);
const tokens = parseHttpTokenPolicies(process.env.SEARCH_TOOLKIT_HTTP_TOKENS);
const allowedHosts = listEnv("SEARCH_TOOLKIT_HTTP_ALLOWED_HOSTS");
const allowedOrigins = listEnv("SEARCH_TOOLKIT_HTTP_ALLOWED_ORIGINS");
const sessionTtlMs = boundedInteger(
  Number(process.env.SEARCH_TOOLKIT_HTTP_SESSION_TTL_MS ?? 30 * 60_000),
  30 * 60_000,
  1_000,
  24 * 60 * 60_000,
);

const toolkit = new SearchToolkit(configPath);
await toolkit.initialize();
const runtime = createSearchToolkitHttpApp(toolkit, {
  tokens,
  host,
  ...(allowedHosts.length ? { allowedHosts } : {}),
  allowedOrigins,
  sessionTtlMs,
});
const httpServer = createServer(runtime.app);
httpServer.listen(port, host, () => {
  console.log(`Search Toolkit Streamable HTTP listening on http://${host}:${port}/mcp`);
});

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  await runtime.close();
  await toolkit.close();
};
process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));

function listEnv(name: string): string[] {
  return (process.env[name] ?? "").split(",").map((item) => item.trim()).filter(Boolean);
}
