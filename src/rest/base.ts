import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { HttpError, shouldRetryWithNextKey, statusFromError } from "../errors.js";
import { RotationStore } from "../rotation.js";
import type { KeySelection, ProviderConfig, ToolBinding } from "../types.js";

export interface RestAdapter {
  tools(provider: string): Tool[];
  call(tool: string, args: Record<string, unknown>, key: string, config: ProviderConfig): Promise<unknown>;
}

export class RestProvider {
  constructor(
    readonly name: string,
    private readonly config: ProviderConfig,
    private readonly rotation: RotationStore,
    private readonly adapter: RestAdapter,
  ) {}

  bindings(): ToolBinding[] {
    return this.adapter.tools(this.name).map((tool) => ({
      provider: this.name,
      upstreamName: tool.name,
      exposed: tool,
      call: async (arguments_: Record<string, unknown>) => this.call(tool.name, arguments_),
    }));
  }

  private async call(tool: string, args: Record<string, unknown>): Promise<unknown> {
    const first = this.rotation.select(this.name, this.config.keys);
    try {
      return await this.callWith(first, tool, args);
    } catch (error) {
      const status = statusFromError(error);
      if (this.config.keys.length < 2 || !shouldRetryWithNextKey(status)) throw error;
      return this.callWith(this.rotation.select(this.name, this.config.keys), tool, args);
    }
  }

  private async callWith(
    selection: KeySelection,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const started = performance.now();
    try {
      const payload = await this.adapter.call(tool, args, selection.key, this.config);
      const latencyMs = Math.round(performance.now() - started);
      this.rotation.record(selection, { ok: true, latencyMs, httpStatus: 200 });
      const structuredContent = {
        provider: this.name,
        keySlot: selection.masked,
        latencyMs,
        data: payload,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(structuredContent) }],
        structuredContent,
        _meta: { searchToolkit: { provider: this.name, upstreamTool: tool, keySlot: selection.masked, latencyMs } },
      };
    } catch (error) {
      const latencyMs = Math.round(performance.now() - started);
      const status = statusFromError(error);
      this.rotation.record(selection, { ok: false, latencyMs, ...(status ? { httpStatus: status } : {}) });
      throw error;
    }
  }
}

export async function requestJson(
  url: string,
  init: RequestInit,
  timeoutMs = 15_000,
): Promise<Record<string, unknown>> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const text = await response.text();
  if (!response.ok) {
    const safe = text.replace(/[A-Za-z0-9_-]{24,}/g, "<redacted>").slice(0, 500);
    throw new HttpError(`HTTP ${response.status}: ${safe}`, response.status);
  }
  return JSON.parse(text) as Record<string, unknown>;
}

export function searchTool(name: string, title: string, description: string, extra: Record<string, unknown> = {}): Tool {
  return {
    name,
    title,
    description,
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1, description: "Search query" },
        limit: { type: "integer", minimum: 1, maximum: 20, default: 6 },
        ...extra,
      },
      required: ["query"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  };
}
