// Measure what a client pays to use this server: startup time, tool-list size, and the largest tools.
// Usage: npm run measure [-- --config <path>] [--profile full|curated|lean] [--top 10]
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

function parseArgs(argv: string[]): { config?: string; profile?: string; top: number; help: boolean } {
  let config: string | undefined;
  let profile: string | undefined;
  let top = 8;
  let help = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === "-h" || arg === "--help") {
      help = true;
      continue;
    }
    const eq = arg.indexOf("=");
    const name = eq >= 0 ? arg.slice(0, eq) : arg;
    const takeValue = (): string => {
      if (eq >= 0) return arg.slice(eq + 1);
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) throw new Error(`${name} requires a value`);
      i += 1;
      return next;
    };
    if (name === "--config") {
      config = takeValue();
    } else if (name === "--profile") {
      profile = takeValue();
      if (profile !== "full" && profile !== "curated" && profile !== "lean") {
        throw new Error(`--profile must be "full", "curated", or "lean", got "${profile}"`);
      }
    } else if (name === "--top") {
      const raw = takeValue();
      const parsed = Number(raw);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 200) {
        throw new Error(`--top must be an integer from 1 to 200, got "${raw}"`);
      }
      top = parsed;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return { ...(config ? { config } : {}), ...(profile ? { profile } : {}), top, help };
}

const parsed = parseArgs(process.argv.slice(2));
if (parsed.help) {
  console.log("Usage: npm run measure [-- --config <path>] [--profile full|curated|lean] [--top 8]");
  process.exit(0);
}

const serverArgs = [resolve(process.cwd(), "dist/src/mcp-server.js")];
if (parsed.config) serverArgs.push("--config", parsed.config);
if (parsed.profile) serverArgs.push("--profile", parsed.profile);

const started = performance.now();
const transport = new StdioClientTransport({ command: process.execPath, args: serverArgs, stderr: "pipe" });
let stderrBuffer = "";
transport.stderr?.on("data", (chunk: Buffer | string) => {
  if (stderrBuffer.length < 4_000) stderrBuffer += String(chunk);
});
const client = new Client({ name: "search-toolkit-measure", version: "1.0.0" }, { capabilities: {} });
try {
  await client.connect(transport);
  const ready = performance.now();
  const { tools } = await client.listTools();
  const listed = performance.now();
  const json = JSON.stringify(tools);
  console.log(JSON.stringify({
    profile: parsed.profile ?? "from config/env",
    startupMs: Math.round(ready - started),
    listToolsMs: Math.round(listed - ready),
    toolCount: tools.length,
    toolListChars: json.length,
    approxTokens: Math.round(json.length / 3.5),
    instructionChars: client.getInstructions()?.length ?? 0,
    largest: tools
      .map((tool) => ({ name: tool.name, chars: JSON.stringify(tool).length, descriptionChars: (tool.description ?? "").length }))
      .sort((a, b) => b.chars - a.chars)
      .slice(0, parsed.top),
  }, null, 2));
} catch (error) {
  const details = stderrBuffer.trim();
  const message = error instanceof Error ? error.message : String(error);
  throw new Error(details ? `${message}\nServer stderr:\n${details}` : message);
} finally {
  await transport.close().catch(() => undefined);
}
