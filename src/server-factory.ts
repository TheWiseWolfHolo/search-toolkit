import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { SearchToolkit } from "./toolkit.js";
import { PACKAGE_VERSION } from "./version.js";

const instructions = "Search with search_auto (web), search_images (images), and fetch_auto (a known URL) first; they pick a provider and report the route used. Reach for a provider tool directly only when its specific capability is needed. Brave LLM Context gives token-bounded multi-source grounding, You.com gives Web+News with highlights, Parallel suits semantic objectives. Doubao is manual-only. Rotation probes consume quota. Tools that create, update, delete, start jobs, or submit feedback need explicit user intent; respect annotations and approval prompts.";

interface ProtocolServerOptions {
  allowTool?: (tool: Tool) => boolean;
  beforeCall?: (toolName: string) => void;
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
      options.beforeCall?.(tool.name);
      return await toolkit.callTool(tool.name, request.params.arguments ?? {}) as never;
    } catch (error) {
      const text = (error instanceof Error ? error.message : String(error))
        .replace(/[A-Za-z0-9_-]{24,}/g, "<redacted>")
        .slice(0, 1_000);
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
