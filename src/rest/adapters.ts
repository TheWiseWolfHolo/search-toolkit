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
    return ["web", "news"].map((kind) => searchTool(
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
  }

  async call(tool: string, args: Record<string, unknown>, key: string): Promise<unknown> {
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
  if (name === "grok") return new GrokAdapter();
  throw new Error(`Unknown REST adapter: ${name}`);
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
