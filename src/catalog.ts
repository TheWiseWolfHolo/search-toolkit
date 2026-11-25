import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { IntegrationConfig } from "./types.js";

/** Cached upstream catalogs older than this are refreshed in the background. */
export const CATALOG_REFRESH_MS = 12 * 60 * 60_000;

interface LegacyCatalogEntry {
  fingerprint: string;
  fetchedAt: number;
  tools: Tool[];
}

interface LegacyCatalogFile {
  version: 1;
  providers: Record<string, LegacyCatalogEntry>;
}

/**
 * SQLite-backed snapshot of each upstream MCP server's tool list, co-located in
 * `state.db` (WAL mode) to eliminate cross-process lost-update and Windows rename
 * races. Transparently migrates legacy `tool-catalog.json` snapshots on first read.
 */
export class ToolCatalogCache {
  private readonly db: DatabaseSync;
  private readonly ownsDb: boolean;
  private readonly legacyJsonPath: string | undefined;
  private readonly getStatement: StatementSync;
  private readonly setStatement: StatementSync;
  private readonly insertIgnoreStatement: StatementSync;
  private readonly deleteStatement: StatementSync;
  private migratedLegacy = false;
  private closed = false;

  constructor(pathOrDb: string | DatabaseSync, legacyJsonPath?: string) {
    if (typeof pathOrDb === "string") {
      const dbPath = pathOrDb.endsWith(".json") ? pathOrDb.replace(/\.json$/i, ".db") : pathOrDb;
      mkdirSync(dirname(dbPath), { recursive: true });
      this.db = new DatabaseSync(dbPath);
      this.ownsDb = true;
      this.legacyJsonPath = legacyJsonPath ?? (pathOrDb.endsWith(".json") ? pathOrDb : undefined);
      this.db.exec(`
        PRAGMA busy_timeout = 5000;
        PRAGMA journal_mode = WAL;
      `);
    } else {
      this.db = pathOrDb;
      this.ownsDb = false;
      this.legacyJsonPath = legacyJsonPath;
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tool_catalog (
        provider TEXT PRIMARY KEY,
        fingerprint TEXT NOT NULL,
        fetched_at INTEGER NOT NULL,
        tools TEXT NOT NULL
      );
    `);
    this.getStatement = this.db.prepare("SELECT fingerprint, fetched_at, tools FROM tool_catalog WHERE provider = ?");
    this.setStatement = this.db.prepare(`
      INSERT INTO tool_catalog(provider, fingerprint, fetched_at, tools) VALUES (?, ?, ?, ?)
      ON CONFLICT(provider) DO UPDATE SET
        fingerprint = excluded.fingerprint,
        fetched_at = excluded.fetched_at,
        tools = excluded.tools
    `);
    this.insertIgnoreStatement = this.db.prepare(`
      INSERT OR IGNORE INTO tool_catalog(provider, fingerprint, fetched_at, tools) VALUES (?, ?, ?, ?)
    `);
    this.deleteStatement = this.db.prepare("DELETE FROM tool_catalog WHERE provider = ?");
  }

  get(provider: string, fingerprint: string): { tools: Tool[]; stale: boolean } | undefined {
    if (this.closed) return undefined;
    let row = this.readRow(provider);
    if (!row && !this.migratedLegacy && this.legacyJsonPath) {
      this.migrateLegacyJson();
      row = this.readRow(provider);
    }
    if (!row || row.fingerprint !== fingerprint) return undefined;
    try {
      const tools = JSON.parse(row.tools) as unknown;
      if (!Array.isArray(tools)) return undefined;
      return { tools: tools as Tool[], stale: Date.now() - row.fetched_at > CATALOG_REFRESH_MS };
    } catch {
      try {
        this.deleteStatement.run(provider);
      } catch {
        // ignore read-only / busy state
      }
      return undefined;
    }
  }

  set(provider: string, fingerprint: string, tools: Tool[]): void {
    if (this.closed) return;
    try {
      this.setStatement.run(provider, fingerprint, Date.now(), JSON.stringify(tools));
    } catch {
      // The cache is an optimisation; a read-only or busy state file must not break startup.
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.ownsDb) this.db.close();
  }

  private readRow(provider: string): { fingerprint: string; fetched_at: number; tools: string } | undefined {
    try {
      return this.getStatement.get(provider) as { fingerprint: string; fetched_at: number; tools: string } | undefined;
    } catch {
      return undefined;
    }
  }

  private migrateLegacyJson(): void {
    this.migratedLegacy = true;
    if (!this.legacyJsonPath || !existsSync(this.legacyJsonPath)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.legacyJsonPath, "utf8")) as LegacyCatalogFile;
      if (parsed.version !== 1 || !parsed.providers || typeof parsed.providers !== "object") return;
      for (const [provider, entry] of Object.entries(parsed.providers)) {
        if (!entry || typeof entry.fingerprint !== "string" || !Number.isFinite(entry.fetchedAt) || !Array.isArray(entry.tools)) {
          continue;
        }
        try {
          this.insertIgnoreStatement.run(provider, entry.fingerprint, Math.floor(entry.fetchedAt), JSON.stringify(entry.tools));
        } catch {
          // ignore read-only DB errors during best-effort migration
        }
      }
    } catch {
      // missing or corrupt legacy JSON: ignore
    }
  }
}

/**
 * Identity of an integration for the catalog cache. A local stdio server is
 * often started by a fixed script path, so the script's modification time is
 * folded in: upgrading the package in place then rediscovers its tools.
 */
export function integrationFingerprint(integration: IntegrationConfig): string {
  const hash = createHash("sha256").update(JSON.stringify(integration));
  if (integration.kind === "stdio_mcp") {
    for (const arg of integration.args) {
      if (!/\.[cm]?js$/i.test(arg)) continue;
      try {
        hash.update(`|${statSync(arg).mtimeMs}`);
      } catch {
        // not a local file (a package spec or a missing path): the config text alone identifies it
      }
    }
  }
  return hash.digest("hex").slice(0, 16);
}

export function toolsFingerprint(tools: Tool[]): string {
  return createHash("sha256").update(JSON.stringify(tools)).digest("hex").slice(0, 16);
}
