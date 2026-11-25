#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const rawArgs = process.argv.slice(2);
const checkFriendPolicy = rawArgs.includes("--check-friend-policy");
const positional = rawArgs.filter((arg) => !arg.startsWith("--"));
const endpoint = positional[0];
const tokenPath = positional[1];
if (!endpoint || !tokenPath) {
  throw new Error("Usage: smoke-http <http://host:port/mcp> <token-file> [--check-friend-policy]");
}

const token = readFileSync(tokenPath, "utf8").trim();
if (!token) throw new Error("HTTP MCP token file is empty");

const client = new Client({ name: "search-toolkit-http-smoke", version: "0.1.0" });
const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
  requestInit: { headers: { Authorization: `Bearer ${token}` } },
});

const textOf = (output: unknown, index: number): string =>
  ((output as { content?: Array<{ text?: string }> })?.content?.[index]?.text ?? "");

try {
  await client.connect(transport as unknown as Parameters<typeof client.connect>[0]);
  const tools = await client.listTools();
  const toolNames = new Set(tools.tools.map((tool) => tool.name));
  if (tools.tools.length === 0) throw new Error("HTTP MCP server returned zero tools");

  const poolStatusVisible = toolNames.has("search_pool_status");
  const status = poolStatusVisible
    ? await client.callTool({ name: "search_pool_status", arguments: {} })
    : undefined;
  if (status?.isError === true) {
    throw new Error(`search_pool_status failed: ${textOf(status, 0)}`);
  }
  const structured = status ? JSON.parse(textOf(status, 0) || "{}") as Record<string, unknown> : undefined;
  const warnings = Array.isArray(structured?.warnings) ? structured.warnings.length : null;

  const imageSearch = await client.callTool({
    name: "search_images",
    arguments: { query: "Singapore Marina Bay skyline", limit: 1 },
  });
  if (imageSearch.isError === true) {
    throw new Error(`search_images failed: ${textOf(imageSearch, 0) || "unknown error"}`);
  }
  let route: Record<string, unknown> | undefined;
  try {
    route = (JSON.parse(textOf(imageSearch, 0) || "{}") as { searchToolkitRoute?: Record<string, unknown> }).searchToolkitRoute;
  } catch (error) {
    throw new Error(`search_images returned non-JSON route header: ${textOf(imageSearch, 0).slice(0, 200)} (${String(error)})`);
  }
  const imageItems = (textOf(imageSearch, 1).match(/^\d+\. /gm) ?? []).length;
  if (imageItems < 1) {
    throw new Error(`search_images returned 0 items (route=${route ? `${String(route.provider)}/${String(route.tool)}` : "none"})`);
  }

  const invalidImageSearch = await client.callTool({
    name: "search_images",
    arguments: { query: "", limit: 9_999, bogusField: true },
  });
  if (invalidImageSearch.isError !== true) {
    throw new Error("Expected invalid search_images arguments to be rejected with isError=true");
  }

  let friendPolicyChecked: Record<string, boolean | null> | undefined;
  if (checkFriendPolicy) {
    friendPolicyChecked = { grokMaxDenied: null, linkupFlashAllowedByPolicy: null };
    if (toolNames.has("grok_web_search")) {
      const grokMax = await client.callTool({
        name: "grok_web_search",
        arguments: { query: "policy smoke check", depth: "max" },
      });
      const msg = textOf(grokMax, 0);
      if (grokMax.isError !== true || !/not allowed for this token/i.test(msg)) {
        throw new Error(`Expected friend grok_web_search(depth=max) denial, got: ${msg}`);
      }
      friendPolicyChecked.grokMaxDenied = true;
    }
    if (toolNames.has("linkup_linkup_search")) {
      // Wrong query type fails AJV validation after policy checks, proving depth=flash is allowed with zero paid quota spent.
      const linkupFlash = await client.callTool({
        name: "linkup_linkup_search",
        arguments: { query: 123, depth: "flash" },
      });
      const msg = textOf(linkupFlash, 0);
      if (linkupFlash.isError !== true || /not allowed for this token/i.test(msg)) {
        throw new Error(`Expected friend linkup_linkup_search(depth=flash) to pass argument policy, got: ${msg}`);
      }
      friendPolicyChecked.linkupFlashAllowedByPolicy = true;
    }
  }

  console.log(JSON.stringify({
    connected: true,
    toolCount: tools.tools.length,
    warnings,
    poolStatusVisible,
    imageRoute: route ? `${String(route.provider)}/${String(route.tool)}` : null,
    imageItems,
    inputValidation: true,
    ...(friendPolicyChecked ? { friendPolicyChecked } : {}),
  }));
} finally {
  await client.close();
}
