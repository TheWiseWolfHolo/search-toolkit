import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const dir = mkdtempSync(resolve(tmpdir(), "search-toolkit-mcp-smoke-"));
const configPath = resolve(dir, "providers.json");
const rest = (adapter: string, auto: string[]) => ({
  enabled: true,
  auto,
  keys: ["smoke-key-not-used"],
  integration: { kind: "rest", adapter },
});
writeFileSync(configPath, JSON.stringify({
  version: 2,
  statePath: resolve(dir, "state.db"),
  providers: {
    querit: rest("querit", ["search"]),
    doubao: rest("doubao", []),
    brave: rest("brave", []),
    you: rest("you", []),
    parallel: rest("parallel", []),
  },
}));

async function connect(extraArgs: string[]) {
  const client = new Client({ name: "search-toolkit-smoke", version: "1.0.0" }, { capabilities: {} });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve(process.cwd(), "dist/src/mcp-server.js"), "--config", configPath, ...extraArgs],
  });
  await client.connect(transport);
  return { client, transport };
}

try {
  const full = await connect([]);
  try {
    const listed = await full.client.listTools();
    const names = listed.tools.map((tool) => tool.name);
    for (const expected of ["querit_search", "doubao_search", "brave_web_search", "brave_news_search", "brave_llm_context", "you_search", "parallel_search", "search_auto", "search_images", "fetch_auto", "search_pool_status", "search_rotation_probe"]) {
      if (!names.includes(expected)) throw new Error(`Missing MCP tool: ${expected}`);
    }
    if (names.includes("provider_call")) throw new Error("The gateway must be hidden in the full profile");
    const auto = listed.tools.find((tool) => tool.name === "search_auto");
    const probe = listed.tools.find((tool) => tool.name === "search_rotation_probe");
    if (auto?.annotations?.readOnlyHint !== true) throw new Error("search_auto must be read-only");
    const autoMode = (auto?.inputSchema as { properties?: Record<string, { enum?: string[] }> }).properties?.mode;
    if (!autoMode?.enum?.includes("context")) throw new Error("search_auto must expose context mode");
    if (probe?.annotations?.readOnlyHint !== false) throw new Error("search_rotation_probe must require write approval");
    if (!full.client.getInstructions()?.includes("Doubao is manual-only")) throw new Error("Missing server-wide quota instructions");
    const status = await full.client.callTool({ name: "search_pool_status", arguments: {} });
    if (status.isError) throw new Error("search_pool_status returned an error");

    const lean = await connect(["--profile", "lean"]);
    try {
      const leanNames = (await lean.client.listTools()).tools.map((tool) => tool.name).sort();
      const expected = ["fetch_auto", "provider_call", "provider_tools", "search_auto", "search_images", "search_pool_status", "search_rotation_probe"];
      if (JSON.stringify(leanNames) !== JSON.stringify(expected)) throw new Error(`Unexpected lean tool set: ${leanNames.join(", ")}`);
    } finally {
      await lean.transport.close();
    }
    console.log(JSON.stringify({ ok: true, toolCount: names.length, tools: names }, null, 2));
  } finally {
    await full.transport.close();
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
