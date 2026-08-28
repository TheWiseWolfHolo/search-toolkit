#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { SearchToolkit } from "./toolkit.js";

const configIndex = process.argv.indexOf("--config");
const configPath = configIndex >= 0 ? process.argv[configIndex + 1] : undefined;
const toolkit = new SearchToolkit(configPath);
await toolkit.initialize();

const server = new Server(
  { name: "search-toolkit", version: "0.1.0" },
  {
    capabilities: { tools: { listChanged: false } },
    instructions: "Use the narrowest provider that fits the task. Start with compact search, inspect results, then fetch selected URLs. Use Brave LLM Context for token-bounded multi-source grounding, You.com for unified Web/News with optional query-aware highlights, and Parallel for semantic objectives with LLM-optimized excerpts. Doubao is manual-only. Key rotation probes consume quota. Tools that create, update, delete, start jobs, send notifications, or submit feedback require explicit user intent; respect tool annotations and approval prompts.",
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolkit.listTools() }));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    return await toolkit.callTool(request.params.name, request.params.arguments ?? {}) as never;
  } catch (error) {
    const text = (error instanceof Error ? error.message : String(error))
      .replace(/[A-Za-z0-9_-]{24,}/g, "<redacted>")
      .slice(0, 1_000);
    return { content: [{ type: "text", text }], isError: true };
  }
});

const shutdown = async () => {
  await toolkit.close();
  await server.close();
};
process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));

await server.connect(new StdioServerTransport());
