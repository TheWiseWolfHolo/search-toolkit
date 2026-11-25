import { dirname, join } from "node:path";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { cacheKey, ResultCache } from "./cache.js";
import { integrationFingerprint, ToolCatalogCache, toolsFingerprint } from "./catalog.js";
import { loadConfigWithNotes } from "./config.js";
import {
  CapabilityGateError, InvalidRequestError, isPageFailure, isQuotaExhausted, isTimeout, PlanLimitError,
  shouldFailoverProvider, statusFromError, textOfContent, ToolResultError,
} from "./errors.js";
import {
  bodyText, combineBatchFetch, isUsableFetchResult, isUsableFetchText, parseFetchUrls, readableFetchOutput,
  truncateBody, type TruncateOptions,
} from "./fetching.js";
import { eligibleSlots, slotTier } from "./keys.js";
import { dedupeItems, mergeItems, type MergedItem } from "./merge.js";
import {
  attachRouteMetadata, bodyBlocks, cleanError, isRouteContentBlock, isToolErrorResult, registerKnownSecrets,
  result, routeBlock, type Route, updateAutoMetadata,
} from "./provenance.js";
import { readAllQuotas, type QuotaRow } from "./quota.js";
import { renderItems, renderPayload } from "./render.js";
import { adapterFor } from "./rest/adapters.js";
import { RestProvider } from "./rest/base.js";
import { FLAKY_SCORE, formatDuration, RotationStore } from "./rotation.js";
import {
  autoCandidates, autoMode, cleanDomains, fetchCandidates, imageCandidates,
  type AutoCandidate, type AutoFreshness, type AutoQuality,
} from "./routes.js";
import { shapeTool } from "./shape.js";
import {
  AUTO_TOOL, CURATED_SPECIALIST_TOOLS, FETCH_TOOL, GATEWAY_CALL_TOOL, GATEWAY_LIST_TOOL, GATEWAY_TOOL_NAMES,
  IMAGES_TOOL, MANAGEMENT_TOOL_NAMES, PROBE_TOOL, STATUS_TOOL,
} from "./tools.js";
import type {
  AutoCapability, CallToolOptions, ProviderConfig, SearchItem, ToolBinding, ToolkitConfig, ToolkitProfile,
} from "./types.js";
import { UpstreamMcpProvider } from "./upstream.js";

export { isUsableFetchText, truncateBody, type TruncateOptions } from "./fetching.js";
export { attachRouteMetadata } from "./provenance.js";
export { autoCandidates, fetchCandidates, imageCandidates } from "./routes.js";
export type { AutoCandidate, AutoFreshness, AutoMode, AutoQuality } from "./routes.js";

interface AutoAttempt {
  provider: string;
  tool: string;
  candidateRank: number;
  outcome: "success" | "error" | "empty" | "skipped";
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
  /** Extra failures worth trying the next provider for, beyond availability failures. */
  failover?: (error: unknown) => boolean;
  /** Rewrite a provider's answer before it is judged; may throw to move on. */
  transform?: (output: unknown, provider: string) => unknown;
}

interface RoutedCandidate {
  candidate: AutoCandidate;
  candidateRank: number;
  binding: ToolBinding;
}

interface ChainHistory {
  attempts: AutoAttempt[];
  fallback?: { entry: RoutedCandidate; output: unknown };
  lastError?: unknown;
}

interface CrossCheckSummary {
  routes: Route[];
  failed: string[];
  empty: string[];
  status: "complete" | "partial" | "unavailable";
  corroborated: number;
}

interface FetchCacheEntry {
  output?: unknown;
  requestChars?: number;
  providerCapped?: boolean;
}

/** Readers that return their JSON envelope as text. */
const ENVELOPE_READERS = new Set(["tavily", "firecrawl"]);
/** Fetch providers that accept and enforce a max-characters cap on their response. */
const CAPPED_FETCH_PROVIDERS = new Set(["exa", "parallel"]);
/** Zero-cost promotional tools that remain usable even when a provider's paid credit balance hits 402. */
const ZERO_COST_PROMO_TOOLS = new Set(["vercel_parallel_fast"]);

export interface ToolkitOptions {
  profile?: ToolkitProfile;
  /** false turns the result cache off for this process, whatever the config says. */
  cache?: boolean;
}

type Validator = ReturnType<AjvJsonSchemaValidator["getValidator"]>;

const DEFAULT_BALANCED_EXCERPT_CHARS = 700;
const DEFAULT_MAX_EXCERPT_CHARS = 1_800;
const LEAN_TOOL_NAMES = new Set(MANAGEMENT_TOOL_NAMES);
const CURATED_TOOL_NAMES = new Set([...MANAGEMENT_TOOL_NAMES, ...CURATED_SPECIALIST_TOOLS]);
/** Direct provider tools whose answers are cached like search_auto results (multi-agent Grok calls are expensive). */
const CACHED_DIRECT_PROVIDERS = new Set(["grok"]);

export class SearchToolkit {
  readonly config: ToolkitConfig;
  readonly rotation: RotationStore;
  readonly warnings: string[] = [];
  readonly profile: ToolkitProfile;
  readonly cache: ResultCache | undefined;
  private readonly cacheTtl: { search: number; news: number; fetch: number };
  private readonly bindings = new Map<string, ToolBinding>();
  private readonly fullTools = new Map<string, Tool>();
  private readonly owned = new Map<string, string[]>();
  private readonly upstreams = new Map<string, UpstreamMcpProvider>();
  private readonly listeners = new Set<() => void>();
  private readonly validators = new Map<string, Validator | null>();
  private readonly validatorFactory = new AjvJsonSchemaValidator();
  private readonly catalog: ToolCatalogCache;
  private readonly inflight = new Map<string, Promise<unknown>>();
  private readonly fetchInflight = new Map<string, { requestChars: number; promise: Promise<{ output: unknown; readable: boolean }> }>();
  private closed = false;
  private closePromise: Promise<void> | undefined;

  constructor(configPath?: string, options: ToolkitOptions = {}) {
    const loaded = loadConfigWithNotes(configPath);
    this.config = loaded.config;
    this.warnings.push(...loaded.notes);
    for (const provider of Object.values(this.config.providers)) {
      if (provider.enabled) registerKnownSecrets(provider.keys);
    }
    this.rotation = new RotationStore(this.config.statePath);
    this.rotation.adoptLegacyState(Object.fromEntries(
      Object.entries(this.config.providers).map(([name, provider]) => [name, provider.keys]),
    ));
    this.profile = options.profile ?? profileFromEnv() ?? this.config.profile ?? "full";
    this.catalog = new ToolCatalogCache(
      this.rotation.database(),
      join(dirname(this.config.statePath), "tool-catalog.json"),
    );
    const cache = this.config.cache ?? {};
    const cacheOn = options.cache ?? (process.env.SEARCH_TOOLKIT_CACHE !== "off" && cache.enabled !== false);
    this.cache = cacheOn
      ? new ResultCache(this.rotation.database(), {
          ...(cache.maxEntries !== undefined ? { maxEntries: cache.maxEntries } : {}),
          ...(cache.maxTotalBytes !== undefined ? { maxTotalBytes: cache.maxTotalBytes } : {}),
        })
      : undefined;
    this.cacheTtl = {
      search: (cache.searchTtlSeconds ?? 900) * 1000,
      news: (cache.newsTtlSeconds ?? 300) * 1000,
      fetch: (cache.fetchTtlSeconds ?? 1800) * 1000,
    };
  }

  async initialize(): Promise<void> {
    const providers = Object.entries(this.config.providers).filter(([, config]) => config.enabled);
    const pendingRefreshes: Array<() => void> = [];
    // Providers are independent, so connect and discover them concurrently.
    const settled = await Promise.all(providers.map(async ([name, config]) => {
      try {
        return { name, bindings: await this.providerBindings(name, config, pendingRefreshes) };
      } catch (error) {
        this.warnings.push(`${name}: ${cleanError(error)}`);
        return { name, bindings: { shaped: [] as ToolBinding[], full: [] as Tool[] } };
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
    // Start stale background catalog refreshes only after initial registrations finish so fast refreshes cannot be overwritten.
    for (const startRefresh of pendingRefreshes) startRefresh();
  }

  /** Tools visible to MCP clients under the active profile (or a per-token HTTP profile override). */
  listTools(profileOverride?: ToolkitProfile): Tool[] {
    const active = profileOverride ?? this.profile;
    const exposed = Array.from(this.bindings.values(), (binding) => binding.exposed);
    if (active === "lean") return exposed.filter((tool) => LEAN_TOOL_NAMES.has(tool.name));
    if (active === "curated") return exposed.filter((tool) => CURATED_TOOL_NAMES.has(tool.name));
    return exposed.filter((tool) => !GATEWAY_TOOL_NAMES.has(tool.name));
  }

  /** Convenience helper returning visible tools filtered by profile and optional allowTool predicate. */
  visibleTools(
    profileOrAllow?: ToolkitProfile | ((tool: Tool) => boolean),
    allowTool?: (tool: Tool) => boolean,
  ): Tool[] {
    const profile = typeof profileOrAllow === "string" ? profileOrAllow : undefined;
    const filter = typeof profileOrAllow === "function" ? profileOrAllow : allowTool;
    return this.listTools(profile).filter((tool) => filter?.(tool) ?? true);
  }

  /** Subscribe to tool-catalog changes (an upstream's tools changed after a background refresh). */
  onToolsChanged(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Refresh live balance/quota readings from enabled providers' billing APIs. */
  async refreshQuotas(options?: { providers?: string[]; force?: boolean }): Promise<QuotaRow[]> {
    return readAllQuotas(this.config.providers, this.rotation, options);
  }

  async callTool(
    name: string,
    arguments_: Record<string, unknown>,
    callOptions?: CallToolOptions,
  ): Promise<unknown> {
    const binding = this.bindings.get(name);
    if (!binding) throw new Error(`Unknown Search Toolkit tool: ${name}`);
    const args = this.validateArguments(binding.exposed, arguments_);
    if (name === GATEWAY_LIST_TOOL.name) return this.gatewayList(args, callOptions?.allowTool);
    if (name === GATEWAY_CALL_TOOL.name) return this.gatewayCall(args, callOptions?.allowTool);
    if (name === PROBE_TOOL.name) return this.probe(args, callOptions?.allowTool);
    if (name === STATUS_TOOL.name) {
      if (args.refreshQuota === true) {
        if (callOptions?.isOwner === false) {
          throw new Error("refreshQuota requires owner access");
        }
        const quotaRows = await this.refreshQuotas();
        const snapshot = this.status(args.verbose === true, callOptions) as Record<string, unknown>;
        return result({ ...snapshot, quotaRefresh: quotaRows });
      }
      return result(this.status(args.verbose === true, callOptions));
    }
    return this.invokeBinding(binding, args);
  }

  private async invokeBinding(binding: ToolBinding, args: Record<string, unknown>): Promise<unknown> {
    const callOpts = ZERO_COST_PROMO_TOOLS.has(binding.exposed.name) ? { allowExhausted: true } : undefined;
    if (!CACHED_DIRECT_PROVIDERS.has(binding.provider)) return binding.call(args, callOpts);
    // A Grok multi-agent answer costs dollars; asking the same question again within minutes reuses it.
    const key = cacheKey(binding.exposed.name, { ...args, query: typeof args.query === "string" ? args.query.trim() : args.query });
    const hit = this.fromCache(key);
    if (hit) return hit;
    return this.withSingleflight(key, async () => {
      const recheck = this.fromCache(key);
      if (recheck) return recheck;
      const output = await binding.call(args, callOpts);
      // Do not cache unsourced model-memory fallback answers from Grok.
      if (binding.provider === "grok" && /^\[Grok no /m.test(bodyText(output))) return output;
      return this.remember(key, output, this.cacheTtl.search);
    });
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
    if (!validation.valid) throw new InvalidRequestError(`Invalid arguments for ${tool.name}: ${validation.errorMessage}`);
    return validation.data as Record<string, unknown>;
  }

  close(): Promise<void> {
    this.closed = true;
    this.closePromise ??= (async () => {
      this.listeners.clear();
      await Promise.allSettled(Array.from(this.upstreams.values(), (provider) => provider.close()));
      this.catalog.close();
      this.rotation.close();
      this.cache?.close();
    })();
    return this.closePromise;
  }

  status(verbose = false, scope?: Pick<CallToolOptions, "profile" | "allowTool">): unknown {
    const activeProfile = scope?.profile ?? this.profile;
    const tools = this.listTools(activeProfile).filter((tool) => scope?.allowTool?.(tool) ?? true);
    const failureScores = this.rotation.providerFailureScores();
    return {
      version: 2,
      profile: activeProfile,
      verbose,
      providers: Object.entries(this.config.providers).map(([name, config]) => ({
        name,
        enabled: config.enabled,
        auto: config.auto,
        integration: config.integration.kind,
        ...((failureScores.get(name) ?? 0) >= 0.05 ? { recentFailure: Number((failureScores.get(name) ?? 0).toFixed(2)) } : {}),
        ...(config.strategy && config.strategy !== "round_robin" ? { strategy: config.strategy } : {}),
        rotation: verbose
          ? annotateSlots(config, this.rotation.status(name, config.keys))
          : compactRotation(annotateSlots(config, this.rotation.status(name, config.keys))),
      })),
      toolCount: tools.length,
      cache: this.cache ? { entries: this.cache.entries() } : { enabled: false },
      ...(verbose ? { tools: tools.map((tool) => tool.name) } : {}),
      warnings: this.warnings,
    };
  }

  private async providerBindings(
    name: string,
    config: ProviderConfig,
    pendingRefreshes: Array<() => void>,
  ): Promise<{ shaped: ToolBinding[]; full: Tool[] }> {
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
        if (cached.stale) {
          const known = toolsFingerprint(tools);
          pendingRefreshes.push(() => this.refreshCatalog(name, config, provider, fingerprint, known));
        }
      } else {
        tools = await provider.discover();
        this.catalog.set(name, fingerprint, tools);
      }
      bindings = provider.bindingsFor(tools);
    }
    return this.shapeBindings(config, filterBindings(config, bindings));
  }

  private shapeBindings(config: ProviderConfig, bindings: ToolBinding[]): { shaped: ToolBinding[]; full: Tool[] } {
    const full: Tool[] = [];
    const shaped = bindings.map((binding) => {
      const override = config.toolPolicy?.descriptions?.[binding.upstreamName];
      // Preserve operator description overrides in provider_tools(name) while keeping full parameter schemas.
      full.push(override !== undefined ? { ...binding.exposed, description: override } : binding.exposed);
      return { ...binding, exposed: shapeTool(binding.exposed, this.config.shaping, override) };
    });
    return { shaped, full };
  }

  private registerProvider(name: string, pack: { shaped: ToolBinding[]; full: Tool[] }): void {
    const previousOwned = new Set(this.owned.get(name) ?? []);
    // Validate for cross-provider name collisions before mutating existing maps.
    for (const binding of pack.shaped) {
      if (this.bindings.has(binding.exposed.name) && !previousOwned.has(binding.exposed.name)) {
        throw new Error(`Duplicate tool name: ${binding.exposed.name}`);
      }
    }
    for (const previous of previousOwned) {
      this.bindings.delete(previous);
      this.fullTools.delete(previous);
      this.validators.delete(previous);
    }
    const names: string[] = [];
    pack.shaped.forEach((binding, index) => {
      this.bindings.set(binding.exposed.name, binding);
      const fullTool = pack.full[index];
      if (fullTool) this.fullTools.set(binding.exposed.name, fullTool);
      names.push(binding.exposed.name);
    });
    this.owned.set(name, names);
  }

  private refreshCatalog(name: string, config: ProviderConfig, provider: UpstreamMcpProvider, fingerprint: string, known: string): void {
    void provider.discover().then((tools) => {
      if (this.closed) return;
      this.catalog.set(name, fingerprint, tools);
      if (toolsFingerprint(tools) === known) return;
      try {
        this.registerProvider(name, this.shapeBindings(config, filterBindings(config, provider.bindingsFor(tools))));
        for (const listener of this.listeners) listener();
      } catch (error) {
        this.warnings.push(`${name} catalog refresh: ${cleanError(error)}`);
      }
    }).catch((error) => {
      if (!this.closed) this.warnings.push(`${name} catalog refresh: ${cleanError(error)}`);
    });
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

  private withSingleflight<T>(key: string, work: () => Promise<T>): Promise<T> {
    const existing = this.inflight.get(key) as Promise<T> | undefined;
    if (existing) return existing;
    const promise = work().finally(() => {
      if (this.inflight.get(key) === promise) this.inflight.delete(key);
    });
    this.inflight.set(key, promise);
    return promise;
  }

  private async callAuto(args: Record<string, unknown>): Promise<unknown> {
    const mode = autoMode(args.mode);
    const quality: AutoQuality = args.quality === "max" ? "max" : "balanced";
    const limit = Number(args.limit ?? 6);
    const explicitMaxChars = typeof args.maxCharsPerResult === "number" ? args.maxCharsPerResult : undefined;
    const maxCharsPerItem = explicitMaxChars
      ?? (quality === "max" ? DEFAULT_MAX_EXCERPT_CHARS : DEFAULT_BALANCED_EXCERPT_CHARS);
    const query = String(args.query ?? "");
    const includeDomains = cleanDomains(args.includeDomains);
    const excludeDomains = cleanDomains(args.excludeDomains);
    const effectiveFreshness = normalizedFreshness(mode, args.freshness);
    const key = cacheKey("search_auto:v2", {
      query: query.trim(),
      mode,
      quality,
      limit,
      freshness: effectiveFreshness,
      includeDomains: includeDomains.length ? [...new Set(includeDomains)].sort() : undefined,
      excludeDomains: excludeDomains.length ? [...new Set(excludeDomains)].sort() : undefined,
      maxCharsPerResult: explicitMaxChars,
      maximumNumberOfTokens: mode === "context" ? args.maximumNumberOfTokens : undefined,
      crossCheck: args.crossCheck === true,
    });
    const hit = this.fromCache(key);
    if (hit) return hit;

    return this.withSingleflight(key, async () => {
      const recheck = this.fromCache(key);
      if (recheck) return recheck;
      const ttl = mode === "current" ? this.cacheTtl.news : this.cacheTtl.search;
      const candidates = autoCandidates(mode, quality, args);
      const hasDomainFilter = includeDomains.length > 0 || excludeDomains.length > 0;
      const domainTransform = hasDomainFilter
        ? (output: unknown) => filterOutputByDomains(output, includeDomains, excludeDomains)
        : undefined;
      const spec: ChainSpec = {
        tool: "search_auto",
        capability: "search",
        maxProviders: 3,
        meta: { mode, quality },
        emptyError: `No automatic provider is available for mode ${mode}`,
        usable: mode === "context" ? hasContextContent : (output) => itemsOf(output)?.length !== 0,
        ...(domainTransform ? { transform: domainTransform } : {}),
      };
      let remaining = candidates;
      let history: ChainHistory | undefined;
      if (args.crossCheck === true && mode !== "context") {
        const checked = await this.crossCheck(candidates, spec, limit, maxCharsPerItem, query, includeDomains, excludeDomains);
        if (checked) {
          if (checked.output) return checked.summary.status === "complete" ? this.remember(key, checked.output, ttl) : checked.output;
          if (checked.fatalError) throw checked.fatalError;
          // Both sides were unusable. Spend the remaining attempt on a different provider.
          const tried = new Set(checked.attempts.map((attempt) => attempt.provider));
          remaining = candidates.filter((candidate) => !tried.has(this.bindings.get(candidate.name)?.provider ?? ""));
          spec.meta.crossCheck = checked.summary;
          history = checked;
        } else spec.meta.crossCheck = { routes: [], status: "unavailable", corroborated: 0 };
      }
      const output = await this.runChain(remaining, spec, history);
      // Context mode keeps full passages unless maxCharsPerResult was explicitly given, while still capping item count.
      const capChars = mode === "context" ? explicitMaxChars : maxCharsPerItem;
      const rendered = capSearchOutput(output, capChars, limit, query);
      return history ? rendered : this.remember(key, rendered, ttl);
    });
  }

  private async callImageSearch(args: Record<string, unknown>): Promise<unknown> {
    const imageUrl = typeof args.imageUrl === "string" ? args.imageUrl.trim() : "";
    const query = typeof args.query === "string" ? args.query.trim() : "";
    if (imageUrl && query) {
      throw new InvalidRequestError("Invalid arguments for search_images: provide either query or imageUrl, not both");
    }
    if (!imageUrl && !query) {
      throw new InvalidRequestError("Invalid arguments for search_images: provide query (text) or imageUrl (an image to search by)");
    }
    if (imageUrl) {
      let parsed: URL;
      try {
        parsed = new URL(imageUrl);
      } catch {
        throw new InvalidRequestError("Invalid arguments for search_images: imageUrl must be a public http(s) URL; local files cannot be searched by image");
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new InvalidRequestError("Invalid arguments for search_images: imageUrl must be a public http(s) URL; local files cannot be searched by image");
      }
      if (parsed.username || parsed.password) {
        throw new InvalidRequestError("Invalid arguments for search_images: imageUrl must not contain embedded credentials");
      }
    }
    const key = cacheKey("search_images", {
      query: imageUrl ? undefined : query,
      imageUrl: imageUrl || undefined,
      limit: args.limit,
      language: args.language,
      safesearch: args.safesearch,
    });
    const hit = this.fromCache(key);
    if (hit) return hit;
    return this.withSingleflight(key, async () => {
      const recheck = this.fromCache(key);
      if (recheck) return recheck;
      return this.remember(key, await this.runChain(imageCandidates(args), {
        tool: "search_images",
        capability: "images",
        maxProviders: 2,
        meta: { mode: imageUrl ? "reverse-image" : "images" },
        emptyError: "No automatic image-search provider is available",
        usable: (output) => itemsOf(output)?.length !== 0,
      }), this.cacheTtl.search);
    });
  }

  private async callFetch(args: Record<string, unknown>): Promise<unknown> {
    const urls = parseFetchUrls(args);
    const quality: AutoQuality = args.quality === "max" ? "max" : "balanced";
    const maxChars = typeof args.maxChars === "number" ? args.maxChars : 12_000;
    const offset = typeof args.offset === "number" && args.offset > 0 ? Math.floor(args.offset) : 0;
    const section = typeof args.section === "string" && args.section.trim() ? args.section.trim() : undefined;
    const truncateOpts: TruncateOptions = {
      ...(offset > 0 ? { offset } : {}),
      ...(section ? { section } : {}),
    };
    if (urls.length === 1) {
      return this.fetchSingleUrl(urls[0] as string, quality, maxChars, truncateOpts, false);
    }
    const perUrlChars = Math.floor(maxChars / urls.length);
    const settled = await Promise.allSettled(
      urls.map((url) => this.fetchSingleUrl(url, quality, perUrlChars, truncateOpts, true)),
    );
    return combineBatchFetch(urls, settled, quality);
  }

  private async fetchSingleUrl(
    url: string,
    quality: AutoQuality,
    maxChars: number,
    truncateOpts: TruncateOptions,
    isBatch: boolean,
  ): Promise<unknown> {
    // Read one character beyond the window (and at least 500 chars so small batch budgets do not trigger thin-page fallbacks).
    const baseChars = Math.max(500, (truncateOpts.offset ?? 0) + maxChars + 1);
    const requestChars = truncateOpts.section ? Math.max(baseChars, 100_000) : baseChars;
    const hintContext = {
      ...(isBatch ? { isBatch: true } : {}),
      ...(truncateOpts.section ? { section: truncateOpts.section } : {}),
    };
    // One cached read serves later pages and sections of the same document while it covers them.
    const key = cacheKey("fetch_auto:v2", { url, quality });
    const hit = this.cache?.get(key);
    const cached = hit?.value as FetchCacheEntry | undefined;
    if (hit && cached?.output && coversRequest(cached.output, cached.requestChars ?? 0, requestChars, cached.providerCapped)) {
      return truncateBody(markCached(cached.output, hit.ageMs), maxChars, truncateOpts, "readable", hintContext);
    }

    const activeFetch = this.fetchInflight.get(key);
    if (activeFetch && activeFetch.requestChars >= requestChars) {
      const { output, readable } = await activeFetch.promise;
      return truncateBody(output, maxChars, truncateOpts, readable ? "readable" : "partial", hintContext);
    }

    const runFetch = (async () => {
      const output = await this.runChain(fetchCandidates(quality, { url, maxChars: requestChars }), {
        tool: "fetch_auto",
        capability: "fetch",
        maxProviders: 3,
        meta: { mode: "fetch", quality },
        emptyError: "No automatic fetch provider is available",
        usable: isUsableFetchResult,
        failover: isPageFailure,
        transform: (candidate, provider) => ENVELOPE_READERS.has(provider) ? readableFetchOutput(candidate) : candidate,
      });
      const readable = succeeded(output);
      if (readable) {
        const provider = (output as { structuredContent?: { route?: { provider?: string } } })?.structuredContent?.route?.provider;
        const providerCapped = provider ? CAPPED_FETCH_PROVIDERS.has(provider) : true;
        this.cache?.set(key, { output, requestChars, providerCapped } satisfies FetchCacheEntry, this.cacheTtl.fetch);
      }
      return { output, readable };
    })();

    const tracker = { requestChars, promise: runFetch };
    this.fetchInflight.set(key, tracker);
    try {
      const { output, readable } = await runFetch;
      return truncateBody(output, maxChars, truncateOpts, readable ? "readable" : "partial", hintContext);
    } finally {
      if (this.fetchInflight.get(key) === tracker) this.fetchInflight.delete(key);
    }
  }

  private eligibleBuckets(candidates: AutoCandidate[], capability: AutoCapability): {
    active: RoutedCandidate[];
    cooling: RoutedCandidate[];
  } {
    const matched = candidates
      .map((candidate, index) => ({ candidate, candidateRank: index + 1, binding: this.bindings.get(candidate.name) }))
      .filter((entry): entry is RoutedCandidate => {
        if (!entry.binding) return false;
        return this.config.providers[entry.binding.provider]?.auto.includes(capability) === true;
      });
    // Healthy providers first, then ones failing repeatedly right now, then ones left only with
    // exhausted keys (worth one last try); cooling providers (all keys benched) are kept separate.
    const scores = this.rotation.providerFailureScores(capability);
    const ready: RoutedCandidate[] = [];
    const flaky: RoutedCandidate[] = [];
    const sunk: RoutedCandidate[] = [];
    const cooling: RoutedCandidate[] = [];
    for (const entry of matched) {
      const provider = entry.binding.provider;
      const config = this.config.providers[provider];
      const keys = config?.keys ?? [];
      const slots = config ? eligibleSlots(config, [entry.binding.upstreamName, entry.binding.exposed.name]) : undefined;
      // Capability-gated with zero eligible slots (e.g., paid-only tool on a free-only pool): skip outright.
      if (slots && slots.length === 0) continue;
      if (keys.length > 0) {
        const allowExhausted = ZERO_COST_PROMO_TOOLS.has(entry.binding.exposed.name);
        const summary = this.rotation.slotSummary(provider, keys, slots, allowExhausted);
        if (summary.healthy.length === 0) {
          (summary.sunk.length > 0 ? sunk : cooling).push(entry);
          continue;
        }
      }
      if ((scores.get(provider) ?? 0) >= FLAKY_SCORE) flaky.push(entry);
      else ready.push(entry);
    }
    return { active: [...ready, ...flaky, ...sunk], cooling };
  }

  /** Try candidates in order; move on only after a recognised availability failure or an unusable answer. */
  private async runChain(candidates: AutoCandidate[], spec: ChainSpec, history?: ChainHistory): Promise<unknown> {
    const { active, cooling } = this.eligibleBuckets(candidates, spec.capability);
    // Avoid selecting cooling providers when active providers exist (prevents pointless local errors);
    // fall back to cooling only when nothing else exists so recovery-time diagnostics are surfaced.
    const eligible = active.length > 0 || history ? active : cooling;
    if (!eligible.length && !history) throw new Error(spec.emptyError);

    const attempts = history ? [...history.attempts] : [];
    let lastError = history?.lastError;
    let fallback = history?.fallback;
    let realAttempts = attempts.filter((attempt) => attempt.outcome !== "skipped").length;
    const providerWideFailed = new Set<string>();
    const providerExhausted = new Set<string>();

    for (const entry of eligible) {
      if (realAttempts >= spec.maxProviders) break;
      const provider = entry.binding.provider;
      const toolName = entry.binding.exposed.name;
      if (providerWideFailed.has(provider)) continue;
      if (providerExhausted.has(provider) && !ZERO_COST_PROMO_TOOLS.has(toolName)) continue;

      const base = { provider, tool: toolName, candidateRank: entry.candidateRank };
      const isZeroCostProbe = toolName === "direct_markdown_fetch";
      try {
        const callOpts = ZERO_COST_PROMO_TOOLS.has(toolName) ? { allowExhausted: true } : undefined;
        const raw = await entry.binding.call(adaptCandidateArguments(entry.binding.exposed, entry.candidate.nativeArguments ?? {}), callOpts);
        if (isToolErrorResult(raw)) {
          throw new ToolResultError(textOfContent(bodyBlocks(raw)).slice(0, 500), bodyBlocks(raw));
        }
        const output = spec.transform ? spec.transform(raw, provider) : raw;
        if (isToolErrorResult(output)) {
          throw new ToolResultError(textOfContent(bodyBlocks(output)).slice(0, 500), bodyBlocks(output));
        }
        if (spec.usable && !spec.usable(output)) {
          attempts.push({ ...base, outcome: "empty" });
          realAttempts += 1;
          if (!fallback || isBetterFallback(output, fallback.output)) fallback = { entry, output };
          continue;
        }
        attempts.push({ ...base, outcome: "success" });
        realAttempts += 1;
        this.noteOutcome(provider, false, spec.capability);
        return attachRouteMetadata(entry.binding, output, {
          ...spec.meta,
          candidateRank: entry.candidateRank,
          providerAttempt: realAttempts,
          attempts,
        });
      } catch (error) {
        lastError = error;
        const status = statusFromError(error);
        const skippedProbe = isZeroCostProbe && shouldFailoverProvider(error);
        attempts.push({
          ...base,
          outcome: skippedProbe ? "skipped" : "error",
          ...(status ? { status } : {}),
        });
        if (!skippedProbe) {
          realAttempts += 1;
          if (shouldPenalizeProvider(error)) this.noteOutcome(provider, true, spec.capability);
          if (isQuotaExhausted(error)) {
            providerExhausted.add(provider);
          } else if (isProviderWideFault(error, status)) {
            providerWideFailed.add(provider);
          }
        }
        if (!shouldFailoverProvider(error) && !spec.failover?.(error)) throw autoFailure(error, attempts, spec.tool);
      }
    }
    if (fallback) {
      // Every reader answered thinly; return the fullest non-challenge answer rather than an error.
      return attachRouteMetadata(fallback.entry.binding, fallback.output, {
        ...spec.meta,
        candidateRank: fallback.entry.candidateRank,
        providerAttempt: realAttempts,
        attempts,
      });
    }
    throw autoFailure(lastError ?? new Error(spec.emptyError), attempts, spec.tool);
  }

  /**
   * Query two providers concurrently. Empty lists and errors do not count as
   * corroboration and carry forward into the remaining routing budget.
   */
  private async crossCheck(
    candidates: AutoCandidate[],
    spec: ChainSpec,
    limit: number,
    maxCharsPerItem: number,
    query: string,
    includeDomains: string[],
    excludeDomains: string[],
  ): Promise<(ChainHistory & { output?: unknown; summary: CrossCheckSummary; fatalError?: Error }) | undefined> {
    const seen = new Set<string>();
    const { active } = this.eligibleBuckets(candidates, spec.capability);
    const pair = active.filter((entry) => {
      const provider = entry.binding.provider;
      if (seen.has(provider)) return false;
      seen.add(provider);
      return true;
    }).slice(0, 2);
    if (pair.length < 2) return undefined;

    const settled = await Promise.allSettled(
      pair.map((entry) => entry.binding.call(
        adaptCandidateArguments(entry.binding.exposed, entry.candidate.nativeArguments ?? {}),
        ZERO_COST_PROMO_TOOLS.has(entry.binding.exposed.name) ? { allowExhausted: true } : undefined,
      )),
    );
    const lists: Array<{ provider: string; items: MergedItem[] }> = [];
    const routes: Route[] = [];
    const failed: string[] = [];
    const empty: string[] = [];
    const errors: unknown[] = [];
    const history: ChainHistory = { attempts: [] };
    const hasDomainFilter = includeDomains.length > 0 || excludeDomains.length > 0;

    settled.forEach((outcome, index) => {
      const entry = pair[index] as RoutedCandidate;
      const { provider, upstreamName, exposed } = entry.binding;
      const base = { provider, tool: exposed.name, candidateRank: entry.candidateRank };
      if (outcome.status === "rejected") {
        history.lastError = outcome.reason;
        errors.push(outcome.reason);
        const status = statusFromError(outcome.reason);
        history.attempts.push({ ...base, outcome: "error", ...(status ? { status } : {}) });
        failed.push(provider);
        if (shouldPenalizeProvider(outcome.reason)) this.noteOutcome(provider, true, spec.capability);
        return;
      }
      if (isToolErrorResult(outcome.value)) {
        const toolErr = new ToolResultError(textOfContent(bodyBlocks(outcome.value)).slice(0, 500), bodyBlocks(outcome.value));
        history.lastError = toolErr;
        errors.push(toolErr);
        history.attempts.push({ ...base, outcome: "error" });
        failed.push(provider);
        if (shouldPenalizeProvider(toolErr)) this.noteOutcome(provider, true, spec.capability);
        return;
      }
      const rawItems = itemsOf(outcome.value);
      if (!rawItems) {
        const shapeErr = new Error(`${exposed.name} returned no structured search results`);
        history.lastError = shapeErr;
        errors.push(shapeErr);
        history.attempts.push({ ...base, outcome: "error" });
        failed.push(provider);
        return;
      }
      const items = hasDomainFilter
        ? filterItemsByDomains(rawItems as SearchItem[], includeDomains, excludeDomains)
        : rawItems as SearchItem[];
      if (items.length === 0) {
        history.attempts.push({ ...base, outcome: "empty" });
        empty.push(provider);
        const filteredValue = hasDomainFilter ? filterOutputByDomains(outcome.value, includeDomains, excludeDomains) : outcome.value;
        history.fallback ??= { entry, output: filteredValue };
        return;
      }
      history.attempts.push({ ...base, outcome: "success" });
      this.noteOutcome(provider, false, spec.capability);
      lists.push({ provider, items: items as MergedItem[] });
      routes.push({ provider, tool: exposed.name, upstreamTool: upstreamName });
    });

    const merged = mergeItems(lists, limit);
    const summary: CrossCheckSummary = {
      routes,
      failed,
      empty,
      status: lists.length === 2 ? "complete" : lists.length === 1 ? "partial" : "unavailable",
      corroborated: merged.filter((item) => item.foundBy.length > 1).length,
    };
    const route = routes[0];
    if (!route) {
      // If both sides errored with non-failover faults (e.g. 400/422), stop instead of burning a 3rd provider.
      const allNonFailoverErrors = empty.length === 0 && errors.length > 0 && errors.every((err) => !shouldFailoverProvider(err));
      return {
        ...history,
        summary,
        ...(allNonFailoverErrors ? { fatalError: autoFailure(history.lastError ?? new Error(spec.emptyError), history.attempts, spec.tool) } : {}),
      };
    }
    const auto = { ...spec.meta, crossCheck: summary };
    return {
      ...history,
      summary,
      output: {
        content: [
          routeBlock(route, auto),
          { type: "text", text: renderItems(merged, { maxCharsPerItem, dedupe: false, query }) },
        ],
        structuredContent: { route, searchAuto: auto, result: { items: merged } },
        _meta: { searchToolkit: { route, auto } },
      },
    };
  }

  private fromCache(key: string): unknown | undefined {
    const hit = this.cache?.get(key);
    return hit ? markCached(hit.value, hit.ageMs) : undefined;
  }

  /** Cache an answer that came from a provider that actually succeeded, then hand it back. */
  private remember(key: string, output: unknown, ttlMs: number): unknown {
    if (succeeded(output)) this.cache?.set(key, output, ttlMs);
    return output;
  }

  /** Provider health is advisory: a busy state file must not fail the call. */
  private noteOutcome(provider: string, failed: boolean, capability?: AutoCapability): void {
    try {
      this.rotation.recordProviderOutcome(provider, failed, capability);
    } catch {
      // ordering falls back to the configured order
    }
  }

  private gatewayList(args: Record<string, unknown>, allowTool?: (tool: Tool) => boolean): unknown {
    const name = typeof args.name === "string" ? args.name : undefined;
    if (name) {
      const tool = this.fullTools.get(name);
      if (!tool || MANAGEMENT_TOOL_NAMES.has(name) || (allowTool && !allowTool(tool))) {
        throw new Error(`Unknown provider tool: ${name}`);
      }
      return result({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema, annotations: tool.annotations });
    }
    const provider = typeof args.provider === "string" ? args.provider : undefined;
    const rows = Array.from(this.bindings.values())
      .filter((item) => !MANAGEMENT_TOOL_NAMES.has(item.exposed.name)
        && (!provider || item.provider === provider)
        && (!allowTool || allowTool(item.exposed)))
      .map((item) => {
        const full = this.fullTools.get(item.exposed.name) ?? item.exposed;
        const kind = full.annotations?.readOnlyHint === true ? "read" : "action";
        return `${item.exposed.name} [${kind}] ${firstSentence(full.description ?? "", 110)}`;
      });
    return { content: [{ type: "text", text: rows.length ? rows.join("\n") : "No provider tools match." }] };
  }

  private async gatewayCall(args: Record<string, unknown>, allowTool?: (tool: Tool) => boolean): Promise<unknown> {
    const name = String(args.name ?? "");
    const target = this.bindings.get(name);
    if (!target || MANAGEMENT_TOOL_NAMES.has(name)) throw new Error(`Unknown provider tool: ${name}`);
    if (allowTool && !allowTool(target.exposed)) {
      throw new Error(`Tool ${name} is not available for this token`);
    }
    const inner = args.arguments && typeof args.arguments === "object" ? args.arguments as Record<string, unknown> : {};
    return this.invokeBinding(target, this.validateArguments(target.exposed, inner));
  }

  private async probe(args: Record<string, unknown>, allowTool?: (tool: Tool) => boolean): Promise<unknown> {
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
    if (allowTool && !allowTool(selected.exposed)) {
      throw new Error(`Tool ${selected.exposed.name} is not available for this token`);
    }
    // Each call is pinned to one slot, walking the pool, so sticky and drain pools are probed key by key.
    const requestedSlot = typeof args.slot === "number" && Number.isInteger(args.slot) ? args.slot : undefined;
    if (requestedSlot !== undefined && (requestedSlot < 0 || requestedSlot >= config.keys.length)) {
      throw new Error(`${provider} has no key slot ${requestedSlot}`);
    }
    const slots = requestedSlot !== undefined
      ? [requestedSlot]
      : config.keys.length
        ? Array.from({ length: Math.min(Number(args.calls ?? config.keys.length), config.keys.length, 12) }, (_, index) => index)
        : [undefined];
    const attempts: unknown[] = [];
    for (const [index, slot] of slots.entries()) {
      const options = slot === undefined ? {} : { slot };
      try {
        const output = await selected.call(probeArguments(selected.exposed, String(args.query ?? ""), 1), options);
        attempts.push({ index: index + 1, ...(slot !== undefined ? { slot } : {}), ok: !isToolErrorResult(output), meta: extractMeta(output) });
      } catch (error) {
        attempts.push({ index: index + 1, ...(slot !== undefined ? { slot } : {}), ok: false, error: cleanError(error) });
      }
    }
    return result({ provider, tool: selected.exposed.name, attempts, status: annotateSlots(config, this.rotation.status(provider, config.keys)) });
  }
}

function profileFromEnv(): ToolkitProfile | undefined {
  const value = process.env.SEARCH_TOOLKIT_PROFILE;
  return value === "full" || value === "curated" || value === "lean" ? value : undefined;
}

function binding(tool: Tool, call: ToolBinding["call"]): ToolBinding {
  return { exposed: tool, provider: "search_toolkit", upstreamName: tool.name, call };
}

function normalizedFreshness(mode: ReturnType<typeof autoMode>, value: unknown): AutoFreshness | undefined {
  if (value === "day" || value === "week" || value === "month" || value === "year") return value;
  return mode === "current" ? "week" : undefined;
}

/**
 * Fill schema-required metadata fields added by newer upstream MCP servers
 * (such as Firecrawl hosted v2 MCP requiring `objective` on `firecrawl_scrape`)
 * without sending unknown keys to older schemas that reject them.
 */
function adaptCandidateArguments(tool: Tool, args: Record<string, unknown>): Record<string, unknown> {
  const next = { ...args };
  const required = Array.isArray(tool.inputSchema?.required) ? tool.inputSchema.required : [];
  if (required.includes("objective") && (typeof next.objective !== "string" || !next.objective.trim())) {
    const query = typeof next.query === "string" && next.query.trim() ? next.query.trim() : undefined;
    next.objective = query ?? "Read the main readable content of this web page as clean Markdown.";
  }
  return next;
}

/** A routed answer whose last attempt succeeded and is not an error result; thin fetch fallbacks and failures are not reused. */
function succeeded(output: unknown): boolean {
  if (isToolErrorResult(output)) return false;
  const structured = (output as { structuredContent?: { route?: unknown; searchAuto?: { attempts?: unknown } } })?.structuredContent;
  if (!structured?.route) return false;
  const attempts = structured.searchAuto?.attempts;
  return !Array.isArray(attempts) || (attempts.at(-1) as { outcome?: string } | undefined)?.outcome === "success";
}

/**
 * A cached page serves a request when the answering reader returned the whole page
 * uncapped, or when a capped reader fetched at least as many characters as requested.
 */
function coversRequest(output: unknown, cachedChars: number, wantedChars: number, providerCapped = true): boolean {
  if (!providerCapped) return true;
  if (cachedChars >= wantedChars) return true;
  return bodyText(output).length >= wantedChars;
}

/** Say in the route block that this answer was reused, and how old it is. */
function markCached(output: unknown, ageMs: number): unknown {
  const seconds = Math.max(0, Math.round(ageMs / 1000));
  return updateAutoMetadata(output, { cached: seconds < 60 ? `${seconds}s` : `${Math.round(seconds / 60)}m` });
}

type SlotStatus = ReturnType<RotationStore["status"]>;

/** Add each slot's plan and label from the config; neither is secret. */
function annotateSlots(config: ProviderConfig, rotation: SlotStatus): SlotStatus {
  return {
    ...rotation,
    keys: rotation.keys.map((key) => {
      const tier = slotTier(config, key.slot);
      const label = config.keyMeta?.[key.slot]?.label;
      return { ...key, ...(tier ? { tier } : {}), ...(label ? { label } : {}) };
    }),
  };
}

function isLowBalance(remaining: number, unit: string | undefined): boolean {
  if (remaining <= 0) return true;
  if (unit === "USD") return remaining < 2;
  if (unit === "CNY") return remaining < 10;
  if (unit === "cents") return remaining < 200;
  if (unit === "credits") return remaining < 200;
  return false;
}

function compactRotation(rotation: SlotStatus): unknown {
  const counts = { healthy: 0, cooldown: 0, disabled: 0, exhausted: 0 };
  const unhealthySlots: Array<Record<string, unknown>> = [];
  let remaining: number | undefined;
  let quotaUnit: string | undefined;
  let oldestCheckedAt: number | undefined;
  for (const key of rotation.keys) {
    const details = key.status as Record<string, unknown>;
    if (typeof details.quota_remaining === "number") remaining = (remaining ?? 0) + details.quota_remaining;
    if (!quotaUnit && typeof details.quota_unit === "string") quotaUnit = details.quota_unit;
    if (typeof details.quota_checked_at === "number") {
      oldestCheckedAt = oldestCheckedAt === undefined ? details.quota_checked_at : Math.min(oldestCheckedAt, details.quota_checked_at);
    }
    const status = details.status === "cooldown" || details.status === "disabled" || details.status === "exhausted"
      ? details.status
      : "healthy";
    counts[status] += 1;
    if (status !== "healthy") {
      const { slot: _duplicateSlot, quota_checked_at: _ts, ...health } = details;
      const { tier, label } = key as { tier?: string; label?: string };
      unhealthySlots.push({ slot: key.slot, masked: key.masked, ...(tier ? { tier } : {}), ...(label ? { label } : {}), ...health });
    }
  }
  const lowBalance = remaining !== undefined && isLowBalance(remaining, quotaUnit);
  return {
    keyCount: rotation.keyCount,
    nextSlot: rotation.nextSlot,
    ...counts,
    // Sum of the last `search-toolkit quota` readings, in the provider's unit.
    ...(remaining !== undefined ? { remaining: Number(remaining.toFixed(2)) } : {}),
    ...(quotaUnit ? { quotaUnit } : {}),
    ...(oldestCheckedAt !== undefined ? { quotaChecked: `${formatDuration(Math.max(0, Date.now() - oldestCheckedAt))} ago` } : {}),
    ...(lowBalance ? { lowBalance: true } : {}),
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

function isLocalNoHealthySlotsError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return /has no healthy key slots available/i.test(msg);
}

function shouldPenalizeProvider(error: unknown): boolean {
  if (error instanceof PlanLimitError || error instanceof CapabilityGateError || error instanceof InvalidRequestError) return false;
  if (isLocalNoHealthySlotsError(error)) return false;
  return shouldFailoverProvider(error) && !isPageFailure(error);
}

function isProviderWideFault(error: unknown, status: number | undefined): boolean {
  if (isPageFailure(error) || error instanceof PlanLimitError || error instanceof CapabilityGateError) return false;
  if (isTimeout(error)) return true;
  if (status !== undefined) return status === 401 || status === 429 || status === 434 || status >= 500;
  return shouldFailoverProvider(error);
}

function isBetterFallback(candidate: unknown, current: unknown): boolean {
  const candText = bodyText(candidate);
  const currText = bodyText(current);
  const candUsable = isUsableFetchText(candText);
  const currUsable = isUsableFetchText(currText);
  if (candUsable !== currUsable) return candUsable;
  const candInterstitial = /cloudflare|verify you are human|just a moment|access denied|enable javascript|环境异常|安全验证/i.test(candText);
  const currInterstitial = /cloudflare|verify you are human|just a moment|access denied|enable javascript|环境异常|安全验证/i.test(currText);
  if (candInterstitial !== currInterstitial) return !candInterstitial;
  return candText.length > currText.length;
}

function matchesDomainRule(urlString: string, rule: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(urlString);
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  const path = parsed.pathname.toLowerCase().replace(/\/+$/, "");
  const slash = rule.indexOf("/");
  const ruleHost = (slash >= 0 ? rule.slice(0, slash) : rule).replace(/^www\./, "");
  const rulePath = slash >= 0 ? rule.slice(slash).replace(/\/+$/, "") : "";
  if (host !== ruleHost && !host.endsWith(`.${ruleHost}`)) return false;
  if (!rulePath) return true;
  return path === rulePath || path.startsWith(`${rulePath}/`);
}

function filterItemsByDomains<T extends SearchItem>(items: T[], includeDomains: string[], excludeDomains: string[]): T[] {
  return items.filter((item) => {
    if (!item?.url) return includeDomains.length === 0;
    if (includeDomains.length > 0 && !includeDomains.some((rule) => matchesDomainRule(item.url, rule))) return false;
    if (excludeDomains.length > 0 && excludeDomains.some((rule) => matchesDomainRule(item.url, rule))) return false;
    return true;
  });
}

function replaceStructuredItems(output: unknown, nextItems: SearchItem[]): unknown {
  if (!output || typeof output !== "object") return output;
  const record = output as Record<string, unknown>;
  const structured = record.structuredContent && typeof record.structuredContent === "object"
    ? record.structuredContent as Record<string, unknown>
    : undefined;
  if (!structured) return output;
  if (structured.data && typeof structured.data === "object" && Array.isArray((structured.data as { items?: unknown }).items)) {
    return {
      ...record,
      structuredContent: {
        ...structured,
        data: { ...(structured.data as Record<string, unknown>), items: nextItems },
      },
    };
  }
  if (structured.result && typeof structured.result === "object") {
    const res = structured.result as Record<string, unknown>;
    if (res.data && typeof res.data === "object" && Array.isArray((res.data as { items?: unknown }).items)) {
      return {
        ...record,
        structuredContent: {
          ...structured,
          result: {
            ...res,
            data: { ...(res.data as Record<string, unknown>), items: nextItems },
          },
        },
      };
    }
    if (Array.isArray(res.items)) {
      return {
        ...record,
        structuredContent: {
          ...structured,
          result: { ...res, items: nextItems },
        },
      };
    }
  }
  return output;
}

function payloadRecordOf(output: unknown): Record<string, unknown> | undefined {
  if (!output || typeof output !== "object") return undefined;
  const structured = (output as {
    structuredContent?: { data?: Record<string, unknown>; result?: { data?: Record<string, unknown> } & Record<string, unknown> };
  }).structuredContent;
  if (structured?.data && typeof structured.data === "object") return structured.data;
  if (structured?.result?.data && typeof structured.result.data === "object") return structured.result.data;
  if (structured?.result && typeof structured.result === "object") return structured.result;
  return undefined;
}

function filterOutputByDomains(output: unknown, includeDomains: string[], excludeDomains: string[]): unknown {
  const items = itemsOf(output);
  if (!items) return output;
  const filtered = filterItemsByDomains(items as SearchItem[], includeDomains, excludeDomains);
  return replaceStructuredItems(output, filtered);
}

function hasContextContent(output: unknown): boolean {
  const items = itemsOf(output);
  if (items !== undefined) return items.length > 0;
  const structured = (output as {
    structuredContent?: {
      data?: { grounding?: { generic?: unknown[]; map?: unknown[]; poi?: unknown } };
      result?: { data?: { grounding?: { generic?: unknown[]; map?: unknown[]; poi?: unknown } } };
    };
  } | undefined)?.structuredContent;
  const grounding = structured?.data?.grounding ?? structured?.result?.data?.grounding;
  if (!grounding || typeof grounding !== "object") return true;
  const genericCount = Array.isArray(grounding.generic) ? grounding.generic.length : 0;
  const mapCount = Array.isArray(grounding.map) ? grounding.map.length : 0;
  const hasPoi = Boolean(grounding.poi && typeof grounding.poi === "object");
  return genericCount + mapCount + (hasPoi ? 1 : 0) > 0;
}

function itemsOf(output: unknown): unknown[] | undefined {
  if (!output || typeof output !== "object") return undefined;
  const structured = (output as {
    structuredContent?: { data?: { items?: unknown }; result?: { data?: { items?: unknown }; items?: unknown } };
  }).structuredContent;
  const items = structured?.data?.items ?? structured?.result?.data?.items ?? structured?.result?.items;
  return Array.isArray(items) ? items : undefined;
}

function capSearchOutput(output: unknown, maxCharsPerItem: number | undefined, limit: number, query: string): unknown {
  const items = itemsOf(output);
  if (!items || !output || typeof output !== "object") return output;
  const record = output as { content?: unknown };
  if (!Array.isArray(record.content)) return output;
  const deduped = dedupeItems(items as SearchItem[], limit);
  const updated = replaceStructuredItems(output, deduped) as Record<string, unknown>;
  const payload = payloadRecordOf(updated);
  const renderTarget = payload ? { ...payload, items: deduped } : { items: deduped };
  const route = isRouteContentBlock(record.content[0]) ? [record.content[0]] : [];
  return {
    ...updated,
    content: [
      ...route,
      {
        type: "text",
        text: renderPayload(renderTarget, {
          ...(maxCharsPerItem !== undefined ? { maxCharsPerItem } : {}),
          dedupe: false,
          query,
        }),
      },
    ],
  };
}

function autoFailure(error: unknown, attempts: AutoAttempt[], toolName = "search_auto"): Error {
  const summary = attempts
    .map((attempt) => `${attempt.provider}/${attempt.tool}[${attempt.status ?? attempt.outcome}]`)
    .join(" -> ");
  const wrapped = new Error(`${toolName} failed after ${summary || "no provider attempts"}: ${cleanError(error)}`);
  (wrapped as Error & { attempts: AutoAttempt[] }).attempts = attempts.map((attempt) => ({ ...attempt }));
  return wrapped;
}
