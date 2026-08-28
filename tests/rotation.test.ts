import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { RotationStore } from "../src/rotation.js";

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
  const dir = mkdtempSync(resolve(tmpdir(), "search-toolkit-health-"));
  try {
    const store = new RotationStore(resolve(dir, "state.db"));
    const keys = ["key-one-123456", "key-two-123456"];
    const disabled = store.select("querit", keys, true);
    store.record(disabled, { ok: false, latencyMs: 10, httpStatus: 401 });
    assert.equal(store.select("querit", keys).slot, 1);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("health-aware rotation fails closed when every key is disabled", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "search-toolkit-disabled-"));
  try {
    const store = new RotationStore(resolve(dir, "state.db"));
    const keys = ["key-one-123456"];
    const disabled = store.select("brave", keys, true);
    store.record(disabled, { ok: false, latencyMs: 10, httpStatus: 403 });
    assert.throws(() => store.select("brave", keys), /no healthy key slots/);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
