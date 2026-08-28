import assert from "node:assert/strict";
import test from "node:test";
import { validateConfig } from "../src/config.js";
import type { ToolkitConfig } from "../src/types.js";

function config(keys: string[]): ToolkitConfig {
  return {
    version: 1,
    statePath: "state.db",
    providers: {
      querit: {
        enabled: true,
        automatic: true,
        keys,
        integration: { kind: "rest", adapter: "querit" },
      },
    },
  };
}

test("validates a provider key pool", () => {
  assert.doesNotThrow(() => validateConfig(config(["one", "two"])));
});

test("rejects duplicate or blank keys", () => {
  assert.throws(() => validateConfig(config(["same", "same"])), /duplicates/);
  assert.throws(() => validateConfig(config(["ok", ""])), /blanks/);
});
