#!/usr/bin/env node
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ProviderConfig, ToolkitConfig } from "../src/types.js";
import { DEFAULT_FIRECRAWL_TOOLS } from "../src/upstream.js";

export function importKelivoDatabase(databasePath: string, outputPath: string): unknown {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  const rows = db.prepare("SELECT payload FROM search_service_rows ORDER BY sort_order").all() as Array<{ payload: string }>;
  db.close();
  const providers: Record<string, ProviderConfig> = {};
  const skipped: string[] = [];
  for (const row of rows) {
    const payload = JSON.parse(row.payload) as Record<string, unknown>;
    const type = String(payload.type ?? "");
    const config = providerFromPayload(type, payload);
    if (config) providers[type] = config;
    else skipped.push(type);
  }
  const statePath = resolve(dirname(outputPath), "state.db");
  const config: ToolkitConfig = { version: 1, statePath, providers };
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try { chmodSync(outputPath, 0o600); } catch { /* Windows ACL is inherited from LocalAppData. */ }
  return {
    outputPath,
    providers: Object.fromEntries(Object.entries(providers).map(([name, value]) => [name, value.keys.length])),
    skipped,
  };
}

function providerFromPayload(type: string, payload: Record<string, unknown>): ProviderConfig | undefined {
  const keys = unique([
    String(payload.apiKey ?? "").trim(),
    ...(Array.isArray(payload.apiKeys) ? payload.apiKeys.map(String).map((value) => value.trim()) : []),
  ].filter(Boolean));
  const options = Object.fromEntries(Object.entries(payload).filter(([key]) => !["apiKey", "apiKeys", "id", "type"].includes(key)));
  if (type === "exa") return provider(keys, true, {
    kind: "remote_mcp",
    url: "https://mcp.exa.ai/mcp?tools=web_search_exa,web_fetch_exa,web_search_advanced_exa",
    auth: { kind: "header", name: "x-api-key" },
  }, options);
  if (type === "tavily") return provider(keys, true, {
    kind: "remote_mcp",
    url: "https://mcp.tavily.com/mcp/",
    auth: { kind: "query", name: "tavilyApiKey" },
  }, options);
  if (type === "linkup") return provider(keys, false, {
    kind: "remote_mcp",
    url: "https://mcp.linkup.so/mcp",
    auth: { kind: "bearer" },
  }, options);
  if (type === "firecrawl") return {
    ...provider(keys, false, {
      kind: "stdio_mcp",
      command: "npx",
      args: ["-y", "firecrawl-mcp@3.24.0"],
      envKey: "FIRECRAWL_API_KEY",
    }, options),
    toolPolicy: { allow: [...DEFAULT_FIRECRAWL_TOOLS] },
  };
  if (["querit", "serper", "jina", "tinyfish"].includes(type)) {
    return provider(keys, type === "querit" || type === "serper", { kind: "rest", adapter: type as "querit" }, options);
  }
  if (type === "doubao") {
    return { ...provider(keys, false, { kind: "rest", adapter: "doubao" }, options), manualOnly: true };
  }
  if (type === "brave") {
    return provider(keys, true, { kind: "rest", adapter: "brave" }, options);
  }
  if (type === "grok") {
    return provider(keys, false, {
      kind: "rest",
      adapter: "grok",
      baseUrl: String(payload.customUrl ?? "https://api.x.ai/v1/responses"),
    }, { ...options, model: payload.model, customUrl: payload.customUrl });
  }
  return undefined;
}

function provider(
  keys: string[],
  automatic: boolean,
  integration: ProviderConfig["integration"],
  options: Record<string, unknown>,
): ProviderConfig {
  return { enabled: keys.length > 0, automatic, keys, integration, options };
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function defaultKelivoDatabase(): string {
  if (process.platform !== "win32") throw new Error("Pass --db on non-Windows systems");
  return resolve(process.env.APPDATA ?? resolve(homedir(), "AppData/Roaming"), "com.psyche/kelivo/kelivo.db");
}

function defaultOutput(): string {
  if (process.env.SEARCH_TOOLKIT_CONFIG) return resolve(process.env.SEARCH_TOOLKIT_CONFIG);
  if (process.platform === "win32") {
    return resolve(homedir(), ".config/search-toolkit/providers.json");
  }
  return resolve(process.env.XDG_CONFIG_HOME ?? resolve(homedir(), ".config"), "search-toolkit/providers.json");
}

if (process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replaceAll("\\", "/")}`).href) {
  const args = process.argv.slice(2);
  const dbIndex = args.indexOf("--db");
  const outIndex = args.indexOf("--output");
  const databaseArg = dbIndex >= 0 ? args[dbIndex + 1] : undefined;
  const outputArg = outIndex >= 0 ? args[outIndex + 1] : undefined;
  const database = databaseArg ? resolve(databaseArg) : defaultKelivoDatabase();
  const output = outputArg ? resolve(outputArg) : defaultOutput();
  console.log(JSON.stringify(importKelivoDatabase(database, output), null, 2));
}
