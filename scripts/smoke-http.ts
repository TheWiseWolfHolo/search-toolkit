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
  const structured = status?.structuredContent as Record<string, unknown> | undefined;
  const warnings = Array.isArray(structured?.warnings) ? structured.warnings.length : null;
  const imageSearch = await client.callTool({
    name: "search_images",
    arguments: { query: "Singapore Marina Bay skyline", limit: 1 },
  });
  const invalidImageSearch = await client.callTool({
    name: "search_images",
    arguments: { query: "", limit: 9_999, bogusField: true },
  });
  const imageStructured = imageSearch.structuredContent as Record<string, unknown> | undefined;
  const route = imageStructured?.route as Record<string, unknown> | undefined;
  const providerResult = imageStructured?.result as Record<string, unknown> | undefined;
  const imageData = providerResult?.data as Record<string, unknown> | undefined;
  const imageItems = Array.isArray(imageData?.items) ? imageData.items.length : 0;
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
