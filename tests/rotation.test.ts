import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { HttpError } from "../src/errors.js";
import { callWithRotation } from "../src/keys.js";
import { keyFingerprint, penaltyFor, RotationStore } from "../src/rotation.js";
import type { ProviderConfig } from "../src/types.js";

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
    assert.equal(healed?.strikes, undefined);
    assert.equal(healed?.cooldown_until, undefined);
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

test("callWithRotation retries up to 3 keys when multiple keys hit retryable rate limits", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "search-toolkit-multikey-"));
  const store = new RotationStore(resolve(dir, "state.db"));
  try {
    const keys = ["key-one-123456", "key-two-123456", "key-three-123456"];
    const tried: number[] = [];
    const config: ProviderConfig = { enabled: true, auto: [], keys, integration: { kind: "rest", adapter: "serper" } };
    const result = await callWithRotation(store, "exa", config, { tools: ["web_search_exa"] }, async (selected) => {
      tried.push(selected.slot);
      if (selected.slot < 2) {
        store.record(selected, { ok: false, latencyMs: 5, httpStatus: 429 });
        throw new HttpError("Too Many Requests", 429);
      }
      store.record(selected, { ok: true, latencyMs: 5, httpStatus: 200 });
      return `ok-${selected.slot}`;
    });
    assert.equal(result, "ok-2");
    assert.deepEqual(tried, [0, 1, 2]);
    assert.deepEqual(store.usableSlots("exa", keys), [2]);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
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

test("strikes decay back to zero after 24 hours without errors", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-02T00:00:00Z") });
  withStore((store) => {
    const keys = ["decay-key-123456"];
    // First 401 strike benches for 60m and sets last_error_at.
    store.record(store.select("brave", keys, true), {
      ok: false, latencyMs: 5, httpStatus: 401, error: "HTTP 401: bad key",
    });
    assert.equal(store.status("brave", keys).keys[0]?.status.recovers_in, "60m");
    assert.equal(store.status("brave", keys).keys[0]?.status.strikes, 1);

    // Advance beyond the 24h strike decay window without any intervening success.
    t.mock.timers.tick(25 * 3_600_000);
    const recovered = store.select("brave", keys);
    store.record(recovered, {
      ok: false, latencyMs: 5, httpStatus: 401, error: "HTTP 401: bad key again",
    });
    // Strikes decayed to 0 before penalty calculation, so backoff starts at 60m instead of 6h.
    const status = store.status("brave", keys).keys[0]?.status;
    assert.equal(status?.recovers_in, "60m");
    assert.equal(status?.strikes, 1);
  });
});

test("half-open recovery leases a single canary probe under drain and sticky strategies", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-02T00:00:00Z") });
  withStore((store) => {
    const keys = ["canary-one-123456", "canary-two-123456"];
    // Bench slot 0 with a 60s 429 cooldown.
    const first = store.select("serper", keys, { strategy: "drain" });
    assert.equal(first.slot, 0);
    store.record(first, { ok: false, latencyMs: 5, httpStatus: 429 });

    // Once cooldown expires, the first caller probes slot 0 and holds a 30s probe lease.
    t.mock.timers.tick(61_000);
    const probe = store.select("serper", keys, { strategy: "drain" });
    assert.equal(probe.slot, 0);

    // A concurrent caller during the 30s probe lease routes to slot 1 instead of stampeding slot 0.
    const concurrent = store.select("serper", keys, { strategy: "drain" });
    assert.equal(concurrent.slot, 1);

    // Recording the probe outcome immediately clears probe_until.
    store.record(probe, { ok: true, latencyMs: 5, httpStatus: 200 });
    assert.equal(store.select("serper", keys, { strategy: "drain" }).slot, 0);

    // Also verify probe_until expires automatically after 30s even if a probe never records.
    store.record(store.select("serper", keys, { strategy: "sticky" }), { ok: false, latencyMs: 5, httpStatus: 429 });
    t.mock.timers.tick(61_000);
    const stickyProbe = store.select("serper", keys, { strategy: "sticky" });
    assert.equal(stickyProbe.slot, 0);
    assert.equal(store.select("serper", keys, { strategy: "sticky" }).slot, 1);
    t.mock.timers.tick(31_000);
    assert.deepEqual(store.slotSummary("serper", keys).healthy, [0, 1]);
  });
});

test("nonKeyError records diagnostics without incrementing failures or benching the key", () => {
  withStore((store) => {
    const keys = ["page-err-123456"];
    const sel = store.select("parallel", keys, true);
    store.record(sel, {
      ok: false,
      latencyMs: 12,
      httpStatus: 422,
      toolError: true,
      nonKeyError: true,
      error: "page answered 403",
    });
    const status = store.status("parallel", keys).keys[0]?.status;
    assert.equal(status?.status, "healthy");
    assert.equal(status?.requests, 1);
    assert.equal(status?.failures, 0);
    assert.equal(status?.tool_errors, 1);
    assert.equal(status?.last_error, "page answered 403");
    assert.equal(status?.strikes, undefined);
    assert.equal(status?.cooldown_until, undefined);
  });
});

test("RotationStore.close is idempotent", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "search-toolkit-close-"));
  const store = new RotationStore(resolve(dir, "state.db"));
  try {
    store.close();
    assert.doesNotThrow(() => store.close());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("allowExhausted and preserveExhausted let $0 promo calls reuse 402-exhausted slots without clearing exhaustion or bypassing 401/429", () => {
  withStore((store) => {
    const keys = ["promo-key-123456", "backup-key-123456"];
    const first = store.select("vercel", keys, { strategy: "drain" });
    store.record(first, { ok: false, latencyMs: 5, httpStatus: 402, exhausted: true });

    // Default summary benches slot 0; allowExhausted treats 402-exhausted slot 0 as healthy.
    assert.deepEqual(store.slotSummary("vercel", keys, undefined, false).healthy, [1]);
    assert.deepEqual(store.slotSummary("vercel", keys, undefined, true).healthy, [0, 1]);

    // allowExhausted selects slot 0 without setting a half-open probe_until lease (concurrent calls still see slot 0).
    const promoA = store.select("vercel", keys, { strategy: "drain", allowExhausted: true });
    const promoB = store.select("vercel", keys, { strategy: "drain", allowExhausted: true });
    assert.equal(promoA.slot, 0);
    assert.equal(promoB.slot, 0);

    // preserveExhausted keeps status="exhausted" and cooldown_until intact on success.
    const beforeCooldown = store.status("vercel", keys).keys[0]?.status.cooldown_until;
    store.record(promoA, { ok: true, latencyMs: 5, httpStatus: 200, preserveExhausted: true });
    const afterStatus = store.status("vercel", keys).keys[0]?.status;
    assert.equal(afterStatus?.status, "exhausted");
    assert.equal(afterStatus?.cooldown_until, beforeCooldown);

    // 401 disabled and 429 cooldown remain blocked even when allowExhausted is true.
    const single = ["only-key-123456"];
    store.record(store.select("p429", single, true), { ok: false, latencyMs: 5, httpStatus: 429 });
    assert.throws(() => store.select("p429", single, { allowExhausted: true }), /no healthy key slots/);
    store.record(store.select("p401", single, true), { ok: false, latencyMs: 5, httpStatus: 401 });
    assert.throws(() => store.select("p401", single, { allowExhausted: true }), /no healthy key slots/);
  });
});

