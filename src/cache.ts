import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";

// Results larger than this are not worth the disk churn of caching.
const MAX_ENTRY_CHARS = 2_000_000;
const DEFAULT_MAX_ENTRIES = 500;
const DEFAULT_MAX_TOTAL_BYTES = 32 * 1024 * 1024;

export interface CacheHit {
  value: unknown;
  ageMs: number;
}

export interface ResultCacheOptions {
  /** Maximum cached rows retained before oldest entries are evicted (default 500; 0 disables count cap). */
  maxEntries?: number;
  /** Maximum total UTF-8 byte budget of cached values (default 32 MiB; 0 disables byte cap). */
  maxTotalBytes?: number;
}

/**
 * Short-lived results of the unified tools, shared by every process that uses
 * the same state file. Agents often repeat a search or page through the same
 * document within minutes; answering those from here saves quota and seconds.
 */
export class ResultCache {
  private readonly db: DatabaseSync;
  private readonly ownsDb: boolean;
  private readonly maxEntries: number;
  private readonly maxTotalBytes: number;
  private readonly getStatement: StatementSync;
  private readonly setStatement: StatementSync;
  private readonly deleteStatement: StatementSync;
  private readonly pruneStatement: StatementSync;
  private readonly evictExcessRowsStatement: StatementSync;
  private readonly totalBytesStatement: StatementSync;
  private readonly oldestRowsStatement: StatementSync;
  private lastPrunedAt = 0;
  private writesSincePrune = 0;
  private closed = false;

  constructor(pathOrDb: string | DatabaseSync, options: ResultCacheOptions = {}) {
    if (typeof pathOrDb === "string") {
      mkdirSync(dirname(pathOrDb), { recursive: true });
      this.db = new DatabaseSync(pathOrDb);
      this.ownsDb = true;
      this.db.exec(`
        PRAGMA busy_timeout = 5000;
        PRAGMA journal_mode = WAL;
      `);
    } else {
      this.db = pathOrDb;
      this.ownsDb = false;
    }
    this.maxEntries = options.maxEntries !== undefined && Number.isInteger(options.maxEntries) && options.maxEntries >= 0
      ? options.maxEntries
      : DEFAULT_MAX_ENTRIES;
    this.maxTotalBytes = options.maxTotalBytes !== undefined && Number.isInteger(options.maxTotalBytes) && options.maxTotalBytes >= 0
      ? options.maxTotalBytes
      : DEFAULT_MAX_TOTAL_BYTES;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS result_cache (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS result_cache_expiry ON result_cache(expires_at);
      CREATE INDEX IF NOT EXISTS result_cache_created ON result_cache(created_at);
    `);
    this.getStatement = this.db.prepare("SELECT value, created_at FROM result_cache WHERE key = ? AND expires_at > ?");
    this.setStatement = this.db.prepare(`
      INSERT INTO result_cache(key, value, created_at, expires_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, created_at = excluded.created_at, expires_at = excluded.expires_at
    `);
    this.deleteStatement = this.db.prepare("DELETE FROM result_cache WHERE key = ?");
    this.pruneStatement = this.db.prepare("DELETE FROM result_cache WHERE expires_at <= ?");
    this.evictExcessRowsStatement = this.db.prepare(`
      DELETE FROM result_cache WHERE key IN (
        SELECT key FROM result_cache ORDER BY created_at DESC LIMIT -1 OFFSET ?
      )
    `);
    this.totalBytesStatement = this.db.prepare("SELECT COALESCE(SUM(LENGTH(CAST(value AS BLOB))), 0) AS total FROM result_cache");
    this.oldestRowsStatement = this.db.prepare("SELECT key, LENGTH(CAST(value AS BLOB)) AS bytes FROM result_cache ORDER BY created_at ASC");
  }

  get(key: string): CacheHit | undefined {
    if (this.closed) return undefined;
    const now = Date.now();
    try {
      const row = this.getStatement.get(key, now) as { value: string; created_at: number } | undefined;
      if (!row) return undefined;
      try {
        return { value: JSON.parse(row.value) as unknown, ageMs: Math.max(0, now - row.created_at) };
      } catch {
        // Delete corrupt JSON rows so subsequent lookups do not repeat parse failures.
        try {
          this.deleteStatement.run(key);
        } catch {
          // ignore read-only / busy failure
        }
        return undefined;
      }
    } catch {
      return undefined;
    }
  }

  set(key: string, value: unknown, ttlMs: number): void {
    if (this.closed || ttlMs <= 0) return;
    const text = JSON.stringify(value);
    if (text.length > MAX_ENTRY_CHARS) return;
    if (this.maxTotalBytes > 0 && Buffer.byteLength(text, "utf8") > this.maxTotalBytes) return;
    const now = Date.now();
    try {
      this.writesSincePrune += 1;
      const shouldPrune = now - this.lastPrunedAt >= 60_000 || this.writesSincePrune >= 20;
      if (shouldPrune) {
        this.pruneStatement.run(now);
        this.lastPrunedAt = now;
        this.writesSincePrune = 0;
      }
      this.setStatement.run(key, text, now, now + ttlMs);
      this.enforceCapacity(key);
    } catch {
      // A busy or read-only state file only costs the cache, never the answer.
    }
  }

  private enforceCapacity(preserveKey: string): void {
    if (this.maxEntries > 0) {
      this.evictExcessRowsStatement.run(this.maxEntries);
    }
    if (this.maxTotalBytes > 0) {
      const row = this.totalBytesStatement.get() as { total: number } | undefined;
      let total = Number(row?.total ?? 0);
      if (total > this.maxTotalBytes) {
        const oldest = this.oldestRowsStatement.all() as Array<{ key: string; bytes: number }>;
        for (const entry of oldest) {
          if (total <= this.maxTotalBytes) break;
          if (entry.key === preserveKey) continue;
          this.deleteStatement.run(entry.key);
          total -= Number(entry.bytes ?? 0);
        }
      }
    }
  }

  entries(): number {
    if (this.closed) return 0;
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM result_cache WHERE expires_at > ?").get(Date.now()) as { count: number };
    return Number(row.count);
  }

  clear(): number {
    if (this.closed) return 0;
    return Number(this.db.prepare("DELETE FROM result_cache").run().changes);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.ownsDb) this.db.close();
  }
}

/** Order-independent key for a tool and the arguments that change its answer. */
export function cacheKey(tool: string, parts: Record<string, unknown>): string {
  const stable = JSON.stringify(parts, (_key, value: unknown) => value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .filter(([, item]) => item !== undefined)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      )
    : value);
  return `${tool}:${createHash("sha256").update(stable).digest("hex").slice(0, 32)}`;
}
