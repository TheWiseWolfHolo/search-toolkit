import type { Tool } from "@modelcontextprotocol/sdk/types.js";

const READ_ONLY_OPEN = { readOnlyHint: true, destructiveHint: false, openWorldHint: true } as const;

export const STATUS_TOOL: Tool = {
  name: "search_pool_status",
  title: "Search provider and key-pool status",
  description: "Masked provider and key-pool health, cool-downs, and startup warnings. verbose=true adds every key slot's counters and the exposed tool list. Never returns raw keys.",
  inputSchema: {
    type: "object",
    properties: {
      verbose: { type: "boolean", default: false, description: "Include every masked key slot and the complete tool list." },
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
};

export const AUTO_TOOL: Tool = {
  name: "search_auto",
  title: "Search with the recommended provider",
  description: "Quality-first web search that picks the provider by mode, quality, and query language (Parallel, Serper, Exa, You.com, Brave, Tavily); Chinese queries use Chinese-market settings. Repeats within a few minutes are served from cache and marked cached. balanced suits routine work; max uses deeper retrieval for complex or multi-hop questions. Supports domain filtering, time windows, per-result excerpt budgets, and crossCheck=true across independent indexes (including REST and MCP providers). Never selects Doubao, research, crawl, or agentic tools.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", minLength: 1 },
      mode: {
        type: "string",
        enum: ["general", "exact", "current", "official", "context", "scholar", "code"],
        default: "general",
        description: "exact: quoted strings and error messages; current: news (past week by default); official: vendor or government sites; context: grounding chunks; scholar: papers; code: repositories and code examples",
      },
      quality: {
        type: "string",
        enum: ["balanced", "max"],
        default: "balanced",
        description: "max selects Parallel Advanced or Exa Advanced where the mode supports it",
      },
      freshness: {
        type: "string",
        enum: ["day", "week", "month", "year"],
        description: "Time window mapped to each provider's native control (defaults to week in current mode)",
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 20,
        default: 6,
        description: "Result limit. Brave LLM Context ignores it and keeps a 20-source grounding pool.",
      },
      includeDomains: {
        type: "array",
        maxItems: 20,
        items: { type: "string", minLength: 1 },
        description: "Restrict results to these domains (mapped to native domain filters or site: operators)",
      },
      excludeDomains: {
        type: "array",
        maxItems: 20,
        items: { type: "string", minLength: 1 },
        description: "Exclude results from these domains",
      },
      maxCharsPerResult: {
        type: "integer",
        minimum: 150,
        maximum: 10000,
        description: "Cap each result's rendered excerpt length (defaults to 700 in balanced and 1800 in max)",
      },
      maximumNumberOfTokens: {
        type: "integer",
        minimum: 1024,
        maximum: 32768,
        default: 4096,
        description: "Token budget when context mode routes to Brave LLM Context; other providers ignore it",
      },
      crossCheck: {
        type: "boolean",
        default: false,
        description: "Run two independent indexes and merge by URL. Ignored for context mode, where results are not itemised.",
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
  annotations: READ_ONLY_OPEN,
};

export const IMAGES_TOOL: Tool = {
  name: "search_images",
  title: "Search for images",
  description: "Find images by text (`query`: Brave Images, then Serper Google Images and Parallel), or by image (`imageUrl`: Google Lens reverse search for pages showing the same or a similar picture, to identify it or trace where it came from). Returns image URLs, source pages, and publishers. imageUrl must be publicly reachable; local files are not supported.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", minLength: 1, description: "Text describing the images to find" },
      imageUrl: { type: "string", minLength: 1, description: "Public http(s) URL of an image to search by, instead of query" },
      limit: { type: "integer", minimum: 1, maximum: 20, default: 10 },
      language: { type: "string", description: "Optional language preference for Brave/Serper" },
      safesearch: { type: "string", enum: ["strict", "off"], default: "strict", description: "Applied by Brave; the fallback uses its own safety behavior" },
    },
    additionalProperties: false,
  },
  annotations: READ_ONLY_OPEN,
};

export const FETCH_TOOL: Tool = {
  name: "fetch_auto",
  title: "Read one or more known URLs",
  description: "Fetch the readable content of one known URL (`url`) or up to 5 URLs concurrently (`urls`) through Exa, Tavily, Parallel, You.com, Firecrawl, LinkUp, or AnySearch, falling back when a reader returns nothing usable or hits a challenge wall. Supports `offset` pagination and `section` filtering for large pages. quality=max leads with Firecrawl (JavaScript rendering).",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", minLength: 1, description: "Single http(s) URL to read" },
      urls: {
        type: "array",
        minItems: 1,
        maxItems: 5,
        items: { type: "string", minLength: 1 },
        description: "Batch of up to 5 http(s) URLs to read concurrently",
      },
      quality: { type: "string", enum: ["balanced", "max"], default: "balanced" },
      maxChars: { type: "integer", minimum: 500, maximum: 100000, default: 12000, description: "Longest content returned; longer pages are truncated with an offset marker" },
      offset: { type: "integer", minimum: 0, default: 0, description: "Character offset to start reading from on long pages" },
      section: { type: "string", description: "Optional heading or keyword filter to extract matching sections before truncating" },
    },
    additionalProperties: false,
  },
  annotations: READ_ONLY_OPEN,
};

export const PROBE_TOOL: Tool = {
  name: "search_rotation_probe",
  title: "Verify provider key rotation",
  description: "Run a few real calls through one provider and return the masked key-slot sequence. Consumes provider quota.",
  inputSchema: {
    type: "object",
    properties: {
      provider: { type: "string" },
      query: { type: "string", minLength: 1 },
      calls: { type: "integer", minimum: 1, maximum: 12 },
      tool: { type: "string", description: "Optional exposed tool name; defaults to the provider's first search tool" },
    },
    required: ["provider", "query"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
};

export const GATEWAY_LIST_TOOL: Tool = {
  name: "provider_tools",
  title: "List or describe provider tools",
  description: "Lean/curated profiles. Without arguments, list every provider tool by name with a one-line summary; filter with provider. With name, return that tool's full description and input schema, which provider_call requires.",
  inputSchema: {
    type: "object",
    properties: {
      provider: { type: "string", description: "Only list this provider's tools" },
      name: { type: "string", description: "Return the full description and input schema of this tool" },
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
};

export const GATEWAY_CALL_TOOL: Tool = {
  name: "provider_call",
  title: "Call a provider tool",
  description: "Lean/curated profiles. Call any provider tool by its exposed name. Read its schema with provider_tools first. Tools that crawl, research, or modify state keep their own side effects: only call those when the user asked for them.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", minLength: 1 },
      arguments: { type: "object", additionalProperties: true },
    },
    required: ["name"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
};

export const GATEWAY_TOOL_NAMES = new Set([GATEWAY_LIST_TOOL.name, GATEWAY_CALL_TOOL.name]);
export const MANAGEMENT_TOOL_NAMES = new Set([
  STATUS_TOOL.name, AUTO_TOOL.name, IMAGES_TOOL.name, FETCH_TOOL.name, PROBE_TOOL.name,
  GATEWAY_LIST_TOOL.name, GATEWAY_CALL_TOOL.name,
]);
/** Specialist tools with capabilities not covered by search_auto/fetch_auto/search_images, exposed directly in the curated profile. */
export const CURATED_SPECIALIST_TOOLS = new Set([
  "brave_llm_context",
  "parallel_search",
  "parallel_extract",
  "you_search",
  "you_contents",
  "serper_scholar",
  "exa_web_search_advanced_exa",
  "grok_x_search",
  "grok_web_x_search",
  "doubao_search",
  "anysearch_batch_search",
  "firecrawl_firecrawl_map",
  "firecrawl_firecrawl_crawl",
  "linkup_linkup_research",
  "tavily_tavily_research",
]);

