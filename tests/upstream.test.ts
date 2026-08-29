import assert from "node:assert/strict";
import test from "node:test";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  appendRotationMetadata,
  DEFAULT_FIRECRAWL_TOOLS,
  filterUpstreamTools,
  safeToolAnnotations,
} from "../src/upstream.js";
import type { ProviderConfig } from "../src/types.js";

const baseConfig: ProviderConfig = {
  enabled: true,
  automatic: false,
  keys: ["test-key"],
  integration: { kind: "stdio_mcp", command: "npx", args: [], envKey: "KEY" },
};

function tool(name: string, readOnlyHint?: boolean): Tool {
  return {
    name,
    inputSchema: { type: "object" },
    ...(readOnlyHint === undefined ? {} : { annotations: { readOnlyHint } }),
  };
}

test("Firecrawl exposes a safe focused default tool set", () => {
  const catalog = [
    ...DEFAULT_FIRECRAWL_TOOLS.map((name) => tool(name)),
    tool("firecrawl_monitor_create"),
    tool("firecrawl_monitor_delete"),
    tool("firecrawl_agent"),
  ];
  assert.deepEqual(
    filterUpstreamTools("firecrawl", baseConfig, catalog).map((item) => item.name),
    [...DEFAULT_FIRECRAWL_TOOLS],
  );
});

test("tool policy supports explicit full exposure and deny rules", () => {
  const catalog = [tool("firecrawl_scrape"), tool("firecrawl_monitor_delete")];
  const config: ProviderConfig = { ...baseConfig, toolPolicy: { allow: ["*"], deny: ["firecrawl_monitor_delete"] } };
  assert.deepEqual(filterUpstreamTools("firecrawl", config, catalog).map((item) => item.name), ["firecrawl_scrape"]);
});

test("corrects unsafe upstream annotations", () => {
  assert.deepEqual(
    safeToolAnnotations(tool("firecrawl_monitor_delete", true)),
    { readOnlyHint: false, destructiveHint: true },
  );
  assert.deepEqual(
    safeToolAnnotations(tool("firecrawl_monitor_create", true)),
    { readOnlyHint: false, destructiveHint: false },
  );
  assert.deepEqual(
    safeToolAnnotations(tool("firecrawl_crawl", true)),
    { readOnlyHint: false, destructiveHint: false },
  );
  assert.deepEqual(
    safeToolAnnotations(tool("firecrawl_search", false)),
    { readOnlyHint: true, destructiveHint: false },
  );
});

test("classifies hyphenated upstream tool names", () => {
  assert.deepEqual(
    safeToolAnnotations(tool("linkup-search")),
    { readOnlyHint: true, destructiveHint: false },
  );
  assert.deepEqual(
    safeToolAnnotations(tool("linkup-research")),
    { readOnlyHint: false, destructiveHint: false },
  );
  assert.deepEqual(
    safeToolAnnotations(tool("linkup-get-research")),
    { readOnlyHint: true, destructiveHint: false },
  );
  assert.deepEqual(
    safeToolAnnotations(tool("linkup-fetch")),
    { readOnlyHint: true, destructiveHint: false },
  );
  assert.deepEqual(
    safeToolAnnotations(tool("anysearch-extract")),
    { readOnlyHint: true, destructiveHint: false },
  );
  assert.deepEqual(
    safeToolAnnotations(tool("linkup-delete-cache")),
    { readOnlyHint: false, destructiveHint: true },
  );
});

test("upstream direct results expose route provenance to models", () => {
  const output = appendRotationMetadata(
    {
      content: [{ type: "text", text: "result body" }],
      _meta: { upstream: "preserved" },
    },
    "linkup",
    "linkup-search",
    "masked",
    12,
  ) as Record<string, unknown>;
  const content = output.content as Array<{ type: string; text: string }>;
  assert.deepEqual(JSON.parse(content[0]?.text ?? "{}"), {
    searchToolkitRoute: {
      provider: "linkup",
      tool: "linkup_linkup_search",
      upstreamTool: "linkup-search",
    },
  });
  assert.equal(content[1]?.text, "result body");
  assert.deepEqual(output._meta, {
    upstream: "preserved",
    searchToolkit: {
      provider: "linkup",
      upstreamTool: "linkup-search",
      keySlot: "masked",
      latencyMs: 12,
      route: {
        provider: "linkup",
        tool: "linkup_linkup_search",
        upstreamTool: "linkup-search",
      },
    },
  });
});
