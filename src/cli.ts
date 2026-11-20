#!/usr/bin/env node
import { copyFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { defaultConfigPath, migrateConfig, normalizeConfig, readConfigFile, sanitizedConfig } from "./config.js";
import { redact } from "./provenance.js";
import { quotaEndpointFor, readQuota, type QuotaRow } from "./quota.js";
import { SearchToolkit } from "./toolkit.js";
import type { ToolkitProfile } from "./types.js";
import { PACKAGE_VERSION } from "./version.js";

const BOOLEAN_FLAGS = new Set(["json", "verbose", "write", "cross", "no-cache", "help", "version"]);
const KNOWN_COMMANDS = new Set([
  "help", "version", "migrate-config", "config", "reset", "quota", "cache-clear",
  "tools", "status", "search", "images", "fetch", "call", "probe",
]);

try {
  const argv = process.argv.slice(2);
  const flags = takeFlags(argv);
  const command = flags.has("version") ? "version" : flags.has("help") ? "help" : (argv.shift() ?? "help");
  if (command === "version") {
    console.log(PACKAGE_VERSION);
  } else if (command === "migrate-config") {
    migrate(flags);
  } else {
    await run(command, argv, flags);
  }
} catch (error) {
  console.error(redact(error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
}

async function run(name: string, args: string[], options: Flags): Promise<void> {
  if (name === "help") {
    console.log(helpText());
    return;
  }
  if (!KNOWN_COMMANDS.has(name)) {
    console.error(`Unknown command: ${name}\n\n${helpText()}`);
    process.exitCode = 1;
    return;
  }
  const profile = options.string("profile");
  if (profile !== undefined && profile !== "full" && profile !== "curated" && profile !== "lean") {
    throw new Error(`--profile must be "full", "curated", or "lean", got "${profile}"`);
  }
  const toolkit = new SearchToolkit(options.string("config"), {
    ...(profile ? { profile: profile as ToolkitProfile } : {}),
    ...(options.has("no-cache") ? { cache: false } : {}),
  });
  try {
    if (name === "config") {
      console.log(JSON.stringify(sanitizedConfig(toolkit.config), null, 2));
      return;
    }
    if (name === "reset") {
      const provider = args.shift();
      const config = provider ? toolkit.config.providers[provider] : undefined;
      if (!provider || !config) throw new Error("Usage: search-toolkit reset <provider> [slot]");
      let slot: number | undefined;
      if (args.length) {
        const rawSlot = (args[0] ?? "").trim();
        slot = rawSlot === "" ? Number.NaN : Number(rawSlot);
        if (!Number.isInteger(slot) || slot < 0 || slot >= config.keys.length) {
          throw new Error(config.keys.length
            ? `slot must be an integer from 0 to ${config.keys.length - 1}`
            : `${provider} has no configured keys`);
        }
      }
      const cleared = toolkit.rotation.reset(provider, config.keys, slot);
      console.log(`${provider}: cleared ${cleared} key${cleared === 1 ? "" : "s"}`);
      return;
    }
    if (name === "quota") {
      const wanted = args.shift();
      const names = wanted
        ? [wanted]
        : Object.entries(toolkit.config.providers)
            .filter(([provider, config]) => config.enabled && Boolean(quotaEndpointFor(provider, config)))
            .map(([provider]) => provider);
      const allRows: QuotaRow[] = [];
      for (const provider of names) {
        const config = toolkit.config.providers[provider];
        if (!config) throw new Error(`Unknown provider: ${provider}`);
        const rows = await readQuota(provider, config, toolkit.rotation);
        if (options.has("json")) {
          allRows.push(...rows);
          continue;
        }
        for (const row of rows) {
          const who = [row.tier, row.label].filter(Boolean).join(" ");
          const fields = Object.entries(row.quota ?? {}).map(([field, value]) => `${field}=${value}`).join(" ");
          const detail = row.ok
            ? `${row.remaining !== undefined ? `remaining=${row.remaining}  ` : ""}${options.has("verbose") ? fields : ""}`.trim() || fields || "(no balance fields)"
            : `error: ${row.error}`;
          console.log(`${provider} slot ${row.slot} ${row.masked}${who ? ` [${who}]` : ""}  ${detail}`);
        }
      }
      if (options.has("json")) {
        console.log(JSON.stringify(allRows, null, 2));
      }
      return;
    }
    if (name === "cache-clear") {
      console.log(`cleared ${toolkit.cache?.clear() ?? 0} cached results`);
      return;
    }
    await toolkit.initialize();
    if (name === "tools") {
      const tools = toolkit.listTools();
      if (options.has("json")) {
        console.log(JSON.stringify({ tools, warnings: toolkit.warnings }, null, 2));
      } else {
        for (const tool of tools) console.log(`${tool.name}${tool.annotations?.readOnlyHint === true ? "" : "  [action]"}`);
        for (const warning of toolkit.warnings) console.error(`warning: ${warning}`);
      }
    } else if (name === "status") {
      console.log(JSON.stringify(toolkit.status(options.has("verbose")), null, 2));
    } else if (name === "search") {
      const query = args.join(" ").trim();
      if (!query) {
        throw new Error(
          "Usage: search-toolkit search <query> [--mode general|exact|current|official|scholar|code|context] [--quality balanced|max] [--limit n] [--freshness day|week|month|year] [--domains a.com,b.com] [--exclude-domains x.com] [--max-chars n] [--max-tokens n] [--cross]",
        );
      }
      const includeDomains = csvFlag(options.string("domains"));
      const excludeDomains = csvFlag(options.string("exclude-domains"));
      show(await toolkit.callTool("search_auto", {
        query,
        ...optional("mode", options.string("mode")),
        ...optional("quality", options.string("quality")),
        ...optional("limit", options.number("limit")),
        ...optional("freshness", options.string("freshness")),
        ...optional("maxCharsPerResult", options.number("max-chars")),
        ...optional("maximumNumberOfTokens", options.number("max-tokens")),
        ...(includeDomains.length ? { includeDomains } : {}),
        ...(excludeDomains.length ? { excludeDomains } : {}),
        ...(options.has("cross") ? { crossCheck: true } : {}),
      }), options);
    } else if (name === "images") {
      const input = args.join(" ").trim();
      if (!input) throw new Error("Usage: search-toolkit images <query | image-url> [--limit n] [--language code] [--safesearch strict|off]");
      // A lone http(s) URL is an image to search by; anything else is a text query.
      const byImage = /^https?:\/\/\S+$/i.test(input);
      show(await toolkit.callTool("search_images", {
        ...(byImage ? { imageUrl: input } : { query: input }),
        ...optional("limit", options.number("limit")),
        ...optional("language", options.string("language")),
        ...optional("safesearch", options.string("safesearch")),
      }), options);
    } else if (name === "fetch") {
      if (!args.length) {
        throw new Error("Usage: search-toolkit fetch <url...> [--quality max] [--max-chars n] [--offset n] [--section heading]");
      }
      show(await toolkit.callTool("fetch_auto", {
        ...(args.length === 1 ? { url: args[0] } : { urls: args }),
        ...optional("quality", options.string("quality")),
        ...optional("maxChars", options.number("max-chars")),
        ...optional("offset", options.number("offset")),
        ...optional("section", options.string("section")),
      }), options);
    } else if (name === "call") {
      const tool = args.shift();
      if (!tool) throw new Error("Usage: search-toolkit call <tool> [json-arguments]");
      let parsed: Record<string, unknown> = {};
      if (args.length) {
        const rawJson = args.join(" ");
        let decoded: unknown;
        try {
          decoded = JSON.parse(rawJson);
        } catch (error) {
          throw new Error(`Invalid JSON arguments for ${tool}: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
          throw new Error(`Arguments for ${tool} must be a JSON object`);
        }
        parsed = decoded as Record<string, unknown>;
      }
      show(await toolkit.callTool(tool, parsed), options);
    } else if (name === "probe") {
      const provider = args.shift();
      const query = args.join(" ");
      if (!provider || !query) throw new Error("Usage: search-toolkit probe <provider> <query> [--slot n] [--calls n] [--tool name]");
      console.log(JSON.stringify(await toolkit.callTool("search_rotation_probe", {
        provider,
        query,
        ...optional("slot", options.number("slot")),
        ...optional("calls", options.number("calls")),
        ...optional("tool", options.string("tool")),
      }), null, 2));
    }
  } finally {
    await toolkit.close();
  }
}

/** Print what a model would read; --json prints the complete structured result instead. */
function show(output: unknown, options: Flags): void {
  const record = output as { content?: Array<{ type: string; text?: string }>; isError?: boolean };
  if (options.has("json")) {
    console.log(JSON.stringify(output, null, 2));
    if (record?.isError) process.exitCode = 1;
    return;
  }
  const blocks = Array.isArray(record.content) ? record.content : [];
  console.log(blocks.map((block) => block.type === "text" ? block.text ?? "" : `[${block.type} content]`).join("\n\n"));
  if (record.isError) process.exitCode = 1;
}

function migrate(options: Flags): void {
  const path = options.string("config") ?? defaultConfigPath();
  const baseDir = dirname(resolve(path));
  const raw = readConfigFile(path);
  const { document, changes } = migrateConfig(raw, baseDir);
  normalizeConfig(document, baseDir); // the result must load cleanly before anything is written
  if (!changes.length) {
    console.log(`${path} is already a clean v2 config; nothing to change.`);
    return;
  }
  for (const change of changes) console.log(`- ${change}`);
  if (!options.has("write")) {
    console.log("\nDry run. Re-run with --write to back up the file and apply these changes.");
    return;
  }
  const backup = `${path}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  copyFileSync(path, backup);
  writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  console.log(`\nWrote ${path} (backup: ${backup}). Keys were not printed.`);
}

function optional(name: string, value: string | number | undefined): Record<string, unknown> {
  return value === undefined ? {} : { [name]: value };
}

function csvFlag(value: string | undefined): string[] {
  return value ? value.split(",").map((item) => item.trim()).filter(Boolean) : [];
}

interface Flags {
  has(name: string): boolean;
  string(name: string): string | undefined;
  number(name: string): number | undefined;
}

/** Remove --flag [value] pairs from argv wherever they appear, leaving the positional words in place. */
function takeFlags(args: string[]): Flags {
  const values = new Map<string, string | true>();
  for (let index = 0; index < args.length;) {
    const arg = args[index] as string;
    if (arg === "--") {
      args.splice(index, 1);
      break;
    }
    if (index === 0 && arg === "-h") {
      values.set("help", true);
      args.splice(index, 1);
      continue;
    }
    if (index === 0 && arg === "-v") {
      values.set("version", true);
      args.splice(index, 1);
      continue;
    }
    if (!arg.startsWith("--")) {
      index += 1;
      continue;
    }
    const eq = arg.indexOf("=");
    const name = eq >= 0 ? arg.slice(2, eq) : arg.slice(2);
    if (eq >= 0) {
      values.set(name, arg.slice(eq + 1));
      args.splice(index, 1);
    } else if (BOOLEAN_FLAGS.has(name)) {
      values.set(name, true);
      args.splice(index, 1);
    } else {
      const next = args[index + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new Error(`--${name} requires a value`);
      }
      values.set(name, next);
      args.splice(index, 2);
    }
  }
  return {
    has: (name) => values.has(name),
    string: (name) => {
      const value = values.get(name);
      return typeof value === "string" && value ? value : undefined;
    },
    number: (name) => {
      if (!values.has(name)) return undefined;
      const value = values.get(name);
      const parsed = typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
      if (!Number.isFinite(parsed)) {
        throw new Error(`--${name} must be a finite number, got "${String(value)}"`);
      }
      return parsed;
    },
  };
}

function helpText(): string {
  return `Search Toolkit ${PACKAGE_VERSION}

Commands:
  search-toolkit search <query> [--mode m] [--quality q] [--limit n] [--freshness f] [--domains a,b] [--exclude-domains x,y] [--max-chars n] [--max-tokens n] [--cross]
  search-toolkit images <query | image-url> [--limit n] [--language code] [--safesearch strict|off]   an image URL searches by image (Google Lens)
  search-toolkit fetch <url...> [--quality max] [--max-chars n] [--offset n] [--section heading]
  search-toolkit tools [--profile full|curated|lean] [--json]
  search-toolkit call <tool> '{"query":"..."}' [--json]
  search-toolkit status [--verbose]
  search-toolkit reset <provider> [slot]       clear key cool-downs and exhaustion
  search-toolkit quota [provider] [--verbose] [--json]
                                               remaining credit per key from each provider's billing API (free reads);
                                               empty keys are marked exhausted, refilled ones return to rotation
  search-toolkit config                        sanitized config summary
  search-toolkit cache-clear                   drop cached search and fetch results
  search-toolkit migrate-config [--write]      upgrade a v1 config (dry run by default)
  search-toolkit probe <provider> <query> [--slot n] [--calls n] [--tool name]   one live call per key slot; consumes quota

Options:
  --config <path>   Override SEARCH_TOOLKIT_CONFIG
  --profile <p>     Override SEARCH_TOOLKIT_PROFILE (full, curated, lean)
  --json            Print the complete structured result instead of model-readable text
  --no-cache        Skip the result cache for this run (or set SEARCH_TOOLKIT_CACHE=off)
`;
}
