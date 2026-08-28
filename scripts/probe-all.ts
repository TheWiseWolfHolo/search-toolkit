import { SearchToolkit } from "../src/toolkit.js";

const toolkit = new SearchToolkit();
const providers = ["tavily", "linkup", "serper", "firecrawl", "tinyfish", "brave", "jina", "grok"];

try {
  await toolkit.initialize();
  const results: unknown[] = [];
  for (const provider of providers) {
    const config = toolkit.config.providers[provider];
    if (!config?.enabled) continue;
    const output = await toolkit.callTool("search_rotation_probe", {
      provider,
      query: "Search Toolkit official integration rotation verification",
      calls: config.keys.length,
    }) as Record<string, unknown>;
    const content = output.structuredContent as Record<string, unknown> | undefined;
    const attempts = Array.isArray(content?.attempts) ? content.attempts : [];
    results.push({
      provider,
      configuredKeys: config.keys.length,
      calls: attempts.length,
      successes: attempts.filter((item) => item && typeof item === "object" && (item as Record<string, unknown>).ok === true).length,
      attempts,
    });
  }
  console.log(JSON.stringify({ results, warnings: toolkit.warnings }, null, 2));
} finally {
  await toolkit.close();
}
