import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { loadConfig } from "./config.js";
import { RestProvider } from "./rest/base.js";
import { adapterFor } from "./rest/adapters.js";
import { RotationStore } from "./rotation.js";
import type { ProviderConfig, ToolBinding, ToolkitConfig } from "./types.js";
import { UpstreamMcpProvider } from "./upstream.js";

export class SearchToolkit {
  readonly config: ToolkitConfig;
  readonly rotation: RotationStore;
  readonly warnings: string[] = [];
  private readonly bindings = new Map<string, ToolBinding>();
  private readonly upstreams: UpstreamMcpProvider[] = [];

  constructor(configPath?: string) {
    this.config = loadConfig(configPath);
    this.rotation = new RotationStore(this.config.statePath);
  }

  async initialize(): Promise<void> {
    const providers = Object.entries(this.config.providers).filter(([, config]) => config.enabled);
    for (const [name, config] of providers) {
      try {
        const bindings = await this.providerBindings(name, config);
        for (const binding of bindings) {
          if (this.bindings.has(binding.exposed.name)) {
            throw new Error(`Duplicate tool name: ${binding.exposed.name}`);
          }
          this.bindings.set(binding.exposed.name, binding);
        }
      } catch (error) {
        this.warnings.push(`${name}: ${cleanError(error)}`);
      }
    }
    for (const binding of this.managementBindings()) this.bindings.set(binding.exposed.name, binding);
  }

  listTools(): Tool[] {
    return Array.from(this.bindings.values(), (binding) => binding.exposed);
  }

  async callTool(name: string, arguments_: Record<string, unknown>): Promise<unknown> {
    const binding = this.bindings.get(name);
    if (!binding) throw new Error(`Unknown Search Toolkit tool: ${name}`);
    return binding.call(arguments_);
  }

  async close(): Promise<void> {
    await Promise.allSettled(this.upstreams.map((provider) => provider.close()));
    this.rotation.close();
  }

  status(): unknown {
    return {
      version: 1,
      providers: Object.entries(this.config.providers).map(([name, config]) => ({
        name,
        enabled: config.enabled,
        automatic: config.automatic,
        manualOnly: config.manualOnly ?? false,
        integration: config.integration.kind,
        rotation: this.rotation.status(name, config.keys),
      })),
      tools: this.listTools().map((tool) => tool.name),
      warnings: this.warnings,
    };
  }

  private async providerBindings(name: string, config: ProviderConfig): Promise<ToolBinding[]> {
    let bindings: ToolBinding[];
    if (config.integration.kind === "rest") {
      bindings = new RestProvider(name, config, this.rotation, adapterFor(config.integration.adapter)).bindings();
    } else {
      const provider = new UpstreamMcpProvider(name, config, this.rotation);
      this.upstreams.push(provider);
      bindings = await provider.bindings();
    }
    return filterBindings(config, bindings);
  }

  private managementBindings(): ToolBinding[] {
    const statusTool: Tool = {
      name: "search_pool_status",
      title: "Search provider and key-pool status",
      description: "Show enabled providers, exposed tools, masked key slots, rotation cursors, and startup warnings. Never returns raw keys.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    };
    const autoTool: Tool = {
      name: "search_auto",
      title: "Search with the recommended provider",
      description: "Route general queries to Querit, exact/code queries to Exa, current research to Tavily, official-site lookups to Serper, and LLM-ready grounding to Brave, Parallel, or You.com. Doubao is never selected automatically. Results include auditable provider and tool route metadata.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", minLength: 1 },
          mode: { type: "string", enum: ["general", "exact", "current", "official", "context"], default: "general" },
          limit: { type: "integer", minimum: 1, maximum: 20, default: 6 },
        },
        required: ["query"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    };
    const probeTool: Tool = {
      name: "search_rotation_probe",
      title: "Verify provider key rotation",
      description: "Run a small number of real calls through one provider and return the masked key-slot sequence. This consumes provider quota.",
      inputSchema: {
        type: "object",
        properties: {
          provider: { type: "string" },
          query: { type: "string", minLength: 1 },
          calls: { type: "integer", minimum: 1, maximum: 12 },
          tool: { type: "string", description: "Optional exposed tool name; defaults to the provider's first search tool" },
        },
        required: ["provider", "query"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    };
    return [
      binding(statusTool, async () => result(this.status())),
      binding(autoTool, async (args) => this.callAuto(args)),
      binding(probeTool, async (args) => this.probe(args)),
    ];
  }

  private async callAuto(args: Record<string, unknown>): Promise<unknown> {
    const mode = typeof args.mode === "string" ? args.mode : "general";
    const candidates = mode === "exact"
      ? ["exa_web_search_advanced_exa", "exa_web_search_exa", "querit_search"]
      : mode === "context"
        ? ["brave_llm_context", "parallel_search", "you_search", "tavily_tavily_search", "linkup_linkup_search"]
      : mode === "current"
        ? ["tavily_tavily_search", "you_search", "brave_news_search", "querit_search", "serper_news"]
        : mode === "official"
          ? ["serper_search", "querit_search", "exa_web_search_exa"]
          : ["querit_search", "parallel_search", "you_search", "brave_web_search", "serper_search", "tavily_tavily_search"];
    const selectedName = candidates.find((name) => {
      const candidate = this.bindings.get(name);
      if (!candidate) return false;
      const provider = this.config.providers[candidate.provider];
      return provider?.automatic === true && provider.manualOnly !== true;
    });
    if (!selectedName) throw new Error(`No automatic provider is available for mode ${mode}`);
    const selected = this.bindings.get(selectedName);
    if (!selected) throw new Error(`Automatic provider disappeared: ${selectedName}`);
    const output = await selected.call(toolArguments(selected.exposed, String(args.query ?? ""), Number(args.limit ?? 6)));
    return attachRouteMetadata(selected, output);
  }

  private async probe(args: Record<string, unknown>): Promise<unknown> {
    const provider = String(args.provider ?? "");
    const config = this.config.providers[provider];
    if (!config?.enabled) throw new Error(`Provider is not enabled: ${provider}`);
    const providerTools = Array.from(this.bindings.values()).filter((item) => item.provider === provider);
    const requested = typeof args.tool === "string" ? this.bindings.get(args.tool) : undefined;
    const selected = requested ?? providerTools.find((item) => /search/i.test(item.exposed.name)) ?? providerTools[0];
    if (!selected || selected.provider !== provider) throw new Error(`No callable tool found for provider: ${provider}`);
    const count = Math.min(Number(args.calls ?? config.keys.length), Math.max(config.keys.length, 1), 12);
    const attempts: unknown[] = [];
    for (let index = 0; index < count; index += 1) {
      try {
        const output = await selected.call(toolArguments(selected.exposed, String(args.query ?? ""), 1));
        attempts.push({ index: index + 1, ok: true, meta: extractMeta(output) });
      } catch (error) {
        attempts.push({ index: index + 1, ok: false, error: cleanError(error) });
      }
    }
    return result({ provider, tool: selected.exposed.name, attempts, status: this.rotation.status(provider, config.keys) });
  }
}

function binding(tool: Tool, call: ToolBinding["call"]): ToolBinding {
  return { exposed: tool, provider: "search_toolkit", upstreamName: tool.name, call };
}

function result(value: unknown): unknown {
  return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value };
}

export function attachRouteMetadata(binding: ToolBinding, output: unknown): unknown {
  const route = {
    provider: binding.provider,
    tool: binding.exposed.name,
    upstreamTool: binding.upstreamName,
  };
  if (!output || typeof output !== "object") return result({ route, result: output });
  const record = output as Record<string, unknown>;
  const content = Array.isArray(record.content) ? record.content : [];
  const resultContent = isRouteContentBlock(content[0]) ? content.slice(1) : content;
  const meta = record._meta && typeof record._meta === "object"
    ? record._meta as Record<string, unknown>
    : {};
  const searchToolkitMeta = meta.searchToolkit && typeof meta.searchToolkit === "object"
    ? meta.searchToolkit as Record<string, unknown>
    : {};
  return {
    ...record,
    content: [{ type: "text", text: JSON.stringify({ searchToolkitRoute: route }) }, ...resultContent],
    structuredContent: { route, result: record.structuredContent ?? null },
    _meta: { ...meta, searchToolkit: { ...searchToolkitMeta, route } },
  };
}

function isRouteContentBlock(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const block = value as Record<string, unknown>;
  if (block.type !== "text" || typeof block.text !== "string") return false;
  try {
    const parsed = JSON.parse(block.text) as Record<string, unknown>;
    return Boolean(parsed.searchToolkitRoute && typeof parsed.searchToolkitRoute === "object");
  } catch {
    return false;
  }
}

export function filterBindings(config: ProviderConfig, bindings: ToolBinding[]): ToolBinding[] {
  const allow = config.toolPolicy?.allow;
  const deny = new Set(config.toolPolicy?.deny ?? []);
  return bindings.filter((binding) => {
    const names = [binding.upstreamName, binding.exposed.name];
    const allowed = !allow || allow.includes("*") || names.some((name) => allow.includes(name));
    return allowed && !names.some((name) => deny.has(name));
  });
}

function cleanError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/[A-Za-z0-9_-]{24,}/g, "<redacted>").slice(0, 500);
}

function extractMeta(value: unknown): unknown {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  return record._meta ?? record.structuredContent;
}

function toolArguments(tool: Tool, query: string, limit: number): Record<string, unknown> {
  const properties = tool.inputSchema && typeof tool.inputSchema === "object"
    ? (tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {}
    : {};
  const args: Record<string, unknown> = {};
  const queryName = ["query", "q", "search_query"].find((name) => name in properties) ?? "query";
  args[queryName] = query;
  for (const name of ["max_results", "numResults", "limit", "count", "num"]) {
    if (name in properties) {
      args[name] = limit;
      break;
    }
  }
  return args;
}
