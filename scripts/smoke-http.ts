#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const endpoint = process.argv[2];
const tokenPath = process.argv[3];
if (!endpoint || !tokenPath) {
  throw new Error("Usage: smoke-http <http://host:port/mcp> <token-file>");
}

const token = readFileSync(tokenPath, "utf8").trim();
if (!token) throw new Error("HTTP MCP token file is empty");

const client = new Client({ name: "search-toolkit-http-smoke", version: "0.1.0" });
const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
  requestInit: { headers: { Authorization: `Bearer ${token}` } },
});

try {
  await client.connect(transport as unknown as Parameters<typeof client.connect>[0]);
  const tools = await client.listTools();
  const poolStatusVisible = tools.tools.some((tool) => tool.name === "search_pool_status");
  const status = poolStatusVisible
    ? await client.callTool({ name: "search_pool_status", arguments: {} })
    : undefined;
  // Only content crosses MCP; structuredContent stays inside the server.
  const text = (output: unknown, index: number) => ((output as { content?: Array<{ text?: string }> })?.content?.[index]?.text ?? "");
  const structured = status ? JSON.parse(text(status, 0) || "{}") as Record<string, unknown> : undefined;
  const warnings = Array.isArray(structured?.warnings) ? structured.warnings.length : null;
  const imageSearch = await client.callTool({
    name: "search_images",
    arguments: { query: "Singapore Marina Bay skyline", limit: 1 },
  });
  const invalidImageSearch = await client.callTool({
    name: "search_images",
    arguments: { query: "", limit: 9_999, bogusField: true },
  });
  const route = (JSON.parse(text(imageSearch, 0) || "{}") as { searchToolkitRoute?: Record<string, unknown> }).searchToolkitRoute;
  const imageItems = (text(imageSearch, 1).match(/^\d+\. /gm) ?? []).length;
  console.log(JSON.stringify({
    connected: true,
    toolCount: tools.tools.length,
    warnings,
    poolStatusVisible,
    imageRoute: route ? `${String(route.provider)}/${String(route.tool)}` : null,
    imageItems,
    inputValidation: invalidImageSearch.isError === true,
  }));
} finally {
  await client.close();
}
