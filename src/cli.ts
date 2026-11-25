#!/usr/bin/env node
import { copyFileSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { defaultConfigPath, migrateConfig, normalizeConfig, readConfigFile, sanitizedConfig } from "./config.js";
import { redact } from "./provenance.js";
import { readAllQuotas, type QuotaRow } from "./quota.js";
import { SearchToolkit } from "./toolkit.js";
import type { ToolkitProfile } from "./types.js";
import { PACKAGE_VERSION } from "./version.js";

const GLOBAL_BOOLEAN_FLAGS = new Set(["json", "no-cache", "help", "version"]);
const GLOBAL_VALUE_FLAGS = new Set(["config", "profile"]);

interface CommandFlagSpec {
  boolean?: readonly string[];
  value?: readonly string[];
  usage: string;
}

const COMMAND_SPECS: Record<string, CommandFlagSpec> = {
  help: { usage: "search-toolkit help [command]" },
  version: { usage: "search-toolkit version" },
  "migrate-config": {
    boolean: ["write"],
    usage: "search-toolkit migrate-config [--write] [--json] [--config <path>]",
  },
  config: { usage: "search-toolkit config [--config <path>] [--profile <p>]" },
  reset: { usage: "search-toolkit reset <provider> [slot] [--json]" },
  quota: {
    boolean: ["verbose", "force"],
    usage: "search-toolkit quota [provider] [--verbose] [--force] [--json]",
  },
  "cache-clear": { usage: "search-toolkit cache-clear [--json]" },
  tools: {
    value: ["provider", "describe"],
    usage: "search-toolkit tools [--profile full|curated|lean] [--provider <name>] [--describe <tool>] [--json]",
  },
  status: {
    boolean: ["verbose", "refresh-quota"],
    usage: "search-toolkit status [--verbose] [--refresh-quota]",
  },
  search: {
    boolean: ["cross"],
    value: ["mode", "quality", "limit", "freshness", "domains", "exclude-domains", "max-chars", "max-tokens"],
    usage: "search-toolkit search <query> [--mode general|exact|current|official|scholar|code|context] [--quality balanced|max] [--limit n] [--freshness day|week|month|year] [--domains a.com,b.com] [--exclude-domains x.com] [--max-chars n] [--max-tokens n] [--cross] [--json]",
  },
  images: {
    value: ["limit", "language", "safesearch", "image-url", "query"],
    usage: "search-toolkit images <query | image-url> [--query <text> | --image-url <url>] [--limit n] [--language code] [--safesearch strict|off] [--json]",
  },
  fetch: {
    value: ["quality", "max-chars", "offset", "section"],
    usage: "search-toolkit fetch <url...> [--quality balanced|max] [--max-chars n] [--offset n] [--section heading] [--json]  (up to 5 URLs)",
  },
  call: {
    value: ["input"],
    usage: "search-toolkit call <tool> [json-arguments | @file.json] [--input - | <file.json>] [--json]",
  },
  probe: {
    value: ["slot", "calls", "tool"],
    usage: "search-toolkit probe <provider> <query> [--slot n] [--calls n] [--tool name] [--json]",
  },
};

try {
  const rawArgv = process.argv.slice(2);
  const { command, explicitCommand, positional, flags } = parseCliArgv(rawArgv);
  if (flags.has("help")) {
    const topic = explicitCommand ? command : positional[0];
    console.log(topic && topic !== "help" && COMMAND_SPECS[topic] ? commandHelp(topic) : helpText());
  } else if (flags.has("version") && (!explicitCommand || command === "version")) {
    console.log(PACKAGE_VERSION);
  } else if (command === "help") {
    const topic = positional[0];
    console.log(topic && topic !== "help" && COMMAND_SPECS[topic] ? commandHelp(topic) : helpText());
  } else if (command === "version") {
    console.log(PACKAGE_VERSION);
  } else if (command === "migrate-config") {
    migrate(flags);
  } else {
    await run(command, positional, flags);
  }
} catch (error) {
  console.error(redact(error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
}

async function run(name: string, args: string[], options: Flags): Promise<void> {
  if (!Object.hasOwn(COMMAND_SPECS, name)) {
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
      if (!provider || !config) throw new Error(`Usage: ${COMMAND_SPECS.reset!.usage}`);
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
      if (options.has("json")) {
        console.log(JSON.stringify({ ok: true, provider, ...(slot !== undefined ? { slot } : {}), cleared }, null, 2));
      } else {
        console.log(`${provider}: cleared ${cleared} key${cleared === 1 ? "" : "s"}`);
      }
      return;
    }
    if (name === "quota") {
      const wanted = args.shift();
      const rows = await readAllQuotas(toolkit.config.providers, toolkit.rotation, {
        ...(wanted ? { providers: [wanted] } : {}),
        ...(options.has("force") ? { force: true } : {}),
      });
      const anyFailed = rows.some((row) => !row.ok);
      if (options.has("json")) {
        console.log(JSON.stringify(rows, null, 2));
      } else if (!rows.length) {
        console.log("No enabled providers with configured quota APIs.");
      } else {
        for (const row of rows) {
          const line = formatQuotaRow(row, options.has("verbose"));
          if (row.ok) console.log(line);
          else console.error(line);
        }
      }
      if (anyFailed) process.exitCode = 1;
      return;
    }
    if (name === "cache-clear") {
      const cleared = toolkit.cache?.clear() ?? 0;
      if (options.has("json")) {
        console.log(JSON.stringify({ ok: true, cleared }, null, 2));
      } else {
        console.log(`cleared ${cleared} cached results`);
      }
      return;
    }
    await toolkit.initialize();
    if (name === "tools") {
      const describe = options.string("describe");
      if (describe) {
        const direct = toolkit.listTools("lean").find((tool) => tool.name === describe);
        if (direct) {
          console.log(JSON.stringify(direct, null, 2));
          return;
        }
        const described = await toolkit.callTool("provider_tools", { name: describe }, { isOwner: true });
        show(described, options);
        return;
      }
      const providerFilter = options.string("provider");
      if (providerFilter) {
        const listed = await toolkit.callTool("provider_tools", { provider: providerFilter }, { isOwner: true }) as {
          content?: Array<{ type: string; text?: string }>;
          isError?: boolean;
        };
        if (options.has("json")) {
          const text = Array.isArray(listed?.content)
            ? listed.content.filter((block) => block.type === "text").map((block) => block.text ?? "").join("\n")
            : "";
          const allowedNames = new Set(
            text === "No provider tools match."
              ? []
              : text.split("\n").map((line) => line.trim().split(/\s+/)[0]).filter((toolName): toolName is string => Boolean(toolName)),
          );
          const allTools = toolkit.listTools("full").filter((tool) => allowedNames.has(tool.name));
          console.log(JSON.stringify({ provider: providerFilter, tools: allTools, warnings: toolkit.warnings }, null, 2));
        } else {
          show(listed, options);
          for (const warning of toolkit.warnings) console.error(`warning: ${warning}`);
        }
        return;
      }
      const tools = toolkit.listTools();
      if (options.has("json")) {
        console.log(JSON.stringify({ tools, warnings: toolkit.warnings }, null, 2));
      } else {
        for (const tool of tools) console.log(`${tool.name}${tool.annotations?.readOnlyHint === true ? "" : "  [action]"}`);
        for (const warning of toolkit.warnings) console.error(`warning: ${warning}`);
      }
    } else if (name === "status") {
      if (options.has("refresh-quota")) {
        const refreshed = await toolkit.callTool(
          "search_pool_status",
          { verbose: options.has("verbose"), refreshQuota: true },
          { isOwner: true },
        ) as { structuredContent?: unknown; content?: Array<{ text?: string }>; isError?: boolean };
        if (refreshed?.isError) {
          show(refreshed, options);
        } else if (refreshed?.structuredContent !== undefined) {
          console.log(JSON.stringify(refreshed.structuredContent, null, 2));
        } else {
          console.log(refreshed?.content?.[0]?.text ?? "{}");
        }
      } else {
        console.log(JSON.stringify(toolkit.status(options.has("verbose")), null, 2));
      }
    } else if (name === "search") {
      const query = args.join(" ").trim();
      if (!query) {
        throw new Error(`Usage: ${COMMAND_SPECS.search!.usage}`);
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
      }, { isOwner: true }), options);
    } else if (name === "images") {
      const explicitUrl = options.string("image-url");
      const explicitQuery = options.string("query");
      if (explicitUrl && explicitQuery) {
        throw new Error("Provide either --query or --image-url, not both.");
      }
      let query = explicitQuery;
      let imageUrl = explicitUrl;
      if (!query && !imageUrl) {
        const input = args.join(" ").trim();
        if (!input) throw new Error(`Usage: ${COMMAND_SPECS.images!.usage}`);
        // A lone http(s) URL is an image to search by; anything else is a text query.
        if (/^https?:\/\/\S+$/i.test(input)) imageUrl = input;
        else query = input;
      }
      show(await toolkit.callTool("search_images", {
        ...(imageUrl ? { imageUrl } : { query }),
        ...optional("limit", options.number("limit")),
        ...optional("language", options.string("language")),
        ...optional("safesearch", options.string("safesearch")),
      }, { isOwner: true }), options);
    } else if (name === "fetch") {
      if (!args.length) {
        throw new Error(`Usage: ${COMMAND_SPECS.fetch!.usage}`);
      }
      show(await toolkit.callTool("fetch_auto", {
        ...(args.length === 1 ? { url: args[0] } : { urls: args }),
        ...optional("quality", options.string("quality")),
        ...optional("maxChars", options.number("max-chars")),
        ...optional("offset", options.number("offset")),
        ...optional("section", options.string("section")),
      }, { isOwner: true }), options);
    } else if (name === "call") {
      const tool = args.shift();
      if (!tool) throw new Error(`Usage: ${COMMAND_SPECS.call!.usage}`);
      const parsed = readCallArguments(tool, args, options.string("input"));
      show(await toolkit.callTool(tool, parsed, { isOwner: true }), options);
    } else if (name === "probe") {
      const provider = args.shift();
      const query = args.join(" ").trim();
      if (!provider || !query) throw new Error(`Usage: ${COMMAND_SPECS.probe!.usage}`);
      const output = await toolkit.callTool("search_rotation_probe", {
        provider,
        query,
        ...optional("slot", options.number("slot")),
        ...optional("calls", options.number("calls")),
        ...optional("tool", options.string("tool")),
      }, { isOwner: true }) as {
        isError?: boolean;
        content?: Array<{ type: string; text?: string }>;
        structuredContent?: {
          provider?: string;
          tool?: string;
          attempts?: Array<{ index?: number; slot?: number; ok?: boolean; error?: string }>;
        };
      };
      const attempts = Array.isArray(output?.structuredContent?.attempts) ? output.structuredContent.attempts : [];
      const failed = output?.isError === true || attempts.some((attempt) => attempt?.ok !== true);
      if (options.has("json")) {
        console.log(JSON.stringify(output, null, 2));
      } else if (output?.isError) {
        show(output, options);
      } else if (attempts.length) {
        for (const attempt of attempts) {
          const slotLabel = attempt.slot !== undefined ? `slot ${attempt.slot}` : `call ${attempt.index ?? "?"}`;
          const line = `${provider} (${output.structuredContent?.tool ?? "probe"}) ${slotLabel}: ${attempt.ok ? "ok" : `error: ${attempt.error ?? "failed"}`}`;
          if (attempt.ok) console.log(line);
          else console.error(line);
        }
      } else {
        console.log(JSON.stringify(output, null, 2));
      }
      if (failed) process.exitCode = 1;
    }
  } finally {
    await toolkit.close();
  }
}

function readCallArguments(tool: string, positional: string[], inputSource: string | undefined): Record<string, unknown> {
  let rawJson: string | undefined;
  if (inputSource !== undefined) {
    if (positional.length) {
      throw new Error(`Pass either inline JSON arguments or --input for ${tool}, not both`);
    }
    rawJson = inputSource === "-" ? readFileSync(0, "utf8") : readFileSync(resolve(inputSource), "utf8");
  } else if (positional.length === 1 && positional[0]?.startsWith("@") && positional[0].length > 1) {
    rawJson = readFileSync(resolve(positional[0].slice(1)), "utf8");
  } else if (positional.length) {
    rawJson = positional.join(" ");
  }
  if (!rawJson || !rawJson.trim()) return {};
  let decoded: unknown;
  try {
    decoded = JSON.parse(rawJson);
  } catch (error) {
    throw new Error(`Invalid JSON arguments for ${tool}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new Error(`Arguments for ${tool} must be a JSON object`);
  }
  return decoded as Record<string, unknown>;
}

function formatQuotaRow(row: QuotaRow, verbose: boolean): string {
  const who = [row.tier, row.label].filter(Boolean).join(" ");
  const fields = Object.entries(row.quota ?? {}).map(([field, value]) => `${field}=${value}`).join(" ");
  if (!row.ok) {
    return `${row.provider} slot ${row.slot} ${row.masked}${who ? ` [${who}]` : ""}  error: ${row.error ?? "unknown error"}`;
  }
  const parts: string[] = [];
  if (row.displayRemaining !== undefined && row.displayUnit) {
    parts.push(`remaining=${row.displayRemaining} ${row.displayUnit}`);
  } else if (row.remaining !== undefined) {
    parts.push(`remaining=${row.remaining}${row.unit ? ` ${row.unit}` : ""}`);
  }
  if (row.planLimit !== undefined) parts.push(`limit=${row.planLimit}`);
  if (row.billingPeriodEnd) parts.push(`resets=${row.billingPeriodEnd}`);
  if (row.lowBalance) parts.push("[LOW]");
  if (row.cached) parts.push("(cached)");
  if (verbose && fields) parts.push(fields);
  const detail = parts.join("  ").trim() || fields || "(no balance fields)";
  return `${row.provider} slot ${row.slot} ${row.masked}${who ? ` [${who}]` : ""}  ${detail}`;
}

/** Print what a model would read; --json prints the complete structured result instead. */
function show(output: unknown, options: Flags): void {
  const record = output as { content?: Array<{ type: string; text?: string }>; isError?: boolean } | undefined;
  if (options.has("json")) {
    console.log(JSON.stringify(output, null, 2));
    if (record?.isError) process.exitCode = 1;
    return;
  }
  const blocks = Array.isArray(record?.content) ? record.content : [];
  const rendered = blocks.map((block) => block.type === "text" ? block.text ?? "" : `[${block.type} content]`).join("\n\n");
  if (record?.isError) {
    console.error(rendered);
    process.exitCode = 1;
  } else {
    console.log(rendered);
  }
}

function migrate(options: Flags): void {
  const path = options.string("config") ?? defaultConfigPath();
  const baseDir = dirname(resolve(path));
  const raw = readConfigFile(path);
  const { document, changes } = migrateConfig(raw, baseDir);
  normalizeConfig(document, baseDir, { resolveSecrets: false }); // the result must load cleanly before anything is written
  if (!changes.length) {
    if (options.has("json")) {
      console.log(JSON.stringify({ ok: true, path, dryRun: !options.has("write"), changes: [] }, null, 2));
    } else {
      console.log(`${path} is already a clean v2 config; nothing to change.`);
    }
    return;
  }
  if (!options.has("write")) {
    if (options.has("json")) {
      console.log(JSON.stringify({ ok: true, path, dryRun: true, changes }, null, 2));
    } else {
      for (const change of changes) console.log(`- ${change}`);
      console.log("\nDry run. Re-run with --write to back up the file and apply these changes.");
    }
    return;
  }
  const backup = `${path}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  copyFileSync(path, backup);
  const tempPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(tempPath, `${JSON.stringify(document, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(tempPath, path);
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw error;
  }
  if (options.has("json")) {
    console.log(JSON.stringify({ ok: true, path, dryRun: false, changes, backup }, null, 2));
  } else {
    for (const change of changes) console.log(`- ${change}`);
    console.log(`\nWrote ${path} (backup: ${backup}). Keys were not printed.`);
  }
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

function parseBooleanLiteral(flagName: string, raw: string): boolean {
  const normalized = raw.trim().toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "yes") return true;
  if (normalized === "false" || normalized === "0" || normalized === "no") return false;
  throw new Error(`--${flagName} expects true or false, got "${raw}"`);
}

function parseCliArgv(rawArgv: string[]): { command: string; explicitCommand: boolean; positional: string[]; flags: Flags } {
  // First pass: detect the command token (first non-flag positional before "--"), respecting global value flags.
  let command: string | undefined;
  const rest: string[] = [];
  let sawDoubleDash = false;
  for (let i = 0; i < rawArgv.length; i += 1) {
    const token = rawArgv[i] as string;
    if (sawDoubleDash) {
      rest.push(token);
      continue;
    }
    if (token === "--") {
      sawDoubleDash = true;
      rest.push(token);
      continue;
    }
    if (!command) {
      if (token === "-h" || token === "--help" || token === "-v" || token === "--version") {
        rest.push(token);
        continue;
      }
      if (token.startsWith("--")) {
        const eq = token.indexOf("=");
        const name = eq >= 0 ? token.slice(2, eq) : token.slice(2);
        rest.push(token);
        if (eq < 0 && GLOBAL_VALUE_FLAGS.has(name) && i + 1 < rawArgv.length) {
          rest.push(rawArgv[i + 1] as string);
          i += 1;
        }
        continue;
      }
      command = token;
      continue;
    }
    rest.push(token);
  }

  const resolvedCommand = command ?? "help";
  const spec = COMMAND_SPECS[resolvedCommand];
  const allowedBooleans = new Set<string>([...GLOBAL_BOOLEAN_FLAGS, ...(spec?.boolean ?? [])]);
  const allowedValues = new Set<string>([...GLOBAL_VALUE_FLAGS, ...(spec?.value ?? [])]);

  const values = new Map<string, string | boolean>();
  const positional: string[] = [];

  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i] as string;
    if (arg === "--") {
      positional.push(...rest.slice(i + 1));
      break;
    }
    if (arg === "-h") {
      values.set("help", true);
      continue;
    }
    if (arg === "-v" && !command) {
      values.set("version", true);
      continue;
    }
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = eq >= 0 ? arg.slice(2, eq) : arg.slice(2);
    if (!name) {
      throw new Error(`Invalid flag: ${arg}`);
    }
    if (allowedBooleans.has(name)) {
      if (eq >= 0) {
        const parsedBool = parseBooleanLiteral(name, arg.slice(eq + 1));
        if (parsedBool) values.set(name, true);
        else values.delete(name);
      } else {
        values.set(name, true);
      }
      continue;
    }
    if (allowedValues.has(name)) {
      if (eq >= 0) {
        values.set(name, arg.slice(eq + 1));
      } else {
        const next = rest[i + 1];
        if (next === undefined || next.startsWith("--")) {
          throw new Error(`--${name} requires a value`);
        }
        values.set(name, next);
        i += 1;
      }
      continue;
    }
    // If the command itself is unknown, let run() report Unknown command cleanly unless --help/--version was passed.
    if (!spec) {
      throw new Error(`Unknown command: ${resolvedCommand}`);
    }
    const validForCommand = [...(spec.boolean ?? []), ...(spec.value ?? []), ...GLOBAL_BOOLEAN_FLAGS, ...GLOBAL_VALUE_FLAGS]
      .filter((flag) => flag !== "version")
      .map((flag) => `--${flag}`)
      .join(", ");
    throw new Error(`Unknown option --${name} for "${resolvedCommand}". Allowed options: ${validForCommand}`);
  }

  return {
    command: resolvedCommand,
    explicitCommand: command !== undefined,
    positional,
    flags: {
      has: (name) => values.get(name) === true,
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
    },
  };
}

function commandHelp(command: string): string {
  const spec = COMMAND_SPECS[command];
  return `${spec?.usage ?? `search-toolkit ${command}`}\n\nGlobal options:\n  --config <path>   Override SEARCH_TOOLKIT_CONFIG\n  --profile <p>     Override SEARCH_TOOLKIT_PROFILE (full, curated, lean)\n  --json            Print structured JSON output\n  --no-cache        Skip the result cache for this run (or set SEARCH_TOOLKIT_CACHE=off)\n  -h, --help        Show help\n`;
}

function helpText(): string {
  return `Search Toolkit ${PACKAGE_VERSION}

Commands:
  search-toolkit search <query> [--mode m] [--quality q] [--limit n] [--freshness f] [--domains a,b] [--exclude-domains x,y] [--max-chars n] [--max-tokens n] [--cross]
  search-toolkit images <query | image-url> [--query text | --image-url url] [--limit n] [--language code] [--safesearch strict|off]
                                               an image URL searches by image (Google Lens)
  search-toolkit fetch <url...> [--quality balanced|max] [--max-chars n] [--offset n] [--section heading]
                                               read 1 to 5 URLs concurrently
  search-toolkit tools [--profile full|curated|lean] [--provider <name>] [--describe <tool>] [--json]
  search-toolkit call <tool> ['{"query":"..."}' | @file.json] [--input - | <file.json>] [--json]
  search-toolkit status [--verbose] [--refresh-quota]
  search-toolkit reset <provider> [slot] [--json]
                                               clear key cool-downs and exhaustion
  search-toolkit quota [provider] [--verbose] [--force] [--json]
                                               remaining credit per key from each provider's billing API (free reads);
                                               empty keys are marked exhausted, refilled ones return to rotation
  search-toolkit config                        sanitized config summary
  search-toolkit cache-clear [--json]          drop cached search and fetch results
  search-toolkit migrate-config [--write] [--json]
                                               upgrade a v1 config (dry run by default; atomic backup+write)
  search-toolkit probe <provider> <query> [--slot n] [--calls n] [--tool name] [--json]
                                               one live call per key slot; consumes quota
  search-toolkit version                       print package version
  search-toolkit help [command]                show help

Options:
  --config <path>   Override SEARCH_TOOLKIT_CONFIG
  --profile <p>     Override SEARCH_TOOLKIT_PROFILE (full, curated, lean)
  --json            Print the complete structured JSON result instead of model-readable text
  --verbose         Include detailed per-slot / billing fields (status, quota)
  --no-cache        Skip the result cache for this run (or set SEARCH_TOOLKIT_CACHE=off)
  -v, --version     Print package version
  -h, --help        Show help (works at any position; pass after a command for command usage)
`;
}
