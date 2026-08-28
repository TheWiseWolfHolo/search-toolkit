import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { statusFromError, shouldRetryWithNextKey } from "./errors.js";
import type { KeySelection, ProviderConfig, ToolBinding } from "./types.js";
import { maskKey, RotationStore } from "./rotation.js";

export const DEFAULT_FIRECRAWL_TOOLS = [
  "firecrawl_scrape",
  "firecrawl_map",
  "firecrawl_search",
  "firecrawl_crawl",
  "firecrawl_check_crawl_status",
  "firecrawl_developer_search",
  "firecrawl_research_search_github",
] as const;

interface ClientEntry {
  client: Client;
  close(): Promise<void>;
}

export class UpstreamMcpProvider {
  private readonly clients = new Map<number, Promise<ClientEntry>>();
  private discovered: Tool[] | undefined;

  constructor(
    readonly name: string,
    private readonly config: ProviderConfig,
    private readonly rotation: RotationStore,
  ) {}

  async bindings(): Promise<ToolBinding[]> {
    const tools = filterUpstreamTools(this.name, this.config, await this.discoverTools());
    return tools.map((tool) => {
      const exposedName = `${this.name}_${sanitizeName(tool.name)}`;
      return {
        provider: this.name,
        upstreamName: tool.name,
        exposed: {
          ...tool,
          name: exposedName,
          title: tool.title ? `${this.name}: ${tool.title}` : `${this.name}: ${tool.name}`,
          description: `[Official ${this.name} MCP; rotating ${this.config.keys.length} configured key(s)] ${tool.description ?? ""}`,
          annotations: safeToolAnnotations(tool),
        },
        call: async (arguments_: Record<string, unknown>) => this.call(tool.name, arguments_),
      };
    });
  }

  async close(): Promise<void> {
    const entries = await Promise.allSettled(this.clients.values());
    await Promise.allSettled(entries.flatMap((entry) => entry.status === "fulfilled" ? [entry.value.close()] : []));
  }

  private async discoverTools(): Promise<Tool[]> {
    if (this.discovered) return this.discovered;
    const key = this.config.keys[0];
    if (!key) throw new Error(`${this.name} has no API key for MCP discovery`);
    const selection: KeySelection = { provider: this.name, slot: 0, key, masked: maskKey(key) };
    const entry = await this.clientFor(selection);
    const result = await entry.client.listTools();
    this.discovered = result.tools;
    return result.tools;
  }

  private async call(upstreamName: string, arguments_: Record<string, unknown>): Promise<unknown> {
    const first = this.rotation.select(this.name, this.config.keys);
    try {
      return await this.callWith(first, upstreamName, arguments_);
    } catch (error) {
      const status = statusFromError(error);
      if (this.config.keys.length < 2 || !shouldRetryWithNextKey(status)) throw error;
      const next = this.rotation.select(this.name, this.config.keys);
      return this.callWith(next, upstreamName, arguments_);
    }
  }

  private async callWith(
    selection: KeySelection,
    upstreamName: string,
    arguments_: Record<string, unknown>,
  ): Promise<unknown> {
    const started = performance.now();
    try {
      const entry = await this.clientFor(selection);
      const result = await entry.client.callTool({ name: upstreamName, arguments: arguments_ });
      const latencyMs = Math.round(performance.now() - started);
      if (result.isError) {
        const text = JSON.stringify(result.content);
        throw new Error(`${this.name} upstream tool error: ${text.slice(0, 500)}`);
      }
      this.rotation.record(selection, { ok: true, latencyMs });
      return appendRotationMetadata(result, this.name, upstreamName, selection.masked, latencyMs);
    } catch (error) {
      const latencyMs = Math.round(performance.now() - started);
      const httpStatus = statusFromError(error);
      this.rotation.record(selection, { ok: false, latencyMs, ...(httpStatus ? { httpStatus } : {}) });
      throw error;
    }
  }

  private clientFor(selection: KeySelection): Promise<ClientEntry> {
    let pending = this.clients.get(selection.slot);
    if (!pending) {
      pending = this.createClient(selection);
      this.clients.set(selection.slot, pending);
    }
    return pending;
  }

  private async createClient(selection: KeySelection): Promise<ClientEntry> {
    const client = new Client(
      { name: `search-toolkit-${this.name}-${selection.slot}`, version: "0.1.0" },
      { capabilities: {} },
    );
    const integration = this.config.integration;
    if (integration.kind === "remote_mcp") {
      const url = new URL(integration.url);
      const headers = new Headers(integration.headers ?? {});
      if (integration.auth.kind === "query") url.searchParams.set(integration.auth.name, selection.key);
      if (integration.auth.kind === "header") headers.set(integration.auth.name, selection.key);
      if (integration.auth.kind === "bearer") headers.set("Authorization", `Bearer ${selection.key}`);
      const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers } });
      // SDK v1.29's optional sessionId property conflicts with projects that
      // enable exactOptionalPropertyTypes, though the runtime transport is valid.
      await client.connect(transport as unknown as Transport);
      return { client, close: async () => transport.close() };
    }
    if (integration.kind === "stdio_mcp") {
      const command = process.platform === "win32" && integration.command === "npx" ? "npx.cmd" : integration.command;
      const transport = new StdioClientTransport({
        command,
        args: integration.args,
        env: {
          ...process.env,
          ...integration.env,
          [integration.envKey]: selection.key,
        } as Record<string, string>,
        stderr: "pipe",
      });
      await client.connect(transport);
      return { client, close: async () => transport.close() };
    }
    throw new Error(`${this.name} is not an MCP integration`);
  }
}

function sanitizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
}

export function filterUpstreamTools(provider: string, config: ProviderConfig, tools: Tool[]): Tool[] {
  const defaultAllow = provider === "firecrawl" ? [...DEFAULT_FIRECRAWL_TOOLS] : undefined;
  const allow = config.toolPolicy?.allow ?? defaultAllow;
  const deny = new Set(config.toolPolicy?.deny ?? []);
  return tools.filter((tool) => {
    const allowed = !allow || allow.includes("*") || allow.includes(tool.name);
    return allowed && !deny.has(tool.name);
  });
}

export function safeToolAnnotations(tool: Tool): Tool["annotations"] {
  const annotations = { ...tool.annotations };
  const name = tool.name.toLowerCase();
  const destructive = /(?:^|_)(?:delete|remove|destroy|revoke)(?:_|$)/.test(name);
  const retrieval = /(?:^|_)(?:search|fetch|scrape|map|list|get|status|check|read|inspect|related)(?:_|$)/.test(name);
  const explicitWrite = /(?:^|_)(?:create|update|patch|set|run|start|stop|feedback|interact)(?:_|$)/.test(name);
  const job = /(?:^|_)(?:agent|crawl|extract|parse|research)(?:_|$)/.test(name);
  if (destructive) return { ...annotations, readOnlyHint: false, destructiveHint: true };
  if (explicitWrite) return { ...annotations, readOnlyHint: false, destructiveHint: false };
  if (retrieval) return { ...annotations, readOnlyHint: true, destructiveHint: false };
  if (job) return { ...annotations, readOnlyHint: false, destructiveHint: false };
  return annotations;
}

function appendRotationMetadata(
  result: unknown,
  provider: string,
  upstreamTool: string,
  masked: string,
  latencyMs: number,
): unknown {
  if (!result || typeof result !== "object") return result;
  const record = result as Record<string, unknown>;
  const meta = record._meta && typeof record._meta === "object"
    ? record._meta as Record<string, unknown>
    : {};
  const searchToolkitMeta = meta.searchToolkit && typeof meta.searchToolkit === "object"
    ? meta.searchToolkit as Record<string, unknown>
    : {};
  return {
    ...record,
    _meta: {
      ...meta,
      searchToolkit: { ...searchToolkitMeta, provider, upstreamTool, keySlot: masked, latencyMs },
    },
  };
}
