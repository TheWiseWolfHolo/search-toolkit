import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AutoCapability, ProviderConfig, ToolkitConfig } from "./types.js";

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const CAPABILITIES: readonly AutoCapability[] = ["search", "images", "fetch"];
// Providers whose upstream tools can fetch a known URL; granted "fetch" when migrating a v1 config.
const FETCH_CAPABLE = new Set(["exa", "tavily", "firecrawl", "linkup", "anysearch"]);
// Provider options that some adapter actually reads. Everything else is dead weight.
const CONSUMED_OPTIONS: Record<string, readonly string[]> = {
  grok: ["model", "reasoningEffort", "systemPrompt", "customUrl"],
};
const PROVIDER_FIELDS = new Set(["enabled", "automatic", "manualOnly", "auto", "keys", "integration", "toolPolicy", "options"]);

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
  const provider: ProviderConfig = { enabled: raw.enabled === true, auto, keys: raw.keys as string[], integration };
  if (raw.toolPolicy !== undefined) provider.toolPolicy = raw.toolPolicy as NonNullable<ProviderConfig["toolPolicy"]>;
  if (options && Object.keys(options).length && consumed.length) provider.options = options;
  return provider;
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
  if (source.version === 1) changes.unshift("version 1 → 2: automatic/manualOnly replaced by auto[] (exa, tavily, firecrawl, linkup, anysearch also get fetch where they were automatic or Firecrawl)");
  const providers = Object.fromEntries(Object.entries(config.providers).map(([name, provider]) => [name, {
    enabled: provider.enabled,
    auto: provider.auto,
    keys: provider.keys,
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
      providers,
    },
    changes,
  };
}

export function validateConfig(config: ToolkitConfig): void {
  if (config.version !== 2) throw new Error(`Unsupported config version: ${String(config.version)}`);
  if (!config.statePath || typeof config.statePath !== "string") throw new Error("statePath is required");
  if (!config.providers || typeof config.providers !== "object") throw new Error("providers is required");
  if (config.profile !== undefined && config.profile !== "full" && config.profile !== "lean") {
    throw new Error("profile must be \"full\" or \"lean\"");
  }
  for (const [name, provider] of Object.entries(config.providers)) validateProvider(name, provider);
}

function validateProvider(name: string, provider: ProviderConfig): void {
  if (!/^[a-z][a-z0-9_]*$/.test(name)) throw new Error(`Invalid provider name: ${name}`);
  if (!Array.isArray(provider.keys)) throw new Error(`${name}.keys must be an array`);
  if (provider.enabled && provider.keys.length === 0 && provider.integration.kind !== "remote_mcp") {
    throw new Error(`${name} is enabled but has no keys`);
  }
  const unique = new Set(provider.keys.map((key) => key.trim()).filter(Boolean));
  if (unique.size !== provider.keys.length) throw new Error(`${name}.keys contains blanks or duplicates`);
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
        integration: value.integration.kind,
        toolPolicy: value.toolPolicy,
      }]),
    ),
  };
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}
