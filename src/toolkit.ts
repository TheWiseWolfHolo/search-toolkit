import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { loadConfig } from "./config.js";
import { shouldFailoverProvider, statusFromError } from "./errors.js";
import { RestProvider } from "./rest/base.js";
import { adapterFor } from "./rest/adapters.js";
import { RotationStore } from "./rotation.js";
import type { ProviderConfig, ToolBinding, ToolkitConfig } from "./types.js";
import { UpstreamMcpProvider } from "./upstream.js";

export type AutoMode = "general" | "exact" | "current" | "official" | "context";
export type AutoQuality = "balanced" | "max";
export type AutoFreshness = "day" | "week" | "month" | "year";

export interface AutoCandidate {
  name: string;
  nativeArguments?: Record<string, unknown>;
}

interface AutoAttempt {
  provider: string;
  tool: string;
  candidateRank: number;
  outcome: "success" | "error";
  status?: number;
}

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

  status(verbose = false): unknown {
    const tools = this.listTools();
    return {
      version: 1,
      verbose,
      providers: Object.entries(this.config.providers).map(([name, config]) => ({
        name,
        enabled: config.enabled,
        automatic: config.automatic,
        manualOnly: config.manualOnly ?? false,
        integration: config.integration.kind,
        rotation: verbose
          ? this.rotation.status(name, config.keys)
          : compactRotation(this.rotation.status(name, config.keys)),
      })),
      toolCount: tools.length,
      ...(verbose ? { tools: tools.map((tool) => tool.name) } : {}),
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
      description: "Show a compact masked provider/key-pool health summary and startup warnings. Set verbose=true for complete masked key-slot counters and the exposed tool list. Never returns raw keys.",
      inputSchema: {
        type: "object",
        properties: {
          verbose: {
            type: "boolean",
            default: false,
            description: "Include every masked key slot, its counters, and the complete exposed tool list.",
          },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    };
    const autoTool: Tool = {
      name: "search_auto",
      title: "Search with the recommended provider",
      description: "Quality-first routing across Parallel, You.com, Brave, Exa, Querit, Tavily, and Serper. Use balanced for routine work and max for complex semantic or multi-hop retrieval. On a recognized provider-availability failure it may try one compatible retrieval fallback. Doubao, research, crawl, and agentic tools are never selected automatically. Results include auditable route and attempt metadata.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", minLength: 1 },
          mode: { type: "string", enum: ["general", "exact", "current", "official", "context"], default: "general" },
          quality: {
            type: "string",
            enum: ["balanced", "max"],
            default: "balanced",
            description: "Balanced uses strong routine retrieval; max selects Parallel Advanced or Exa Advanced where the mode supports it",
          },
          freshness: {
            type: "string",
            enum: ["day", "week", "month", "year"],
            default: "week",
            description: "Current-mode time window mapped to each provider's native freshness control; ignored by other modes",
          },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 20,
            default: 6,
            description: "Requested result limit. Brave LLM Context ignores this field and preserves a 20-source grounding pool; context-mode fallback providers may apply it to their own result count.",
          },
          maximumNumberOfTokens: {
            type: "integer",
            minimum: 1024,
            maximum: 32768,
            default: 4096,
            description: "Brave LLM Context token budget when context mode selects Brave; other fallback providers ignore this field",
          },
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
      binding(statusTool, async (args) => result(this.status(args.verbose === true))),
      binding(autoTool, async (args) => this.callAuto(args)),
      binding(probeTool, async (args) => this.probe(args)),
    ];
  }

  private async callAuto(args: Record<string, unknown>): Promise<unknown> {
    const mode = autoMode(args.mode);
    const quality = args.quality === "max" ? "max" : "balanced";
    const candidates = autoCandidates(mode, quality, args)
      .map((candidate, index) => ({ candidate, candidateRank: index + 1, binding: this.bindings.get(candidate.name) }))
      .filter((entry): entry is typeof entry & { binding: ToolBinding } => {
        if (!entry.binding) return false;
        const provider = this.config.providers[entry.binding.provider];
        return provider?.automatic === true && provider.manualOnly !== true;
      });
    if (!candidates.length) throw new Error(`No automatic provider is available for mode ${mode}`);

    const attempts: AutoAttempt[] = [];
    let lastError: unknown;
    for (const entry of candidates.slice(0, 2)) {
      const selectedArguments = { ...(entry.candidate.nativeArguments ?? {}) };
      try {
        const output = await entry.binding.call(selectedArguments);
        attempts.push({
          provider: entry.binding.provider,
          tool: entry.binding.exposed.name,
          candidateRank: entry.candidateRank,
          outcome: "success",
        });
        return attachRouteMetadata(entry.binding, output, {
          mode,
          quality,
          candidateRank: entry.candidateRank,
          providerAttempt: attempts.length,
          attempts,
        });
      } catch (error) {
        lastError = error;
        const status = statusFromError(error);
        attempts.push({
          provider: entry.binding.provider,
          tool: entry.binding.exposed.name,
          candidateRank: entry.candidateRank,
          outcome: "error",
          ...(status ? { status } : {}),
        });
        if (!shouldFailoverProvider(error)) throw autoFailure(error, attempts);
      }
    }
    throw autoFailure(lastError ?? new Error(`No automatic provider completed mode ${mode}`), attempts);
  }

  private async probe(args: Record<string, unknown>): Promise<unknown> {
    const provider = String(args.provider ?? "");
    const config = this.config.providers[provider];
    if (!config?.enabled) throw new Error(`Provider is not enabled: ${provider}`);
    const providerTools = Array.from(this.bindings.values()).filter((item) => item.provider === provider);
    const requested = typeof args.tool === "string" ? this.bindings.get(args.tool) : undefined;
    const selected = requested
      ?? providerTools.find((item) => item.exposed.name === `${provider}_search`)
      ?? providerTools.find((item) => item.upstreamName === "search")
      ?? providerTools.find((item) => /search/i.test(item.exposed.name))
      ?? providerTools[0];
    if (!selected || selected.provider !== provider) throw new Error(`No callable tool found for provider: ${provider}`);
    const count = Math.min(Number(args.calls ?? config.keys.length), Math.max(config.keys.length, 1), 12);
    const attempts: unknown[] = [];
    for (let index = 0; index < count; index += 1) {
      try {
        const output = await selected.call(probeArguments(selected.exposed, String(args.query ?? ""), 1));
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

function compactRotation(rotation: ReturnType<RotationStore["status"]>): unknown {
  const counts = { healthy: 0, cooldown: 0, disabled: 0 };
  const unhealthySlots: Array<Record<string, unknown>> = [];
  for (const key of rotation.keys) {
    const details = key.status as Record<string, unknown>;
    const status = details.status === "cooldown" || details.status === "disabled" ? details.status : "healthy";
    counts[status] += 1;
    if (status !== "healthy") {
      const { slot: _duplicateSlot, ...health } = details;
      unhealthySlots.push({ slot: key.slot, masked: key.masked, ...health });
    }
  }
  return {
    keyCount: rotation.keyCount,
    nextSlot: rotation.nextSlot,
    ...counts,
    unhealthySlots,
  };
}

export function attachRouteMetadata(
  binding: ToolBinding,
  output: unknown,
  auto?: Record<string, unknown>,
): unknown {
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
    content: [{
      type: "text",
      text: JSON.stringify({ searchToolkitRoute: route, ...(auto ? { searchToolkitAuto: auto } : {}) }),
    }, ...resultContent],
    structuredContent: { route, ...(auto ? { searchAuto: auto } : {}), result: record.structuredContent ?? null },
    _meta: { ...meta, searchToolkit: { ...searchToolkitMeta, route, ...(auto ? { auto } : {}) } },
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

function probeArguments(tool: Tool, query: string, limit: number): Record<string, unknown> {
  const properties = tool.inputSchema && typeof tool.inputSchema === "object"
    ? (tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {}
    : {};
  const args: Record<string, unknown> = {};
  const queryName = ["query", "q", "search_query"].find((name) => name in properties) ?? "query";
  args[queryName] = query;
  for (const name of ["max_results", "maxResults", "numResults", "limit", "count", "num"]) {
    if (name in properties) {
      args[name] = limit;
      break;
    }
  }
  return args;
}

function autoMode(value: unknown): AutoMode {
  return value === "exact" || value === "current" || value === "official" || value === "context"
    ? value
    : "general";
}

function autoFreshness(value: unknown): AutoFreshness {
  return value === "day" || value === "month" || value === "year" ? value : "week";
}

export function autoCandidates(mode: AutoMode, quality: AutoQuality, args: Record<string, unknown> = {}): AutoCandidate[] {
  const query = String(args.query ?? "");
  const limit = Number(args.limit ?? 6);
  const parallelMode = quality === "max" ? "advanced" : "fast";
  const tavilyDepth = quality === "max" ? "advanced" : "basic";
  const braveTokens = typeof args.maximumNumberOfTokens === "number" ? args.maximumNumberOfTokens : 4096;
  const freshness = autoFreshness(args.freshness);
  const braveFreshness = { day: "pd", week: "pw", month: "pm", year: "py" }[freshness];
  const serperFreshness = { day: "qdr:d", week: "qdr:w", month: "qdr:m", year: "qdr:y" }[freshness];
  const candidate = (
    name: string,
    limitKey: "limit" | "max_results" | "maxResults" | "numResults" | undefined,
    nativeArguments: Record<string, unknown> = {},
  ): AutoCandidate => ({
    name,
    nativeArguments: {
      query,
      ...(limitKey ? { [limitKey]: limit } : {}),
      ...nativeArguments,
    },
  });
  switch (mode) {
    case "exact":
      return [
        candidate(quality === "max" ? "exa_web_search_advanced_exa" : "exa_web_search_exa", "numResults"),
        candidate("serper_search", "limit"),
        candidate("tavily_tavily_search", "max_results", { search_depth: tavilyDepth, exact_match: true }),
        candidate("brave_web_search", "limit"),
      ];
    case "context":
      return quality === "max"
        ? [
            candidate("parallel_search", "maxResults", { mode: "advanced" }),
            candidate("brave_llm_context", undefined, { count: 20, maximumNumberOfTokens: braveTokens }),
            candidate("you_search", "limit", { contentLevel: "highlights" }),
            candidate("tavily_tavily_search", "max_results", { search_depth: "advanced" }),
          ]
        : [
            candidate("brave_llm_context", undefined, { count: 20, maximumNumberOfTokens: braveTokens }),
            candidate("parallel_search", "maxResults", { mode: "basic" }),
            candidate("you_search", "limit", { contentLevel: "highlights" }),
            candidate("tavily_tavily_search", "max_results", { search_depth: "basic" }),
          ];
    case "current":
      return [
        candidate("brave_news_search", "limit", { freshness: braveFreshness }),
        candidate("serper_news", "limit", { tbs: serperFreshness }),
        candidate("you_search", "limit", { contentLevel: "snippets", freshness }),
        candidate("tavily_tavily_search", "max_results", { search_depth: tavilyDepth, time_range: freshness }),
      ];
    case "official":
      return [
        candidate("serper_search", "limit"),
        candidate("brave_web_search", "limit"),
        candidate(quality === "max" ? "exa_web_search_advanced_exa" : "exa_web_search_exa", "numResults"),
        candidate("you_search", "limit", { contentLevel: "snippets" }),
      ];
    default:
      return [
        candidate("parallel_search", "maxResults", { mode: parallelMode }),
        candidate("you_search", "limit", { contentLevel: quality === "max" ? "highlights" : "snippets" }),
        candidate("brave_web_search", "limit"),
        candidate("exa_web_search_exa", "numResults"),
        candidate("querit_search", "limit"),
        candidate("tavily_tavily_search", "max_results", { search_depth: tavilyDepth }),
      ];
  }
}

function autoFailure(error: unknown, attempts: AutoAttempt[]): Error {
  const summary = attempts
    .map((attempt) => `${attempt.provider}/${attempt.tool}[${attempt.status ?? "unknown"}]`)
    .join(" -> ");
  const wrapped = new Error(`search_auto failed after ${summary || "no provider attempts"}: ${cleanError(error)}`);
  (wrapped as Error & { attempts: AutoAttempt[] }).attempts = attempts.map((attempt) => ({ ...attempt }));
  return wrapped;
}
