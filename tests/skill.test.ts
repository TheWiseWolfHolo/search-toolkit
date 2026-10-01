import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { MANAGEMENT_TOOL_NAMES } from "../src/tools.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const skillDir = resolve(root, "skills/search-toolkit");
const skill = readFileSync(resolve(skillDir, "SKILL.md"), "utf8");

test("the skill has valid frontmatter and its reference file exists", () => {
  const match = skill.match(/^---\r?\nname: (.+)\r?\ndescription: (.+)\r?\n---/);
  assert.ok(match, "frontmatter");
  assert.equal(match[1]?.trim(), "search-toolkit");
  assert.ok((match[2] ?? "").length > 40);
  assert.ok(existsSync(resolve(skillDir, "references/provider-routing.md")));
  assert.match(skill, /references\/provider-routing\.md/);
});

test("every unified tool is described in the skill, and the skill names no phantom unified tool", () => {
  for (const name of MANAGEMENT_TOOL_NAMES) assert.ok(skill.includes(name), `${name} is described in the skill`);
  const unified = /(?:search|fetch|provider)_[a-z_]+/g;
  for (const hit of skill.matchAll(unified)) {
    const name = hit[0];
    // `search_toolkit`-style words and CLI/provider names are fine; an unknown unified-looking tool is a typo.
    if (["search_toolkit"].includes(name)) continue;
    assert.ok(MANAGEMENT_TOOL_NAMES.has(name), `${name} is a real tool`);
  }
});

test("evals are well-formed and cover the unified tools", () => {
  const evals = JSON.parse(readFileSync(resolve(root, "evals/evals.json"), "utf8")) as {
    skill_name: string;
    evals: Array<{ id: number; prompt: string; expected_output: string; expectations: string[] }>;
  };
  assert.equal(evals.skill_name, "search-toolkit");
  assert.equal(new Set(evals.evals.map((item) => item.id)).size, evals.evals.length);
  for (const item of evals.evals) {
    assert.ok(item.prompt && item.expected_output && item.expectations.length > 0, `eval ${item.id}`);
  }
  const all = JSON.stringify(evals);
  for (const needle of ["fetch_auto", "crossCheck", "search_auto"]) assert.ok(all.includes(needle), needle);
  // Provenance is reported only on request, so no eval may demand an unprompted route footer.
  assert.doesNotMatch(all, /without being prompted/i);
});
