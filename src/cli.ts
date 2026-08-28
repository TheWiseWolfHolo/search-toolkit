#!/usr/bin/env node
import { sanitizedConfig } from "./config.js";
import { SearchToolkit } from "./toolkit.js";

const argv = process.argv.slice(2);
const configIndex = argv.indexOf("--config");
const configPath = configIndex >= 0 ? argv[configIndex + 1] : undefined;
if (configIndex >= 0) argv.splice(configIndex, 2);
const command = argv.shift() ?? "help";
const toolkit = new SearchToolkit(configPath);

try {
  if (command === "config") {
    console.log(JSON.stringify(sanitizedConfig(toolkit.config), null, 2));
    process.exitCode = 0;
  } else {
    await toolkit.initialize();
    if (command === "tools") {
      console.log(JSON.stringify({ tools: toolkit.listTools(), warnings: toolkit.warnings }, null, 2));
    } else if (command === "status") {
      console.log(JSON.stringify(toolkit.status(), null, 2));
    } else if (command === "call") {
      const name = argv.shift();
      if (!name) throw new Error("Usage: search-toolkit call <tool> [json-arguments]");
      const args = argv.length ? JSON.parse(argv.join(" ")) as Record<string, unknown> : {};
      console.log(JSON.stringify(await toolkit.callTool(name, args), null, 2));
    } else if (command === "probe") {
      const provider = argv.shift();
      const query = argv.join(" ");
      if (!provider || !query) throw new Error("Usage: search-toolkit probe <provider> <query>");
      console.log(JSON.stringify(await toolkit.callTool("search_rotation_probe", { provider, query }), null, 2));
    } else {
      console.log(`Search Toolkit 0.1.0

Commands:
  search-toolkit tools
  search-toolkit status
  search-toolkit config
  search-toolkit call <tool> '{"query":"..."}'
  search-toolkit probe <provider> <query>

Options:
  --config <path>   Override SEARCH_TOOLKIT_CONFIG
`);
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await toolkit.close();
}
