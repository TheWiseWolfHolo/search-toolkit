import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { redact } from "./provenance.js";
import { SearchToolkit } from "./toolkit.js";
import { GATEWAY_CALL_TOOL, MANAGEMENT_TOOL_NAMES, PROBE_TOOL } from "./tools.js";
import type { ToolkitProfile } from "./types.js";
import { PACKAGE_VERSION } from "./version.js";

const DEFAULT_MAX_INPUT_DEPTH = 64;

export interface CreateProtocolServerOptions {
  profile?: ToolkitProfile;
  allowTool?: (tool: Tool) => boolean;
  beforeCall?: (toolName: string, arguments_: Record<string, unknown>) => void;
  maxToolInputElements?: number;
  maxToolInputDepth?: number;
  /** Advertise tools/listChanged capability and forward catalog updates (default true; set false for stateless HTTP). */
  listChanged?: boolean;
  /** Whether the caller has owner-level privileges (e.g. live quota refresh). Defaults to true. */
  isOwner?: boolean;
  /** Optional lifecycle hooks for tracking in-flight MCP tool calls (e.g. stdio EOF draining). */
  onCallStart?: () => void;
  onCallEnd?: () => void;
}

/**
 * Derive concise server instructions from the tools this client can actually invoke,
 * so restricted HTTP tokens (guest/friend) and minimal configs never receive hints
 * pointing at unavailable providers.
 */
function buildInstructions(visible: Tool[], accessible: Tool[]): string {
  const visibleNames = new Set(visible.map((tool) => tool.name));
  const accessibleNames = new Set(accessible.map((tool) => tool.name));
  const parts: string[] = [];

  const unified: string[] = [];
  if (visibleNames.has("search_auto")) unified.push("search_auto (web)");
  if (visibleNames.has("search_images")) unified.push("search_images (images)");
  if (visibleNames.has("fetch_auto")) unified.push("fetch_auto (1-5 known URLs)");
  if (unified.length) {
    const joined = unified.length === 1
      ? unified[0]
      : `${unified.slice(0, -1).join(", ")}, and ${unified[unified.length - 1]}`;
    parts.push(`Search with ${joined} first; they pick a provider and report the route used.`);
  }

  const hasProviderTools = visible.some((tool) => !MANAGEMENT_TOOL_NAMES.has(tool.name))
    || visibleNames.has(GATEWAY_CALL_TOOL.name);
  if (hasProviderTools && unified.length) {
    parts.push(
      visibleNames.has(GATEWAY_CALL_TOOL.name)
        ? "Reach for a provider tool (directly or via provider_tools + provider_call) only when its specific capability is needed."
        : "Reach for a provider tool directly only when its specific capability is needed.",
    );
  }

  const specialistTips: string[] = [];
  if (accessibleNames.has("brave_llm_context")) specialistTips.push("Brave LLM Context gives token-bounded multi-source grounding");
  if (accessibleNames.has("you_search")) specialistTips.push("You.com gives Web+News with highlights");
  if (accessibleNames.has("parallel_search")) specialistTips.push("Parallel suits semantic objectives");
  if (specialistTips.length) parts.push(`${specialistTips.join(", ")}.`);

  const manualTips: string[] = [];
  if (accessibleNames.has("doubao_search")) manualTips.push("Doubao is manual-only");
  if (Array.from(accessibleNames).some((name) => name.startsWith("grok_"))) {
    manualTips.push("Grok (X/Web synthesis) is manual-only by default");
  }
  if (manualTips.length) parts.push(`${manualTips.join(", and ")}.`);

  if (visibleNames.has(PROBE_TOOL.name)) {
    parts.push("Rotation probes consume quota.");
  }

  if (accessible.some((tool) => tool.annotations?.readOnlyHint !== true)) {
    parts.push("Tools that create, update, delete, start jobs, or submit feedback need explicit user intent; respect annotations and approval prompts.");
  }

  return parts.join(" ") || "Use the exposed Search Toolkit tools according to their input schemas and annotations.";
}

/**
 * Clients such as Claude Code hand the model structuredContent instead of
 * content when both are present. None of these tools declares an
 * outputSchema, and the readable text lives in content, so structuredContent
 * stays inside the process (CLI --json, routing) and never crosses MCP.
 * Upstream `_meta` keys outside `searchToolkit` are also stripped at the boundary.
 */
function forModel(output: unknown): unknown {
  if (!output || typeof output !== "object") return output;
  const record = output as Record<string, unknown>;
  const { structuredContent: _internal, _meta, ...visible } = record;
  if (_meta && typeof _meta === "object" && "searchToolkit" in (_meta as Record<string, unknown>)) {
    return { ...visible, _meta: { searchToolkit: (_meta as Record<string, unknown>).searchToolkit } };
  }
  return visible;
}

export function createProtocolServer(toolkit: SearchToolkit, options: CreateProtocolServerOptions = {}): Server {
  const activeProfile = options.profile ?? toolkit.profile;
  const listChanged = options.listChanged !== false;
  const visibleTools = () => toolkit.listTools(activeProfile).filter((tool) => options.allowTool?.(tool) ?? true);
  const initialVisible = visibleTools();
  const initialAccessible = initialVisible.some((tool) => tool.name === GATEWAY_CALL_TOOL.name)
    ? toolkit.listTools("full").filter((tool) => options.allowTool?.(tool) ?? true)
    : initialVisible;
  const instructions = buildInstructions(initialVisible, initialAccessible);

  const server = new Server(
    { name: "search-toolkit", version: PACKAGE_VERSION },
    { capabilities: { tools: { listChanged } }, instructions },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: visibleTools() }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    options.onCallStart?.();
    try {
      const tool = visibleTools().find((candidate) => candidate.name === request.params.name);
      if (!tool) {
        if (options.allowTool) throw new Error("Tool is not available for this token");
        if (activeProfile === "full") {
          throw new Error(
            `Unknown tool "${request.params.name}". Check tools/list or call search_pool_status(verbose=true) to see available tools.`,
          );
        }
        throw new Error(
          `Tool "${request.params.name}" is not exposed in profile "${activeProfile}"; use provider_tools and provider_call to inspect and invoke provider tools.`,
        );
      }
      const arguments_ = request.params.arguments ?? {};
      if (options.maxToolInputElements !== undefined || options.maxToolInputDepth !== undefined) {
        enforceInputElementLimit(
          arguments_,
          options.maxToolInputElements ?? Number.POSITIVE_INFINITY,
          options.maxToolInputDepth ?? DEFAULT_MAX_INPUT_DEPTH,
        );
      }
      options.beforeCall?.(tool.name, arguments_);
      return forModel(
        await toolkit.callTool(tool.name, arguments_, {
          profile: activeProfile,
          ...(options.allowTool ? { allowTool: options.allowTool } : {}),
          ...(options.isOwner !== undefined ? { isOwner: options.isOwner } : {}),
        }),
      ) as never;
    } catch (error) {
      const text = redact(error instanceof Error ? error.message : String(error)).slice(0, 1_000);
      return { content: [{ type: "text", text }], isError: true };
    } finally {
      options.onCallEnd?.();
    }
  });

  if (listChanged) {
    // An upstream catalog refreshed in the background changes the tool list mid-session.
    const unsubscribe = toolkit.onToolsChanged(() => {
      void server.sendToolListChanged().catch(() => undefined);
    });
    server.onclose = unsubscribe;
  }
  return server;
}

// The low-level Server has no McpServer maxToolInputElements option.
// Count JSON members and enforce maximum nesting depth before invoking AJV.
function enforceInputElementLimit(value: unknown, maximum: number, maxDepth: number): void {
  let count = 0;
  const pending: Array<{ node: unknown; depth: number }> = [{ node: value, depth: 0 }];
  while (pending.length) {
    const entry = pending.pop()!;
    const { node, depth } = entry;
    if (node === null || typeof node !== "object") continue;
    if (depth > maxDepth) {
      throw new Error(`Tool input exceeds maximum nesting depth of ${maxDepth}`);
    }
    for (const key in node) {
      if (!Object.hasOwn(node, key)) continue;
      if (++count > maximum) throw new Error(`Tool input exceeds ${maximum} array elements and object keys`);
      const child = (node as Record<string, unknown>)[key];
      if (child !== null && typeof child === "object") {
        pending.push({ node: child, depth: depth + 1 });
      }
    }
  }
}
