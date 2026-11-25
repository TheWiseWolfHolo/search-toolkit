// Probe configured key slots across enabled providers. Consumes real provider quota!
// Usage: npm run probe:all [-- --config <path>] [--providers a,b] [--calls n] [--query "..."]
import { SearchToolkit } from "../src/toolkit.js";

function parseArgs(argv: string[]): { config?: string; providers?: string[]; calls?: number; query: string; help: boolean } {
  let config: string | undefined;
  let providers: string[] | undefined;
  let calls: number | undefined;
  let query = "Search Toolkit official integration rotation verification";
  let help = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === "-h" || arg === "--help") {
      help = true;
      continue;
    }
    const eq = arg.indexOf("=");
    const name = eq >= 0 ? arg.slice(0, eq) : arg;
    const takeValue = (): string => {
      if (eq >= 0) return arg.slice(eq + 1);
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) throw new Error(`${name} requires a value`);
      i += 1;
      return next;
    };
    if (name === "--config") {
      config = takeValue();
    } else if (name === "--providers") {
      providers = takeValue().split(",").map((item) => item.trim()).filter(Boolean);
    } else if (name === "--calls") {
      const raw = takeValue();
      const num = Number(raw);
      if (!Number.isInteger(num) || num < 1 || num > 12) {
        throw new Error(`--calls must be an integer from 1 to 12, got "${raw}"`);
      }
      calls = num;
    } else if (name === "--query") {
      query = takeValue();
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return {
    ...(config ? { config } : {}),
    ...(providers ? { providers } : {}),
    ...(calls !== undefined ? { calls } : {}),
    query,
    help,
  };
}

const parsed = parseArgs(process.argv.slice(2));
if (parsed.help) {
  console.log("Usage: npm run probe:all [-- --config <path>] [--providers a,b] [--calls n] [--query \"...\"]");
  process.exit(0);
}

const toolkit = new SearchToolkit(parsed.config, { profile: "full", cache: false });

try {
  await toolkit.initialize();
  const targetProviders = parsed.providers?.length
    ? parsed.providers
    : Object.entries(toolkit.config.providers)
        .filter(([, cfg]) => cfg.enabled && cfg.keys.length > 0)
        .map(([name]) => name);
  const results: unknown[] = [];
  for (const provider of targetProviders) {
    const config = toolkit.config.providers[provider];
    if (!config?.enabled) {
      if (parsed.providers?.length) {
        results.push({ provider, skipped: true, reason: config ? "disabled" : "unknown provider" });
      }
      continue;
    }
    const callCount = Math.min(parsed.calls ?? Math.max(config.keys.length, 1), 12);
    const output = await toolkit.callTool("search_rotation_probe", {
      provider,
      query: parsed.query,
      calls: callCount,
    }) as Record<string, unknown>;
    const content = output.structuredContent as Record<string, unknown> | undefined;
    const attempts = Array.isArray(content?.attempts) ? content.attempts : [];
    results.push({
      provider,
      configuredKeys: config.keys.length,
      calls: attempts.length,
      successes: attempts.filter((item) => item && typeof item === "object" && (item as Record<string, unknown>).ok === true).length,
      attempts,
    });
  }
  console.log(JSON.stringify({ results, warnings: toolkit.warnings }, null, 2));
} finally {
  await toolkit.close();
}
