import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { REST_ADAPTER_NAMES } from "./rest/adapters.js";
import type { AutoCapability, KeyMeta, KeyStrategy, KeyTier, ProviderConfig, ToolkitConfig } from "./types.js";

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const CAPABILITIES: readonly AutoCapability[] = ["search", "images", "fetch"];
// Providers whose upstream tools can fetch a known URL; granted "fetch" when migrating a v1 config.
const FETCH_CAPABLE = new Set([
  "exa", "tavily", "firecrawl", "linkup", "anysearch", "parallel", "you",
  "tinyfish", "octen", "querit", "deepseek", "vercel_gateway", "direct_markdown",
]);
const STRATEGIES: readonly KeyStrategy[] = ["round_robin", "sticky", "drain"];
const TIERS: readonly KeyTier[] = ["free", "paid"];
const KEY_FIELDS = new Set(["key", "tier", "label", "allowTools", "denyTools"]);
const KNOWN_REST_ADAPTERS = new Set(REST_ADAPTER_NAMES);
const KNOWN_AUTH_KINDS = new Set(["header", "bearer", "query", "none"]);
const TOP_LEVEL_FIELDS = new Set(["version", "statePath", "profile", "shaping", "cache", "providers"]);
const TOOL_POLICY_FIELDS = new Set(["allow", "deny", "descriptions"]);
// Provider options that some adapter actually reads. Everything else is dead weight.
const CONSUMED_OPTIONS: Record<string, readonly string[]> = {
  grok: ["model", "multiAgentModel", "reasoningEffort", "systemPrompt", "customUrl"],
  deepseek: ["localization"],
  vercel_gateway: ["model", "reasoning", "enableParallelFast", "localization", "fallbackModels", "authMethod"],
  direct_markdown: ["timeoutMs", "allowedPorts"],
  tinyfish: ["searchBaseUrl", "fetchBaseUrl"],
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

export interface NormalizeConfigOptions {
  /** When false, validate env:/file: syntax without requiring local env vars or secret files (used by migrateConfig). */
  resolveSecrets?: boolean;
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
  return normalizeConfig(readConfigFile(path), dirname(resolve(path)));
}

function resolvePathRef(rawPath: string, baseDir?: string): string {
  const trimmed = rawPath.trim();
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return resolve(homedir(), trimmed.slice(2));
  }
  return baseDir ? resolve(baseDir, trimmed) : trimmed;
}

/** Accept v1 and v2 files and return the v2 shape the rest of the code uses. */
export function normalizeConfig(raw: unknown, baseDir?: string, options: NormalizeConfigOptions = {}): LoadedConfig {
  const record = asRecord(raw, "config");
  const version = record.version;
  if (version !== 1 && version !== 2) throw new Error(`Unsupported config version: ${String(version)}`);
  const notes: string[] = [];
  for (const field of Object.keys(record)) {
    if (!TOP_LEVEL_FIELDS.has(field)) notes.push(`config.${field} is not a recognised field and is ignored`);
  }
  if (version === 1) {
    notes.push("config uses the v1 format (automatic/manualOnly); run `search-toolkit migrate-config --write` to upgrade it");
  }
  const providersRaw = asRecord(record.providers, "providers");
  const resolveSecrets = options.resolveSecrets !== false;
  const providers: Record<string, ProviderConfig> = {};
  for (const [name, value] of Object.entries(providersRaw)) {
    providers[name] = normalizeProvider(name, asRecord(value, `${name}`), version, notes, baseDir, resolveSecrets);
  }
  const rawStatePath = typeof record.statePath === "string" ? record.statePath.trim() : "";
  const statePath = rawStatePath ? resolvePathRef(rawStatePath, baseDir) : (record.statePath as string);
  const config: ToolkitConfig = { version: 2, statePath, providers };
  if (record.profile !== undefined) config.profile = record.profile as NonNullable<ToolkitConfig["profile"]>;
  if (record.shaping !== undefined) config.shaping = record.shaping as NonNullable<ToolkitConfig["shaping"]>;
  if (record.cache !== undefined) config.cache = record.cache as NonNullable<ToolkitConfig["cache"]>;
  validateConfig(config);
  return { config, notes };
}

function normalizeProvider(
  name: string,
  raw: Record<string, unknown>,
  version: unknown,
  notes: string[],
  baseDir: string | undefined,
  resolveSecrets: boolean,
): ProviderConfig {
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
  const options = raw.options && typeof raw.options === "object" && !Array.isArray(raw.options)
    ? raw.options as Record<string, unknown>
    : undefined;
  const integration = raw.integration as ProviderConfig["integration"];
  const consumed = integration?.kind === "rest" ? CONSUMED_OPTIONS[integration.adapter] ?? [] : [];
  const unused = Object.keys(options ?? {}).filter((key) => !consumed.includes(key));
  if (unused.length) notes.push(`${name}.options.{${unused.join(",")}} is never read by this server`);
  const enabled = raw.enabled === true;
  const { keys, keyRefs, keyMeta } = normalizeKeys(name, raw.keys, enabled && resolveSecrets, notes, baseDir);
  const provider: ProviderConfig = { enabled, auto, keys, integration };
  if (keyRefs.some((ref) => ref !== undefined)) provider.keyRefs = keyRefs;
  if (keyMeta.some((meta) => Object.keys(meta).length)) provider.keyMeta = keyMeta;
  if (raw.strategy !== undefined) provider.strategy = raw.strategy as KeyStrategy;
  if (raw.defaultTier !== undefined) provider.defaultTier = raw.defaultTier as KeyTier;
  if (raw.paidTools !== undefined) provider.paidTools = raw.paidTools as string[];
  if (raw.toolPolicy !== undefined) provider.toolPolicy = raw.toolPolicy as NonNullable<ProviderConfig["toolPolicy"]>;
  if (options && consumed.length) {
    const kept = Object.fromEntries(Object.entries(options).filter(([key]) => consumed.includes(key)));
    if (Object.keys(kept).length) provider.options = kept;
  }
  return provider;
}

/**
 * Resolve `env:VAR_NAME` and `file:/path/to/secret` indirections so credentials
 * do not need to sit in plaintext inside providers.json. Disabled providers and
 * offline config migrations skip env/file reads so paused or portable entries
 * stay valid and never fail on unreadable paths.
 */
function resolveKeyRef(
  rawKey: string,
  shouldResolve: boolean,
  label: string,
  baseDir?: string,
): { value: string; ref?: string } {
  const trimmed = rawKey.trim();
  if (trimmed.startsWith("env:")) {
    const varName = trimmed.slice(4).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(varName)) {
      throw new Error(`${label} has invalid env reference: ${trimmed}`);
    }
    if (!shouldResolve) return { value: trimmed, ref: trimmed };
    const envVal = process.env[varName]?.trim();
    if (!envVal) throw new Error(`${label}: environment variable ${varName} is not set`);
    if (/[\r\n]/.test(envVal)) throw new Error(`${label}: resolved key from ${varName} contains newline characters`);
    return { value: envVal, ref: trimmed };
  }
  if (trimmed.startsWith("file:")) {
    const filePath = trimmed.slice(5).trim();
    if (!filePath) throw new Error(`${label} has empty file reference`);
    if (!shouldResolve) return { value: trimmed, ref: trimmed };
    const resolved = filePath.startsWith("~/") || filePath.startsWith("~\\")
      ? resolve(homedir(), filePath.slice(2))
      : resolve(baseDir ?? process.cwd(), filePath);
    if (!existsSync(resolved)) throw new Error(`${label}: secret file not found: ${resolved}`);
    const contents = readFileSync(resolved, "utf8").trim();
    if (!contents) throw new Error(`${label}: secret file is empty: ${resolved}`);
    if (/[\r\n]/.test(contents)) throw new Error(`${label}: secret file contains newline characters`);
    return { value: contents, ref: trimmed };
  }
  if (/[\r\n]/.test(trimmed)) throw new Error(`${label}: key contains newline characters`);
  return { value: trimmed };
}

/**
 * A key is either its plain string (or `env:VAR` / `file:PATH`) or
 * `{ key, tier?, label?, allowTools?, denyTools? }`. Both shapes become a plain
 * key list plus parallel references and annotations.
 */
function normalizeKeys(
  name: string,
  raw: unknown,
  shouldResolve: boolean,
  notes: string[],
  baseDir?: string,
): { keys: string[]; keyRefs: Array<string | undefined>; keyMeta: KeyMeta[] } {
  if (!Array.isArray(raw)) throw new Error(`${name}.keys must be an array`);
  const keys: string[] = [];
  const keyRefs: Array<string | undefined> = [];
  const keyMeta: KeyMeta[] = [];
  raw.forEach((entry, slot) => {
    const label = `${name}.keys[${slot}]`;
    if (typeof entry === "string") {
      const resolved = resolveKeyRef(entry, shouldResolve, label, baseDir);
      keys.push(resolved.value);
      keyRefs.push(resolved.ref);
      keyMeta.push({});
      return;
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry) || typeof (entry as { key?: unknown }).key !== "string") {
      throw new Error(`${label} must be a string or an object with a string key`);
    }
    const record = entry as Record<string, unknown>;
    for (const field of Object.keys(record)) {
      if (!KEY_FIELDS.has(field)) notes.push(`${label}.${field} is not a recognised field and is ignored`);
    }
    const meta: KeyMeta = {};
    if (record.tier !== undefined) {
      if (!TIERS.includes(record.tier as KeyTier)) throw new Error(`${label}.tier must be "free" or "paid"`);
      meta.tier = record.tier as KeyTier;
    }
    if (record.label !== undefined) {
      if (typeof record.label !== "string") throw new Error(`${label}.label must be a string`);
      meta.label = record.label;
    }
    for (const field of ["allowTools", "denyTools"] as const) {
      if (record[field] === undefined) continue;
      meta[field] = toolNames(record[field], `${label}.${field}`);
    }
    const resolved = resolveKeyRef(record.key as string, shouldResolve, label, baseDir);
    keys.push(resolved.value);
    keyRefs.push(resolved.ref);
    keyMeta.push(meta);
  });
  return { keys, keyRefs, keyMeta };
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
 * `auto`, and options no adapter reads are dropped. Preserves `env:`/`file:` refs
 * without requiring them to be resolvable on the machine running migration.
 */
export function migrateConfig(raw: unknown, baseDir?: string): { document: Record<string, unknown>; changes: string[] } {
  const { config, notes } = normalizeConfig(raw, baseDir, { resolveSecrets: false });
  const source = asRecord(raw, "config");
  const rawStatePath = typeof source.statePath === "string" && source.statePath.trim() ? source.statePath.trim() : config.statePath;
  const changes = notes.filter((note) => !note.startsWith("config uses the v1 format"));
  if (source.version === 1) changes.unshift("version 1 → 2: automatic/manualOnly replaced by auto[] (exa, tavily, firecrawl, linkup, anysearch, parallel, you also get fetch where they were automatic or Firecrawl)");
  const providers = Object.fromEntries(Object.entries(config.providers).map(([name, provider]) => [name, {
    enabled: provider.enabled,
    auto: provider.auto,
    ...(provider.strategy ? { strategy: provider.strategy } : {}),
    ...(provider.defaultTier ? { defaultTier: provider.defaultTier } : {}),
    keys: provider.keys.map((key, slot) => keyDocument(provider.keyRefs?.[slot] ?? key, provider.keyMeta?.[slot])),
    ...(provider.paidTools ? { paidTools: provider.paidTools } : {}),
    integration: provider.integration,
    ...(provider.toolPolicy ? { toolPolicy: provider.toolPolicy } : {}),
    ...(provider.options ? { options: provider.options } : {}),
  }]));
  return {
    document: {
      version: 2,
      statePath: rawStatePath,
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
  if (!config.statePath || typeof config.statePath !== "string" || !config.statePath.trim()) throw new Error("statePath is required");
  if (!config.providers || typeof config.providers !== "object") throw new Error("providers is required");
  if (config.profile !== undefined && config.profile !== "full" && config.profile !== "curated" && config.profile !== "lean") {
    throw new Error("profile must be \"full\", \"curated\", or \"lean\"");
  }
  if (config.shaping !== undefined) validateShaping(config.shaping);
  if (config.cache !== undefined) validateCache(config.cache);
  for (const [name, provider] of Object.entries(config.providers)) validateProvider(name, provider);
}

function validateShaping(shaping: NonNullable<ToolkitConfig["shaping"]>): void {
  if (!shaping || typeof shaping !== "object" || Array.isArray(shaping)) throw new Error("shaping must be an object");
  for (const field of ["maxDescriptionChars", "maxParamDescriptionChars"] as const) {
    const value = shaping[field];
    if (value !== undefined && (!Number.isInteger(value) || value < 0 || value > 100_000)) {
      throw new Error(`shaping.${field} must be an integer from 0 to 100000`);
    }
  }
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
  if (cache.maxEntries !== undefined && (!Number.isInteger(cache.maxEntries) || cache.maxEntries < 0 || cache.maxEntries > 100_000)) {
    throw new Error("cache.maxEntries must be an integer from 0 to 100000");
  }
  if (cache.maxTotalBytes !== undefined && (!Number.isInteger(cache.maxTotalBytes) || cache.maxTotalBytes < 0 || cache.maxTotalBytes > 1_073_741_824)) {
    throw new Error("cache.maxTotalBytes must be an integer from 0 to 1073741824");
  }
}

function validateHttpUrl(raw: unknown, label: string): void {
  if (typeof raw !== "string" || !raw.trim()) throw new Error(`${label} must be a valid http(s) URL`);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${label} must be a valid http(s) URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${label} must be a valid http(s) URL`);
  }
}

function validateStringRecord(value: unknown, label: string, rejectNewlines = false): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a string-to-string object`);
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v !== "string") throw new Error(`${label}.${k} must be a string`);
    if (rejectNewlines && /[\r\n]/.test(v)) throw new Error(`${label}.${k} must not contain newline characters`);
  }
}

function validateIntegration(name: string, integration: ProviderConfig["integration"]): void {
  if (!integration || typeof integration !== "object" || Array.isArray(integration)) {
    throw new Error(`${name}.integration must be an object`);
  }
  if (integration.kind === "rest") {
    if (!KNOWN_REST_ADAPTERS.has(integration.adapter)) {
      throw new Error(`${name}.integration.adapter is unknown: ${String(integration.adapter)}`);
    }
    if (integration.baseUrl !== undefined) {
      validateHttpUrl(integration.baseUrl, `${name}.integration.baseUrl`);
    }
    if (integration.timeoutMs !== undefined && (!Number.isInteger(integration.timeoutMs) || integration.timeoutMs < 1_000 || integration.timeoutMs > 300_000)) {
      throw new Error(`${name}.integration.timeoutMs must be an integer from 1000 to 300000`);
    }
    return;
  }
  if (integration.kind === "remote_mcp") {
    if (typeof integration.url !== "string" || !integration.url.trim()) {
      throw new Error(`${name}.integration.url is required`);
    }
    validateHttpUrl(integration.url, `${name}.integration.url`);
    const auth = integration.auth as { kind?: unknown; name?: unknown } | undefined;
    if (!auth || typeof auth !== "object" || typeof auth.kind !== "string" || !KNOWN_AUTH_KINDS.has(auth.kind)) {
      throw new Error(`${name}.integration.auth.kind must be one of header, bearer, query, none`);
    }
    if ((auth.kind === "header" || auth.kind === "query") && (typeof auth.name !== "string" || !auth.name.trim())) {
      throw new Error(`${name}.integration.auth.name is required for ${auth.kind} auth`);
    }
    if (integration.headers !== undefined) {
      validateStringRecord(integration.headers, `${name}.integration.headers`, true);
    }
    if (integration.timeoutMs !== undefined && (!Number.isInteger(integration.timeoutMs) || integration.timeoutMs < 1_000 || integration.timeoutMs > 300_000)) {
      throw new Error(`${name}.integration.timeoutMs must be an integer from 1000 to 300000`);
    }
    if (integration.idleTimeoutMs !== undefined && (!Number.isInteger(integration.idleTimeoutMs) || integration.idleTimeoutMs < 0 || integration.idleTimeoutMs > 86_400_000)) {
      throw new Error(`${name}.integration.idleTimeoutMs must be an integer from 0 to 86400000`);
    }
    return;
  }
  if (integration.kind === "stdio_mcp") {
    if (typeof integration.command !== "string" || !integration.command.trim()) {
      throw new Error(`${name}.integration.command is required`);
    }
    if (!Array.isArray(integration.args) || integration.args.some((arg) => typeof arg !== "string")) {
      throw new Error(`${name}.integration.args must be a string array`);
    }
    if (typeof integration.envKey !== "string" || !integration.envKey.trim()) {
      throw new Error(`${name}.integration.envKey is required`);
    }
    if (integration.env !== undefined) {
      validateStringRecord(integration.env, `${name}.integration.env`);
    }
    if (integration.timeoutMs !== undefined && (!Number.isInteger(integration.timeoutMs) || integration.timeoutMs < 1_000 || integration.timeoutMs > 300_000)) {
      throw new Error(`${name}.integration.timeoutMs must be an integer from 1000 to 300000`);
    }
    if (integration.idleTimeoutMs !== undefined && (!Number.isInteger(integration.idleTimeoutMs) || integration.idleTimeoutMs < 0 || integration.idleTimeoutMs > 86_400_000)) {
      throw new Error(`${name}.integration.idleTimeoutMs must be an integer from 0 to 86400000`);
    }
    return;
  }
  throw new Error(`${name}.integration.kind must be "remote_mcp", "stdio_mcp", or "rest"`);
}

function validateProvider(name: string, provider: ProviderConfig): void {
  if (!/^[a-z][a-z0-9_]*$/.test(name)) throw new Error(`Invalid provider name: ${name}`);
  validateIntegration(name, provider.integration);
  if (!Array.isArray(provider.keys)) throw new Error(`${name}.keys must be an array`);
  const keylessAllowed = (provider.integration.kind === "remote_mcp" && provider.integration.auth.kind === "none")
    || (provider.integration.kind === "rest" && provider.integration.adapter === "direct_markdown");
  if (provider.enabled && provider.keys.length === 0 && !keylessAllowed) {
    throw new Error(`${name} is enabled but has no keys`);
  }
  if (provider.enabled) {
    const unique = new Set(provider.keys.map((key) => key.trim()).filter(Boolean));
    if (unique.size !== provider.keys.length) throw new Error(`${name}.keys contains blanks or duplicates`);
  } else {
    const nonBlank = provider.keys.map((key) => key.trim()).filter(Boolean);
    if (new Set(nonBlank).size !== nonBlank.length) throw new Error(`${name}.keys contains duplicates`);
  }
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
  if (provider.integration.kind === "rest" && provider.integration.adapter === "direct_markdown") {
    const timeoutMs = provider.options?.timeoutMs;
    if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || (timeoutMs as number) < 1_000 || (timeoutMs as number) > 15_000)) {
      throw new Error(`${name}.options.timeoutMs must be an integer from 1000 to 15000`);
    }
    const allowedPorts = provider.options?.allowedPorts;
    if (allowedPorts !== undefined) {
      if (!Array.isArray(allowedPorts) || allowedPorts.some((port) => !Number.isInteger(port) || (port as number) < 1 || (port as number) > 65_535)) {
        throw new Error(`${name}.options.allowedPorts must be an array of integer ports from 1 to 65535`);
      }
    }
  }
  if (provider.integration.kind === "rest" && provider.integration.adapter === "tinyfish") {
    if (provider.options?.searchBaseUrl !== undefined) {
      validateHttpUrl(provider.options.searchBaseUrl, `${name}.options.searchBaseUrl`);
    }
    if (provider.options?.fetchBaseUrl !== undefined) {
      validateHttpUrl(provider.options.fetchBaseUrl, `${name}.options.fetchBaseUrl`);
    }
  }
  if (provider.integration.kind === "rest" && provider.integration.adapter === "grok" && provider.options?.customUrl !== undefined) {
    validateHttpUrl(provider.options.customUrl, `${name}.options.customUrl`);
  }
  for (const [policyName, values] of Object.entries(provider.toolPolicy ?? {})) {
    if (!TOOL_POLICY_FIELDS.has(policyName)) {
      throw new Error(`${name}.toolPolicy.${policyName} is not a recognised field (expected allow, deny, or descriptions)`);
    }
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
