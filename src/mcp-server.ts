#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createProtocolServer } from "./server-factory.js";
import { SearchToolkit } from "./toolkit.js";
import type { ToolkitProfile } from "./types.js";

const configPath = flagValue("--config");
const profile = flagValue("--profile");
if (profile !== undefined && profile !== "full" && profile !== "curated" && profile !== "lean") {
  console.error(`--profile must be "full", "curated", or "lean", got "${profile}"`);
  process.exit(2);
}
const toolkit = new SearchToolkit(configPath, profile ? { profile: profile as ToolkitProfile } : {});
await toolkit.initialize();

const server = createProtocolServer(toolkit);

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  await server.close().catch(() => undefined);
  await toolkit.close().catch(() => undefined);
};
process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
process.stdin.once("end", () => void shutdown().finally(() => process.exit(0)));
process.stdin.once("close", () => void shutdown().finally(() => process.exit(0)));

await server.connect(new StdioServerTransport());

function flagValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
