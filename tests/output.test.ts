import assert from "node:assert/strict";
import test from "node:test";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { canonicalUrl, dedupeItems, mergeItems, nearDuplicateKey } from "../src/merge.js";
import { renderPayload } from "../src/render.js";
import { BraveAdapter, ParallelAdapter, SerperAdapter, YouAdapter } from "../src/rest/adapters.js";
import { cleanHighlightText, extractUpstreamSearchItems, pickDate } from "../src/rest/normalize.js";
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

test("canonical URLs ignore scheme, www, fragments, trailing slashes, doc suffixes and tracking parameters", () => {
  assert.equal(canonicalUrl("https://www.Example.com/a/?utm_source=x&b=2&a=1#frag"), "example.com/a?a=1&b=2");
  assert.equal(canonicalUrl("http://example.com/a"), "example.com/a");
  assert.equal(canonicalUrl("https://docs.example.com/guide/intro.md"), "docs.example.com/guide/intro");
  assert.equal(canonicalUrl("https://docs.example.com/guide/intro.html"), "docs.example.com/guide/intro");
  assert.equal(canonicalUrl("https://docs.example.com/guide/index.html"), "docs.example.com/guide");
  assert.equal(canonicalUrl("not a url"), "not a url");
});

test("dedupeItems collapses duplicate URLs from a single provider while preferring clean URLs and richer excerpts", () => {
  const deduped = dedupeItems([
    { title: "Spec", url: "https://modelcontextprotocol.io/specification/2025-11-25.md", text: "short" },
    { title: "Spec Full", url: "https://modelcontextprotocol.io/specification/2025-11-25", text: "much richer excerpt from the canonical page", date: "2025-11-25" },
    { title: "Other", url: "https://example.com/other", text: "other" },
  ]);
  assert.equal(deduped.length, 2);
  assert.equal(deduped[0]?.url, "https://modelcontextprotocol.io/specification/2025-11-25");
  assert.equal(deduped[0]?.text, "much richer excerpt from the canonical page");
  assert.equal(deduped[0]?.date, "2025-11-25");
});

test("renderPayload caps per-item excerpt length when maxCharsPerItem is set", () => {
  const text = renderPayload({
    items: [{
      title: "Long",
      url: "https://example.com/long",
      text: `${"First sentence is concise. ".repeat(5)}${"More details follow here. ".repeat(20)}`,
    }],
  }, { maxCharsPerItem: 120 });
  assert.ok(text.length < 200);
  assert.match(text, /1\. Long/);
  assert.match(text, /First sentence is concise\./);
});

test("extractUpstreamSearchItems normalizes Exa text blocks and JSON search payloads", () => {
  const exaItems = extractUpstreamSearchItems("web_search_exa", {
    content: [{
      type: "text",
      text: [
        "Title: Specification - Model Context Protocol",
        "URL: https://modelcontextprotocol.io/specification/2025-11-25",
        "Published Date: 2025-11-25T00:00:00.000Z",
        "Highlights: The Model Context Protocol (MCP) is an open protocol.",
        "",
        "Title: Transports",
        "URL: https://modelcontextprotocol.io/specification/2025-11-25/basic/transports",
        "Text: MCP supports stdio and Streamable HTTP transports.",
      ].join("\n"),
    }],
  });
  assert.equal(exaItems?.length, 2);
  assert.deepEqual(exaItems?.[0], {
    title: "Specification - Model Context Protocol",
    url: "https://modelcontextprotocol.io/specification/2025-11-25",
    text: "The Model Context Protocol (MCP) is an open protocol.",
    date: "2025-11-25",
  });
  assert.equal(exaItems?.[1]?.title, "Transports");

  const tavilyItems = extractUpstreamSearchItems("tavily_search", {
    content: [{
      type: "text",
      text: JSON.stringify({
        results: [
          { title: "Tavily Hit", url: "https://tavily.example/hit", content: "Tavily snippet", published_date: "2026-10-01" },
        ],
      }),
    }],
  });
  assert.deepEqual(tavilyItems, [
    { title: "Tavily Hit", url: "https://tavily.example/hit", text: "Tavily snippet", date: "2026-10-01" },
  ]);
  assert.equal(extractUpstreamSearchItems("web_fetch_exa", { content: [{ type: "text", text: "Title: X\nURL: https://x.com" }] }), undefined);
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

test("truncation keeps the route block, supports offset pagination and section extraction", () => {
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

  const paged = truncateBody({
    content: [{ type: "text", text: "0123456789abcdefghij" }],
  }, 6, { offset: 10 }) as { content: Array<{ text?: string }> };
  assert.equal(content(paged, 0), "abcdef");
  assert.match(content(paged, 1), /truncated: 4 more characters; pass offset=16/);

  const sectioned = truncateBody({
    content: [{
      type: "text",
      text: "# Intro\nWelcome.\n\n## Rate Limits\n100 requests per minute.\n\n### Burst\nUp to 20 rps.\n\n## Auth\nUse Bearer tokens.",
    }],
  }, 500, { section: "Rate Limits" }) as { content: Array<{ text?: string }> };
  assert.equal(content(sectioned, 0), "## Rate Limits\n100 requests per minute.\n\n### Burst\nUp to 20 rps.");
});

function content(output: { content: Array<{ text?: string }> }, index: number): string {
  return output.content[index]?.text ?? "";
}

test("canonicalUrl preserves non-default ports, strips /index.md, and sorts repeated query params deterministically", () => {
  assert.equal(canonicalUrl("https://docs.example.com:8443/guide/"), "docs.example.com:8443/guide");
  assert.equal(canonicalUrl("https://docs.example.com:443/guide/"), "docs.example.com/guide");
  assert.notEqual(canonicalUrl("https://docs.example.com:8443/guide"), canonicalUrl("https://docs.example.com/guide"));
  assert.equal(canonicalUrl("https://docs.example.com/guide/index.md"), "docs.example.com/guide");
  assert.equal(canonicalUrl("https://example.com/s?tag=b&tag=a&utm_source=x"), "example.com/s?tag=a&tag=b");
  assert.equal(canonicalUrl("https://example.com/s?tag=a&tag=b"), "example.com/s?tag=a&tag=b");
});

test("nearDuplicateKey preserves major versions, path versions, and generic site titles while dedupeItems pass 2 merges richer fields", () => {
  // Different major versions stay distinct; minor/patch releases within the same major version collapse.
  assert.notEqual(
    nearDuplicateKey({ title: "SQLite | Node.js v20.1.0 Documentation", url: "https://nodejs.org/dist/v20.1.0/docs/api/sqlite.html" }),
    nearDuplicateKey({ title: "SQLite | Node.js v24.1.0 Documentation", url: "https://nodejs.org/dist/v24.1.0/docs/api/sqlite.html" }),
  );
  const deduped = dedupeItems([
    { title: "SQLite | Node.js v24.13.1 Documentation", url: "https://nodejs.org/dist/v24.13.1/docs/api/sqlite.md", text: "short" },
    { title: "SQLite | Node.js v24.17.0 Documentation", url: "https://nodejs.org/dist/v24.17.0/docs/api/sqlite.html", text: "much richer sqlite documentation excerpt", date: "2026-09-10" },
    { title: "SQLite | Node.js v20.1.0 Documentation", url: "https://nodejs.org/dist/v20.1.0/docs/api/sqlite.html", text: "v20 docs" },
  ]);
  assert.equal(deduped.length, 2);
  assert.equal(deduped[0]?.url, "https://nodejs.org/dist/v24.17.0/docs/api/sqlite.html");
  assert.equal(deduped[0]?.text, "much richer sqlite documentation excerpt");
  assert.equal(deduped[0]?.date, "2026-09-10");
  assert.equal(deduped[1]?.text, "v20 docs");

  // Unversioned titles under /v1/ vs /v2/ stay distinct.
  assert.notEqual(
    nearDuplicateKey({ title: "Authentication and API Tokens", url: "https://api.example.com/v1/authentication" }),
    nearDuplicateKey({ title: "Authentication and API Tokens", url: "https://api.example.com/v2/authentication" }),
  );

  // Generic site titles fall back to canonicalUrl so unrelated pages never collapse.
  assert.notEqual(
    nearDuplicateKey({ title: "Stripe Docs", url: "https://stripe.com/docs/payments" }),
    nearDuplicateKey({ title: "Stripe Docs", url: "https://stripe.com/docs/billing" }),
  );
  assert.notEqual(
    nearDuplicateKey({ title: "GitHub - Documentation", url: "https://github.com/docs/actions" }),
    nearDuplicateKey({ title: "GitHub - Documentation", url: "https://github.com/docs/packages" }),
  );
});

test("mergeItems ranks with RRF (k=20) and breaks ties deterministically by corroboration and first-seen order", () => {
  const fillers = (prefix: string, count: number) => Array.from({ length: count }, (_, idx) => ({
    title: `${prefix} filler ${idx}`,
    url: `https://${prefix}.example/filler-${idx}`,
    text: `${prefix} ${idx}`,
  }));

  // #2 + #2 (2/22 = 0.0909) beats #1 + #8 (1/21 + 1/28 = 0.0833).
  const rrfOrder = mergeItems([
    {
      provider: "a",
      items: [
        { title: "One Plus Eight", url: "https://shared.example/1-and-8", text: "a1" },
        { title: "Two Plus Two", url: "https://shared.example/2-and-2", text: "a2" },
        ...fillers("a", 6),
      ],
    },
    {
      provider: "b",
      items: [
        { title: "B Top", url: "https://b.example/top", text: "b1" },
        { title: "Two Plus Two", url: "https://shared.example/2-and-2", text: "b2" },
        ...fillers("b", 5),
        { title: "One Plus Eight", url: "https://shared.example/1-and-8", text: "b8" },
      ],
    },
  ], 4);
  assert.equal(rrfOrder[0]?.url, "https://shared.example/2-and-2");
  assert.equal(rrfOrder[1]?.url, "https://shared.example/1-and-8");

  // Single #1 (1/21 = 0.0476) beats deep dual match #25 + #25 (2/45 = 0.0444),
  // while exact RRF tie #22 + #22 (2/42 = 1/21) beats single #1 via foundBy.length DESC.
  const tieAndDeep = mergeItems([
    {
      provider: "p1",
      items: [
        { title: "Single First", url: "https://single.example/first", text: "p1-1" },
        ...fillers("p1", 20),
        { title: "Exact Tie Dual", url: "https://tie.example/rank22", text: "p1-22" },
        ...fillers("p1b", 2),
        { title: "Deep Dual", url: "https://deep.example/rank25", text: "p1-25" },
      ],
    },
    {
      provider: "p2",
      items: [
        { title: "Single Second", url: "https://single.example/second", text: "p2-1" },
        ...fillers("p2", 20),
        { title: "Exact Tie Dual", url: "https://tie.example/rank22", text: "p2-22" },
        ...fillers("p2b", 2),
        { title: "Deep Dual", url: "https://deep.example/rank25", text: "p2-25" },
      ],
    },
  ], 5);
  assert.equal(tieAndDeep[0]?.url, "https://tie.example/rank22");
  assert.equal(tieAndDeep[1]?.url, "https://single.example/first");
  assert.equal(tieAndDeep[2]?.url, "https://single.example/second");
  assert.ok(tieAndDeep.findIndex((item) => item.url === "https://deep.example/rank25") === -1);
});

test("renderPayload deduplicates answer citations canonically and trims/dedupes warnings", () => {
  const rendered = renderPayload({
    text: "Concise answer.",
    citations: [
      "https://docs.example.com/guide.md?utm_source=test",
      { url: "https://www.docs.example.com/guide", title: "Official Guide" },
      { url: "https://other.example.com/ref", title: "Ref" },
    ],
    warnings: ["  partial results  ", "partial results", { message: "limit applied" }, ""],
  });
  assert.equal(
    rendered,
    [
      "Concise answer.",
      "",
      "Sources:",
      "1. Official Guide — https://www.docs.example.com/guide",
      "2. Ref — https://other.example.com/ref",
      "",
      "Warnings: partial results; limit applied",
    ].join("\n"),
  );
});

test("shapeTool trims descriptions on properties literally named default/enum/const/examples without mutating data keywords", () => {
  const longDesc = "Sentence one explains the property clearly. ".repeat(10);
  const literalDefaultObj = { description: "d".repeat(400), nested: true };
  const tool: Tool = {
    name: "schema_keywords",
    description: "Short tool description.",
    inputSchema: {
      type: "object",
      properties: {
        default: { type: "string", description: longDesc, default: "keep-me" },
        enum: { type: "string", description: longDesc, enum: ["alpha", "beta"] },
        const: { type: "string", description: longDesc, const: "fixed" },
        examples: { type: "object", description: longDesc, default: literalDefaultObj, examples: [literalDefaultObj] },
      },
    } as Tool["inputSchema"],
  };
  const shaped = shapeTool(tool, { maxDescriptionChars: 100, maxParamDescriptionChars: 60 });
  const props = (shaped.inputSchema as unknown as {
    properties: Record<string, { description: string; default?: unknown; enum?: unknown; const?: unknown; examples?: unknown }>;
  }).properties;
  for (const name of ["default", "enum", "const", "examples"]) {
    assert.ok((props[name]?.description ?? "").length <= 62, `${name} description should be trimmed`);
  }
  assert.equal(props.default?.default, "keep-me");
  assert.deepEqual(props.enum?.enum, ["alpha", "beta"]);
  assert.equal(props.const?.const, "fixed");
  assert.deepEqual(props.examples?.default, literalDefaultObj);
  assert.deepEqual(props.examples?.examples, [literalDefaultObj]);
});
