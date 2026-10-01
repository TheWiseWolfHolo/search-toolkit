import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  isConnectionFailure,
  keyFaultStatusFromToolText,
  statusFromError,
  textOfContent,
  ToolResultError,
} from "./errors.js";
import { callWithRotation } from "./keys.js";
import { keyFingerprint, maskKey, type RotationStore } from "./rotation.js";
import type { KeySelection, ProviderConfig, ToolBinding } from "./types.js";
import { PACKAGE_VERSION } from "./version.js";

export const DEFAULT_FIRECRAWL_TOOLS = [
  "firecrawl_scrape",
  "firecrawl_map",
  "firecrawl_search",
  "firecrawl_crawl",
  "firecrawl_check_crawl_status",
  "firecrawl_developer_search",
  "firecrawl_research_search_github",
] as const;

const DISCOVERY_TIMEOUT_MS = 25_000;

interface ClientEntry {
  client: Client;
  close(): Promise<void>;
}

export class UpstreamMcpProvider {
  private readonly clients = new Map<string, Promise<ClientEntry>>();

  constructor(
    readonly name: string,
    private readonly config: ProviderConfig,
    private readonly rotation: RotationStore,
  ) {}

  /** Wrap discovered upstream tools as exposed bindings; descriptions are shaped later by the toolkit. */
  bindingsFor(discovered: Tool[]): ToolBinding[] {
    return filterUpstreamTools(this.name, this.config, discovered).map((tool) => ({
      provider: this.name,
      upstreamName: tool.name,
      exposed: {
        ...tool,
        name: `${this.name}_${sanitizeName(tool.name)}`,
        title: tool.title ? `${this.name}: ${tool.title}` : `${this.name}: ${tool.name}`,
        description: tool.description ?? "",
        annotations: safeToolAnnotations(tool),
      },
      call: async (arguments_: Record<string, unknown>) => this.call(tool.name, arguments_),
    }));
  }

  async close(): Promise<void> {
    const entries = await Promise.allSettled(this.clients.values());
    this.clients.clear();
    await Promise.allSettled(entries.flatMap((entry) => entry.status === "fulfilled" ? [entry.value.close()] : []));
  }

  /** List the live upstream catalog, falling back across keys so one bad key cannot hide a provider. */
  async discover(): Promise<Tool[]> {
    const keys = this.config.keys;
    if (!keys.length) throw new Error(`${this.name} has no API key for MCP discovery`);
    const usable = this.rotation.usableSlots(this.name, keys);
    const order = usable.length ? usable : keys.map((_, slot) => slot);
    let lastError: unknown;
    for (const slot of order) {
      const key = keys[slot] as string;
      const selection = selectionFor(this.name, slot, key);
      try {
        const entry = await withTimeout(this.clientFor(selection), DISCOVERY_TIMEOUT_MS, `${this.name} connect`);
        return await withTimeout(listAllTools(entry.client), DISCOVERY_TIMEOUT_MS, `${this.name} tools/list`);
      } catch (error) {
        lastError = error;
        await this.dropClient(selection);
        const status = statusFromError(error);
        if (status === 401 || status === 402 || status === 403 || status === 429) {
          this.rotation.record(selection, { ok: false, latencyMs: 0, httpStatus: status });
        }
      }
    }
    throw lastError;
  }

  private call(upstreamName: string, arguments_: Record<string, unknown>): Promise<unknown> {
    return callWithRotation(this.rotation, this.name, this.config.keys, (selection) =>
      this.callWith(selection, upstreamName, arguments_));
  }

  private async callWith(
    selection: KeySelection,
    upstreamName: string,
    arguments_: Record<string, unknown>,
  ): Promise<unknown> {
    const started = performance.now();
    try {
      const result = await this.invoke(selection, upstreamName, arguments_);
      const latencyMs = Math.round(performance.now() - started);
      if (result.isError) {
        const text = textOfContent(result.content);
        const keyFault = keyFaultStatusFromToolText(text);
        if (keyFault) {
          throw new ToolResultError(`${this.name} upstream tool error: ${text.slice(0, 500)}`, result.content as unknown[], keyFault);
        }
        // The key and transport worked; the tool rejected this particular request.
        this.rotation.record(selection, { ok: true, latencyMs, toolError: true });
        return appendRotationMetadata(result, this.name, upstreamName, selection.masked, latencyMs);
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

  /** One tool call; a dead transport (closed stdio child, expired session) is rebuilt once on the same key. */
  private async invoke(selection: KeySelection, upstreamName: string, arguments_: Record<string, unknown>) {
    for (let attempt = 0; ; attempt += 1) {
      const entry = await this.clientFor(selection);
      try {
        return await entry.client.callTool({ name: upstreamName, arguments: arguments_ });
      } catch (error) {
        if (attempt > 0 || !isConnectionFailure(error)) throw error;
        await this.dropClient(selection);
      }
    }
  }

  private clientFor(selection: KeySelection): Promise<ClientEntry> {
    let pending = this.clients.get(selection.fingerprint);
    if (!pending) {
      const created = this.createClient(selection).then((entry) => {
        // A crashed child process or closed session must not stay cached.
        entry.client.onclose = () => {
          if (this.clients.get(selection.fingerprint) === created) this.clients.delete(selection.fingerprint);
        };
        return entry;
      });
      pending = created;
      this.clients.set(selection.fingerprint, created);
      // A failed connect must not poison the slot for the rest of the process.
      created.catch(() => {
        if (this.clients.get(selection.fingerprint) === created) this.clients.delete(selection.fingerprint);
      });
    }
    return pending;
  }

  private async dropClient(selection: KeySelection): Promise<void> {
    const pending = this.clients.get(selection.fingerprint);
    this.clients.delete(selection.fingerprint);
    if (!pending) return;
    const entry = await pending.catch(() => undefined);
    await entry?.close().catch(() => undefined);
  }

  private async createClient(selection: KeySelection): Promise<ClientEntry> {
    const client = new Client(
      { name: `search-toolkit-${this.name}-${selection.slot}`, version: PACKAGE_VERSION },
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
      // The SDK's optional sessionId property conflicts with projects that
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

export function selectionFor(provider: string, slot: number, key: string): KeySelection {
  return { provider, slot, key, masked: maskKey(key), fingerprint: keyFingerprint(key) };
}

async function listAllTools(client: Client): Promise<Tool[]> {
  const tools: Tool[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor ? { cursor } : {});
    tools.push(...page.tools);
    cursor = page.nextCursor;
  } while (cursor);
  return tools;
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function sanitizeName(name: string): string {
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
  const name = sanitizeName(tool.name);
  const destructive = /(?:^|_)(?:delete|remove|destroy|revoke)(?:_|$)/.test(name);
  const retrieval = /(?:^|_)(?:search|fetch|scrape|extract|map|list|get|status|check|read|inspect|related)(?:_|$)/.test(name);
  const explicitWrite = /(?:^|_)(?:create|update|patch|set|run|start|stop|feedback|interact)(?:_|$)/.test(name);
  const job = /(?:^|_)(?:agent|crawl|parse|research)(?:_|$)/.test(name);
  if (destructive) return { ...annotations, readOnlyHint: false, destructiveHint: true };
  if (explicitWrite) return { ...annotations, readOnlyHint: false, destructiveHint: false };
  if (retrieval) return { ...annotations, readOnlyHint: true, destructiveHint: false };
  if (job) return { ...annotations, readOnlyHint: false, destructiveHint: false };
  return annotations;
}

export function appendRotationMetadata(
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
  const route = {
    provider,
    tool: `${provider}_${sanitizeName(upstreamTool)}`,
    upstreamTool,
  };
  const content = Array.isArray(record.content) ? record.content : [];
  return {
    ...record,
    content: [{ type: "text", text: JSON.stringify({ searchToolkitRoute: route }) }, ...content],
    _meta: {
      ...meta,
      searchToolkit: { ...searchToolkitMeta, provider, upstreamTool, keySlot: masked, latencyMs, route },
    },
  };
}
