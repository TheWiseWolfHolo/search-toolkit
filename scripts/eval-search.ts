// Compare search providers on real queries without an LLM judge.
// Usage: npm run eval:search [-- --config <path>] [--only id1,id2] [--variants a,b] [--limit 8]
// Spends real quota: every query runs on every variant that fits its kind.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { nearDuplicateKey } from "../src/merge.js";
import { SearchToolkit } from "../src/toolkit.js";

type Kind = "web" | "news" | "scholar" | "code";

interface Query {
  id: string;
  lang: "en" | "zh";
  kind: Kind;
  mode: string;
  query: string;
  gold: string[];
}

interface Variant {
  name: string;
  tool: string;
  kinds: Kind[];
  lang?: "zh";
  args(query: string, limit: number, spec: Query): Record<string, unknown>;
}

interface Item {
  title: string;
  url: string;
  date?: string;
}

const args = process.argv.slice(2);
const flag = (name: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const limit = Number(flag("--limit") ?? 8);
const only = flag("--only")?.split(",");
const onlyVariants = flag("--variants")?.split(",");
const WEEK_SECONDS = 604_800;

const WEB: Kind[] = ["web", "code"];
const VARIANTS: Variant[] = [
  // The unified route as shipped, in the query's own mode. Compare it with the single-provider rows.
  { name: "auto", tool: "search_auto", kinds: ["web", "news", "scholar", "code"], args: (query, n, spec) => ({ query, limit: n, mode: spec.mode }) },
  { name: "parallel", tool: "parallel_search", kinds: [...WEB, "scholar"], args: (query, n) => ({ query, maxResults: n, mode: "fast" }) },
  { name: "parallel-news", tool: "parallel_search", kinds: ["news"], args: (query, n) => ({ query, maxResults: n, mode: "fast", maxAgeSeconds: WEEK_SECONDS }) },
  { name: "you", tool: "you_search", kinds: [...WEB, "scholar"], args: (query, n) => ({ query, limit: n, contentLevel: "snippets" }) },
  { name: "you-news", tool: "you_search", kinds: ["news"], args: (query, n) => ({ query, limit: n, contentLevel: "snippets", freshness: "week" }) },
  { name: "brave", tool: "brave_web_search", kinds: WEB, args: (query, n) => ({ query, limit: n }) },
  { name: "brave-zh", tool: "brave_web_search", kinds: WEB, lang: "zh", args: (query, n) => ({ query, limit: n, searchLang: "zh-hans", country: "CN" }) },
  { name: "brave-news", tool: "brave_news_search", kinds: ["news"], args: (query, n) => ({ query, limit: n, freshness: "pw" }) },
  { name: "brave-news-zh", tool: "brave_news_search", kinds: ["news"], lang: "zh", args: (query, n) => ({ query, limit: n, freshness: "pw", searchLang: "zh-hans", country: "CN" }) },
  { name: "serper", tool: "serper_search", kinds: WEB, args: (query, n) => ({ query, limit: n }) },
  { name: "serper-zh", tool: "serper_search", kinds: WEB, lang: "zh", args: (query, n) => ({ query, limit: n, gl: "cn", hl: "zh-cn" }) },
  { name: "serper-news", tool: "serper_news", kinds: ["news"], args: (query, n) => ({ query, limit: n, tbs: "qdr:w" }) },
  { name: "serper-news-zh", tool: "serper_news", kinds: ["news"], lang: "zh", args: (query, n) => ({ query, limit: n, tbs: "qdr:w", gl: "cn", hl: "zh-cn" }) },
  { name: "serper-scholar", tool: "serper_scholar", kinds: ["scholar"], args: (query, n) => ({ query, limit: n }) },
  { name: "exa", tool: "exa_web_search_exa", kinds: [...WEB, "scholar"], args: (query, n) => ({ query, numResults: n, objective: query }) },
  { name: "exa-news", tool: "exa_web_search_advanced_exa", kinds: ["news"], args: (query, n) => ({ query, numResults: n, category: "news", maxAgeHours: 168 }) },
  { name: "exa-pdf", tool: "exa_web_search_advanced_exa", kinds: ["scholar"], args: (query, n) => ({ query, numResults: n, category: "pdf" }) },
  { name: "exa-github", tool: "exa_web_search_advanced_exa", kinds: ["code"], args: (query, n) => ({ query, numResults: n, category: "github" }) },
  { name: "tavily", tool: "tavily_tavily_search", kinds: [...WEB, "scholar"], args: (query, n) => ({ query, max_results: n, search_depth: "basic" }) },
  { name: "tavily-news", tool: "tavily_tavily_search", kinds: ["news"], args: (query, n) => ({ query, max_results: n, search_depth: "basic", topic: "news", time_range: "week" }) },
  { name: "querit", tool: "querit_search", kinds: WEB, args: (query, n) => ({ query, limit: n }) },
  { name: "jina", tool: "jina_search", kinds: WEB, args: (query, n) => ({ query, limit: n }) },
  { name: "tinyfish", tool: "tinyfish_search", kinds: WEB, args: (query, n) => ({ query, limit: n }) },
  { name: "octen", tool: "octen_search", kinds: WEB, args: (query, n) => ({ query, limit: n }) },
  { name: "octen-zh", tool: "octen_search", kinds: WEB, lang: "zh", args: (query, n) => ({ query, limit: n, language: ["zh"] }) },
  { name: "octen-news", tool: "octen_search", kinds: ["news"], args: (query, n) => ({ query, limit: n, freshness: "week" }) },
  { name: "linkup", tool: "linkup_linkup_search", kinds: [...WEB, "news"], args: (query, n) => ({ query, maxResults: n, depth: "fast" }) },
  { name: "anysearch", tool: "anysearch_search", kinds: WEB, args: (query, n) => ({ query, max_results: n, domain: "general" }) },
  { name: "anysearch-academic", tool: "anysearch_search", kinds: ["scholar"], args: (query, n) => ({ query, max_results: n, domain: "academic" }) },
];

const CJK = /[㐀-鿿]/;

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

function matchesGold(url: string, gold: string[]): boolean {
  const host = hostOf(url);
  return Boolean(host) && gold.some((entry) => host === entry || host.endsWith(`.${entry}`));
}

/** Days since a provider-reported date, or undefined when it cannot be read. */
function ageDays(value: string | undefined, now: number): number | undefined {
  if (!value) return undefined;
  const relative = value.match(/(\d+)\s*(minute|hour|day|week|month|分钟|小时|天|周|月)/i);
  if (relative?.[1] && relative[2]) {
    const unit = relative[2].toLowerCase();
    const days = /minute|分钟/.test(unit) ? 0 : /hour|小时/.test(unit) ? 0 : /week|周/.test(unit) ? 7 : /month|月/.test(unit) ? 30 : 1;
    return Number(relative[1]) * days;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.max(0, (now - parsed) / 86_400_000) : undefined;
}

function itemsOf(output: unknown): Item[] {
  const structured = (output as { structuredContent?: { data?: { items?: unknown }; result?: { data?: { items?: unknown }; items?: unknown } } })?.structuredContent;
  const items = structured?.data?.items ?? structured?.result?.data?.items ?? structured?.result?.items;
  return Array.isArray(items) ? items as Item[] : [];
}

function score(query: Query, items: Item[], now: number) {
  const top = items.slice(0, limit);
  const count = Math.min(top.length / limit, 1);
  const gold3 = top.slice(0, 3).some((item) => matchesGold(item.url, query.gold)) ? 1 : 0;
  const goldShare = top.length ? top.filter((item) => matchesGold(item.url, query.gold)).length / top.length : 0;
  const lang = query.lang === "zh" && top.length ? top.filter((item) => CJK.test(item.title ?? "")).length / top.length : 1;
  const dated = top.length ? top.filter((item) => item.date).length / top.length : 0;
  const ages = top.map((item) => ageDays(item.date, now));
  const fresh = query.kind === "news" && top.length ? ages.filter((age) => age !== undefined && age <= 14).length / top.length : undefined;
  const keys = top.map((item) => nearDuplicateKey(item));
  const duplicates = top.length ? (top.length - new Set(keys).size) / top.length : 0;
  const composite = query.kind === "news"
    ? 0.3 * gold3 + 0.15 * goldShare + 0.3 * (fresh ?? 0) + 0.1 * lang + 0.15 * count
    : 0.4 * gold3 + 0.2 * goldShare + 0.15 * lang + 0.05 * dated + 0.2 * count - 0.1 * duplicates;
  return { count: top.length, gold3, goldShare, lang, dated, fresh, duplicates, composite };
}

const file = JSON.parse(readFileSync(resolve(process.cwd(), "evals/search-queries.json"), "utf8")) as { queries: Query[] };
const queries = file.queries.filter((query) => !only || only.includes(query.id));
// The cache would hide providers behind earlier answers; every call here must reach one.
const toolkit = new SearchToolkit(flag("--config"), { profile: "full", cache: false });
await toolkit.initialize();
const available = new Set(toolkit.listTools().map((tool) => tool.name));
const variants = VARIANTS.filter((variant) => available.has(variant.tool) && (!onlyVariants || onlyVariants.includes(variant.name)));
const now = Date.now();

interface Row {
  query: string;
  lang: string;
  kind: Kind;
  mode: string;
  variant: string;
  ok: boolean;
  latencyMs: number;
  error?: string;
  metrics?: ReturnType<typeof score>;
  items?: Item[];
}

// One worker per provider keeps each provider at one request at a time.
const byProvider = new Map<string, Variant[]>();
for (const variant of variants) {
  const provider = variant.tool.split("_")[0] as string;
  byProvider.set(provider, [...(byProvider.get(provider) ?? []), variant]);
}
const rows: Row[] = [];
await Promise.all(Array.from(byProvider.values(), async (group) => {
  for (const query of queries) {
    for (const variant of group) {
      if (!variant.kinds.includes(query.kind) || (variant.lang && variant.lang !== query.lang)) continue;
      const started = performance.now();
      try {
        const output = await toolkit.callTool(variant.tool, variant.args(query.query, limit, query));
        const items = itemsOf(output);
        const isError = (output as { isError?: boolean }).isError === true;
        rows.push({
          query: query.id, lang: query.lang, kind: query.kind, mode: query.mode, variant: variant.name,
          ok: !isError, latencyMs: Math.round(performance.now() - started),
          metrics: score(query, items, now),
          items: items.slice(0, limit).map(({ title, url, date }) => ({ title, url, ...(date ? { date } : {}) })),
        });
      } catch (error) {
        rows.push({
          query: query.id, lang: query.lang, kind: query.kind, mode: query.mode, variant: variant.name,
          ok: false, latencyMs: Math.round(performance.now() - started),
          error: (error instanceof Error ? error.message : String(error)).slice(0, 200),
        });
      }
      process.stderr.write(".");
    }
  }
}));
process.stderr.write("\n");
await toolkit.close();

// A failed call scores zero: availability is part of quality.
function summarize(filter: (row: Row) => boolean) {
  const groups = new Map<string, Row[]>();
  for (const row of rows.filter(filter)) groups.set(row.variant, [...(groups.get(row.variant) ?? []), row]);
  const mean = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
  return Array.from(groups, ([variant, list]) => {
    const okRows = list.filter((row) => row.ok && row.metrics);
    const metric = (pick: (metrics: NonNullable<Row["metrics"]>) => number | undefined) =>
      mean(list.map((row) => (row.ok && row.metrics ? pick(row.metrics) ?? 0 : 0)));
    const latencies = okRows.map((row) => row.latencyMs).sort((a, b) => a - b);
    return {
      variant,
      n: list.length,
      errors: list.length - okRows.length,
      score: Number(metric((m) => m.composite).toFixed(3)),
      gold3: Number(metric((m) => m.gold3).toFixed(2)),
      goldShare: Number(metric((m) => m.goldShare).toFixed(2)),
      lang: Number(metric((m) => m.lang).toFixed(2)),
      dated: Number(metric((m) => m.dated).toFixed(2)),
      fresh: Number(metric((m) => m.fresh).toFixed(2)),
      dup: Number(metric((m) => m.duplicates).toFixed(2)),
      count: Number(metric((m) => m.count).toFixed(1)),
      p50ms: latencies[Math.floor(latencies.length / 2)] ?? null,
    };
  }).sort((a, b) => b.score - a.score);
}

const buckets: Record<string, (row: Row) => boolean> = {};
for (const lang of ["en", "zh"]) {
  for (const kind of ["web", "news", "scholar", "code"]) buckets[`${lang}/${kind}`] = (row) => row.lang === lang && row.kind === kind;
  for (const mode of ["general", "official", "exact"]) buckets[`${lang}/web:${mode}`] = (row) => row.lang === lang && row.kind === "web" && row.mode === mode;
}
const summary = Object.fromEntries(Object.entries(buckets)
  .map(([name, filter]) => [name, summarize(filter)] as const)
  .filter(([, list]) => list.length));

const directory = resolve(process.cwd(), "evals/results");
mkdirSync(directory, { recursive: true });
const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
const path = resolve(directory, `search-eval-${stamp}.json`);
writeFileSync(path, JSON.stringify({ ranAt: new Date().toISOString(), limit, summary, rows }, null, 2));
for (const [name, list] of Object.entries(summary)) {
  console.log(`\n## ${name}`);
  console.table(list);
}
console.log(`\nFull results: ${path}`);
