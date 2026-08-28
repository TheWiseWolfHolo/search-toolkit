import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { importKelivoDatabase } from "../scripts/import-kelivo.js";

test("one-time importer flattens all keys without retaining a Kelivo dependency", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "search-toolkit-import-"));
  try {
    const databasePath = resolve(dir, "kelivo.db");
    const outputPath = resolve(dir, "providers.json");
    const db = new DatabaseSync(databasePath);
    db.exec("CREATE TABLE search_service_rows(id TEXT, sort_order INTEGER, payload TEXT, updated_at INTEGER)");
    db.prepare("INSERT INTO search_service_rows VALUES (?, ?, ?, ?)").run(
      "q",
      0,
      JSON.stringify({ type: "querit", id: "q", apiKey: "primary-key", apiKeys: ["extra-one", "extra-two"] }),
      Date.now(),
    );
    db.prepare("INSERT INTO search_service_rows VALUES (?, ?, ?, ?)").run(
      "f",
      1,
      JSON.stringify({ type: "firecrawl", id: "f", apiKey: "firecrawl-key" }),
      Date.now(),
    );
    db.close();
    importKelivoDatabase(databasePath, outputPath);
    const config = JSON.parse(readFileSync(outputPath, "utf8")) as Record<string, unknown>;
    const providers = config.providers as Record<string, {
      keys: string[];
      integration: { kind: string };
      toolPolicy?: { allow?: string[] };
    }>;
    assert.deepEqual(providers.querit?.keys, ["primary-key", "extra-one", "extra-two"]);
    assert.equal(providers.querit?.integration.kind, "rest");
    assert.deepEqual(providers.firecrawl?.toolPolicy?.allow, [
      "firecrawl_scrape",
      "firecrawl_map",
      "firecrawl_search",
      "firecrawl_crawl",
      "firecrawl_check_crawl_status",
      "firecrawl_developer_search",
      "firecrawl_research_search_github",
    ]);
    rmSync(databasePath, { force: true });
    assert.equal(JSON.parse(readFileSync(outputPath, "utf8")).providers.querit.keys.length, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
