#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { redact } from "./provenance.js";
import { createProtocolServer } from "./server-factory.js";
import { SearchToolkit } from "./toolkit.js";
import type { ToolkitProfile } from "./types.js";
import { PACKAGE_VERSION } from "./version.js";

function parseServerArgs(argv: string[]): { configPath?: string; profile?: ToolkitProfile; help: boolean; version: boolean } {
  let configPath: string | undefined;
  let profile: string | undefined;
  let help = false;
  let version = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === "-h" || arg === "--help") {
      help = true;
      continue;
    }
    if (arg === "-v" || arg === "--version") {
      version = true;
      continue;
    }
    const eq = arg.indexOf("=");
    const name = eq >= 0 ? arg.slice(0, eq) : arg;
    const takeValue = (): string => {
      if (eq >= 0) {
        const value = arg.slice(eq + 1);
        if (!value) throw new Error(`${name} requires a value`);
        return value;
      }
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) throw new Error(`${name} requires a value`);
      i += 1;
      return next;
    };
    if (name === "--config") {
      configPath = takeValue();
    } else if (name === "--profile") {
      profile = takeValue();
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (profile !== undefined && profile !== "full" && profile !== "curated" && profile !== "lean") {
    throw new Error(`--profile must be "full", "curated", or "lean", got "${profile}"`);
  }
  return {
    ...(configPath ? { configPath } : {}),
    ...(profile ? { profile: profile as ToolkitProfile } : {}),
    help,
    version,
  };
}

let parsed: ReturnType<typeof parseServerArgs>;
try {
  parsed = parseServerArgs(process.argv.slice(2));
} catch (error) {
  console.error(redact(error instanceof Error ? error.message : String(error)));
  process.exit(2);
}

if (parsed.version) {
  console.log(PACKAGE_VERSION);
  process.exit(0);
}
if (parsed.help) {
  console.log(`search-toolkit-mcp ${PACKAGE_VERSION}\n\nUsage: search-toolkit-mcp [--config <path>] [--profile full|curated|lean] [-v|--version] [-h|--help]`);
  process.exit(0);
}

try {
  const toolkit = new SearchToolkit(parsed.configPath, parsed.profile ? { profile: parsed.profile } : {});
  await toolkit.initialize();

  let inFlight = 0;
  let stdinEnded = false;
  let shuttingDown = false;
  let drainTimer: NodeJS.Timeout | undefined;

  const flushAndExit = (code: number): void => {
    if (process.stdout.writableNeedDrain) {
      process.stdout.once("drain", () => process.exit(code));
    } else {
      process.exit(code);
    }
  };

  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (drainTimer) clearTimeout(drainTimer);
    await server.close().catch(() => undefined);
    await toolkit.close().catch(() => undefined);
  };

  const maybeFinishAfterEof = (): void => {
    if (!stdinEnded || shuttingDown || inFlight > 0) return;
    // Yield one tick so any JSON-RPC frame just delivered before EOF can start executing.
    setImmediate(() => {
      if (stdinEnded && !shuttingDown && inFlight === 0) {
        void shutdown().finally(() => flushAndExit(0));
      }
    });
  };

  const server = createProtocolServer(toolkit, {
    isOwner: true,
    onCallStart: () => {
      inFlight += 1;
    },
    onCallEnd: () => {
      inFlight = Math.max(0, inFlight - 1);
      maybeFinishAfterEof();
    },
  });

  const handleStdinEof = (): void => {
    if (stdinEnded) return;
    stdinEnded = true;
    // Safety ceiling so a wedged upstream cannot keep an orphaned stdio server alive forever.
    drainTimer = setTimeout(() => {
      void shutdown().finally(() => flushAndExit(0));
    }, 60_000);
    drainTimer.unref();
    maybeFinishAfterEof();
  };

  process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
  process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
  process.stdin.once("end", handleStdinEof);
  process.stdin.once("close", handleStdinEof);

  await server.connect(new StdioServerTransport());
} catch (error) {
  console.error(redact(error instanceof Error ? error.message : String(error)));
  process.exit(1);
}
