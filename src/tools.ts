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
  description: "Quality-first web search that picks the provider by mode and quality (Parallel, You.com, Brave, Exa, Querit, Tavily, Serper). balanced suits routine work; max uses deeper retrieval for complex or multi-hop questions. On a provider-availability failure it tries one compatible fallback. crossCheck=true queries two independent indexes and merges results by URL. Never selects Doubao, research, crawl, or agentic tools.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", minLength: 1 },
      mode: { type: "string", enum: ["general", "exact", "current", "official", "context"], default: "general" },
      quality: {
        type: "string",
        enum: ["balanced", "max"],
        default: "balanced",
        description: "max selects Parallel Advanced or Exa Advanced where the mode supports it",
      },
      freshness: {
        type: "string",
        enum: ["day", "week", "month", "year"],
        default: "week",
        description: "Time window for current mode, mapped to each provider's native control; ignored by other modes",
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 20,
        default: 6,
        description: "Result limit. Brave LLM Context ignores it and keeps a 20-source grounding pool.",
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
  description: "Text-to-image discovery through Brave Images, with Serper Google Images as the availability fallback. Returns image URLs and source metadata; it cannot inspect an uploaded image or do reverse image search. Use the provider tools directly for country filtering.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", minLength: 1 },
      limit: { type: "integer", minimum: 1, maximum: 20, default: 10 },
      language: { type: "string", description: "Optional language preference for Brave/Serper" },
      safesearch: { type: "string", enum: ["strict", "off"], default: "strict", description: "Applied by Brave; the fallback uses its own safety behavior" },
    },
    required: ["query"],
    additionalProperties: false,
  },
  annotations: READ_ONLY_OPEN,
};

export const FETCH_TOOL: Tool = {
  name: "fetch_auto",
  title: "Read a known URL",
  description: "Fetch the readable content of one known URL through Exa, Tavily, Firecrawl, LinkUp, or AnySearch, falling back when a reader returns nothing usable. quality=max leads with Firecrawl (JavaScript rendering). Use instead of searching for a URL you already have.",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", minLength: 1, description: "http(s) URL to read" },
      quality: { type: "string", enum: ["balanced", "max"], default: "balanced" },
      maxChars: { type: "integer", minimum: 500, maximum: 100000, default: 12000, description: "Longest content returned; longer pages are truncated with a marker" },
    },
    required: ["url"],
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
  description: "Lean profile only. Without arguments, list every provider tool by name with a one-line summary; filter with provider. With name, return that tool's full description and input schema, which provider_call requires.",
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
  description: "Lean profile only. Call any provider tool by its exposed name. Read its schema with provider_tools first. Tools that crawl, research, or modify state keep their own side effects: only call those when the user asked for them.",
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
