import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { KeySelection } from "./types.js";

const SCHEMA_VERSION = 2;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export function maskKey(key: string): string {
  const value = key.trim();
  if (value.length <= 8) return "••••••••";
  return `${value.slice(0, 4)}••••${value.slice(-4)}`;
}

/** Stable identity for a key that survives reordering of the provider's key list. */
export function keyFingerprint(key: string): string {
  return createHash("sha256").update(key.trim()).digest("hex").slice(0, 16);
}

export interface KeyPenalty {
  status: "cooldown" | "disabled";
  cooldownMs: number;
}

/**
 * Translate a key-attributable failure into a recoverable cool-down. Repeated
 * faults back off further; a success clears the strike count. Nothing is ever
 * disabled forever: when the window ends the key gets another chance.
 */
export function penaltyFor(status: number | undefined, strikes: number, retryAfterMs?: number): KeyPenalty | undefined {
  const step = Math.min(strikes, 2);
  if (status === 401 || status === 403) return { status: "disabled", cooldownMs: [HOUR, 6 * HOUR, 24 * HOUR][step] as number };
  if (status === 402) return { status: "cooldown", cooldownMs: [30 * MINUTE, 6 * HOUR, 24 * HOUR][step] as number };
  if (status === 429) {
    const fallback = [MINUTE, 5 * MINUTE, 15 * MINUTE][step] as number;
    const cooldownMs = retryAfterMs === undefined ? fallback : Math.min(Math.max(retryAfterMs, 5_000), 6 * HOUR);
    return { status: "cooldown", cooldownMs };
  }
  return undefined;
}

interface StateRow {
  fp: string;
  status: string;
  cooldown_until: number | null;
  strikes: number;
}

export class RotationStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS provider_cursor (
        provider TEXT PRIMARY KEY,
        next_slot INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS key_state (
        provider TEXT NOT NULL,
        fp TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'healthy',
        cooldown_until INTEGER,
        strikes INTEGER NOT NULL DEFAULT 0,
        requests INTEGER NOT NULL DEFAULT 0,
        successes INTEGER NOT NULL DEFAULT 0,
        failures INTEGER NOT NULL DEFAULT 0,
        tool_errors INTEGER NOT NULL DEFAULT 0,
        last_http_status INTEGER,
        last_latency_ms INTEGER,
        last_used_at INTEGER,
        PRIMARY KEY (provider, fp)
      );
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
  }

  close(): void {
    this.db.close();
  }

  /**
   * One-time import of the slot-indexed v1 `key_health` table. Rows are mapped
   * through the current key order, which is the only meaning they ever had.
   * The legacy table is left untouched so older processes that are still
   * running keep working until they restart.
   */
  adoptLegacyState(keysByProvider: Record<string, string[]>): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const done = this.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
      if (Number(done?.value ?? 0) >= SCHEMA_VERSION) {
        this.db.exec("COMMIT");
        return;
      }
      const legacy = this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'key_health'").get();
      if (legacy) {
        const rows = this.db.prepare(`
          SELECT provider, slot, status, requests, successes, failures,
                 last_http_status, last_latency_ms, last_used_at
          FROM key_health
        `).all() as Array<{
          provider: string; slot: number; status: string; requests: number; successes: number;
          failures: number; last_http_status: number | null; last_latency_ms: number | null; last_used_at: number | null;
        }>;
        const insert = this.db.prepare(`
          INSERT OR IGNORE INTO key_state(
            provider, fp, status, cooldown_until, strikes, requests, successes, failures,
            last_http_status, last_latency_ms, last_used_at
          ) VALUES (?, ?, 'healthy', NULL, 0, ?, ?, ?, ?, ?, ?)
        `);
        for (const row of rows) {
          const key = keysByProvider[row.provider]?.[row.slot];
          if (!key) continue;
          // v1 permanently disabled keys on any 401/403, including misattributed ones.
          // Start them healthy; a real fault earns a fresh, recoverable cool-down.
          insert.run(
            row.provider, keyFingerprint(key), row.requests, row.successes, row.failures,
            row.last_http_status, row.last_latency_ms, row.last_used_at,
          );
        }
      }
      this.db.prepare("INSERT INTO meta(key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .run(String(SCHEMA_VERSION));
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  select(provider: string, keys: string[], strict = false): KeySelection {
    if (keys.length === 0) throw new Error(`${provider} has no API keys`);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare("SELECT next_slot FROM provider_cursor WHERE provider = ?").get(provider) as
        | { next_slot: number }
        | undefined;
      const start = (row?.next_slot ?? 0) % keys.length;
      const health = this.healthByFingerprint(provider);
      const now = Date.now();
      let slot = start;
      if (!strict) {
        const found = Array.from({ length: keys.length }, (_, offset) => (start + offset) % keys.length).find((candidate) => {
          const item = health.get(keyFingerprint(keys[candidate] as string));
          return !item || item.cooldown_until === null || item.cooldown_until <= now;
        });
        if (found === undefined) {
          const soonest = Math.min(...keys.map((key) => health.get(keyFingerprint(key))?.cooldown_until ?? Infinity));
          const wait = Number.isFinite(soonest) ? ` (next recovery in ${formatDuration(soonest - now)})` : "";
          throw new Error(`${provider} has no healthy key slots available${wait}`);
        }
        slot = found;
      }
      this.db.prepare(`
        INSERT INTO provider_cursor(provider, next_slot) VALUES (?, ?)
        ON CONFLICT(provider) DO UPDATE SET next_slot = excluded.next_slot
      `).run(provider, (slot + 1) % keys.length);
      this.db.exec("COMMIT");
      const key = keys[slot];
      if (!key) throw new Error(`${provider} key slot ${slot} is missing`);
      return { provider, slot, key, masked: maskKey(key), fingerprint: keyFingerprint(key) };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  record(
    selection: KeySelection,
    result: { ok: boolean; latencyMs: number; httpStatus?: number; retryAfterMs?: number; toolError?: boolean },
  ): void {
    const now = Date.now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.db.prepare("SELECT strikes FROM key_state WHERE provider = ? AND fp = ?")
        .get(selection.provider, selection.fingerprint) as { strikes: number } | undefined;
      const strikes = current?.strikes ?? 0;
      const penalty = result.ok ? undefined : penaltyFor(result.httpStatus, strikes, result.retryAfterMs);
      const nextStrikes = result.ok ? 0 : penalty ? strikes + 1 : strikes;
      this.db.prepare(`
        INSERT INTO key_state(
          provider, fp, status, cooldown_until, strikes, requests, successes, failures, tool_errors,
          last_http_status, last_latency_ms, last_used_at
        ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(provider, fp) DO UPDATE SET
          status = excluded.status,
          cooldown_until = excluded.cooldown_until,
          strikes = excluded.strikes,
          requests = key_state.requests + 1,
          successes = key_state.successes + excluded.successes,
          failures = key_state.failures + excluded.failures,
          tool_errors = key_state.tool_errors + excluded.tool_errors,
          last_http_status = excluded.last_http_status,
          last_latency_ms = excluded.last_latency_ms,
          last_used_at = excluded.last_used_at
      `).run(
        selection.provider,
        selection.fingerprint,
        penalty?.status ?? "healthy",
        penalty ? now + penalty.cooldownMs : null,
        nextStrikes,
        result.ok ? 1 : 0,
        result.ok ? 0 : 1,
        result.toolError ? 1 : 0,
        result.httpStatus ?? null,
        result.latencyMs,
        now,
      );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Slots that are not cooling down, in key order, without advancing the round-robin cursor. */
  usableSlots(provider: string, keys: string[]): number[] {
    const health = this.healthByFingerprint(provider);
    const now = Date.now();
    return keys.flatMap((key, slot) => {
      const item = health.get(keyFingerprint(key));
      return !item || item.cooldown_until === null || item.cooldown_until <= now ? [slot] : [];
    });
  }

  /** Clear cool-downs and strikes so keys are selectable immediately. Returns the number of keys cleared. */
  reset(provider: string, keys: string[], slot?: number): number {
    const targets = slot === undefined ? keys : [keys[slot]].filter((key): key is string => Boolean(key));
    let cleared = 0;
    for (const key of targets) {
      const result = this.db.prepare(`
        UPDATE key_state SET status = 'healthy', cooldown_until = NULL, strikes = 0
        WHERE provider = ? AND fp = ? AND (status != 'healthy' OR cooldown_until IS NOT NULL OR strikes > 0)
      `).run(provider, keyFingerprint(key));
      cleared += Number(result.changes);
    }
    return cleared;
  }

  status(provider: string, keys: string[]) {
    const cursor = this.db.prepare("SELECT next_slot FROM provider_cursor WHERE provider = ?").get(provider) as
      | { next_slot: number }
      | undefined;
    const rows = this.db.prepare(`
      SELECT fp, status, cooldown_until, strikes, requests, successes, failures, tool_errors,
             last_http_status, last_latency_ms, last_used_at
      FROM key_state WHERE provider = ?
    `).all(provider) as Array<Record<string, unknown> & { fp: string }>;
    const byFingerprint = new Map(rows.map((item) => [item.fp, item]));
    const now = Date.now();
    return {
      provider,
      keyCount: keys.length,
      nextSlot: (cursor?.next_slot ?? 0) % Math.max(keys.length, 1),
      keys: keys.map((key, slot) => {
        const { fp: _fp, ...row } = byFingerprint.get(keyFingerprint(key)) ?? {} as Record<string, unknown>;
        const coolingDown = typeof row.cooldown_until === "number" && row.cooldown_until > now;
        return {
          slot,
          masked: maskKey(key),
          status: {
            requests: 0, successes: 0, failures: 0, tool_errors: 0, strikes: 0,
            ...row,
            status: coolingDown ? row.status : "healthy",
            ...(coolingDown ? { recovers_in: formatDuration(Number(row.cooldown_until) - now) } : {}),
          } as Record<string, unknown>,
        };
      }),
    };
  }

  private healthByFingerprint(provider: string): Map<string, StateRow> {
    const rows = this.db.prepare(
      "SELECT fp, status, cooldown_until, strikes FROM key_state WHERE provider = ?",
    ).all(provider) as unknown as StateRow[];
    return new Map(rows.map((item) => [item.fp, item]));
  }
}

function formatDuration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / MINUTE));
  if (minutes < 120) return `${minutes}m`;
  return `${Math.round(minutes / 60)}h`;
}
