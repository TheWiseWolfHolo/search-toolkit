import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { HttpError, parseRetryAfter, statusFromError } from "../errors.js";
import { callWithRotation } from "../keys.js";
import { renderPayload } from "../render.js";
import type { RotationStore } from "../rotation.js";
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

  private call(tool: string, args: Record<string, unknown>): Promise<unknown> {
    return callWithRotation(this.rotation, this.name, this.config.keys, (selection) =>
      this.callWith(selection, tool, args));
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
      const route = { provider: this.name, tool, upstreamTool: tool };
      return {
        // Model-visible content: one compact route block, then readable text.
        content: [
          { type: "text", text: JSON.stringify({ searchToolkitRoute: route }) },
          { type: "text", text: renderPayload(payload) },
        ],
        structuredContent: {
          provider: this.name,
          tool,
          route,
          keySlot: selection.masked,
          latencyMs,
          data: payload,
        },
        _meta: {
          searchToolkit: { provider: this.name, upstreamTool: tool, keySlot: selection.masked, latencyMs, route },
        },
      };
    } catch (error) {
      const latencyMs = Math.round(performance.now() - started);
      const status = statusFromError(error);
      this.rotation.record(selection, {
        ok: false,
        latencyMs,
        ...(status ? { httpStatus: status } : {}),
        ...(error instanceof HttpError && error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}),
      });
      throw error;
    }
  }
}

export function baseUrlOf(config: ProviderConfig, fallback: string): string {
  return config.integration.kind === "rest" && config.integration.baseUrl ? config.integration.baseUrl : fallback;
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
    throw new HttpError(`HTTP ${response.status}: ${safe}`, response.status, parseRetryAfter(response.headers.get("retry-after")));
  }
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    // A 200 with a non-JSON body is a gateway or captive-page problem, not a request error.
    throw new HttpError(`HTTP 502: non-JSON response (${text.slice(0, 80).replace(/\s+/g, " ")})`, 502);
  }
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
