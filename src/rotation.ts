import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { KeySelection, KeyStrategy } from "./types.js";

const SCHEMA_VERSION = 2;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const HEALTH_STEP = 0.4;
const HEALTH_HALF_LIFE_MS = 15 * MINUTE;
/** A provider at or above this recent failure score is tried after its healthy peers. */
export const FLAKY_SCORE = 0.5;

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
  status: "cooldown" | "disabled" | "exhausted";
  cooldownMs: number;
}

/**
 * Translate a key-attributable failure into a recoverable penalty. Repeated
 * faults back off further; a success clears the strike count. Nothing is ever
 * disabled forever: when the window ends the key gets another chance.
 *
 * An exhausted key (out of credit or quota) is different from a cooling one:
 * after its window it stays at the back of the pool and is only tried again
 * when no other key is healthy, so a spent prepaid key does not keep taking
 * a share of the traffic just to fail with 402. Under `drain` it gets one try
 * per window instead, so a key whose allowance reset is spent first again.
 * A success, a positive quota reading, or `reset` makes it healthy.
 */
export function penaltyFor(
  status: number | undefined,
  strikes: number,
  retryAfterMs?: number,
  exhausted = false,
): KeyPenalty | undefined {
  const step = Math.min(strikes, 2);
  if (exhausted || status === 402) return { status: "exhausted", cooldownMs: [30 * MINUTE, 6 * HOUR, 24 * HOUR][step] as number };
  if (status === 401 || status === 403) return { status: "disabled", cooldownMs: [HOUR, 6 * HOUR, 24 * HOUR][step] as number };
  if (status === 429) {
    const fallback = [MINUTE, 5 * MINUTE, 15 * MINUTE][step] as number;
    const cooldownMs = retryAfterMs === undefined ? fallback : Math.min(Math.max(retryAfterMs, 5_000), 6 * HOUR);
    return { status: "cooldown", cooldownMs };
  }
  return undefined;
}

export interface SelectOptions {
  /** Return the cursor slot regardless of health (tests and diagnostics). */
  strict?: boolean;
  strategy?: KeyStrategy;
  /** Slots this call may use; omitted means the whole pool. */
  eligible?: readonly number[];
  /** Slots already tried by this call. */
  exclude?: ReadonlySet<number>;
  /** Use exactly this slot, healthy or not (probes). */
  pin?: number;
}

/** healthy: selectable now. sunk: exhausted, window over, tried only as a last resort. benched: still inside its window. */
export type SlotState = "healthy" | "sunk" | "benched";

interface StateRow {
  fp: string;
  status: string;
  cooldown_until: number | null;
  strikes: number;
}

type Statement = ReturnType<DatabaseSync["prepare"]>;

export class RotationStore {
  private readonly db: DatabaseSync;
  private readonly statements = new Map<string, Statement>();

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
    this.addColumn("last_error", "TEXT");
    this.addColumn("last_error_at", "INTEGER");
    this.addColumn("quota_remaining", "REAL");
    this.addColumn("quota_checked_at", "INTEGER");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS provider_health (
        provider TEXT PRIMARY KEY,
        failure_score REAL NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
    `);
  }

  /**
   * Fold one automatic-route outcome into the provider's recent failure score.
   * Each failure moves the score 40% of the way to 1, each success 40% toward 0,
   * and the score halves every 15 minutes without news, so two failures in a
   * row mark a provider flaky and one success or a quiet half hour clears it.
   */
  recordProviderOutcome(provider: string, failed: boolean): void {
    const now = Date.now();
    const current = this.decayedScore(this.statement("SELECT failure_score, updated_at FROM provider_health WHERE provider = ?")
      .get(provider) as { failure_score: number; updated_at: number } | undefined, now);
    const next = current * (1 - HEALTH_STEP) + (failed ? HEALTH_STEP : 0);
    this.statement(`
      INSERT INTO provider_health(provider, failure_score, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(provider) DO UPDATE SET failure_score = excluded.failure_score, updated_at = excluded.updated_at
    `).run(provider, next, now);
  }

  /** Recent failure score per provider, 0 (healthy) to 1 (failing every time), decayed to now. */
  providerFailureScores(): Map<string, number> {
    const now = Date.now();
    const rows = this.statement("SELECT provider, failure_score, updated_at FROM provider_health").all() as
      Array<{ provider: string; failure_score: number; updated_at: number }>;
    return new Map(rows.map((row) => [row.provider, this.decayedScore(row, now)]));
  }

  private decayedScore(row: { failure_score: number; updated_at: number } | undefined, now: number): number {
    if (!row) return 0;
    return row.failure_score * 0.5 ** (Math.max(0, now - row.updated_at) / HEALTH_HALF_LIFE_MS);
  }

  /** Columns added after a state file was first created. Older processes keep working: they name their columns. */
  private addColumn(name: string, type: string): void {
    const columns = this.db.prepare("PRAGMA table_info(key_state)").all() as Array<{ name: string }>;
    if (columns.some((column) => column.name === name)) return;
    try {
      this.db.exec(`ALTER TABLE key_state ADD COLUMN ${name} ${type}`);
    } catch (error) {
      // Another process starting at the same moment may have added it first.
      if (!/duplicate column/i.test(error instanceof Error ? error.message : String(error))) throw error;
    }
  }

  private statement(sql: string): Statement {
    let prepared = this.statements.get(sql);
    if (!prepared) {
      prepared = this.db.prepare(sql);
      this.statements.set(sql, prepared);
    }
    return prepared;
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

  select(provider: string, keys: string[], options: boolean | SelectOptions = {}): KeySelection {
    if (keys.length === 0) throw new Error(`${provider} has no API keys`);
    const opts: SelectOptions = typeof options === "boolean" ? { strict: options } : options;
    const strategy = opts.strategy ?? "round_robin";
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.statement("SELECT next_slot FROM provider_cursor WHERE provider = ?").get(provider) as
        | { next_slot: number }
        | undefined;
      const cursor = (row?.next_slot ?? 0) % keys.length;
      let slot: number;
      if (opts.pin !== undefined) {
        if (!keys[opts.pin]) throw new Error(`${provider} key slot ${opts.pin} is missing`);
        slot = opts.pin;
      } else if (opts.strict) {
        slot = cursor;
      } else {
        const states = this.slotStates(provider, keys);
        const allowed = (opts.eligible ?? keys.map((_, index) => index))
          .filter((index) => index >= 0 && index < keys.length && !opts.exclude?.has(index));
        // drain walks the pool in configured order; the others start from the cursor.
        const distance = (index: number) => (index - cursor + keys.length) % keys.length;
        const ordered = strategy === "drain"
          ? [...allowed].sort((a, b) => a - b)
          : [...allowed].sort((a, b) => distance(a) - distance(b));
        // An exhausted key past its window waits behind every healthy key, except under drain:
        // there the order is the point (spend this key first), so it gets one try per window,
        // which is how a monthly allowance that has reset gets used again instead of a paid balance.
        const found = strategy === "drain"
          ? ordered.find((index) => states[index]?.state !== "benched")
          : ordered.find((index) => states[index]?.state === "healthy")
            ?? ordered.find((index) => states[index]?.state === "sunk");
        if (found === undefined) {
          const soonest = Math.min(...allowed.map((index) => states[index]?.until ?? Infinity));
          const wait = Number.isFinite(soonest) ? ` (next recovery in ${formatDuration(soonest - Date.now())})` : "";
          const scope = opts.eligible && opts.eligible.length < keys.length ? " for this tool" : "";
          throw new Error(`${provider} has no healthy key slots available${scope}${wait}`);
        }
        slot = found;
      }
      // sticky keeps pointing at the key in use; round_robin moves past it; drain never moves.
      // A call limited to some slots, or pinned to one, leaves a sticky pointer alone.
      const restricted = opts.pin !== undefined || (opts.eligible !== undefined && opts.eligible.length < keys.length);
      const next = strategy === "sticky" ? (restricted ? undefined : slot) : strategy === "drain" ? undefined : (slot + 1) % keys.length;
      if (next !== undefined) {
        this.statement(`
          INSERT INTO provider_cursor(provider, next_slot) VALUES (?, ?)
          ON CONFLICT(provider) DO UPDATE SET next_slot = excluded.next_slot
        `).run(provider, next);
      }
      this.db.exec("COMMIT");
      const key = keys[slot];
      if (!key) throw new Error(`${provider} key slot ${slot} is missing`);
      return { provider, slot, key, masked: maskKey(key), fingerprint: keyFingerprint(key) };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Where each slot stands right now, in key order. */
  slotStates(provider: string, keys: string[]): Array<{ state: SlotState; until?: number }> {
    const health = this.healthByFingerprint(provider);
    const now = Date.now();
    return keys.map((key) => {
      const item = health.get(keyFingerprint(key));
      if (!item) return { state: "healthy" };
      if (item.cooldown_until !== null && item.cooldown_until > now) return { state: "benched", until: item.cooldown_until };
      return { state: item.status === "exhausted" ? "sunk" : "healthy" };
    });
  }

  record(
    selection: KeySelection,
    result: {
      ok: boolean;
      latencyMs: number;
      httpStatus?: number;
      retryAfterMs?: number;
      toolError?: boolean;
      error?: string;
      /** Out of credit or quota, whatever status code said so. */
      exhausted?: boolean;
      /** The key's plan does not cover this request: noted, but the key is not benched. */
      planLimit?: boolean;
    },
  ): void {
    const now = Date.now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.statement("SELECT strikes FROM key_state WHERE provider = ? AND fp = ?")
        .get(selection.provider, selection.fingerprint) as { strikes: number } | undefined;
      const strikes = current?.strikes ?? 0;
      const penalty = result.ok || result.planLimit
        ? undefined
        : penaltyFor(result.httpStatus, strikes, result.retryAfterMs, result.exhausted === true);
      const nextStrikes = result.ok ? 0 : penalty ? strikes + 1 : strikes;
      this.statement(`
        INSERT INTO key_state(
          provider, fp, status, cooldown_until, strikes, requests, successes, failures, tool_errors,
          last_http_status, last_latency_ms, last_used_at, last_error, last_error_at
        ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)
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
          last_used_at = excluded.last_used_at,
          last_error = COALESCE(excluded.last_error, key_state.last_error),
          last_error_at = COALESCE(excluded.last_error_at, key_state.last_error_at)
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
        result.error ? result.error.slice(0, 200) : null,
        result.error ? now : null,
      );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Healthy slots (not benched, not exhausted), in key order, without moving the cursor. */
  usableSlots(provider: string, keys: string[], eligible?: readonly number[]): number[] {
    const states = this.slotStates(provider, keys);
    return (eligible ?? keys.map((_, slot) => slot)).filter((slot) => states[slot]?.state === "healthy");
  }

  /** Exhausted slots whose window has passed: the last resort when nothing healthy is left. */
  sunkSlots(provider: string, keys: string[], eligible?: readonly number[]): number[] {
    const states = this.slotStates(provider, keys);
    return (eligible ?? keys.map((_, slot) => slot)).filter((slot) => states[slot]?.state === "sunk");
  }

  /**
   * Store what a provider's billing API says is left on a key. An empty key
   * sinks to the back of the pool at once; an exhausted key that has credit
   * again (recharged, or a new billing period) is healthy again. Cool-downs
   * and auth failures are left alone: a balance says nothing about them.
   */
  recordQuota(provider: string, key: string, remaining: number | undefined): void {
    const now = Date.now();
    const fp = keyFingerprint(key);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.statement(`
        INSERT INTO key_state(provider, fp, quota_remaining, quota_checked_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(provider, fp) DO UPDATE SET quota_remaining = excluded.quota_remaining, quota_checked_at = excluded.quota_checked_at
      `).run(provider, fp, remaining ?? null, now);
      if (remaining !== undefined && remaining <= 0) {
        // Confirmed empty: bench it for six hours, then it waits at the back like any exhausted key.
        this.statement(`
          UPDATE key_state SET status = 'exhausted', cooldown_until = MAX(COALESCE(cooldown_until, 0), ?)
          WHERE provider = ? AND fp = ? AND status IN ('healthy', 'exhausted')
        `).run(now + 6 * HOUR, provider, fp);
      } else if (remaining !== undefined) {
        this.statement(`
          UPDATE key_state SET status = 'healthy', cooldown_until = NULL, strikes = 0
          WHERE provider = ? AND fp = ? AND status = 'exhausted'
        `).run(provider, fp);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Clear cool-downs, exhaustion, and strikes so keys are selectable immediately. Returns the number of keys cleared. */
  reset(provider: string, keys: string[], slot?: number): number {
    const targets = slot === undefined ? keys : [keys[slot]].filter((key): key is string => Boolean(key));
    let cleared = 0;
    for (const key of targets) {
      const result = this.statement(`
        UPDATE key_state SET status = 'healthy', cooldown_until = NULL, strikes = 0
        WHERE provider = ? AND fp = ? AND (status != 'healthy' OR cooldown_until IS NOT NULL OR strikes > 0)
      `).run(provider, keyFingerprint(key));
      cleared += Number(result.changes);
    }
    return cleared;
  }

  status(provider: string, keys: string[]) {
    const cursor = this.statement("SELECT next_slot FROM provider_cursor WHERE provider = ?").get(provider) as
      | { next_slot: number }
      | undefined;
    const rows = this.statement(`
      SELECT fp, status, cooldown_until, strikes, requests, successes, failures, tool_errors,
             last_http_status, last_latency_ms, last_used_at, last_error, last_error_at,
             quota_remaining, quota_checked_at
      FROM key_state WHERE provider = ?
    `).all(provider) as Array<Record<string, unknown> & { fp: string }>;
    const byFingerprint = new Map(rows.map((item) => [item.fp, item]));
    const now = Date.now();
    return {
      provider,
      keyCount: keys.length,
      nextSlot: (cursor?.next_slot ?? 0) % Math.max(keys.length, 1),
      keys: keys.map((key, slot) => {
        const { fp: _fp, quota_remaining: remaining, quota_checked_at: checkedAt, ...row } =
          byFingerprint.get(keyFingerprint(key)) ?? {} as Record<string, unknown>;
        const coolingDown = typeof row.cooldown_until === "number" && row.cooldown_until > now;
        // Exhaustion outlives its window: the key stays at the back until a call succeeds or it is reset.
        const shown = coolingDown || row.status === "exhausted" ? row.status : "healthy";
        return {
          slot,
          masked: maskKey(key),
          status: {
            requests: 0, successes: 0, failures: 0, tool_errors: 0, strikes: 0,
            ...row,
            status: shown,
            ...(coolingDown ? { recovers_in: formatDuration(Number(row.cooldown_until) - now) } : {}),
            // Last balance read by `search-toolkit quota`, and how long ago.
            ...(typeof checkedAt === "number"
              ? { quota_remaining: remaining ?? null, quota_checked: `${formatDuration(now - checkedAt)} ago` }
              : {}),
          } as Record<string, unknown>,
        };
      }),
    };
  }

  private healthByFingerprint(provider: string): Map<string, StateRow> {
    const rows = this.statement(
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
