import assert from "node:assert/strict";
import test from "node:test";
import { attachRouteMetadata, autoCandidates, filterBindings } from "../src/toolkit.js";
import type { ProviderConfig, ToolBinding } from "../src/types.js";

const binding: ToolBinding = {
  provider: "exa",
  upstreamName: "web_search_exa",
  exposed: { name: "exa_web_search_exa", inputSchema: { type: "object" } },
  call: async () => ({}),
};

test("search_auto results preserve content and expose an auditable route", () => {
  const output = attachRouteMetadata(binding, {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          searchToolkitRoute: {
            provider: "exa",
            tool: "exa_web_search_exa",
            upstreamTool: "web_search_exa",
          },
        }),
      },
      { type: "text", text: "result body" },
    ],
    structuredContent: { items: [1] },
    _meta: { searchToolkit: { keySlot: "masked" } },
  }) as Record<string, unknown>;
  assert.deepEqual(output.structuredContent, {
    route: { provider: "exa", tool: "exa_web_search_exa", upstreamTool: "web_search_exa" },
    result: { items: [1] },
  });
  assert.deepEqual((output._meta as Record<string, unknown>).searchToolkit, {
    keySlot: "masked",
    route: { provider: "exa", tool: "exa_web_search_exa", upstreamTool: "web_search_exa" },
  });
  assert.equal((output.content as Array<{ text: string }>).length, 2);
  assert.equal((output.content as Array<{ text: string }>)[1]?.text, "result body");
});

test("provider tool policies also filter REST bindings", () => {
  const config: ProviderConfig = {
    enabled: true,
    automatic: true,
    keys: ["key"],
    integration: { kind: "rest", adapter: "brave" },
    toolPolicy: { allow: ["brave_web_search"], deny: [] },
  };
  const news: ToolBinding = {
    ...binding,
    provider: "brave",
    upstreamName: "brave_news_search",
    exposed: { name: "brave_news_search", inputSchema: { type: "object" } },
  };
  const web: ToolBinding = {
    ...binding,
    provider: "brave",
    upstreamName: "brave_web_search",
    exposed: { name: "brave_web_search", inputSchema: { type: "object" } },
  };
  assert.deepEqual(filterBindings(config, [web, news]).map((item) => item.exposed.name), ["brave_web_search"]);
});

test("automatic route profiles keep their intentional provider order", () => {
  assert.deepEqual(autoCandidates("general", "balanced").map((item) => item.name), [
    "parallel_search", "you_search", "brave_web_search", "exa_web_search_exa", "querit_search", "tavily_tavily_search",
  ]);
  assert.equal(autoCandidates("general", "max")[0]?.nativeArguments?.mode, "advanced");
  assert.equal(autoCandidates("exact", "balanced")[0]?.name, "exa_web_search_exa");
  assert.equal(autoCandidates("exact", "max")[0]?.name, "exa_web_search_advanced_exa");
  assert.deepEqual(autoCandidates("context", "balanced").map((item) => item.name), [
    "brave_llm_context", "parallel_search", "you_search", "tavily_tavily_search",
  ]);
  assert.equal(autoCandidates("context", "max")[0]?.nativeArguments?.mode, "advanced");
  assert.deepEqual(autoCandidates("current", "balanced")[2]?.nativeArguments, { search_depth: "basic" });
  assert.equal(autoCandidates("official", "balanced")[0]?.name, "serper_search");
});
