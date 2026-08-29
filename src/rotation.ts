import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { KeySelection } from "./types.js";

export function maskKey(key: string): string {
  const value = key.trim();
  if (value.length <= 8) return "••••••••";
  return `${value.slice(0, 4)}••••${value.slice(-4)}`;
}

export class RotationStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS provider_cursor (
        provider TEXT PRIMARY KEY,
        next_slot INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS key_health (
        provider TEXT NOT NULL,
        slot INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'healthy',
        cooldown_until INTEGER,
        requests INTEGER NOT NULL DEFAULT 0,
        successes INTEGER NOT NULL DEFAULT 0,
        failures INTEGER NOT NULL DEFAULT 0,
        last_http_status INTEGER,
        last_latency_ms INTEGER,
        last_used_at INTEGER,
        PRIMARY KEY (provider, slot)
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  select(provider: string, keys: string[], strict = false): KeySelection {
    if (keys.length === 0) throw new Error(`${provider} has no API keys`);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare("SELECT next_slot FROM provider_cursor WHERE provider = ?").get(provider) as
        | { next_slot: number }
        | undefined;
      const start = (row?.next_slot ?? 0) % keys.length;
      const healthRows = this.db.prepare(
        "SELECT slot, status, cooldown_until FROM key_health WHERE provider = ?",
      ).all(provider) as Array<{ slot: number; status: string; cooldown_until: number | null }>;
      const health = new Map(healthRows.map((item) => [item.slot, item]));
      const now = Date.now();
      let slot = start;
      if (!strict) {
        const found = Array.from({ length: keys.length }, (_, offset) => (start + offset) % keys.length).find((candidate) => {
          const item = health.get(candidate);
          if (!item) return true;
          if (item.status === "disabled") return false;
          return item.cooldown_until === null || item.cooldown_until <= now;
        });
        if (found === undefined) throw new Error(`${provider} has no healthy key slots available`);
        slot = found;
      }
      this.db.prepare(`
        INSERT INTO provider_cursor(provider, next_slot) VALUES (?, ?)
        ON CONFLICT(provider) DO UPDATE SET next_slot = excluded.next_slot
      `).run(provider, (slot + 1) % keys.length);
      this.db.exec("COMMIT");
      const key = keys[slot];
      if (!key) throw new Error(`${provider} key slot ${slot} is missing`);
      return { provider, slot, key, masked: maskKey(key) };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  record(selection: KeySelection, result: { ok: boolean; latencyMs: number; httpStatus?: number }): void {
    const status = result.httpStatus === 401 || result.httpStatus === 403 ? "disabled"
      : result.httpStatus === 429 || result.httpStatus === 402 ? "cooldown"
      : "healthy";
    const cooldown = status === "cooldown" ? Date.now() + 60_000 : null;
    this.db.prepare(`
      INSERT INTO key_health(
        provider, slot, status, cooldown_until, requests, successes, failures,
        last_http_status, last_latency_ms, last_used_at
      ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
      ON CONFLICT(provider, slot) DO UPDATE SET
        status = excluded.status,
        cooldown_until = excluded.cooldown_until,
        requests = key_health.requests + 1,
        successes = key_health.successes + excluded.successes,
        failures = key_health.failures + excluded.failures,
        last_http_status = excluded.last_http_status,
        last_latency_ms = excluded.last_latency_ms,
        last_used_at = excluded.last_used_at
    `).run(
      selection.provider,
      selection.slot,
      status,
      cooldown,
      result.ok ? 1 : 0,
      result.ok ? 0 : 1,
      result.httpStatus ?? null,
      result.latencyMs,
      Date.now(),
    );
  }

  status(provider: string, keys: string[]) {
    const cursor = this.db.prepare("SELECT next_slot FROM provider_cursor WHERE provider = ?").get(provider) as
      | { next_slot: number }
      | undefined;
    const rows = this.db.prepare(`
      SELECT slot, status, cooldown_until, requests, successes, failures,
             last_http_status, last_latency_ms, last_used_at
      FROM key_health WHERE provider = ? ORDER BY slot
    `).all(provider) as Array<Record<string, unknown> & { slot: number }>;
    const bySlot = new Map(rows.map((item) => [item.slot, item]));
    return {
      provider,
      keyCount: keys.length,
      nextSlot: (cursor?.next_slot ?? 0) % Math.max(keys.length, 1),
      keys: keys.map((key, slot) => ({
        slot,
        masked: maskKey(key),
        status: bySlot.get(slot) ?? { status: "healthy", requests: 0, successes: 0, failures: 0 },
      })),
    };
  }
}
