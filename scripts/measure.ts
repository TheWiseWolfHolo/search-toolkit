// Measure what a client pays to use this server: startup time, tool-list size, and the largest tools.
// Usage: npm run measure [-- --config <path>] [--profile full|lean] [--top 10]
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const args = process.argv.slice(2);
const value = (name: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const serverArgs = [resolve(process.cwd(), "dist/src/mcp-server.js")];
for (const name of ["--config", "--profile"]) {
  const found = value(name);
  if (found) serverArgs.push(name, found);
}
const top = Number(value("--top") ?? 8);

const started = performance.now();
const transport = new StdioClientTransport({ command: process.execPath, args: serverArgs, stderr: "ignore" });
const client = new Client({ name: "search-toolkit-measure", version: "1.0.0" }, { capabilities: {} });
try {
  await client.connect(transport);
  const ready = performance.now();
  const { tools } = await client.listTools();
  const listed = performance.now();
  const json = JSON.stringify(tools);
  console.log(JSON.stringify({
    profile: value("--profile") ?? "from config/env",
    startupMs: Math.round(ready - started),
    listToolsMs: Math.round(listed - ready),
    toolCount: tools.length,
    toolListChars: json.length,
    approxTokens: Math.round(json.length / 3.5),
    instructionChars: client.getInstructions()?.length ?? 0,
    largest: tools
      .map((tool) => ({ name: tool.name, chars: JSON.stringify(tool).length, descriptionChars: (tool.description ?? "").length }))
      .sort((a, b) => b.chars - a.chars)
      .slice(0, top),
  }, null, 2));
} finally {
  await transport.close();
}
