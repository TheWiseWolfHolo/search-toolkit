import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AutoCapability, KeyMeta, KeyStrategy, KeyTier, ProviderConfig, ToolkitConfig } from "./types.js";

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const CAPABILITIES: readonly AutoCapability[] = ["search", "images", "fetch"];
// Providers whose upstream tools can fetch a known URL; granted "fetch" when migrating a v1 config.
const FETCH_CAPABLE = new Set(["exa", "tavily", "firecrawl", "linkup", "anysearch", "parallel", "you"]);
const STRATEGIES: readonly KeyStrategy[] = ["round_robin", "sticky", "drain"];
const TIERS: readonly KeyTier[] = ["free", "paid"];
const KEY_FIELDS = new Set(["key", "tier", "label", "allowTools", "denyTools"]);
// Provider options that some adapter actually reads. Everything else is dead weight.
const CONSUMED_OPTIONS: Record<string, readonly string[]> = {
  grok: ["model", "multiAgentModel", "reasoningEffort", "systemPrompt", "customUrl"],
};
const PROVIDER_FIELDS = new Set([
  "enabled", "automatic", "manualOnly", "auto", "keys", "integration", "toolPolicy", "options",
  "strategy", "defaultTier", "paidTools",
]);

export interface LoadedConfig {
  config: ToolkitConfig;
  /** Non-fatal observations: legacy format, dead fields. Surfaced as startup warnings. */
  notes: string[];
}

export function defaultConfigPath(): string {
  if (process.env.SEARCH_TOOLKIT_CONFIG) return resolve(process.env.SEARCH_TOOLKIT_CONFIG);
  if (process.platform === "win32") {
    // AppData/Local is transparently virtualized for packaged Windows apps.
    // A home-relative path is visible to packaged Codex and ordinary CLI/Claude
    // processes as the same physical file.
    return resolve(homedir(), ".config/search-toolkit/providers.json");
  }
  const configHome = process.env.XDG_CONFIG_HOME ?? resolve(homedir(), ".config");
  return resolve(configHome, "search-toolkit/providers.json");
}

export function exampleConfigPath(): string {
  return resolve(projectDir, "config.example.json");
}

export function readConfigFile(path = defaultConfigPath()): unknown {
  if (!existsSync(path)) {
    throw new Error(`Search Toolkit config not found: ${path}. Import or copy ${exampleConfigPath()}.`);
  }
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

export function loadConfig(path = defaultConfigPath()): ToolkitConfig {
  return loadConfigWithNotes(path).config;
}

export function loadConfigWithNotes(path = defaultConfigPath()): LoadedConfig {
  return normalizeConfig(readConfigFile(path));
}

/** Accept v1 and v2 files and return the v2 shape the rest of the code uses. */
export function normalizeConfig(raw: unknown): LoadedConfig {
  const record = asRecord(raw, "config");
  const version = record.version;
  if (version !== 1 && version !== 2) throw new Error(`Unsupported config version: ${String(version)}`);
  const notes: string[] = [];
  if (version === 1) {
    notes.push("config uses the v1 format (automatic/manualOnly); run `search-toolkit migrate-config --write` to upgrade it");
  }
  const providersRaw = asRecord(record.providers, "providers");
  const providers: Record<string, ProviderConfig> = {};
  for (const [name, value] of Object.entries(providersRaw)) {
    providers[name] = normalizeProvider(name, asRecord(value, `${name}`), version, notes);
  }
  const config: ToolkitConfig = { version: 2, statePath: record.statePath as string, providers };
  if (record.profile !== undefined) config.profile = record.profile as NonNullable<ToolkitConfig["profile"]>;
  if (record.shaping !== undefined) config.shaping = record.shaping as NonNullable<ToolkitConfig["shaping"]>;
  if (record.cache !== undefined) config.cache = record.cache as NonNullable<ToolkitConfig["cache"]>;
  validateConfig(config);
  return { config, notes };
}

function normalizeProvider(name: string, raw: Record<string, unknown>, version: unknown, notes: string[]): ProviderConfig {
  for (const field of Object.keys(raw)) {
    if (!PROVIDER_FIELDS.has(field)) notes.push(`${name}.${field} is not a recognised field and is ignored`);
  }
  let auto: AutoCapability[];
  if (version === 1) {
    const automatic = raw.automatic === true && raw.manualOnly !== true;
    auto = automatic ? ["search", "images"] : [];
    if (FETCH_CAPABLE.has(name) && raw.manualOnly !== true && (automatic || name === "firecrawl")) auto = [...auto, "fetch"];
  } else {
    if (!Array.isArray(raw.auto) || raw.auto.some((item) => !CAPABILITIES.includes(item as AutoCapability))) {
      throw new Error(`${name}.auto must be an array drawn from ${CAPABILITIES.join(", ")}`);
    }
    auto = raw.auto as AutoCapability[];
  }
  const options = raw.options && typeof raw.options === "object" ? raw.options as Record<string, unknown> : undefined;
  const integration = raw.integration as ProviderConfig["integration"];
  const consumed = integration?.kind === "rest" ? CONSUMED_OPTIONS[integration.adapter] ?? [] : [];
  const unused = Object.keys(options ?? {}).filter((key) => !consumed.includes(key));
  if (unused.length) notes.push(`${name}.options.{${unused.join(",")}} is never read by this server`);
  const { keys, keyMeta } = normalizeKeys(name, raw.keys, notes);
  const provider: ProviderConfig = { enabled: raw.enabled === true, auto, keys, integration };
  if (keyMeta.some((meta) => Object.keys(meta).length)) provider.keyMeta = keyMeta;
  if (raw.strategy !== undefined) provider.strategy = raw.strategy as KeyStrategy;
  if (raw.defaultTier !== undefined) provider.defaultTier = raw.defaultTier as KeyTier;
  if (raw.paidTools !== undefined) provider.paidTools = raw.paidTools as string[];
  if (raw.toolPolicy !== undefined) provider.toolPolicy = raw.toolPolicy as NonNullable<ProviderConfig["toolPolicy"]>;
  if (options && Object.keys(options).length && consumed.length) provider.options = options;
  return provider;
}

/**
 * A key is either its plain string or `{ key, tier?, label?, allowTools?, denyTools? }`.
 * Both shapes become a plain key list plus parallel annotations.
 */
function normalizeKeys(name: string, raw: unknown, notes: string[]): { keys: string[]; keyMeta: KeyMeta[] } {
  if (!Array.isArray(raw)) throw new Error(`${name}.keys must be an array`);
  const keys: string[] = [];
  const keyMeta: KeyMeta[] = [];
  raw.forEach((entry, slot) => {
    if (typeof entry === "string") {
      keys.push(entry);
      keyMeta.push({});
      return;
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry) || typeof (entry as { key?: unknown }).key !== "string") {
      throw new Error(`${name}.keys[${slot}] must be a string or an object with a string key`);
    }
    const record = entry as Record<string, unknown>;
    for (const field of Object.keys(record)) {
      if (!KEY_FIELDS.has(field)) notes.push(`${name}.keys[${slot}].${field} is not a recognised field and is ignored`);
    }
    const meta: KeyMeta = {};
    if (record.tier !== undefined) {
      if (!TIERS.includes(record.tier as KeyTier)) throw new Error(`${name}.keys[${slot}].tier must be "free" or "paid"`);
      meta.tier = record.tier as KeyTier;
    }
    if (record.label !== undefined) {
      if (typeof record.label !== "string") throw new Error(`${name}.keys[${slot}].label must be a string`);
      meta.label = record.label;
    }
    for (const field of ["allowTools", "denyTools"] as const) {
      if (record[field] === undefined) continue;
      meta[field] = toolNames(record[field], `${name}.keys[${slot}].${field}`);
    }
    keys.push(record.key as string);
    keyMeta.push(meta);
  });
  return { keys, keyMeta };
}

function toolNames(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`${label} must contain non-blank tool names`);
  }
  return value as string[];
}

/** The written form of one key: a bare string unless it carries annotations. */
function keyDocument(key: string, meta: KeyMeta | undefined): unknown {
  return meta && Object.keys(meta).length ? { key, ...meta } : key;
}

/**
 * Produce a clean v2 document from any readable config: legacy switches become
 * `auto`, and options no adapter reads are dropped. Returns what changed so the
 * caller can show it before writing.
 */
export function migrateConfig(raw: unknown): { document: Record<string, unknown>; changes: string[] } {
  const { config, notes } = normalizeConfig(raw);
  const source = asRecord(raw, "config");
  const changes = notes.filter((note) => !note.startsWith("config uses the v1 format"));
  if (source.version === 1) changes.unshift("version 1 → 2: automatic/manualOnly replaced by auto[] (exa, tavily, firecrawl, linkup, anysearch, parallel, you also get fetch where they were automatic or Firecrawl)");
  const providers = Object.fromEntries(Object.entries(config.providers).map(([name, provider]) => [name, {
    enabled: provider.enabled,
    auto: provider.auto,
    ...(provider.strategy ? { strategy: provider.strategy } : {}),
    ...(provider.defaultTier ? { defaultTier: provider.defaultTier } : {}),
    keys: provider.keys.map((key, slot) => keyDocument(key, provider.keyMeta?.[slot])),
    ...(provider.paidTools ? { paidTools: provider.paidTools } : {}),
    integration: provider.integration,
    ...(provider.toolPolicy ? { toolPolicy: provider.toolPolicy } : {}),
    ...(provider.options ? { options: provider.options } : {}),
  }]));
  return {
    document: {
      version: 2,
      statePath: config.statePath,
      ...(config.profile ? { profile: config.profile } : {}),
      ...(config.shaping ? { shaping: config.shaping } : {}),
      ...(config.cache ? { cache: config.cache } : {}),
      providers,
    },
    changes,
  };
}

export function validateConfig(config: ToolkitConfig): void {
  if (config.version !== 2) throw new Error(`Unsupported config version: ${String(config.version)}`);
  if (!config.statePath || typeof config.statePath !== "string") throw new Error("statePath is required");
  if (!config.providers || typeof config.providers !== "object") throw new Error("providers is required");
  if (config.profile !== undefined && config.profile !== "full" && config.profile !== "curated" && config.profile !== "lean") {
    throw new Error("profile must be \"full\", \"curated\", or \"lean\"");
  }
  if (config.cache !== undefined) validateCache(config.cache);
  for (const [name, provider] of Object.entries(config.providers)) validateProvider(name, provider);
}

function validateCache(cache: NonNullable<ToolkitConfig["cache"]>): void {
  if (!cache || typeof cache !== "object" || Array.isArray(cache)) throw new Error("cache must be an object");
  if (cache.enabled !== undefined && typeof cache.enabled !== "boolean") throw new Error("cache.enabled must be a boolean");
  for (const field of ["searchTtlSeconds", "newsTtlSeconds", "fetchTtlSeconds"] as const) {
    const value = cache[field];
    if (value !== undefined && (!Number.isInteger(value) || value < 0 || value > 86_400)) {
      throw new Error(`cache.${field} must be an integer from 0 to 86400`);
    }
  }
}

function validateProvider(name: string, provider: ProviderConfig): void {
  if (!/^[a-z][a-z0-9_]*$/.test(name)) throw new Error(`Invalid provider name: ${name}`);
  if (!Array.isArray(provider.keys)) throw new Error(`${name}.keys must be an array`);
  if (provider.enabled && provider.keys.length === 0 && provider.integration.kind !== "remote_mcp") {
    throw new Error(`${name} is enabled but has no keys`);
  }
  const unique = new Set(provider.keys.map((key) => key.trim()).filter(Boolean));
  if (unique.size !== provider.keys.length) throw new Error(`${name}.keys contains blanks or duplicates`);
  if (provider.strategy !== undefined && !STRATEGIES.includes(provider.strategy)) {
    throw new Error(`${name}.strategy must be one of ${STRATEGIES.join(", ")}`);
  }
  if (provider.defaultTier !== undefined && !TIERS.includes(provider.defaultTier)) {
    throw new Error(`${name}.defaultTier must be "free" or "paid"`);
  }
  if (provider.paidTools !== undefined) toolNames(provider.paidTools, `${name}.paidTools`);
  if (provider.keyMeta !== undefined && provider.keyMeta.length !== provider.keys.length) {
    throw new Error(`${name}.keyMeta must match keys`);
  }
  for (const [policyName, values] of Object.entries(provider.toolPolicy ?? {})) {
    if (policyName === "descriptions") {
      if (!values || typeof values !== "object" || Array.isArray(values)
        || Object.values(values).some((text) => typeof text !== "string")) {
        throw new Error(`${name}.toolPolicy.descriptions must map tool names to strings`);
      }
      continue;
    }
    if (!Array.isArray(values) || values.some((value) => typeof value !== "string" || !value.trim())) {
      throw new Error(`${name}.toolPolicy.${policyName} must contain non-blank tool names`);
    }
    if (new Set(values).size !== values.length) {
      throw new Error(`${name}.toolPolicy.${policyName} contains duplicates`);
    }
  }
}

export function sanitizedConfig(config: ToolkitConfig): unknown {
  return {
    version: config.version,
    statePath: config.statePath,
    profile: config.profile ?? "full",
    providers: Object.fromEntries(
      Object.entries(config.providers).map(([name, value]) => [name, {
        enabled: value.enabled,
        auto: value.auto,
        keyCount: value.keys.length,
        ...(value.strategy ? { strategy: value.strategy } : {}),
        ...tierCounts(value),
        integration: value.integration.kind,
        toolPolicy: value.toolPolicy,
      }]),
    ),
  };
}

/** How many keys sit on each plan, when any plan is known. Never includes key material. */
function tierCounts(provider: ProviderConfig): { tiers?: Record<string, number> } {
  const tiers: Record<string, number> = {};
  provider.keys.forEach((_, slot) => {
    const tier = provider.keyMeta?.[slot]?.tier ?? provider.defaultTier ?? "unset";
    tiers[tier] = (tiers[tier] ?? 0) + 1;
  });
  return Object.keys(tiers).length === 1 && tiers.unset ? {} : { tiers };
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}
