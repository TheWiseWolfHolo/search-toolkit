import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { IntegrationConfig } from "./types.js";

/** Cached upstream catalogs older than this are refreshed in the background. */
export const CATALOG_REFRESH_MS = 12 * 60 * 60_000;

interface CatalogEntry {
  fingerprint: string;
  fetchedAt: number;
  tools: Tool[];
}

interface CatalogFile {
  version: 1;
  providers: Record<string, CatalogEntry>;
}

/**
 * On-disk snapshot of each upstream MCP server's tool list. Starting from the
 * snapshot makes the server ready immediately and defers connecting to
 * upstreams until a tool is actually called.
 */
export class ToolCatalogCache {
  constructor(private readonly path: string) {}

  get(provider: string, fingerprint: string): { tools: Tool[]; stale: boolean } | undefined {
    const entry = this.read().providers[provider];
    if (!entry || entry.fingerprint !== fingerprint || !Array.isArray(entry.tools)) return undefined;
    return { tools: entry.tools, stale: Date.now() - entry.fetchedAt > CATALOG_REFRESH_MS };
  }

  set(provider: string, fingerprint: string, tools: Tool[]): void {
    // Re-read so concurrent processes updating other providers are not clobbered.
    const file = this.read();
    file.providers[provider] = { fingerprint, fetchedAt: Date.now(), tools };
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const temporary = `${this.path}.${process.pid}.tmp`;
      writeFileSync(temporary, JSON.stringify(file));
      renameSync(temporary, this.path);
    } catch {
      // The cache is an optimisation; a read-only state directory must not break startup.
    }
  }

  private read(): CatalogFile {
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as CatalogFile;
      if (parsed.version === 1 && parsed.providers && typeof parsed.providers === "object") return parsed;
    } catch {
      // missing or corrupt: start empty
    }
    return { version: 1, providers: {} };
  }
}

export function integrationFingerprint(integration: IntegrationConfig): string {
  return createHash("sha256").update(JSON.stringify(integration)).digest("hex").slice(0, 16);
}

export function toolsFingerprint(tools: Tool[]): string {
  return createHash("sha256").update(JSON.stringify(tools)).digest("hex").slice(0, 16);
}
