import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";

// Results larger than this are not worth the disk churn of caching.
const MAX_ENTRY_CHARS = 2_000_000;

export interface CacheHit {
  value: unknown;
  ageMs: number;
}

/**
 * Short-lived results of the unified tools, shared by every process that uses
 * the same state file. Agents often repeat a search or page through the same
 * document within minutes; answering those from here saves quota and seconds.
 */
export class ResultCache {
  private readonly db: DatabaseSync;
  private readonly getStatement: StatementSync;
  private readonly setStatement: StatementSync;
  private readonly pruneStatement: StatementSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS result_cache (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS result_cache_expiry ON result_cache(expires_at);
    `);
    this.getStatement = this.db.prepare("SELECT value, created_at FROM result_cache WHERE key = ? AND expires_at > ?");
    this.setStatement = this.db.prepare(`
      INSERT INTO result_cache(key, value, created_at, expires_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, created_at = excluded.created_at, expires_at = excluded.expires_at
    `);
    this.pruneStatement = this.db.prepare("DELETE FROM result_cache WHERE expires_at <= ?");
  }

  get(key: string): CacheHit | undefined {
    const now = Date.now();
    const row = this.getStatement.get(key, now) as { value: string; created_at: number } | undefined;
    if (!row) return undefined;
    try {
      return { value: JSON.parse(row.value) as unknown, ageMs: now - row.created_at };
    } catch {
      return undefined;
    }
  }

  set(key: string, value: unknown, ttlMs: number): void {
    if (ttlMs <= 0) return;
    const text = JSON.stringify(value);
    if (text.length > MAX_ENTRY_CHARS) return;
    const now = Date.now();
    try {
      this.pruneStatement.run(now);
      this.setStatement.run(key, text, now, now + ttlMs);
    } catch {
      // A busy or read-only state file only costs the cache, never the answer.
    }
  }

  entries(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM result_cache WHERE expires_at > ?").get(Date.now()) as { count: number };
    return Number(row.count);
  }

  clear(): number {
    return Number(this.db.prepare("DELETE FROM result_cache").run().changes);
  }

  close(): void {
    this.db.close();
  }
}

/** Order-independent key for a tool and the arguments that change its answer. */
export function cacheKey(tool: string, parts: Record<string, unknown>): string {
  const stable = JSON.stringify(parts, (_key, value: unknown) => value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)))
    : value);
  return `${tool}:${createHash("sha256").update(stable).digest("hex").slice(0, 32)}`;
}
