import { dirname, join } from "node:path";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { integrationFingerprint, ToolCatalogCache, toolsFingerprint } from "./catalog.js";
import { loadConfigWithNotes } from "./config.js";
import { shouldFailoverProvider, statusFromError, textOfContent, ToolResultError } from "./errors.js";
import { mergeItems, type MergedItem } from "./merge.js";
import { attachRouteMetadata, bodyBlocks, cleanError, isRouteContentBlock, isToolErrorResult, result } from "./provenance.js";
import { renderItems } from "./render.js";
import { RestProvider } from "./rest/base.js";
import { adapterFor } from "./rest/adapters.js";
import { RotationStore } from "./rotation.js";
import {
  autoCandidates, autoMode, fetchCandidates, imageCandidates,
  type AutoCandidate, type AutoQuality,
} from "./routes.js";
import { shapeTool } from "./shape.js";
import {
  AUTO_TOOL, FETCH_TOOL, GATEWAY_CALL_TOOL, GATEWAY_LIST_TOOL, GATEWAY_TOOL_NAMES,
  IMAGES_TOOL, MANAGEMENT_TOOL_NAMES, PROBE_TOOL, STATUS_TOOL,
} from "./tools.js";
import type { AutoCapability, ProviderConfig, ToolBinding, ToolkitConfig, ToolkitProfile } from "./types.js";
import { UpstreamMcpProvider } from "./upstream.js";

export { attachRouteMetadata } from "./provenance.js";
export { autoCandidates, fetchCandidates, imageCandidates } from "./routes.js";
export type { AutoCandidate, AutoFreshness, AutoMode, AutoQuality } from "./routes.js";

interface AutoAttempt {
  provider: string;
  tool: string;
  candidateRank: number;
  outcome: "success" | "error" | "empty";
  status?: number;
}

interface ChainSpec {
  tool: string;
  capability: AutoCapability;
  maxProviders: number;
  meta: Record<string, unknown>;
  emptyError: string;
  /** Soft success test: false means "answered, but nothing usable"; the next provider is tried. */
  usable?: (output: unknown) => boolean;
}

export interface ToolkitOptions {
  profile?: ToolkitProfile;
}

type Validator = ReturnType<AjvJsonSchemaValidator["getValidator"]>;

const MIN_FETCH_CHARS = 80;
const LEAN_TOOL_NAMES = new Set(MANAGEMENT_TOOL_NAMES);

export class SearchToolkit {
  readonly config: ToolkitConfig;
  readonly rotation: RotationStore;
  readonly warnings: string[] = [];
  readonly profile: ToolkitProfile;
  private readonly bindings = new Map<string, ToolBinding>();
  private readonly fullTools = new Map<string, Tool>();
  private readonly owned = new Map<string, string[]>();
  private readonly upstreams = new Map<string, UpstreamMcpProvider>();
  private readonly listeners = new Set<() => void>();
  private readonly validators = new Map<string, Validator | null>();
  private readonly validatorFactory = new AjvJsonSchemaValidator();
  private readonly catalog: ToolCatalogCache;
  private closed = false;

  constructor(configPath?: string, options: ToolkitOptions = {}) {
    const loaded = loadConfigWithNotes(configPath);
    this.config = loaded.config;
    this.warnings.push(...loaded.notes);
    this.rotation = new RotationStore(this.config.statePath);
    this.rotation.adoptLegacyState(Object.fromEntries(
      Object.entries(this.config.providers).map(([name, provider]) => [name, provider.keys]),
    ));
    this.profile = options.profile ?? profileFromEnv() ?? this.config.profile ?? "full";
    this.catalog = new ToolCatalogCache(join(dirname(this.config.statePath), "tool-catalog.json"));
  }

  async initialize(): Promise<void> {
    const providers = Object.entries(this.config.providers).filter(([, config]) => config.enabled);
    // Providers are independent, so connect and discover them concurrently.
    const settled = await Promise.all(providers.map(async ([name, config]) => {
      try {
        return { name, bindings: await this.providerBindings(name, config) };
      } catch (error) {
        this.warnings.push(`${name}: ${cleanError(error)}`);
        return { name, bindings: [] as ToolBinding[] };
      }
    }));
    for (const { name, bindings } of settled) {
      try {
        this.registerProvider(name, bindings);
      } catch (error) {
        this.warnings.push(`${name}: ${cleanError(error)}`);
      }
    }
    for (const managed of this.managementBindings()) this.bindings.set(managed.exposed.name, managed);
  }

  /** Tools visible to MCP clients under the active profile. */
  listTools(): Tool[] {
    const exposed = Array.from(this.bindings.values(), (binding) => binding.exposed);
    return this.profile === "lean"
      ? exposed.filter((tool) => LEAN_TOOL_NAMES.has(tool.name))
      : exposed.filter((tool) => !GATEWAY_TOOL_NAMES.has(tool.name));
  }

  /** Subscribe to tool-catalog changes (an upstream's tools changed after a background refresh). */
  onToolsChanged(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async callTool(name: string, arguments_: Record<string, unknown>): Promise<unknown> {
    const binding = this.bindings.get(name);
    if (!binding) throw new Error(`Unknown Search Toolkit tool: ${name}`);
    return binding.call(this.validateArguments(binding.exposed, arguments_));
  }

  /** Validate and default arguments against the exposed schema. A schema the validator cannot compile is left to the upstream. */
  validateArguments(tool: Tool, arguments_: Record<string, unknown>): Record<string, unknown> {
    let validator = this.validators.get(tool.name);
    if (validator === undefined) {
      try {
        validator = this.validatorFactory.getValidator(tool.inputSchema as Parameters<AjvJsonSchemaValidator["getValidator"]>[0]);
      } catch {
        validator = null;
      }
      this.validators.set(tool.name, validator);
    }
    if (!validator) return arguments_;
    const validation = validator(arguments_ ?? {});
    if (!validation.valid) throw new Error(`Invalid arguments for ${tool.name}: ${validation.errorMessage}`);
    return validation.data as Record<string, unknown>;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.listeners.clear();
    await Promise.allSettled(Array.from(this.upstreams.values(), (provider) => provider.close()));
    this.rotation.close();
  }

  status(verbose = false): unknown {
    const tools = this.listTools();
    return {
      version: 2,
      profile: this.profile,
      verbose,
      providers: Object.entries(this.config.providers).map(([name, config]) => ({
        name,
        enabled: config.enabled,
        auto: config.auto,
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
      this.upstreams.set(name, provider);
      const fingerprint = integrationFingerprint(config.integration);
      const cached = this.catalog.get(name, fingerprint);
      let tools: Tool[];
      if (cached) {
        // Ready immediately from the snapshot; the upstream is contacted on first use.
        tools = cached.tools;
        if (cached.stale) this.refreshCatalog(name, config, provider, fingerprint, toolsFingerprint(tools));
      } else {
        tools = await provider.discover();
        this.catalog.set(name, fingerprint, tools);
      }
      bindings = provider.bindingsFor(tools);
    }
    return this.shapeBindings(config, filterBindings(config, bindings));
  }

  private shapeBindings(config: ProviderConfig, bindings: ToolBinding[]): ToolBinding[] {
    return bindings.map((binding) => {
      this.fullTools.set(binding.exposed.name, binding.exposed);
      const override = config.toolPolicy?.descriptions?.[binding.upstreamName];
      return { ...binding, exposed: shapeTool(binding.exposed, this.config.shaping, override) };
    });
  }

  private registerProvider(name: string, bindings: ToolBinding[]): void {
    for (const previous of this.owned.get(name) ?? []) {
      this.bindings.delete(previous);
      this.validators.delete(previous);
    }
    const names: string[] = [];
    for (const binding of bindings) {
      if (this.bindings.has(binding.exposed.name)) {
        throw new Error(`Duplicate tool name: ${binding.exposed.name}`);
      }
      this.bindings.set(binding.exposed.name, binding);
      names.push(binding.exposed.name);
    }
    this.owned.set(name, names);
  }

  private refreshCatalog(name: string, config: ProviderConfig, provider: UpstreamMcpProvider, fingerprint: string, known: string): void {
    void provider.discover().then((tools) => {
      if (this.closed) return;
      this.catalog.set(name, fingerprint, tools);
      if (toolsFingerprint(tools) === known) return;
      this.registerProvider(name, this.shapeBindings(config, filterBindings(config, provider.bindingsFor(tools))));
      for (const listener of this.listeners) listener();
    }).catch(() => undefined);
  }

  private managementBindings(): ToolBinding[] {
    return [
      binding(STATUS_TOOL, async (args) => result(this.status(args.verbose === true))),
      binding(AUTO_TOOL, async (args) => this.callAuto(args)),
      binding(IMAGES_TOOL, async (args) => this.callImageSearch(args)),
      binding(FETCH_TOOL, async (args) => this.callFetch(args)),
      binding(PROBE_TOOL, async (args) => this.probe(args)),
      binding(GATEWAY_LIST_TOOL, async (args) => this.gatewayList(args)),
      binding(GATEWAY_CALL_TOOL, async (args) => this.gatewayCall(args)),
    ];
  }

  private async callAuto(args: Record<string, unknown>): Promise<unknown> {
    const mode = autoMode(args.mode);
    const quality: AutoQuality = args.quality === "max" ? "max" : "balanced";
    const candidates = autoCandidates(mode, quality, args);
    const spec: ChainSpec = {
      tool: "search_auto",
      capability: "search",
      maxProviders: 2,
      meta: { mode, quality },
      emptyError: `No automatic provider is available for mode ${mode}`,
    };
    if (args.crossCheck === true && mode !== "context") {
      const merged = await this.crossCheck(candidates, spec, Number(args.limit ?? 6));
      if (merged) return merged;
    }
    return this.runChain(candidates, spec);
  }

  private callImageSearch(args: Record<string, unknown>): Promise<unknown> {
    return this.runChain(imageCandidates(args), {
      tool: "search_images",
      capability: "images",
      maxProviders: 2,
      meta: { mode: "images" },
      emptyError: "No automatic image-search provider is available",
    });
  }

  private async callFetch(args: Record<string, unknown>): Promise<unknown> {
    const url = String(args.url ?? "").trim();
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error("fetch_auto requires an absolute http(s) URL");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("fetch_auto requires an http(s) URL");
    const quality: AutoQuality = args.quality === "max" ? "max" : "balanced";
    const maxChars = typeof args.maxChars === "number" ? args.maxChars : 12_000;
    const output = await this.runChain(fetchCandidates(quality, { url: parsed.toString(), maxChars }), {
      tool: "fetch_auto",
      capability: "fetch",
      maxProviders: 3,
      meta: { mode: "fetch", quality },
      emptyError: "No automatic fetch provider is available",
      usable: (candidate) => bodyText(candidate).trim().length >= MIN_FETCH_CHARS,
    });
    return truncateBody(output, maxChars);
  }

  private eligible(candidates: AutoCandidate[], capability: AutoCapability) {
    return candidates
      .map((candidate, index) => ({ candidate, candidateRank: index + 1, binding: this.bindings.get(candidate.name) }))
      .filter((entry): entry is typeof entry & { binding: ToolBinding } => {
        if (!entry.binding) return false;
        return this.config.providers[entry.binding.provider]?.auto.includes(capability) === true;
      });
  }

  /** Try candidates in order; move on only after a recognised availability failure or an unusable answer. */
  private async runChain(candidates: AutoCandidate[], spec: ChainSpec): Promise<unknown> {
    const eligible = this.eligible(candidates, spec.capability);
    if (!eligible.length) throw new Error(spec.emptyError);

    const attempts: AutoAttempt[] = [];
    let lastError: unknown;
    let fallback: { entry: (typeof eligible)[number]; output: unknown } | undefined;
    for (const entry of eligible.slice(0, spec.maxProviders)) {
      const base = { provider: entry.binding.provider, tool: entry.binding.exposed.name, candidateRank: entry.candidateRank };
      try {
        const output = await entry.binding.call({ ...(entry.candidate.nativeArguments ?? {}) });
        if (isToolErrorResult(output)) {
          throw new ToolResultError(textOfContent(bodyBlocks(output)).slice(0, 500), bodyBlocks(output));
        }
        if (spec.usable && !spec.usable(output)) {
          attempts.push({ ...base, outcome: "empty" });
          if (!fallback || bodyText(output).length > bodyText(fallback.output).length) fallback = { entry, output };
          continue;
        }
        attempts.push({ ...base, outcome: "success" });
        return attachRouteMetadata(entry.binding, output, {
          ...spec.meta,
          candidateRank: entry.candidateRank,
          providerAttempt: attempts.length,
          attempts,
        });
      } catch (error) {
        lastError = error;
        const status = statusFromError(error);
        attempts.push({ ...base, outcome: "error", ...(status ? { status } : {}) });
        if (!shouldFailoverProvider(error)) throw autoFailure(error, attempts, spec.tool);
      }
    }
    if (fallback) {
      // Every reader answered thinly; return the fullest answer rather than an error.
      return attachRouteMetadata(fallback.entry.binding, fallback.output, {
        ...spec.meta,
        candidateRank: fallback.entry.candidateRank,
        providerAttempt: attempts.length,
        attempts,
      });
    }
    throw autoFailure(lastError ?? new Error(spec.emptyError), attempts, spec.tool);
  }

  /** Query two independent REST-backed indexes concurrently and merge by URL. Returns undefined when a pair is not available. */
  private async crossCheck(candidates: AutoCandidate[], spec: ChainSpec, limit: number): Promise<unknown | undefined> {
    const seen = new Set<string>();
    const pair = this.eligible(candidates, spec.capability).filter((entry) => {
      const provider = entry.binding.provider;
      if (seen.has(provider) || this.config.providers[provider]?.integration.kind !== "rest") return false;
      seen.add(provider);
      return true;
    }).slice(0, 2);
    if (pair.length < 2) return undefined;

    const settled = await Promise.allSettled(pair.map((entry) => entry.binding.call({ ...(entry.candidate.nativeArguments ?? {}) })));
    const lists: Array<{ provider: string; items: MergedItem[] }> = [];
    const routes: Array<Record<string, unknown>> = [];
    const failed: string[] = [];
    settled.forEach((outcome, index) => {
      const entry = pair[index] as (typeof pair)[number];
      const items = outcome.status === "fulfilled" ? itemsOf(outcome.value) : undefined;
      if (!items) {
        failed.push(entry.binding.provider);
        return;
      }
      lists.push({ provider: entry.binding.provider, items: items as MergedItem[] });
      routes.push({ provider: entry.binding.provider, tool: entry.binding.exposed.name, upstreamTool: entry.binding.upstreamName });
    });
    if (!lists.length) return undefined;

    const merged = mergeItems(lists, limit);
    const auto = {
      ...spec.meta,
      crossCheck: { routes, failed, corroborated: merged.filter((item) => item.foundBy.length > 1).length },
    };
    const route = routes[0] as Record<string, unknown>;
    return {
      content: [
        { type: "text", text: JSON.stringify({ searchToolkitRoute: route, searchToolkitAuto: auto }) },
        { type: "text", text: renderItems(merged) },
      ],
      structuredContent: { route, searchAuto: auto, result: { items: merged } },
      _meta: { searchToolkit: { route, auto } },
    };
  }

  private gatewayList(args: Record<string, unknown>): unknown {
    const name = typeof args.name === "string" ? args.name : undefined;
    if (name) {
      const tool = this.fullTools.get(name);
      if (!tool || MANAGEMENT_TOOL_NAMES.has(name)) throw new Error(`Unknown provider tool: ${name}`);
      return result({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema, annotations: tool.annotations });
    }
    const provider = typeof args.provider === "string" ? args.provider : undefined;
    const rows = Array.from(this.bindings.values())
      .filter((item) => !MANAGEMENT_TOOL_NAMES.has(item.exposed.name) && (!provider || item.provider === provider))
      .map((item) => {
        const full = this.fullTools.get(item.exposed.name) ?? item.exposed;
        const kind = full.annotations?.readOnlyHint === true ? "read" : "action";
        return `${item.exposed.name} [${kind}] ${firstSentence(full.description ?? "", 110)}`;
      });
    return { content: [{ type: "text", text: rows.length ? rows.join("\n") : "No provider tools match." }] };
  }

  private async gatewayCall(args: Record<string, unknown>): Promise<unknown> {
    const name = String(args.name ?? "");
    const target = this.bindings.get(name);
    if (!target || MANAGEMENT_TOOL_NAMES.has(name)) throw new Error(`Unknown provider tool: ${name}`);
    const inner = args.arguments && typeof args.arguments === "object" ? args.arguments as Record<string, unknown> : {};
    return target.call(this.validateArguments(target.exposed, inner));
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

function profileFromEnv(): ToolkitProfile | undefined {
  const value = process.env.SEARCH_TOOLKIT_PROFILE;
  return value === "full" || value === "lean" ? value : undefined;
}

function binding(tool: Tool, call: ToolBinding["call"]): ToolBinding {
  return { exposed: tool, provider: "search_toolkit", upstreamName: tool.name, call };
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

export function filterBindings(config: ProviderConfig, bindings: ToolBinding[]): ToolBinding[] {
  const allow = config.toolPolicy?.allow;
  const deny = new Set(config.toolPolicy?.deny ?? []);
  return bindings.filter((item) => {
    const names = [item.upstreamName, item.exposed.name];
    const allowed = !allow || allow.includes("*") || names.some((name) => allow.includes(name));
    return allowed && !names.some((name) => deny.has(name));
  });
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

function firstSentence(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const end = flat.search(/[.!?](?:\s|$)/);
  const sentence = end > 0 ? flat.slice(0, end + 1) : flat;
  return sentence.length > max ? `${sentence.slice(0, max - 1).trimEnd()}…` : sentence;
}

function bodyText(output: unknown): string {
  return textOfContent(bodyBlocks(output));
}

function itemsOf(output: unknown): unknown[] | undefined {
  if (!output || typeof output !== "object") return undefined;
  const data = (output as { structuredContent?: { data?: { items?: unknown } } }).structuredContent?.data;
  return Array.isArray(data?.items) ? data.items : undefined;
}

/** Cap the readable text of a result, keeping the route block and any non-text content. */
export function truncateBody(output: unknown, maxChars: number): unknown {
  if (!output || typeof output !== "object") return output;
  const record = output as { content?: unknown };
  if (!Array.isArray(record.content)) return output;
  let remaining = maxChars;
  let dropped = 0;
  const content = record.content.map((block, index) => {
    if (index === 0 && isRouteContentBlock(block)) return block;
    const text = block && typeof block === "object" ? (block as { type?: string; text?: unknown }) : undefined;
    if (text?.type !== "text" || typeof text.text !== "string") return block;
    if (text.text.length <= remaining) {
      remaining -= text.text.length;
      return block;
    }
    dropped += text.text.length - remaining;
    const kept = text.text.slice(0, Math.max(remaining, 0));
    remaining = 0;
    return { ...text, text: kept };
  });
  if (dropped > 0) content.push({ type: "text", text: `…[truncated: ${dropped} more characters; raise maxChars to read further]` });
  return { ...(output as object), content };
}

function autoFailure(error: unknown, attempts: AutoAttempt[], toolName = "search_auto"): Error {
  const summary = attempts
    .map((attempt) => `${attempt.provider}/${attempt.tool}[${attempt.status ?? attempt.outcome}]`)
    .join(" -> ");
  const wrapped = new Error(`${toolName} failed after ${summary || "no provider attempts"}: ${cleanError(error)}`);
  (wrapped as Error & { attempts: AutoAttempt[] }).attempts = attempts.map((attempt) => ({ ...attempt }));
  return wrapped;
}
