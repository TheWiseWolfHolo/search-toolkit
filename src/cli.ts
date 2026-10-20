#!/usr/bin/env node
import { copyFileSync, writeFileSync } from "node:fs";
import { defaultConfigPath, migrateConfig, normalizeConfig, readConfigFile, sanitizedConfig } from "./config.js";
import { SearchToolkit } from "./toolkit.js";
import type { ToolkitProfile } from "./types.js";
import { PACKAGE_VERSION } from "./version.js";

const BOOLEAN_FLAGS = new Set(["json", "verbose", "write", "cross", "no-cache"]);

const argv = process.argv.slice(2);
const flags = takeFlags(argv);
const command = argv.shift() ?? "help";

try {
  if (command === "migrate-config") {
    migrate(flags);
  } else {
    await run(command, argv, flags);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

async function run(name: string, args: string[], options: Flags): Promise<void> {
  if (name === "help") {
    console.log(helpText());
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
      const slot = args.length ? Number(args[0]) : undefined;
      if (slot !== undefined && !Number.isInteger(slot)) throw new Error("slot must be an integer");
      const cleared = toolkit.rotation.reset(provider, config.keys, slot);
      console.log(`${provider}: cleared ${cleared} key${cleared === 1 ? "" : "s"}`);
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
          "Usage: search-toolkit search <query> [--mode general|exact|current|official|context] [--quality balanced|max] [--limit n] [--freshness day|week|month|year] [--domains a.com,b.com] [--exclude-domains x.com] [--max-chars n] [--cross]",
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
        ...(includeDomains.length ? { includeDomains } : {}),
        ...(excludeDomains.length ? { excludeDomains } : {}),
        ...(options.has("cross") ? { crossCheck: true } : {}),
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
      const parsed = args.length ? JSON.parse(args.join(" ")) as Record<string, unknown> : {};
      show(await toolkit.callTool(tool, parsed), options);
    } else if (name === "probe") {
      const provider = args.shift();
      const query = args.join(" ");
      if (!provider || !query) throw new Error("Usage: search-toolkit probe <provider> <query>");
      console.log(JSON.stringify(await toolkit.callTool("search_rotation_probe", { provider, query }), null, 2));
    } else {
      console.log(helpText());
      process.exitCode = 1;
    }
  } finally {
    await toolkit.close();
  }
}

/** Print what a model would read; --json prints the complete structured result instead. */
function show(output: unknown, options: Flags): void {
  if (options.has("json")) {
    console.log(JSON.stringify(output, null, 2));
    return;
  }
  const record = output as { content?: Array<{ type: string; text?: string }>; isError?: boolean };
  const blocks = Array.isArray(record.content) ? record.content : [];
  console.log(blocks.map((block) => block.type === "text" ? block.text ?? "" : `[${block.type} content]`).join("\n\n"));
  if (record.isError) process.exitCode = 1;
}

function migrate(options: Flags): void {
  const path = options.string("config") ?? defaultConfigPath();
  const raw = readConfigFile(path);
  const { document, changes } = migrateConfig(raw);
  normalizeConfig(document); // the result must load cleanly before anything is written
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
    if (!arg.startsWith("--")) {
      index += 1;
      continue;
    }
    const name = arg.slice(2);
    if (BOOLEAN_FLAGS.has(name)) {
      values.set(name, true);
      args.splice(index, 1);
    } else {
      values.set(name, args[index + 1] ?? "");
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
      const value = values.get(name);
      const parsed = typeof value === "string" ? Number(value) : Number.NaN;
      return Number.isFinite(parsed) ? parsed : undefined;
    },
  };
}

function helpText(): string {
  return `Search Toolkit ${PACKAGE_VERSION}

Commands:
  search-toolkit search <query> [--mode m] [--quality q] [--limit n] [--freshness f] [--domains a,b] [--exclude-domains x,y] [--max-chars n] [--cross]
  search-toolkit fetch <url...> [--quality max] [--max-chars n] [--offset n] [--section heading]
  search-toolkit tools [--profile full|curated|lean] [--json]
  search-toolkit call <tool> '{"query":"..."}' [--json]
  search-toolkit status [--verbose]
  search-toolkit reset <provider> [slot]       clear key cool-downs
  search-toolkit config                        sanitized config summary
  search-toolkit cache-clear                   drop cached search and fetch results
  search-toolkit migrate-config [--write]      upgrade a v1 config (dry run by default)
  search-toolkit probe <provider> <query>      live rotation test; consumes quota

Options:
  --config <path>   Override SEARCH_TOOLKIT_CONFIG
  --profile <p>     Override SEARCH_TOOLKIT_PROFILE (full, curated, lean)
  --json            Print the complete structured result instead of model-readable text
  --no-cache        Skip the result cache for this run (or set SEARCH_TOOLKIT_CACHE=off)
`;
}
