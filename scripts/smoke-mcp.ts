import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const dir = mkdtempSync(resolve(tmpdir(), "search-toolkit-mcp-smoke-"));
const configPath = resolve(dir, "providers.json");
writeFileSync(configPath, JSON.stringify({
  version: 1,
  statePath: resolve(dir, "state.db"),
  providers: {
    querit: {
      enabled: true,
      automatic: true,
      keys: ["smoke-key-not-used"],
      integration: { kind: "rest", adapter: "querit" },
    },
    doubao: {
      enabled: true,
      automatic: false,
      manualOnly: true,
      keys: ["smoke-key-not-used"],
      integration: { kind: "rest", adapter: "doubao" },
    },
    brave: {
      enabled: true,
      automatic: false,
      keys: ["smoke-key-not-used"],
      integration: { kind: "rest", adapter: "brave" },
    },
    you: {
      enabled: true,
      automatic: false,
      keys: ["smoke-key-not-used"],
      integration: { kind: "rest", adapter: "you" },
    },
    parallel: {
      enabled: true,
      automatic: false,
      keys: ["smoke-key-not-used"],
      integration: { kind: "rest", adapter: "parallel" },
    },
  },
}));

const client = new Client({ name: "search-toolkit-smoke", version: "0.1.0" }, { capabilities: {} });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve(process.cwd(), "dist/src/mcp-server.js"), "--config", configPath],
});

try {
  await client.connect(transport);
  const listed = await client.listTools();
  const names = listed.tools.map((tool) => tool.name);
  for (const expected of ["querit_search", "doubao_search", "brave_web_search", "brave_news_search", "brave_llm_context", "you_search", "parallel_search", "search_auto", "search_pool_status", "search_rotation_probe"]) {
    if (!names.includes(expected)) throw new Error(`Missing MCP tool: ${expected}`);
  }
  const auto = listed.tools.find((tool) => tool.name === "search_auto");
  const probe = listed.tools.find((tool) => tool.name === "search_rotation_probe");
  if (auto?.annotations?.readOnlyHint !== true) throw new Error("search_auto must be read-only");
  const autoMode = (auto?.inputSchema as { properties?: Record<string, { enum?: string[] }> }).properties?.mode;
  if (!autoMode?.enum?.includes("context")) throw new Error("search_auto must expose context mode");
  if (probe?.annotations?.readOnlyHint !== false) throw new Error("search_rotation_probe must require write approval");
  if (!client.getInstructions()?.includes("Doubao is manual-only")) throw new Error("Missing server-wide quota instructions");
  const status = await client.callTool({ name: "search_pool_status", arguments: {} });
  if (status.isError) throw new Error("search_pool_status returned an error");
  console.log(JSON.stringify({ ok: true, toolCount: names.length, tools: names }, null, 2));
} finally {
  await transport.close();
  rmSync(dir, { recursive: true, force: true });
}
