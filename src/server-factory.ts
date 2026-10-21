import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { redact } from "./provenance.js";
import { SearchToolkit } from "./toolkit.js";
import { PACKAGE_VERSION } from "./version.js";

const instructions = "Search with search_auto (web), search_images (images), and fetch_auto (a known URL) first; they pick a provider and report the route used. Reach for a provider tool directly only when its specific capability is needed. Brave LLM Context gives token-bounded multi-source grounding, You.com gives Web+News with highlights, Parallel suits semantic objectives. Doubao is manual-only. Rotation probes consume quota. Tools that create, update, delete, start jobs, or submit feedback need explicit user intent; respect annotations and approval prompts.";

interface ProtocolServerOptions {
  allowTool?: (tool: Tool) => boolean;
  beforeCall?: (toolName: string) => void;
  maxToolInputElements?: number;
}

/**
 * Clients such as Claude Code hand the model structuredContent instead of
 * content when both are present. None of these tools declares an
 * outputSchema, and the readable text lives in content, so structuredContent
 * stays inside the process (CLI --json, routing) and never crosses MCP.
 */
function forModel(output: unknown): unknown {
  if (!output || typeof output !== "object" || !("structuredContent" in output)) return output;
  const { structuredContent: _internal, ...visible } = output as Record<string, unknown>;
  return visible;
}

export function createProtocolServer(toolkit: SearchToolkit, options: ProtocolServerOptions = {}): Server {
  const server = new Server(
    { name: "search-toolkit", version: PACKAGE_VERSION },
    { capabilities: { tools: { listChanged: true } }, instructions },
  );
  const visibleTools = () => toolkit.listTools().filter((tool) => options.allowTool?.(tool) ?? true);
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: visibleTools() }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const tool = visibleTools().find((candidate) => candidate.name === request.params.name);
      if (!tool) throw new Error("Tool is not available for this token");
      const arguments_ = request.params.arguments ?? {};
      if (options.maxToolInputElements !== undefined) enforceInputElementLimit(arguments_, options.maxToolInputElements);
      options.beforeCall?.(tool.name);
      return forModel(await toolkit.callTool(tool.name, arguments_)) as never;
    } catch (error) {
      const text = redact(error instanceof Error ? error.message : String(error)).slice(0, 1_000);
      return { content: [{ type: "text", text }], isError: true };
    }
  });
  // An upstream catalog refreshed in the background changes the tool list mid-session.
  const unsubscribe = toolkit.onToolsChanged(() => {
    void server.sendToolListChanged().catch(() => undefined);
  });
  server.onclose = unsubscribe;
  return server;
}

// The low-level Server has no McpServer maxToolInputElements option.
// Count JSON members before invoking the toolkit's schema validator.
function enforceInputElementLimit(value: unknown, maximum: number): void {
  let count = 0;
  const pending: unknown[] = [value];
  while (pending.length) {
    const node = pending.pop();
    if (node === null || typeof node !== "object") continue;
    for (const key in node) {
      if (!Object.hasOwn(node, key)) continue;
      if (++count > maximum) throw new Error(`Tool input exceeds ${maximum} array elements and object keys`);
      const child = (node as Record<string, unknown>)[key];
      if (child !== null && typeof child === "object") pending.push(child);
    }
  }
}
