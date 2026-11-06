import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { CapabilityGateError, HttpError, PlanLimitError, isPlanLimit, isQuotaExhausted, shouldFailoverProvider } from "../src/errors.js";
import { callWithRotation, eligibleSlots } from "../src/keys.js";
import { keyFingerprint, RotationStore } from "../src/rotation.js";
import type { KeyStrategy, ProviderConfig } from "../src/types.js";

const KEYS = ["key-zero-123456", "key-one-123456", "key-two-123456"];

function withStore(run: (store: RotationStore, path: string) => void | Promise<void>): Promise<void> {
  const dir = mkdtempSync(resolve(tmpdir(), "search-toolkit-strategy-"));
  const path = resolve(dir, "state.db");
  const store = new RotationStore(path);
  return Promise.resolve(run(store, path)).finally(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
}

function pool(extra: Partial<ProviderConfig> = {}, keys = KEYS): ProviderConfig {
  return { enabled: true, auto: [], keys, integration: { kind: "rest", adapter: "serper" }, ...extra };
}

function picks(store: RotationStore, strategy: KeyStrategy, count: number): number[] {
  return Array.from({ length: count }, () => store.select("p", KEYS, { strategy }).slot);
}

/** End a slot's penalty window now, as if the time had passed. */
function expire(path: string, key: string): void {
  const db = new DatabaseSync(path);
  db.prepare("UPDATE key_state SET cooldown_until = ? WHERE fp = ?").run(Date.now() - 1, keyFingerprint(key));
  db.close();
}

test("round_robin spreads, sticky stays, drain uses keys in order", async () => {
  await withStore((store) => assert.deepEqual(picks(store, "round_robin", 4), [0, 1, 2, 0]));
  await withStore((store) => assert.deepEqual(picks(store, "sticky", 3), [0, 0, 0]));
  await withStore((store) => assert.deepEqual(picks(store, "drain", 3), [0, 0, 0]));
});

test("sticky moves to the next healthy key and stays there", async () => {
  await withStore((store) => {
    store.record(store.select("p", KEYS, { strategy: "sticky" }), { ok: false, latencyMs: 1, httpStatus: 401 });
    assert.deepEqual(picks(store, "sticky", 3), [1, 1, 1]);
  });
});

test("a call limited to some slots leaves the sticky pointer alone", async () => {
  await withStore((store) => {
    assert.equal(store.select("p", KEYS, { strategy: "sticky", eligible: [2] }).slot, 2);
    assert.equal(store.select("p", KEYS, { strategy: "sticky" }).slot, 0);
  });
});

test("drain falls back while the first key cools down and returns to it afterwards", async () => {
  await withStore((store, path) => {
    store.record(store.select("p", KEYS, { strategy: "drain" }), { ok: false, latencyMs: 1, httpStatus: 429, retryAfterMs: 30_000 });
    assert.equal(store.select("p", KEYS, { strategy: "drain" }).slot, 1);
    expire(path, KEYS[0] as string);
    assert.equal(store.select("p", KEYS, { strategy: "drain" }).slot, 0);
  });
});

test("an exhausted key stays at the back after its window and is the last resort", async () => {
  await withStore((store, path) => {
    const spent = store.select("p", KEYS, true);
    store.record(spent, { ok: false, latencyMs: 1, httpStatus: 402 });
    assert.equal(store.status("p", KEYS).keys[0]?.status.status, "exhausted");
    expire(path, KEYS[0] as string);
    // The window is over, yet healthy keys still come first, even when the cursor reaches it.
    assert.deepEqual(picks(store, "round_robin", 3), [1, 2, 1]);
    assert.equal(store.status("p", KEYS).keys[0]?.status.status, "exhausted", "exhaustion outlives the window");
    // With every other key benched, the exhausted one gets its chance, and a success restores it.
    for (const key of [KEYS[1], KEYS[2]] as string[]) {
      store.record({ provider: "p", slot: 0, key, masked: "", fingerprint: keyFingerprint(key) }, { ok: false, latencyMs: 1, httpStatus: 401 });
    }
    const lastResort = store.select("p", KEYS);
    assert.equal(lastResort.slot, 0);
    store.record(lastResort, { ok: true, latencyMs: 1 });
    assert.equal(store.status("p", KEYS).keys[0]?.status.status, "healthy");
    assert.deepEqual(store.usableSlots("p", KEYS), [0]);
  });
});

test("drain retries its first key once per window, so an allowance that reset is spent first again", async () => {
  await withStore((store, path) => {
    store.record(store.select("p", KEYS, { strategy: "drain" }), { ok: false, latencyMs: 1, httpStatus: 402 });
    assert.equal(store.select("p", KEYS, { strategy: "drain" }).slot, 1, "benched inside its window");
    expire(path, KEYS[0] as string);
    const retry = store.select("p", KEYS, { strategy: "drain" });
    assert.equal(retry.slot, 0, "one try after the window");
    store.record(retry, { ok: false, latencyMs: 1, httpStatus: 402 });
    assert.match(String(store.status("p", KEYS).keys[0]?.status.recovers_in), /^6h$/, "the next window is longer");
    assert.equal(store.select("p", KEYS, { strategy: "drain" }).slot, 1);
  });
});

test("out-of-credit wording counts as exhaustion whatever the status code", async () => {
  await withStore((store) => {
    const octen = store.select("p", KEYS, true);
    store.record(octen, { ok: false, latencyMs: 1, httpStatus: 403, exhausted: true });
    assert.equal(store.status("p", KEYS).keys[0]?.status.status, "exhausted");
  });
  assert.equal(isQuotaExhausted(new HttpError('HTTP 403: {"code":403,"msg":"Insufficient balance in account"}', 403)), true);
  assert.equal(isQuotaExhausted(new HttpError('HTTP 429: {"error":"spend_cap_exceeded"}', 429)), true);
  assert.equal(isQuotaExhausted(new Error("This request exceeds your plan's set usage limit. Please upgrade your plan")), true);
  assert.equal(isQuotaExhausted(new Error("Tool 'firecrawl_scrape' execution failed: insufficient_credits")), true);
  assert.equal(isQuotaExhausted(new HttpError("HTTP 429: rate limit exceeded", 429)), false);
  assert.equal(isQuotaExhausted(new HttpError("HTTP 403: invalid api key", 403)), false);
  // Exhaustion moves automatic routes on even though a plain 403 would not.
  assert.equal(shouldFailoverProvider(new HttpError("HTTP 403: Insufficient balance in account", 403)), true);
});

test("a quota reading sinks an empty key and restores a refilled one", async () => {
  await withStore((store) => {
    store.recordQuota("p", KEYS[0] as string, 0);
    assert.equal(store.status("p", KEYS).keys[0]?.status.status, "exhausted");
    assert.equal(store.select("p", KEYS, { strategy: "drain" }).slot, 1, "benched, not retried on every call");
    store.recordQuota("p", KEYS[0] as string, 42);
    const row = store.status("p", KEYS).keys[0]?.status;
    assert.equal(row?.status, "healthy");
    assert.equal(row?.quota_remaining, 42);
    assert.equal(store.select("p", KEYS, { strategy: "drain" }).slot, 0);
    // A balance says nothing about a revoked key.
    store.record(store.select("p", KEYS, { pin: 1 }), { ok: false, latencyMs: 1, httpStatus: 401 });
    store.recordQuota("p", KEYS[1] as string, 10);
    assert.equal(store.status("p", KEYS).keys[1]?.status.status, "disabled");
  });
});

test("reset clears exhaustion", async () => {
  await withStore((store) => {
    store.record(store.select("p", KEYS, true), { ok: false, latencyMs: 1, httpStatus: 402 });
    assert.equal(store.reset("p", KEYS, 0), 1);
    assert.equal(store.status("p", KEYS).keys[0]?.status.status, "healthy");
  });
});

test("callWithRotation drains past an exhausted key to the next one", async () => {
  await withStore(async (store) => {
    const config = pool({ strategy: "drain" });
    const tried: number[] = [];
    const result = await callWithRotation(store, "p", config, { tools: ["t"] }, async (selection) => {
      tried.push(selection.slot);
      if (selection.slot === 0) {
        const error = new HttpError("HTTP 402: Insufficient credit", 402);
        store.record(selection, { ok: false, latencyMs: 1, httpStatus: 402, exhausted: true });
        throw error;
      }
      store.record(selection, { ok: true, latencyMs: 1 });
      return selection.slot;
    });
    assert.equal(result, 1);
    assert.deepEqual(tried, [0, 1]);
    // Later calls go straight to slot 1.
    assert.equal(await callWithRotation(store, "p", config, { tools: ["t"] }, async (selection) => selection.slot), 1);
  });
});

test("a transient failure on a sticky pool retries a different key", async () => {
  await withStore(async (store) => {
    const tried: number[] = [];
    await assert.rejects(callWithRotation(store, "p", pool({ strategy: "sticky" }), { tools: ["t"] }, async (selection) => {
      tried.push(selection.slot);
      throw new HttpError("HTTP 503: unavailable", 503);
    }));
    assert.deepEqual(tried, [0, 1]);
  });
});

test("a plan limit moves to a paid key without benching the free one", async () => {
  await withStore(async (store) => {
    const config = pool({ defaultTier: "free", keyMeta: [{}, {}, { tier: "paid" }] });
    const tried: number[] = [];
    const result = await callWithRotation(store, "p", config, { tools: ["serper_search"] }, async (selection) => {
      tried.push(selection.slot);
      if (selection.slot !== 2) {
        store.record(selection, { ok: false, latencyMs: 1, httpStatus: 400, planLimit: true });
        throw new HttpError('HTTP 400: {"message":"Query pattern not allowed for free accounts."}', 400);
      }
      return "paid";
    });
    assert.equal(result, "paid");
    assert.deepEqual(tried, [0, 2]);
    assert.deepEqual(store.usableSlots("p", KEYS), [0, 1, 2], "the free key stays in rotation");
  });
});

test("with no paid key, a plan limit lets automatic routes move to the next provider", async () => {
  await withStore(async (store) => {
    let calls = 0;
    const error = await callWithRotation(store, "p", pool({ defaultTier: "free" }), { tools: ["serper_search"] }, async () => {
      calls += 1;
      throw new HttpError('HTTP 400: {"message":"Query pattern not allowed for free accounts."}', 400);
    }).catch((caught: unknown) => caught);
    assert.ok(error instanceof PlanLimitError);
    assert.equal(calls, 1);
    assert.equal(isPlanLimit(error), true);
    // Octen gift accounts: a plan limit, not a bad key, so the key keeps serving search.
    assert.equal(isPlanLimit(new HttpError('HTTP 403: {"code":403,"msg":"Payment method required. Please add one to use the API."}', 403)), true);
    assert.equal(shouldFailoverProvider(error), true);
    // A plain 400 still stops the route: another provider would get the same bad request.
    assert.equal(shouldFailoverProvider(new HttpError("HTTP 400: bad request", 400)), false);
  });
});

test("paidTools and per-key tool rules decide which slots a tool may use", async () => {
  const config = pool({
    defaultTier: "free",
    paidTools: ["octen_image_search"],
    keyMeta: [{ tier: "paid" }, { denyTools: ["octen_extract"] }, { allowTools: ["octen_search"] }],
  });
  assert.deepEqual(eligibleSlots(config, ["octen_image_search"]), [0]);
  assert.deepEqual(eligibleSlots(config, ["octen_extract"]), [0]);
  assert.equal(eligibleSlots(config, ["octen_search"]), undefined, "every slot: no restriction");
  await withStore(async (store) => {
    await assert.rejects(
      callWithRotation(store, "p", pool({ defaultTier: "free", paidTools: ["x"] }), { tools: ["x"] }, async () => "never"),
      (error: unknown) => error instanceof CapabilityGateError && /paid tier required/.test(error.message),
    );
    assert.equal(shouldFailoverProvider(new CapabilityGateError("no slot")), true);
  });
});

test("a pinned call uses that slot even when it is benched", async () => {
  await withStore(async (store) => {
    store.record(store.select("p", KEYS, true), { ok: false, latencyMs: 1, httpStatus: 401 });
    assert.equal(await callWithRotation(store, "p", pool(), { tools: ["t"], pin: 0 }, async (selection) => selection.slot), 0);
  });
});
