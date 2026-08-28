import assert from "node:assert/strict";
import test from "node:test";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { defaultConfigPath, validateConfig } from "../src/config.js";
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

test("validates provider tool policies", () => {
  const value = config(["one"]);
  const provider = value.providers.querit;
  assert.ok(provider);
  provider.toolPolicy = { allow: ["querit_search"], deny: ["legacy_tool"] };
  assert.doesNotThrow(() => validateConfig(value));
  provider.toolPolicy.allow = ["querit_search", "querit_search"];
  assert.throws(() => validateConfig(value), /toolPolicy\.allow contains duplicates/);
});

test("uses a non-virtualized shared config path on Windows", () => {
  if (process.platform !== "win32" || process.env.SEARCH_TOOLKIT_CONFIG) return;
  assert.equal(defaultConfigPath(), resolve(homedir(), ".config/search-toolkit/providers.json"));
});
