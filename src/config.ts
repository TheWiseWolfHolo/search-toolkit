import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ProviderConfig, ToolkitConfig } from "./types.js";

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export function defaultConfigPath(): string {
  if (process.env.SEARCH_TOOLKIT_CONFIG) return resolve(process.env.SEARCH_TOOLKIT_CONFIG);
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA ?? resolve(homedir(), "AppData/Local");
    return resolve(local, "search-toolkit/providers.json");
  }
  const configHome = process.env.XDG_CONFIG_HOME ?? resolve(homedir(), ".config");
  return resolve(configHome, "search-toolkit/providers.json");
}

export function exampleConfigPath(): string {
  return resolve(projectDir, "config.example.json");
}

export function loadConfig(path = defaultConfigPath()): ToolkitConfig {
  if (!existsSync(path)) {
    throw new Error(`Search Toolkit config not found: ${path}. Import or copy ${exampleConfigPath()}.`);
  }
  const parsed = JSON.parse(readFileSync(path, "utf8")) as ToolkitConfig;
  validateConfig(parsed);
  return parsed;
}

export function validateConfig(config: ToolkitConfig): void {
  if (config.version !== 1) throw new Error(`Unsupported config version: ${String(config.version)}`);
  if (!config.statePath || typeof config.statePath !== "string") throw new Error("statePath is required");
  if (!config.providers || typeof config.providers !== "object") throw new Error("providers is required");
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
}

export function sanitizedConfig(config: ToolkitConfig): unknown {
  return {
    version: config.version,
    statePath: config.statePath,
    providers: Object.fromEntries(
      Object.entries(config.providers).map(([name, value]) => [name, {
        enabled: value.enabled,
        automatic: value.automatic,
        manualOnly: value.manualOnly ?? false,
        keyCount: value.keys.length,
        integration: value.integration.kind,
      }]),
    ),
  };
}
