import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { exampleConfigPath, normalizeConfig, readConfigFile } from "../src/config.js";
import { adapterFor, REST_ADAPTER_NAMES } from "../src/rest/adapters.js";
import { CURATED_SPECIALIST_TOOLS, MANAGEMENT_TOOL_NAMES } from "../src/tools.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const skillDir = resolve(root, "skills/search-toolkit");
const skill = readFileSync(resolve(skillDir, "SKILL.md"), "utf8");
const routingRef = readFileSync(resolve(skillDir, "references/provider-routing.md"), "utf8");

const KNOWN_MCP_TOOLS = new Set([
  // Exa official MCP
  "exa_web_search_exa",
  "exa_web_search_advanced_exa",
  "exa_web_fetch_exa",
  "exa_agent_run",
  // Firecrawl official MCP (focused default allowlist + documented tools)
  "firecrawl_firecrawl_scrape",
  "firecrawl_firecrawl_map",
  "firecrawl_firecrawl_search",
  "firecrawl_firecrawl_crawl",
  "firecrawl_firecrawl_check_crawl_status",
  "firecrawl_firecrawl_extract",
  "firecrawl_firecrawl_agent",
  // Tavily official MCP
  "tavily_tavily_search",
  "tavily_tavily_extract",
  "tavily_tavily_crawl",
  "tavily_tavily_map",
  "tavily_tavily_research",
  // LinkUp official MCP
  "linkup_linkup_search",
  "linkup_linkup_fetch",
  "linkup_linkup_research",
  // AnySearch official MCP
  "anysearch_search",
  "anysearch_batch_search",
  "anysearch_extract",
  "anysearch_get_sub_domains",
]);

function allKnownToolNames(): Set<string> {
  const names = new Set<string>([...MANAGEMENT_TOOL_NAMES, ...KNOWN_MCP_TOOLS]);
  for (const adapterName of REST_ADAPTER_NAMES) {
    for (const tool of adapterFor(adapterName).tools(adapterName)) {
      names.add(tool.name);
    }
  }
  return names;
}

const TOOL_PREFIX = /^(?:search|fetch|provider|brave|serper|parallel|you|octen|deepseek|vercel|direct_markdown|tinyfish|jina|querit|grok|doubao|exa|firecrawl|tavily|linkup|anysearch)_[a-z0-9_]+$/;
const BANNED_PHANTOM_TOOLS = [
  "firecrawl_crawl",
  "firecrawl_map",
  "firecrawl_search",
  "firecrawl_scrape",
  "firecrawl_extract",
  "firecrawl_check_crawl_status",
  "tavily_search",
  "tavily_extract",
  "tavily_research",
  "linkup_search",
  "linkup_fetch",
  "linkup_research",
  "get_sub_domains",
  "web_search_exa",
  "web_search_advanced_exa",
];

test("the skill has valid frontmatter and its reference file exists", () => {
  const match = skill.match(/^---\r?\nname: (.+)\r?\ndescription: (.+)\r?\n---/);
  assert.ok(match, "frontmatter");
  assert.equal(match[1]?.trim(), "search-toolkit");
  assert.ok((match[2] ?? "").length > 40);
  assert.ok(existsSync(resolve(skillDir, "references/provider-routing.md")));
  assert.match(skill, /references\/provider-routing\.md/);
});

test("every unified tool is described in the skill, and SKILL.md + provider-routing.md name no phantom tools", () => {
  const known = allKnownToolNames();
  for (const name of MANAGEMENT_TOOL_NAMES) {
    assert.ok(skill.includes(name), `${name} is described in SKILL.md`);
  }

  for (const [label, content] of [
    ["SKILL.md", skill],
    ["references/provider-routing.md", routingRef],
  ] as const) {
    const backticked = /`([a-z][a-z0-9_]+)`/g;
    for (const hit of content.matchAll(backticked)) {
      const token = hit[1]!;
      if (token === "search_toolkit") continue;
      if (TOOL_PREFIX.test(token)) {
        assert.ok(known.has(token), `${label} references unknown tool \`${token}\``);
      }
      assert.ok(!BANNED_PHANTOM_TOOLS.includes(token), `${label} references unprefixed phantom tool \`${token}\``);
    }
  }
});

test("CURATED_SPECIALIST_TOOLS stays in parity with README.md, README.zh-CN.md, and provider-routing.md", () => {
  const expectedTools = Array.from(CURATED_SPECIALIST_TOOLS).sort();
  const expectedCount = expectedTools.length;

  const readmeEn = readFileSync(resolve(root, "README.md"), "utf8");
  const readmeZh = readFileSync(resolve(root, "README.zh-CN.md"), "utf8");

  for (const [label, doc, countPattern] of [
    ["README.md", readmeEn, /(\d+)\s+specialist tools/],
    ["README.zh-CN.md", readmeZh, /(\d+)\s*个专长工具/],
  ] as const) {
    const row = doc.split(/\r?\n/).find((line) => line.startsWith("| `curated` |"));
    assert.ok(row, `${label} documents the curated profile row`);
    const countMatch = row.match(countPattern);
    assert.ok(countMatch, `${label} curated row states the specialist tool count`);
    assert.equal(Number(countMatch[1]), expectedCount, `${label} specialist count matches CURATED_SPECIALIST_TOOLS (${expectedCount})`);

    const listedTools = Array.from(row.matchAll(/`([a-z][a-z0-9_]+)`/g))
      .map((match) => match[1]!)
      .filter((name) => name !== "curated" && !MANAGEMENT_TOOL_NAMES.has(name))
      .sort();
    assert.deepEqual(listedTools, expectedTools, `${label} curated specialist tool list matches CURATED_SPECIALIST_TOOLS`);
  }

  const refCountMatch = routingRef.match(/`curated`[^\n]*?(\d+)\s+specialist tools/);
  assert.ok(refCountMatch, "provider-routing.md states the curated specialist tool count");
  assert.equal(
    Number(refCountMatch[1]),
    expectedCount,
    `provider-routing.md specialist count matches CURATED_SPECIALIST_TOOLS (${expectedCount})`,
  );
});

test("config.example.json is a valid v2 template with accurate capabilities and adapters", () => {
  const { config, notes } = normalizeConfig(readConfigFile(exampleConfigPath()));
  assert.deepEqual(notes, []);
  assert.equal(config.version, 2);
  assert.equal(config.providers.exa?.auto.includes("images"), false, "exa has no image search tool");
  assert.equal(config.providers.tavily?.auto.includes("images"), false, "tavily has no image search tool");
  assert.deepEqual(config.providers.doubao?.auto, [], "doubao must remain manual-only");
  assert.deepEqual(config.providers.direct_markdown?.keys, [], "direct_markdown requires no keys");
  for (const [name, provider] of Object.entries(config.providers)) {
    if (provider.integration.kind === "rest") {
      assert.ok(REST_ADAPTER_NAMES.includes(provider.integration.adapter), `${name} uses a registered REST adapter`);
    }
  }
});

test("evals/search-queries.json is well-formed and covers both languages and all search_auto modes", () => {
  const dataset = JSON.parse(readFileSync(resolve(root, "evals/search-queries.json"), "utf8")) as {
    about: string;
    queries: Array<{ id: string; lang: string; kind: string; mode: string; query: string; gold: string[] }>;
  };
  assert.ok(typeof dataset.about === "string" && dataset.about.length > 20);
  assert.ok(Array.isArray(dataset.queries) && dataset.queries.length >= 20);

  const validLangs = new Set(["en", "zh"]);
  const validKinds = new Set(["web", "news", "scholar", "code"]);
  const validModes = new Set(["general", "exact", "current", "official", "scholar", "code", "context"]);
  const seenIds = new Set<string>();
  const seenLangs = new Set<string>();
  const seenModes = new Set<string>();

  for (const entry of dataset.queries) {
    assert.ok(entry.id && !seenIds.has(entry.id), `unique query id: ${entry.id}`);
    seenIds.add(entry.id);
    assert.ok(validLangs.has(entry.lang), `${entry.id} has valid lang: ${entry.lang}`);
    assert.ok(validKinds.has(entry.kind), `${entry.id} has valid kind: ${entry.kind}`);
    assert.ok(validModes.has(entry.mode), `${entry.id} has valid mode: ${entry.mode}`);
    assert.ok(typeof entry.query === "string" && entry.query.trim().length > 0, `${entry.id} has non-empty query`);
    assert.ok(
      Array.isArray(entry.gold) && entry.gold.length > 0 && entry.gold.every((host) => typeof host === "string" && host.includes(".")),
      `${entry.id} has non-empty gold host list`,
    );
    seenLangs.add(entry.lang);
    seenModes.add(entry.mode);
  }

  assert.deepEqual(Array.from(seenLangs).sort(), ["en", "zh"]);
  assert.deepEqual(Array.from(seenModes).sort(), Array.from(validModes).sort());
});

test("evals/evals.json is well-formed and covers unified tools across Chinese and English prompts", () => {
  const evals = JSON.parse(readFileSync(resolve(root, "evals/evals.json"), "utf8")) as {
    skill_name: string;
    evals: Array<{ id: number; prompt: string; expected_output: string; expectations: string[] }>;
  };
  assert.equal(evals.skill_name, "search-toolkit");
  assert.equal(new Set(evals.evals.map((item) => item.id)).size, evals.evals.length);
  for (const item of evals.evals) {
    assert.ok(item.prompt && item.expected_output && item.expectations.length > 0, `eval ${item.id}`);
  }
  assert.ok(evals.evals.some((item) => /[\u4e00-\u9fff]/.test(item.prompt)), "includes Chinese prompts");
  assert.ok(evals.evals.some((item) => !/[\u4e00-\u9fff]/.test(item.prompt)), "includes English prompts");
  const all = JSON.stringify(evals);
  for (const needle of ["fetch_auto", "crossCheck", "search_auto"]) assert.ok(all.includes(needle), needle);
  // Provenance is reported only on request, so no eval may demand an unprompted route footer.
  assert.doesNotMatch(all, /without being prompted/i);
});
