import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RestProvider, searchTool, type RestAdapter } from "../src/rest/base.js";
import { RotationStore } from "../src/rotation.js";
import type { ProviderConfig } from "../src/types.js";

test("REST direct results expose the same route provenance shape", async () => {
  const directory = mkdtempSync(join(tmpdir(), "search-toolkit-rest-"));
  const rotation = new RotationStore(join(directory, "state.db"));
  const config: ProviderConfig = {
    enabled: true,
    automatic: true,
    keys: ["test-key"],
    integration: { kind: "rest", adapter: "brave" },
  };
  const adapter: RestAdapter = {
    tools: () => [searchTool("brave_web_search", "Brave", "Search")],
    call: async () => ({ results: [{ url: "https://example.com" }] }),
  };
  try {
    const provider = new RestProvider("brave", config, rotation, adapter);
    const binding = provider.bindings()[0];
    assert.ok(binding);
    const output = await binding.call({ query: "example" }) as Record<string, unknown>;
    const expectedRoute = {
      provider: "brave",
      tool: "brave_web_search",
      upstreamTool: "brave_web_search",
    };
    assert.deepEqual((output.structuredContent as Record<string, unknown>).route, expectedRoute);
    assert.deepEqual(
      ((output._meta as Record<string, unknown>).searchToolkit as Record<string, unknown>).route,
      expectedRoute,
    );
    const content = output.content as Array<{ text: string }>;
    assert.deepEqual(JSON.parse(content[0]?.text ?? "{}").route, expectedRoute);
  } finally {
    rotation.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
