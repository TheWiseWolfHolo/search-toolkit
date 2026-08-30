import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createProtocolServer } from "../src/server-factory.js";
import { SearchToolkit } from "../src/toolkit.js";

test("shared MCP server enforces tool input schemas", async () => {
  const directory = mkdtempSync(join(tmpdir(), "search-toolkit-server-"));
  const configPath = join(directory, "providers.json");
  writeFileSync(configPath, JSON.stringify({
    version: 1,
    statePath: join(directory, "state.db"),
    providers: {
      brave: {
        enabled: true,
        automatic: true,
        keys: ["test-key"],
        integration: { kind: "rest", adapter: "brave" },
      },
    },
  }));
  const toolkit = new SearchToolkit(configPath);
  await toolkit.initialize();
  const server = createProtocolServer(toolkit);
  const client = new Client({ name: "search-toolkit-validation-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    for (const arguments_ of [
      {},
      { query: "" },
      { query: "image", limit: "abc" },
      { query: "image", limit: 21 },
      { query: "image", bogusField: true },
    ]) {
      const result = await client.callTool({ name: "search_images", arguments: arguments_ });
      assert.equal(result.isError, true);
      const content = result.content as Array<{ type: string; text?: string }>;
      assert.match(String(content[0]?.text ?? ""), /Invalid arguments for search_images/);
    }
  } finally {
    await client.close();
    await server.close();
    await toolkit.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
