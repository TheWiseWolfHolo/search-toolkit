import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { SearchToolkit } from "./toolkit.js";

const instructions = "Use the narrowest provider that fits the task. Start with compact search, inspect results, then fetch selected URLs. Use Brave LLM Context for token-bounded multi-source grounding, You.com for unified Web/News with optional query-aware highlights, and Parallel for semantic objectives with LLM-optimized excerpts. Doubao is manual-only. Key rotation probes consume quota. Tools that create, update, delete, start jobs, send notifications, or submit feedback require explicit user intent; respect tool annotations and approval prompts.";

interface ProtocolServerOptions {
  allowTool?: (tool: Tool) => boolean;
  beforeCall?: (toolName: string) => void;
}

export function createProtocolServer(toolkit: SearchToolkit, options: ProtocolServerOptions = {}): Server {
  const validatorProvider = new AjvJsonSchemaValidator();
  const validators = new Map<string, ReturnType<AjvJsonSchemaValidator["getValidator"]>>();
  const server = new Server(
    { name: "search-toolkit", version: "0.1.0" },
    { capabilities: { tools: { listChanged: false } }, instructions },
  );
  const visibleTools = () => toolkit.listTools().filter((tool) => options.allowTool?.(tool) ?? true);
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: visibleTools() }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const tool = toolkit.listTools().find((candidate) => candidate.name === request.params.name);
      if (!tool || (options.allowTool && !options.allowTool(tool))) {
        throw new Error("Tool is not available for this token");
      }
      let validator = validators.get(tool.name);
      if (!validator) {
        validator = validatorProvider.getValidator(tool.inputSchema as Parameters<AjvJsonSchemaValidator["getValidator"]>[0]);
        validators.set(tool.name, validator);
      }
      const validation = validator(request.params.arguments ?? {});
      if (!validation.valid) {
        throw new Error(`Invalid arguments for ${tool.name}: ${validation.errorMessage}`);
      }
      options.beforeCall?.(tool.name);
      return await toolkit.callTool(request.params.name, validation.data as Record<string, unknown>) as never;
    } catch (error) {
      const text = (error instanceof Error ? error.message : String(error))
        .replace(/[A-Za-z0-9_-]{24,}/g, "<redacted>")
        .slice(0, 1_000);
      return { content: [{ type: "text", text }], isError: true };
    }
  });
  return server;
}
