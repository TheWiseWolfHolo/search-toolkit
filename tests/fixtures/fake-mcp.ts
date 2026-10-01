// A tiny STDIO MCP server used by integration tests as a stand-in for an official upstream.
// Behaviour is driven by the tool name and by the API key it was started with (FAKE_KEY).
import { appendFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const key = process.env.FAKE_KEY ?? "";
const marker = process.env.FAKE_MARKER;
const toolNames = JSON.parse(process.env.FAKE_TOOLS ?? '["echo","keyed","limited","tool_error","crash"]') as string[];
const log = (line: string) => {
  if (marker) appendFileSync(marker, `${line}\n`);
};
log(`start ${key}`);
if (key === "broken") process.exit(1);

const server = new Server({ name: "fake", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: toolNames.map((name) => ({
    name,
    description: `fake ${name} tool. ${"Long filler sentence. ".repeat(60)}`,
    inputSchema: { type: "object", properties: { query: { type: "string", description: "x".repeat(400) } } },
  })),
}));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = request.params.name;
  log(`call ${name} ${key}`);
  if (name === "keyed") {
    return key.startsWith("bad")
      ? { isError: true, content: [{ type: "text", text: "Invalid API key provided" }] }
      : { content: [{ type: "text", text: `ok:${key}` }] };
  }
  if (name === "limited") {
    return key.startsWith("bad")
      ? { isError: true, content: [{ type: "text", text: "Rate limit exceeded, please retry" }] }
      : { content: [{ type: "text", text: `ok:${key}` }] };
  }
  if (name === "tool_error") {
    return { isError: true, content: [{ type: "text", text: "Failed to scrape URL. Status code: 403 Forbidden" }] };
  }
  if (name === "crash") {
    setTimeout(() => process.exit(1), 20);
    return { content: [{ type: "text", text: "bye" }] };
  }
  if (process.env.FAKE_ERROR) return { isError: true, content: [{ type: "text", text: process.env.FAKE_ERROR }] };
  return { content: [{ type: "text", text: process.env.FAKE_REPLY ?? `echo:${key}` }] };
});
await server.connect(new StdioServerTransport());
