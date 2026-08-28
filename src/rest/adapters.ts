import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ProviderConfig, SearchItem } from "../types.js";
import { requestJson, searchTool, type RestAdapter } from "./base.js";

const numberArg = (args: Record<string, unknown>, name: string, fallback: number) =>
  typeof args[name] === "number" ? args[name] : fallback;
const stringArg = (args: Record<string, unknown>, name: string, fallback = "") =>
  typeof args[name] === "string" ? args[name] : fallback;

export class QueritAdapter implements RestAdapter {
  tools(): Tool[] {
    return [searchTool(
      "querit_search",
      "Querit Search",
      "Search with Querit's filtered web search API. Best general-purpose default in Search Toolkit.",
      {
        sitesInclude: { type: "array", items: { type: "string" } },
        sitesExclude: { type: "array", items: { type: "string" } },
        countries: { type: "array", items: { type: "string" } },
        languages: { type: "array", items: { type: "string" } },
        timeRange: { type: "string" },
      },
    )];
  }

  async call(_tool: string, args: Record<string, unknown>, key: string, config: ProviderConfig): Promise<unknown> {
    const body: Record<string, unknown> = { query: stringArg(args, "query"), count: numberArg(args, "limit", 6) };
    const filters: Record<string, unknown> = {};
    const include = arrayArg(args, "sitesInclude");
    const exclude = arrayArg(args, "sitesExclude");
    if (include.length || exclude.length) filters.sites = { ...(include.length ? { include } : {}), ...(exclude.length ? { exclude } : {}) };
    const countries = arrayArg(args, "countries");
    const languages = arrayArg(args, "languages");
    if (countries.length) filters.geo = { countries: { include: countries } };
    if (languages.length) filters.languages = { include: languages };
    if (stringArg(args, "timeRange")) filters.timeRange = { date: stringArg(args, "timeRange") };
    if (Object.keys(filters).length) body.filters = filters;
    const base = config.integration.kind === "rest" && config.integration.baseUrl
      ? config.integration.baseUrl
      : "https://api.querit.ai/v1/search";
    const data = await requestJson(base, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const results = (data.results as Record<string, unknown> | undefined)?.result;
    return { items: Array.isArray(results) ? results.map(normalizeItem) : [] };
  }
}

export class SerperAdapter implements RestAdapter {
  tools(): Tool[] {
    return ["search", "news", "images"].map((kind) => searchTool(
      `serper_${kind}`,
      `Serper ${kind[0]?.toUpperCase()}${kind.slice(1)}`,
      `Query Google's ${kind} results through the official Serper REST API with concise snippets.`,
      {
        gl: { type: "string", description: "Country code" },
        hl: { type: "string", description: "Language code" },
        tbs: { type: "string", description: "Google time filter" },
      },
    ));
  }

  async call(tool: string, args: Record<string, unknown>, key: string): Promise<unknown> {
    const kind = tool.replace("serper_", "");
    const body: Record<string, unknown> = { q: stringArg(args, "query"), num: numberArg(args, "limit", 6) };
    for (const name of ["gl", "hl", "tbs"]) if (stringArg(args, name)) body[name] = stringArg(args, name);
    const data = await requestJson(`https://google.serper.dev/${kind}`, {
      method: "POST",
      headers: { "X-API-KEY": key, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const source = kind === "search" ? data.organic : data[kind];
    return { items: Array.isArray(source) ? source.map(normalizeItem) : [] };
  }
}

export class DoubaoAdapter implements RestAdapter {
  tools(): Tool[] {
    return [searchTool(
      "doubao_search",
      "Doubao Web Search (manual only)",
      "Search the Chinese web through Doubao. This provider is manual-only to preserve the monthly free quota.",
    )];
  }

  async call(_tool: string, args: Record<string, unknown>, key: string): Promise<unknown> {
    const data = await requestJson("https://open.feedcoopapi.com/search_api/web_search", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        Query: stringArg(args, "query"),
        SearchType: "web",
        Count: numberArg(args, "limit", 6),
        Filter: { NeedUrl: true },
      }),
    });
    const result = data.Result as Record<string, unknown> | undefined;
    const rows = result?.WebResults;
    return { items: Array.isArray(rows) ? rows.map((item) => normalizeItem({
      title: objectValue(item, "Title"),
      url: objectValue(item, "Url"),
      text: objectValue(item, "Summary") || objectValue(item, "Content") || objectValue(item, "Snippet"),
    })) : [] };
  }
}

export class JinaAdapter implements RestAdapter {
  tools(): Tool[] {
    return [searchTool("jina_search", "Jina Search", "Search with Jina Search and return compact result descriptions.")];
  }

  async call(_tool: string, args: Record<string, unknown>, key: string): Promise<unknown> {
    const data = await requestJson("https://s.jina.ai/", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ q: stringArg(args, "query") }),
    }, 20_000);
    const rows = data.data ?? data.results;
    return { items: Array.isArray(rows) ? rows.slice(0, numberArg(args, "limit", 6)).map(normalizeItem) : [] };
  }
}

export class TinyfishAdapter implements RestAdapter {
  tools(): Tool[] {
    return [searchTool(
      "tinyfish_search",
      "TinyFish Search",
      "Search through TinyFish's official Search API. TinyFish browser automation remains available through its official CLI/MCP separately.",
      {
        location: { type: "string" },
        language: { type: "string" },
        includeDomains: { type: "array", items: { type: "string" } },
        excludeDomains: { type: "array", items: { type: "string" } },
      },
    )];
  }

  async call(_tool: string, args: Record<string, unknown>, key: string, config: ProviderConfig): Promise<unknown> {
    const base = config.integration.kind === "rest" && config.integration.baseUrl
      ? config.integration.baseUrl
      : "https://api.search.tinyfish.ai";
    const url = new URL(base);
    url.searchParams.set("query", stringArg(args, "query"));
    for (const [source, target] of [["location", "location"], ["language", "language"]] as const) {
      if (stringArg(args, source)) url.searchParams.set(target, stringArg(args, source));
    }
    for (const [source, target] of [["includeDomains", "include_domains"], ["excludeDomains", "exclude_domains"]] as const) {
      const values = arrayArg(args, source);
      if (values.length) url.searchParams.set(target, values.join(","));
    }
    const data = await requestJson(url.toString(), { headers: { "X-API-Key": key } });
    return { items: Array.isArray(data.results) ? data.results.slice(0, numberArg(args, "limit", 6)).map(normalizeItem) : [] };
  }
}

export class BraveAdapter implements RestAdapter {
  tools(): Tool[] {
    const searches = ["web", "news"].map((kind) => searchTool(
      `brave_${kind}_search`,
      `Brave ${kind === "web" ? "Web" : "News"} Search`,
      `Search Brave's independent ${kind} index with the official Search API.`,
      {
        country: { type: "string" },
        searchLang: { type: "string" },
        freshness: { type: "string" },
        safesearch: { type: "string", enum: ["off", "moderate", "strict"] },
      },
    ));
    const context: Tool = {
      name: "brave_llm_context",
      title: "Brave LLM Context",
      description: "Retrieve pre-extracted, relevance-ranked Web content for AI agents, grounding, and RAG with explicit token and URL budgets.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", minLength: 1, maxLength: 400, description: "Search query; Brave allows at most 50 words" },
          country: { type: "string", minLength: 2, maxLength: 2 },
          searchLang: { type: "string", minLength: 2 },
          count: { type: "integer", minimum: 1, maximum: 50, default: 20, description: "Search results considered before context extraction" },
          maximumNumberOfUrls: { type: "integer", minimum: 1, maximum: 50, default: 20 },
          maximumNumberOfTokens: { type: "integer", minimum: 1024, maximum: 32768, default: 8192 },
          maximumNumberOfSnippets: { type: "integer", minimum: 1, maximum: 256, default: 50 },
          contextThresholdMode: { type: "string", enum: ["disabled", "strict", "balanced", "lenient"] },
          maximumNumberOfTokensPerUrl: { type: "integer", minimum: 512, maximum: 8192, default: 4096 },
          maximumNumberOfSnippetsPerUrl: { type: "integer", minimum: 1, maximum: 100, default: 50 },
          goggles: {
            oneOf: [
              { type: "string" },
              { type: "array", minItems: 1, maxItems: 3, items: { type: "string" } },
            ],
          },
          freshness: { type: "string", description: "pd, pw, pm, py, or YYYY-MM-DDtoYYYY-MM-DD" },
          safesearch: { type: "string", enum: ["off", "moderate", "strict"] },
          spellcheck: { type: "boolean", default: true },
          enableLocal: { type: "boolean" },
          enableSourceMetadata: { type: "boolean", default: false },
          locationLatitude: { type: "number", minimum: -90, maximum: 90 },
          locationLongitude: { type: "number", minimum: -180, maximum: 180 },
          locationCity: { type: "string" },
          locationState: { type: "string" },
          locationStateName: { type: "string" },
          locationCountry: { type: "string", minLength: 2, maxLength: 2 },
          locationPostalCode: { type: "string" },
        },
        required: ["query"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    };
    return [...searches, context];
  }

  async call(tool: string, args: Record<string, unknown>, key: string): Promise<unknown> {
    if (tool === "brave_llm_context") return this.callLlmContext(args, key);
    const kind = tool.includes("news") ? "news" : "web";
    const url = new URL(`https://api.search.brave.com/res/v1/${kind}/search`);
    url.searchParams.set("q", stringArg(args, "query"));
    url.searchParams.set("count", String(numberArg(args, "limit", 6)));
    for (const [source, target] of [["country", "country"], ["searchLang", "search_lang"], ["freshness", "freshness"], ["safesearch", "safesearch"]] as const) {
      if (stringArg(args, source)) url.searchParams.set(target, stringArg(args, source));
    }
    const data = await requestJson(url.toString(), {
      headers: { Accept: "application/json", "X-Subscription-Token": key },
    });
    const container = data[kind] as Record<string, unknown> | undefined;
    const rows = container?.results ?? data.results;
    return { items: Array.isArray(rows) ? rows.map(normalizeItem) : [] };
  }

  private async callLlmContext(args: Record<string, unknown>, key: string): Promise<unknown> {
    const body: Record<string, unknown> = { q: stringArg(args, "query") };
    for (const [source, target] of [
      ["country", "country"],
      ["searchLang", "search_lang"],
      ["count", "count"],
      ["maximumNumberOfUrls", "maximum_number_of_urls"],
      ["maximumNumberOfTokens", "maximum_number_of_tokens"],
      ["maximumNumberOfSnippets", "maximum_number_of_snippets"],
      ["contextThresholdMode", "context_threshold_mode"],
      ["maximumNumberOfTokensPerUrl", "maximum_number_of_tokens_per_url"],
      ["maximumNumberOfSnippetsPerUrl", "maximum_number_of_snippets_per_url"],
      ["goggles", "goggles"],
      ["freshness", "freshness"],
      ["safesearch", "safesearch"],
      ["spellcheck", "spellcheck"],
      ["enableLocal", "enable_local"],
      ["enableSourceMetadata", "enable_source_metadata"],
    ] as const) {
      const value = args[source];
      if (value !== undefined && value !== null && value !== "") body[target] = value;
    }
    const headers: Record<string, string> = {
      Accept: "application/json",
      "Accept-Encoding": "gzip",
      "Content-Type": "application/json",
      "X-Subscription-Token": key,
    };
    for (const [source, target] of [
      ["locationLatitude", "X-Loc-Lat"],
      ["locationLongitude", "X-Loc-Long"],
      ["locationCity", "X-Loc-City"],
      ["locationState", "X-Loc-State"],
      ["locationStateName", "X-Loc-State-Name"],
      ["locationCountry", "X-Loc-Country"],
      ["locationPostalCode", "X-Loc-Postal-Code"],
    ] as const) {
      const value = args[source];
      if (typeof value === "string" && value.trim()) headers[target] = value;
      if (typeof value === "number" && Number.isFinite(value)) headers[target] = String(value);
    }
    return requestJson("https://api.search.brave.com/res/v1/llm/context", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }, 30_000);
  }
}

export class YouAdapter implements RestAdapter {
  tools(): Tool[] {
    return [searchTool(
      "you_search",
      "You.com Web Search",
      "Search You.com's unified Web and News index. Returns snippets by default or query-aware highlights when explicitly requested.",
      {
        freshness: { type: "string", description: "day, week, month, year, or YYYY-MM-DDtoYYYY-MM-DD" },
        offset: { type: "integer", minimum: 0, maximum: 9, default: 0 },
        country: { type: "string" },
        language: { type: "string", description: "BCP 47 language code" },
        safesearch: { type: "string", enum: ["off", "moderate", "strict"], default: "moderate" },
        includeDomains: { type: "array", maxItems: 500, items: { type: "string" } },
        excludeDomains: { type: "array", maxItems: 500, items: { type: "string" } },
        boostDomains: { type: "array", maxItems: 500, items: { type: "string" } },
        contentLevel: {
          type: "string",
          enum: ["snippets", "highlights"],
          default: "snippets",
          description: "Highlights trigger query-aware per-page extraction; snippets are the low-cost default",
        },
      },
    )];
  }

  async call(_tool: string, args: Record<string, unknown>, key: string, config: ProviderConfig): Promise<unknown> {
    const body: Record<string, unknown> = {
      query: stringArg(args, "query"),
      count: numberArg(args, "limit", 6),
    };
    for (const [source, target] of [
      ["freshness", "freshness"],
      ["offset", "offset"],
      ["country", "country"],
      ["language", "language"],
      ["safesearch", "safesearch"],
    ] as const) {
      const value = args[source];
      if (value !== undefined && value !== null && value !== "") body[target] = value;
    }
    for (const [source, target] of [
      ["includeDomains", "include_domains"],
      ["excludeDomains", "exclude_domains"],
      ["boostDomains", "boost_domains"],
    ] as const) {
      const values = arrayArg(args, source);
      if (values.length) body[target] = values;
    }
    if (stringArg(args, "contentLevel") === "highlights") {
      body.extraction = { extraction_mode: "highlights", highlights: {} };
    }
    const base = config.integration.kind === "rest" && config.integration.baseUrl
      ? config.integration.baseUrl
      : "https://ydc-index.io/v1/search";
    const data = await requestJson(base, {
      method: "POST",
      headers: { "X-API-Key": key, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }, 30_000);
    const results = data.results && typeof data.results === "object"
      ? data.results as Record<string, unknown>
      : {};
    const items = [
      ...normalizeYouSection(results.web, "web"),
      ...normalizeYouSection(results.news, "news"),
    ];
    return { items, metadata: data.metadata };
  }
}

export class ParallelAdapter implements RestAdapter {
  tools(): Tool[] {
    return [searchTool(
      "parallel_search",
      "Parallel Search",
      "Search Parallel's AI-native index with a natural-language objective and LLM-optimized excerpts. Supply 1-3 concise keyword queries when possible.",
      {
        searchQueries: {
          type: "array",
          minItems: 1,
          maxItems: 5,
          items: { type: "string", maxLength: 200 },
          description: "Concise 3-6 word keyword searches; the main query is used if omitted",
        },
        mode: {
          type: "string",
          enum: ["turbo", "fast", "basic", "advanced"],
          default: "basic",
          description: "Basic is the recommended default for general agents; use turbo for lowest latency/cost and advanced explicitly for highest-quality multi-hop retrieval",
        },
        maxCharsTotal: { type: "integer", minimum: 1 },
        maxResults: { type: "integer", minimum: 1, maximum: 20 },
        maxCharsPerResult: { type: "integer", minimum: 1 },
        includeDomains: { type: "array", items: { type: "string" } },
        excludeDomains: { type: "array", items: { type: "string" } },
        maxAgeSeconds: { type: "integer", minimum: 0 },
        location: { type: "string", minLength: 2, maxLength: 2, description: "ISO 3166-1 alpha-2 country code" },
        sessionId: { type: "string", maxLength: 1000 },
        clientModel: { type: "string" },
      },
    )];
  }

  async call(_tool: string, args: Record<string, unknown>, key: string, config: ProviderConfig): Promise<unknown> {
    const query = stringArg(args, "query");
    const searches = arrayArg(args, "searchQueries");
    const body: Record<string, unknown> = {
      objective: query,
      search_queries: searches.length ? searches : [query],
      mode: stringArg(args, "mode", "basic"),
    };
    for (const [source, target] of [
      ["maxCharsTotal", "max_chars_total"],
      ["sessionId", "session_id"],
      ["clientModel", "client_model"],
    ] as const) {
      const value = args[source];
      if (value !== undefined && value !== null && value !== "") body[target] = value;
    }
    const advanced: Record<string, unknown> = {};
    const sourcePolicy: Record<string, unknown> = {};
    const include = arrayArg(args, "includeDomains");
    const exclude = arrayArg(args, "excludeDomains");
    if (include.length) sourcePolicy.include_domains = include;
    if (exclude.length) sourcePolicy.exclude_domains = exclude;
    if (Object.keys(sourcePolicy).length) advanced.source_policy = sourcePolicy;
    if (typeof args.maxAgeSeconds === "number") advanced.fetch_policy = { max_age_seconds: args.maxAgeSeconds };
    if (typeof args.maxCharsPerResult === "number") advanced.excerpt_settings = { max_chars_per_result: args.maxCharsPerResult };
    const maxResults = typeof args.maxResults === "number"
      ? args.maxResults
      : typeof args.limit === "number"
        ? args.limit
        : undefined;
    if (maxResults !== undefined) advanced.max_results = maxResults;
    if (stringArg(args, "location")) advanced.location = stringArg(args, "location").toLowerCase();
    if (Object.keys(advanced).length) body.advanced_settings = advanced;
    const base = config.integration.kind === "rest" && config.integration.baseUrl
      ? config.integration.baseUrl
      : "https://api.parallel.ai/v1/search";
    const data = await requestJson(base, {
      method: "POST",
      headers: { "x-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }, 60_000);
    return {
      items: Array.isArray(data.results) ? data.results.map(normalizeParallelItem) : [],
      searchId: data.search_id,
      sessionId: data.session_id,
      warnings: data.warnings,
      usage: data.usage,
    };
  }
}

export class GrokAdapter implements RestAdapter {
  tools(): Tool[] {
    const common = {
      maxTurns: { type: "integer", minimum: 1, maximum: 20, default: 3 },
    };
    return [
      searchTool("grok_web_search", "Grok Web Search", "Use the configured Grok model with xAI's native web_search tool and citations.", {
        ...common,
        allowedDomains: { type: "array", items: { type: "string" } },
        excludedDomains: { type: "array", items: { type: "string" } },
        enableImageSearch: { type: "boolean", default: false },
      }),
      searchTool("grok_x_search", "Grok X Search", "Use the configured Grok model with xAI's native x_search tool for posts, users, and threads.", {
        ...common,
        allowedXHandles: { type: "array", items: { type: "string" } },
        excludedXHandles: { type: "array", items: { type: "string" } },
        fromDate: { type: "string", format: "date" },
        toDate: { type: "string", format: "date" },
      }),
      searchTool("grok_web_x_search", "Grok Web + X Search", "Use both xAI native web_search and x_search in one Responses API request.", common),
    ];
  }

  async call(tool: string, args: Record<string, unknown>, key: string, config: ProviderConfig): Promise<unknown> {
    const options = config.options ?? {};
    const base = config.integration.kind === "rest" && config.integration.baseUrl
      ? config.integration.baseUrl
      : String(options.customUrl ?? "https://api.x.ai/v1/responses");
    const tools: Array<Record<string, unknown>> = [];
    if (tool !== "grok_x_search") {
      const web: Record<string, unknown> = { type: "web_search" };
      const allowed = arrayArg(args, "allowedDomains");
      const excluded = arrayArg(args, "excludedDomains");
      if (allowed.length) web.allowed_domains = allowed;
      if (excluded.length) web.excluded_domains = excluded;
      if (args.enableImageSearch === true) web.enable_image_search = true;
      tools.push(web);
    }
    if (tool !== "grok_web_search") {
      const x: Record<string, unknown> = { type: "x_search" };
      const allowed = arrayArg(args, "allowedXHandles");
      const excluded = arrayArg(args, "excludedXHandles");
      if (allowed.length) x.allowed_x_handles = allowed;
      if (excluded.length) x.excluded_x_handles = excluded;
      if (stringArg(args, "fromDate")) x.from_date = stringArg(args, "fromDate");
      if (stringArg(args, "toDate")) x.to_date = stringArg(args, "toDate");
      tools.push(x);
    }
    const body: Record<string, unknown> = {
      model: String(options.model ?? "grok-4.6"),
      input: [{ role: "user", content: stringArg(args, "query") }],
      tools,
      max_turns: numberArg(args, "maxTurns", 3),
    };
    const effort = String(options.reasoningEffort ?? "").trim();
    if (effort) body.reasoning = { effort };
    const data = await requestJson(base, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }, 60_000);
    return {
      text: extractResponseText(data),
      citations: collectCitations(data),
      usage: data.usage,
      serverSideToolUsage: data.server_side_tool_usage,
      responseId: data.id,
    };
  }
}

export function adapterFor(name: string): RestAdapter {
  if (name === "querit") return new QueritAdapter();
  if (name === "serper") return new SerperAdapter();
  if (name === "doubao") return new DoubaoAdapter();
  if (name === "jina") return new JinaAdapter();
  if (name === "tinyfish") return new TinyfishAdapter();
  if (name === "brave") return new BraveAdapter();
  if (name === "you") return new YouAdapter();
  if (name === "parallel") return new ParallelAdapter();
  if (name === "grok") return new GrokAdapter();
  throw new Error(`Unknown REST adapter: ${name}`);
}

function normalizeYouSection(value: unknown, section: "web" | "news"): Array<SearchItem & { section: string }> {
  if (!Array.isArray(value)) return [];
  return value.map((row) => {
    const item = row && typeof row === "object" ? row as Record<string, unknown> : {};
    const contents = item.contents && typeof item.contents === "object"
      ? item.contents as Record<string, unknown>
      : {};
    const highlights = Array.isArray(contents.highlights) ? contents.highlights.map(String) : [];
    const snippets = Array.isArray(item.snippets) ? item.snippets.map(String) : [];
    return {
      section,
      title: String(item.title ?? item.url ?? ""),
      url: String(item.url ?? ""),
      text: (highlights.length ? highlights : snippets.length ? snippets : [String(item.description ?? "")]).join("\n").slice(0, 12_000),
    };
  });
}

function normalizeParallelItem(value: unknown): SearchItem {
  const item = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const excerpts = Array.isArray(item.excerpts) ? item.excerpts.map(String) : [];
  return {
    title: String(item.title ?? item.url ?? ""),
    url: String(item.url ?? ""),
    text: excerpts.join("\n").slice(0, 20_000),
  };
}

function arrayArg(args: Record<string, unknown>, name: string): string[] {
  return Array.isArray(args[name]) ? args[name].map(String).map((value) => value.trim()).filter(Boolean) : [];
}

function objectValue(value: unknown, key: string): string {
  return value && typeof value === "object" ? String((value as Record<string, unknown>)[key] ?? "") : "";
}

function normalizeItem(value: unknown): SearchItem {
  const item = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    title: String(item.title ?? item.name ?? item.Title ?? item.url ?? ""),
    url: String(item.url ?? item.link ?? item.Url ?? ""),
    text: String(item.text ?? item.snippet ?? item.description ?? item.content ?? item.Summary ?? "").slice(0, 4_000),
  };
}

function extractResponseText(data: Record<string, unknown>): string {
  if (typeof data.output_text === "string") return data.output_text;
  if (!Array.isArray(data.output)) return "";
  const parts: string[] = [];
  for (const item of data.output) {
    if (!item || typeof item !== "object") continue;
    const content = (item as Record<string, unknown>).content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block && typeof block === "object" && typeof (block as Record<string, unknown>).text === "string") {
        parts.push(String((block as Record<string, unknown>).text));
      }
    }
  }
  return parts.join("\n");
}

function collectCitations(data: Record<string, unknown>): unknown[] {
  const found: unknown[] = [];
  if (Array.isArray(data.citations)) found.push(...data.citations);
  if (!Array.isArray(data.output)) return found;
  for (const item of data.output) {
    if (!item || typeof item !== "object") continue;
    const content = (item as Record<string, unknown>).content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block && typeof block === "object" && Array.isArray((block as Record<string, unknown>).annotations)) {
        found.push(...((block as Record<string, unknown>).annotations as unknown[]));
      }
    }
  }
  return found;
}
