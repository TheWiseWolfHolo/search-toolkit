import assert from "node:assert/strict";
import test from "node:test";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { canonicalUrl, mergeItems } from "../src/merge.js";
import { renderPayload } from "../src/render.js";
import { BraveAdapter, ParallelAdapter, SerperAdapter, YouAdapter } from "../src/rest/adapters.js";
import { cleanHighlightText, pickDate } from "../src/rest/normalize.js";
import { shapeTool, trimText } from "../src/shape.js";
import { truncateBody } from "../src/toolkit.js";

function stubFetch(body: unknown) {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  return () => { globalThis.fetch = original; };
}

test("items render as compact numbered text with dates and indented excerpts", () => {
  const text = renderPayload({
    items: [
      { title: "First", url: "https://a.example/1", text: "alpha\nbeta", date: "2026-09-30" },
      { title: "", url: "https://b.example/2", text: "" },
    ],
  });
  assert.equal(text, [
    "1. First (2026-09-30)",
    "   https://a.example/1",
    "   alpha",
    "   beta",
    "2. https://b.example/2",
  ].join("\n"));
  assert.equal(renderPayload({ items: [] }), "No results.");
});

test("image items keep original URL, thumbnail, dimensions and source page", () => {
  const text = renderPayload({
    items: [{
      title: "Cat", url: "https://site.example/page", text: "ignored", imageUrl: "https://cdn.example/cat.jpg",
      thumbnailUrl: "https://cdn.example/cat-t.jpg", width: 800, height: 600, source: "Site",
    }],
  });
  assert.match(text, /image: https:\/\/cdn\.example\/cat\.jpg \(800×600\)/);
  assert.match(text, /thumbnail: https:\/\/cdn\.example\/cat-t\.jpg/);
  assert.match(text, /page: https:\/\/site\.example\/page/);
  assert.match(text, /source: Site/);
});

test("Brave LLM Context renders grounding per source instead of dumping JSON", () => {
  const text = renderPayload({
    grounding: { generic: [{ url: "https://docs.example/a", title: "Docs", snippets: ["one", "two"] }] },
    sources: { "https://docs.example/a": { title: "Docs", hostname: "docs.example", age: ["Monday", "2026-05-11", "351 days ago"] } },
  });
  assert.equal(text, "### Docs (docs.example, 2026-05-11)\nhttps://docs.example/a\n- one\n- two");
  assert.equal(renderPayload({ grounding: { generic: [] } }), "No grounding results.");
});

test("a Grok answer renders text followed by de-duplicated sources", () => {
  const text = renderPayload({
    text: "The answer.",
    citations: ["https://x.example/a", { url: "https://x.example/a" }, { url: "https://y.example/b", title: "Why" }],
  });
  assert.equal(text, "The answer.\n\nSources:\n1. https://x.example/a\n2. Why — https://y.example/b");
});

test("unknown payload shapes fall back to compact JSON", () => {
  assert.equal(renderPayload({ odd: 1 }), '{"odd":1}');
});

test("highlight markup and entities are cleaned from Brave text", () => {
  assert.equal(cleanHighlightText("A <strong>bold</strong> &amp; it&#x27;s &quot;fine&quot; &lt;ok&gt;"), 'A bold & it\'s "fine" <ok>');
  assert.equal(pickDate({ page_age: "2026-09-28T10:00:00", age: "2 days ago" }), "2026-09-28");
  assert.equal(pickDate({ age: "2 days ago" }), "2 days ago");
  assert.equal(pickDate({ title: "x" }), undefined);
});

test("search adapters keep publication dates and Brave text is cleaned", async () => {
  let restore = stubFetch({
    web: { results: [{ title: "T <strong>x</strong>", url: "https://a.example", description: "Say <strong>hi</strong> &amp; bye", page_age: "2026-09-28T10:00:00", age: "2 days ago" }] },
  });
  try {
    const brave = await new BraveAdapter().call("brave_web_search", { query: "q" }, "k") as { items: Array<Record<string, string>> };
    assert.deepEqual(brave.items[0], { title: "T x", url: "https://a.example", text: "Say hi & bye", date: "2026-09-28" });
  } finally { restore(); }

  restore = stubFetch({ news: [{ title: "N", link: "https://n.example", snippet: "s", date: "2 hours ago" }] });
  try {
    const serper = await new SerperAdapter().call("serper_news", { query: "q" }, "k") as { items: Array<Record<string, string>> };
    assert.equal(serper.items[0]?.date, "2 hours ago");
  } finally { restore(); }

  restore = stubFetch({ results: [{ url: "https://p.example", title: "P", excerpts: ["e"], publish_date: "2026-08-01" }] });
  try {
    const parallel = await new ParallelAdapter().call("parallel_search", { query: "q" }, "k", {
      enabled: true, auto: [], keys: ["k"], integration: { kind: "rest", adapter: "parallel" },
    }) as { items: Array<Record<string, string>> };
    assert.equal(parallel.items[0]?.date, "2026-08-01");
  } finally { restore(); }

  restore = stubFetch({ results: { web: [{ title: "W", url: "https://w.example", snippets: ["s"], page_age: "2026-09-01T00:00:00Z" }], news: [] } });
  try {
    const you = await new YouAdapter().call("you_search", { query: "q" }, "k", {
      enabled: true, auto: [], keys: ["k"], integration: { kind: "rest", adapter: "you" },
    }) as { items: Array<Record<string, string>> };
    assert.equal(you.items[0]?.date, "2026-09-01");
  } finally { restore(); }
});

test("canonical URLs ignore scheme, www, fragments, trailing slashes and tracking parameters", () => {
  assert.equal(canonicalUrl("https://www.Example.com/a/?utm_source=x&b=2&a=1#frag"), "example.com/a?a=1&b=2");
  assert.equal(canonicalUrl("http://example.com/a"), "example.com/a");
  assert.equal(canonicalUrl("not a url"), "not a url");
});

test("merged results put corroborated URLs first, then interleave by rank", () => {
  const merged = mergeItems([
    { provider: "brave", items: [
      { title: "B1", url: "https://one.example/", text: "short" },
      { title: "B2", url: "https://two.example/x", text: "b" },
      { title: "B3", url: "https://shared.example/p?utm_source=a", text: "from brave, longer text here" },
    ] },
    { provider: "parallel", items: [
      { title: "P1", url: "https://three.example/", text: "p" },
      { title: "P2", url: "https://www.shared.example/p/", text: "tiny", date: "2026-09-01" },
    ] },
  ], 4);
  assert.deepEqual(merged.map((item) => item.url), [
    "https://www.shared.example/p/", "https://one.example/", "https://three.example/", "https://two.example/x",
  ]);
  assert.deepEqual(merged[0]?.foundBy, ["parallel", "brave"]);
  assert.equal(merged[0]?.text, "from brave, longer text here");
  assert.equal(merged[0]?.date, "2026-09-01");
  assert.match(renderPayload({ items: merged }), /found by: parallel, brave/);
});

test("shaping trims descriptions at natural boundaries and leaves schemas functionally intact", () => {
  const paragraph = "First paragraph explains the tool.\n\n";
  const tool: Tool = {
    name: "t",
    description: paragraph + "Second paragraph. ".repeat(200),
    inputSchema: {
      type: "object",
      $schema: "http://json-schema.org/draft-07/schema#",
      properties: {
        mode: { type: "string", enum: ["a", "b"], default: "a", description: "d".repeat(500) },
        nested: { type: "object", properties: { deep: { type: "number", description: "e".repeat(500) } }, required: ["deep"] },
      },
      required: ["mode"],
    } as Tool["inputSchema"],
  };
  const shaped = shapeTool(tool, { maxDescriptionChars: 100, maxParamDescriptionChars: 50 });
  assert.ok((shaped.description ?? "").length <= 102);
  assert.ok((shaped.description ?? "").startsWith("First paragraph explains the tool."));
  const schema = shaped.inputSchema as unknown as { $schema?: string; properties: Record<string, { description: string; enum?: string[]; default?: string; properties?: Record<string, { description: string }> }>; required: string[] };
  assert.equal("$schema" in schema, false);
  assert.deepEqual(schema.properties.mode?.enum, ["a", "b"]);
  assert.equal(schema.properties.mode?.default, "a");
  assert.ok((schema.properties.mode?.description ?? "").length <= 52);
  assert.ok((schema.properties.nested?.properties?.deep?.description ?? "").length <= 52);
  assert.deepEqual(schema.required, ["mode"]);
  assert.equal(shapeTool(tool, {}, "override").description, "override");
  assert.equal(shapeTool(tool, { maxDescriptionChars: 0, maxParamDescriptionChars: 0 }).description, tool.description);
  assert.equal(trimText("short", 100), "short");
});

test("truncation keeps the route block and reports what was dropped", () => {
  const output = truncateBody({
    content: [
      { type: "text", text: JSON.stringify({ searchToolkitRoute: { provider: "exa", tool: "t", upstreamTool: "t" } }) },
      { type: "text", text: "a".repeat(600) },
      { type: "image", data: "xx", mimeType: "image/png" },
    ],
  }, 500) as { content: Array<{ type: string; text?: string }> };
  assert.match(content(output, 0), /searchToolkitRoute/);
  assert.equal(content(output, 1).length, 500);
  assert.equal(output.content[2]?.type, "image");
  assert.match(content(output, 3), /truncated: 100 more characters/);
  const intact = truncateBody({ content: [{ type: "text", text: "hello" }] }, 500) as { content: unknown[] };
  assert.equal(intact.content.length, 1);
});

function content(output: { content: Array<{ text?: string }> }, index: number): string {
  return output.content[index]?.text ?? "";
}
