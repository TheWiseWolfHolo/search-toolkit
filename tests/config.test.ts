import assert from "node:assert/strict";
import test from "node:test";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { defaultConfigPath, exampleConfigPath, migrateConfig, normalizeConfig, readConfigFile, validateConfig } from "../src/config.js";
import type { ToolkitConfig } from "../src/types.js";

function config(keys: string[]): ToolkitConfig {
  return {
    version: 2,
    statePath: "state.db",
    providers: {
      querit: {
        enabled: true,
        auto: ["search"],
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

test("v1 configs load with automatic/manualOnly translated to capabilities", () => {
  const { config, notes } = normalizeConfig({
    version: 1,
    statePath: "state.db",
    providers: {
      brave: { enabled: true, automatic: true, keys: ["k"], integration: { kind: "rest", adapter: "brave" } },
      doubao: { enabled: true, automatic: true, manualOnly: true, keys: ["k"], integration: { kind: "rest", adapter: "doubao" } },
      exa: { enabled: true, automatic: true, keys: ["k"], integration: { kind: "remote_mcp", url: "https://example.com", auth: { kind: "none" } } },
      firecrawl: { enabled: true, automatic: false, keys: ["k"], integration: { kind: "stdio_mcp", command: "npx", args: [], envKey: "K" } },
      linkup: { enabled: true, automatic: false, keys: ["k"], integration: { kind: "remote_mcp", url: "https://example.com", auth: { kind: "none" } } },
    },
  });
  assert.equal(config.version, 2);
  assert.deepEqual(config.providers.brave?.auto, ["search", "images"]);
  assert.deepEqual(config.providers.doubao?.auto, []);
  assert.deepEqual(config.providers.exa?.auto, ["search", "images", "fetch"]);
  assert.deepEqual(config.providers.firecrawl?.auto, ["fetch"]);
  assert.deepEqual(config.providers.linkup?.auto, []);
  assert.ok(notes.some((note) => /v1 format/.test(note)));
});

test("v2 configs require explicit, valid auto capabilities", () => {
  const base = { version: 2, statePath: "state.db" };
  const brave = { enabled: true, keys: ["k"], integration: { kind: "rest", adapter: "brave" } };
  assert.throws(() => normalizeConfig({ ...base, providers: { brave } }), /auto must be an array/);
  assert.throws(() => normalizeConfig({ ...base, providers: { brave: { ...brave, auto: ["browse"] } } }), /auto must be an array/);
  assert.deepEqual(normalizeConfig({ ...base, providers: { brave: { ...brave, auto: ["search"] } } }).config.providers.brave?.auto, ["search"]);
});

test("migration drops options no adapter reads and keeps Grok's", () => {
  const raw = {
    version: 1,
    statePath: "state.db",
    providers: {
      serper: { enabled: true, automatic: true, keys: ["k"], integration: { kind: "rest", adapter: "serper" }, options: { gl: "", page: 1 } },
      grok: {
        enabled: true, automatic: false, keys: ["k"], integration: { kind: "rest", adapter: "grok" },
        options: { model: "grok-x", systemPrompt: "be brief", legacy: true },
      },
      bogus: { enabled: false, automatic: false, keys: [], integration: { kind: "rest", adapter: "jina" }, extra: 1 },
    },
  };
  const { document, changes } = migrateConfig(raw);
  const providers = document.providers as Record<string, Record<string, unknown>>;
  assert.equal(document.version, 2);
  assert.equal("options" in (providers.serper ?? {}), false);
  assert.deepEqual((providers.grok?.options as Record<string, unknown>).model, "grok-x");
  assert.equal("extra" in (providers.bogus ?? {}), false);
  assert.ok(changes.some((change) => change.includes("serper.options")));
  assert.ok(changes.some((change) => change.includes("bogus.extra")));
  // The migrated document must itself be a valid, note-free v2 config.
  assert.deepEqual(normalizeConfig(document).notes.filter((note) => !note.startsWith("grok.options")), []);
});

test("the shipped example config is a clean v2 document", () => {
  const { config, notes } = normalizeConfig(readConfigFile(exampleConfigPath()));
  assert.deepEqual(notes, []);
  assert.equal(config.version, 2);
  assert.deepEqual(config.providers.doubao?.auto, []);
  assert.ok(config.providers.firecrawl?.auto.includes("fetch"));
  assert.equal(typeof config.providers.anysearch?.toolPolicy?.descriptions?.search, "string");
});
