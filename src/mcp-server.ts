#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createProtocolServer } from "./server-factory.js";
import { SearchToolkit } from "./toolkit.js";

const configIndex = process.argv.indexOf("--config");
const configPath = configIndex >= 0 ? process.argv[configIndex + 1] : undefined;
const toolkit = new SearchToolkit(configPath);
await toolkit.initialize();

const server = createProtocolServer(toolkit);

const shutdown = async () => {
  await toolkit.close();
  await server.close();
};
process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));

await server.connect(new StdioServerTransport());
