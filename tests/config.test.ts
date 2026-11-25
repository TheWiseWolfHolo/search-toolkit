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

test("uses a non-virtualized shared config path on Windows", (t) => {
  if (process.platform !== "win32" || process.env.SEARCH_TOOLKIT_CONFIG) {
    t.skip("Windows default path check applies only on win32 without SEARCH_TOOLKIT_CONFIG");
    return;
  }
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

test("statePath expands ~/ and resolves relative paths against baseDir", () => {
  const base = {
    version: 2,
    providers: {
      brave: { enabled: true, auto: ["search"], keys: ["k1"], integration: { kind: "rest", adapter: "brave" } },
    },
  };
  const tildeLoaded = normalizeConfig({ ...base, statePath: "~/search-toolkit-test/state.db" });
  assert.equal(tildeLoaded.config.statePath, resolve(homedir(), "search-toolkit-test/state.db"));

  const baseDir = resolve(homedir(), "st-base-dir");
  const relLoaded = normalizeConfig({ ...base, statePath: "data/state.db" }, baseDir);
  assert.equal(relLoaded.config.statePath, resolve(baseDir, "data/state.db"));
});

test("rejects unknown toolPolicy keys and warns on unknown top-level config fields", () => {
  const withBadPolicy = {
    version: 2,
    statePath: "state.db",
    providers: {
      querit: {
        enabled: true,
        auto: ["search"],
        keys: ["k1"],
        integration: { kind: "rest", adapter: "querit" },
        toolPolicy: { allows: ["querit_search"] },
      },
    },
  };
  assert.throws(
    () => normalizeConfig(withBadPolicy),
    /toolPolicy\.allows is not a recognised field \(expected allow, deny, or descriptions\)/,
  );

  const withUnknownTop = {
    version: 2,
    statePath: "state.db",
    extraSetting: true,
    providers: {
      querit: { enabled: true, auto: ["search"], keys: ["k1"], integration: { kind: "rest", adapter: "querit" } },
    },
  };
  const { notes } = normalizeConfig(withUnknownTop);
  assert.ok(notes.some((note) => note.includes("config.extraSetting is not a recognised field")));
});

test("disabled providers allow blank placeholder keys while still rejecting duplicate non-blank keys", () => {
  const withBlanks = {
    version: 2,
    statePath: "state.db",
    providers: {
      brave: { enabled: false, auto: ["search"], keys: ["", "   "], integration: { kind: "rest", adapter: "brave" } },
    },
  };
  assert.doesNotThrow(() => normalizeConfig(withBlanks));

  const withDups = {
    version: 2,
    statePath: "state.db",
    providers: {
      brave: { enabled: false, auto: ["search"], keys: ["", "dup-key", "dup-key"], integration: { kind: "rest", adapter: "brave" } },
    },
  };
  assert.throws(() => normalizeConfig(withDups), /brave\.keys contains duplicates/);
});

test("migrateConfig preserves unresolvable env:/file: refs on enabled providers and keeps raw statePath", () => {
  const raw = {
    version: 1,
    statePath: "~/portable/state.db",
    providers: {
      brave: {
        enabled: true,
        automatic: true,
        keys: [
          "env:SEARCH_TOOLKIT_UNSET_PORTABLE_KEY_999",
          { key: "file:/nonexistent/portable-secret.txt", tier: "paid", label: "vault" },
        ],
        integration: { kind: "rest", adapter: "brave" },
      },
    },
  };
  const { document, changes } = migrateConfig(raw, resolve(homedir(), "some-dir"));
  assert.equal(document.version, 2);
  assert.equal(document.statePath, "~/portable/state.db");
  const providers = document.providers as Record<string, { keys: unknown[] }>;
  assert.deepEqual(providers.brave?.keys, [
    "env:SEARCH_TOOLKIT_UNSET_PORTABLE_KEY_999",
    { key: "file:/nonexistent/portable-secret.txt", tier: "paid", label: "vault" },
  ]);
  assert.ok(changes.length >= 1);
});

test("validates grok customUrl, cache bounds, and MCP integration settings", () => {
  const make = (overrides: Record<string, unknown>) => ({
    version: 2,
    statePath: "state.db",
    providers: {
      grok: { enabled: true, auto: [], keys: ["k1"], integration: { kind: "rest", adapter: "grok" } },
    },
    ...overrides,
  });

  assert.throws(
    () => normalizeConfig(make({
      providers: {
        grok: {
          enabled: true,
          auto: [],
          keys: ["k1"],
          integration: { kind: "rest", adapter: "grok" },
          options: { customUrl: "ftp://bad.example/v1" },
        },
      },
    })),
    /grok\.options\.customUrl must be a valid http\(s\) URL/,
  );
  assert.doesNotThrow(() => normalizeConfig(make({
    providers: {
      grok: {
        enabled: true,
        auto: [],
        keys: ["k1"],
        integration: { kind: "rest", adapter: "grok" },
        options: { customUrl: "https://api.x.ai/v1/responses" },
      },
    },
  })));

  assert.throws(() => normalizeConfig(make({ cache: { maxEntries: -1 } })), /cache\.maxEntries/);
  assert.throws(() => normalizeConfig(make({ cache: { maxTotalBytes: 2_000_000_000 } })), /cache\.maxTotalBytes/);

  assert.throws(
    () => normalizeConfig(make({
      providers: {
        exa: {
          enabled: true,
          auto: ["search"],
          keys: ["k1"],
          integration: { kind: "remote_mcp", url: "https://mcp.exa.ai/mcp", auth: { kind: "bearer" }, headers: { "X-Bad": "a\nb" } },
        },
      },
    })),
    /must not contain newline/,
  );
  assert.throws(
    () => normalizeConfig(make({
      providers: {
        exa: {
          enabled: true,
          auto: ["search"],
          keys: ["k1"],
          integration: { kind: "remote_mcp", url: "https://mcp.exa.ai/mcp", auth: { kind: "bearer" }, timeoutMs: 500 },
        },
      },
    })),
    /timeoutMs must be an integer from 1000 to 300000/,
  );
  assert.throws(
    () => normalizeConfig(make({
      providers: {
        fc: {
          enabled: true,
          auto: ["fetch"],
          keys: ["k1"],
          integration: { kind: "stdio_mcp", command: "node", args: [], envKey: "FC_KEY", idleTimeoutMs: -5 },
        },
      },
    })),
    /idleTimeoutMs must be an integer from 0 to 86400000/,
  );
  assert.throws(
    () => normalizeConfig(make({
      providers: {
        fc: {
          enabled: true,
          auto: ["fetch"],
          keys: ["k1"],
          integration: { kind: "stdio_mcp", command: "node", args: [], envKey: "FC_KEY", env: { BAD: 123 } },
        },
      },
    })),
    /integration\.env\.BAD must be a string/,
  );

  // direct_markdown.options.allowedPorts and tinyfish.options.{searchBaseUrl,fetchBaseUrl}
  const dmOk = normalizeConfig({
    version: 2,
    statePath: "state.db",
    providers: {
      direct_markdown: {
        enabled: true,
        auto: ["fetch"],
        keys: [],
        integration: { kind: "rest", adapter: "direct_markdown" },
        options: { allowedPorts: [8080, 8443] },
      },
      tinyfish: {
        enabled: true,
        auto: ["search", "fetch"],
        keys: ["tf-key"],
        integration: { kind: "rest", adapter: "tinyfish" },
        options: { searchBaseUrl: "https://search.tinyfish.example/v1", fetchBaseUrl: "https://fetch.tinyfish.example" },
      },
    },
  });
  assert.deepEqual(dmOk.notes, []);
  assert.deepEqual(dmOk.config.providers.direct_markdown?.options?.allowedPorts, [8080, 8443]);

  assert.throws(
    () => normalizeConfig({
      version: 2,
      statePath: "state.db",
      providers: {
        direct_markdown: {
          enabled: true,
          auto: ["fetch"],
          keys: [],
          integration: { kind: "rest", adapter: "direct_markdown" },
          options: { allowedPorts: [0] },
        },
      },
    }),
    /allowedPorts must be an array of integer ports from 1 to 65535/,
  );
  assert.throws(
    () => normalizeConfig({
      version: 2,
      statePath: "state.db",
      providers: {
        tinyfish: {
          enabled: true,
          auto: ["search"],
          keys: ["tf-key"],
          integration: { kind: "rest", adapter: "tinyfish" },
          options: { searchBaseUrl: "ftp://bad.example" },
        },
      },
    }),
    /tinyfish\.options\.searchBaseUrl must be a valid http\(s\) URL/,
  );
  assert.throws(
    () => normalizeConfig({
      version: 2,
      statePath: "state.db",
      providers: {
        tinyfish: {
          enabled: true,
          auto: ["fetch"],
          keys: ["tf-key"],
          integration: { kind: "rest", adapter: "tinyfish" },
          options: { fetchBaseUrl: "not-a-url" },
        },
      },
    }),
    /tinyfish\.options\.fetchBaseUrl must be a valid http\(s\) URL/,
  );
});
