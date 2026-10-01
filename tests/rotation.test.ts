import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { keyFingerprint, penaltyFor, RotationStore } from "../src/rotation.js";

function withStore(run: (store: RotationStore, dir: string) => void): void {
  const dir = mkdtempSync(resolve(tmpdir(), "search-toolkit-store-"));
  const store = new RotationStore(resolve(dir, "state.db"));
  try {
    run(store, dir);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("round robin persists across RotationStore instances", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "search-toolkit-rotation-"));
  try {
    const path = resolve(dir, "state.db");
    const keys = ["key-one-123456", "key-two-123456", "key-three-123456"];
    const first = new RotationStore(path);
    assert.deepEqual(
      [first.select("exa", keys, true).slot, first.select("exa", keys, true).slot],
      [0, 1],
    );
    first.close();
    const second = new RotationStore(path);
    assert.equal(second.select("exa", keys, true).slot, 2);
    assert.equal(second.select("exa", keys, true).slot, 0);
    second.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("health-aware rotation skips disabled keys", () => {
  withStore((store) => {
    const keys = ["key-one-123456", "key-two-123456"];
    const disabled = store.select("querit", keys, true);
    store.record(disabled, { ok: false, latencyMs: 10, httpStatus: 401 });
    assert.equal(store.select("querit", keys).slot, 1);
  });
});

test("health-aware rotation fails closed when every key is disabled", () => {
  withStore((store) => {
    const keys = ["key-one-123456"];
    const disabled = store.select("brave", keys, true);
    store.record(disabled, { ok: false, latencyMs: 10, httpStatus: 403 });
    assert.throws(() => store.select("brave", keys), /no healthy key slots/);
  });
});

test("penalties back off and honour Retry-After without ever being permanent", () => {
  assert.equal(penaltyFor(401, 0)?.status, "disabled");
  assert.equal(penaltyFor(401, 0)?.cooldownMs, 3_600_000);
  assert.equal(penaltyFor(401, 1)?.cooldownMs, 6 * 3_600_000);
  assert.equal(penaltyFor(401, 9)?.cooldownMs, 24 * 3_600_000);
  assert.equal(penaltyFor(402, 0)?.cooldownMs, 30 * 60_000);
  assert.equal(penaltyFor(429, 0)?.cooldownMs, 60_000);
  assert.equal(penaltyFor(429, 0, 90_000)?.cooldownMs, 90_000);
  assert.equal(penaltyFor(429, 0, 1)?.cooldownMs, 5_000);
  assert.equal(penaltyFor(429, 0, 999 * 3_600_000)?.cooldownMs, 6 * 3_600_000);
  assert.equal(penaltyFor(500, 0), undefined);
  assert.equal(penaltyFor(undefined, 0), undefined);
  assert.equal(penaltyFor(422, 0), undefined);
});

test("key health follows the key, not its position in the list", () => {
  withStore((store) => {
    const keys = ["key-alpha-123456", "key-bravo-123456"];
    const alpha = store.select("exa", keys, true);
    store.record(alpha, { ok: false, latencyMs: 5, httpStatus: 401 });
    // The operator reorders the pool: alpha is now slot 1 and must still be benched.
    const reordered = ["key-bravo-123456", "key-alpha-123456"];
    const picks = [store.select("exa", reordered).slot, store.select("exa", reordered).slot, store.select("exa", reordered).slot];
    assert.deepEqual(picks, [0, 0, 0]);
    assert.equal(store.status("exa", reordered).keys[1]?.status.status, "disabled");
    assert.equal(keyFingerprint(" key-alpha-123456 "), keyFingerprint("key-alpha-123456"));
  });
});

test("a benched key returns after its cool-down, and repeated faults back off further", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-02T00:00:00Z") });
  withStore((store) => {
    const keys = ["only-key-123456"];
    store.record(store.select("brave", keys, true), { ok: false, latencyMs: 5, httpStatus: 401 });
    assert.throws(() => store.select("brave", keys), /no healthy key slots available \(next recovery in 60m\)/);
    t.mock.timers.tick(61 * 60_000);
    const probation = store.select("brave", keys);
    assert.equal(probation.slot, 0);
    // Still invalid: the second strike earns a longer bench (6h), not a permanent ban.
    store.record(probation, { ok: false, latencyMs: 5, httpStatus: 401 });
    assert.equal(store.status("brave", keys).keys[0]?.status.recovers_in, "6h");
    t.mock.timers.tick(6 * 3_600_000 + 1);
    store.record(store.select("brave", keys), { ok: true, latencyMs: 5, httpStatus: 200 });
    const healed = store.status("brave", keys).keys[0]?.status;
    assert.equal(healed?.status, "healthy");
    assert.equal(healed?.strikes, 0);
  });
});

test("429 with Retry-After benches only for the advertised time", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-02T00:00:00Z") });
  withStore((store) => {
    const keys = ["rate-key-123456", "other-key-123456"];
    store.record(store.select("serper", keys, true), { ok: false, latencyMs: 5, httpStatus: 429, retryAfterMs: 20_000 });
    assert.equal(store.select("serper", keys).slot, 1);
    t.mock.timers.tick(21_000);
    assert.deepEqual(store.usableSlots("serper", keys), [0, 1]);
  });
});

test("server errors and tool errors never bench a key", () => {
  withStore((store) => {
    const keys = ["steady-key-123456"];
    store.record(store.select("exa", keys, true), { ok: false, latencyMs: 5, httpStatus: 503 });
    store.record(store.select("exa", keys), { ok: true, latencyMs: 5, toolError: true });
    const status = store.status("exa", keys).keys[0]?.status;
    assert.equal(status?.status, "healthy");
    assert.equal(status?.failures, 1);
    assert.equal(status?.tool_errors, 1);
  });
});

test("reset clears cool-downs for one slot or the whole pool", () => {
  withStore((store) => {
    const keys = ["reset-one-123456", "reset-two-123456"];
    store.record(store.select("exa", keys, true), { ok: false, latencyMs: 5, httpStatus: 401 });
    store.record(store.select("exa", keys, true), { ok: false, latencyMs: 5, httpStatus: 429 });
    assert.equal(store.usableSlots("exa", keys).length, 0);
    assert.equal(store.reset("exa", keys, 0), 1);
    assert.deepEqual(store.usableSlots("exa", keys), [0]);
    assert.equal(store.reset("exa", keys), 1);
    assert.deepEqual(store.usableSlots("exa", keys), [0, 1]);
    assert.equal(store.reset("exa", keys), 0);
  });
});

test("v1 slot-indexed health is adopted once and re-keyed by fingerprint", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "search-toolkit-legacy-"));
  try {
    const path = resolve(dir, "state.db");
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE key_health (
        provider TEXT NOT NULL, slot INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'healthy',
        cooldown_until INTEGER, requests INTEGER NOT NULL DEFAULT 0, successes INTEGER NOT NULL DEFAULT 0,
        failures INTEGER NOT NULL DEFAULT 0, last_http_status INTEGER, last_latency_ms INTEGER, last_used_at INTEGER,
        PRIMARY KEY (provider, slot)
      );
      INSERT INTO key_health VALUES ('exa', 0, 'disabled', NULL, 40, 30, 10, 403, 120, 1);
      INSERT INTO key_health VALUES ('exa', 1, 'healthy', NULL, 9, 9, 0, 200, 80, 2);
    `);
    legacy.close();
    const store = new RotationStore(path);
    const keys = ["legacy-key-aaaa", "legacy-key-bbbb"];
    store.adoptLegacyState({ exa: keys });
    const first = store.status("exa", keys).keys;
    // The v1 permanent ban is not carried over; counters are.
    assert.equal(first[0]?.status.status, "healthy");
    assert.equal(first[0]?.status.requests, 40);
    assert.equal(first[0]?.status.failures, 10);
    assert.equal(first[1]?.status.requests, 9);
    store.record(store.select("exa", keys, true), { ok: true, latencyMs: 1 });
    store.adoptLegacyState({ exa: keys });
    assert.equal(store.status("exa", keys).keys[0]?.status.requests, 41, "second adoption is a no-op");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
