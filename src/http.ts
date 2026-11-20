import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { NextFunction, Request, Response } from "express";
import { createProtocolServer } from "./server-factory.js";
import { SearchToolkit } from "./toolkit.js";
import type { ToolkitProfile } from "./types.js";

const MAX_HTTP_REQUEST_BYTES = 100 * 1024;
const MAX_HTTP_TOOL_INPUT_ELEMENTS = 10_000;
const PROFILES: readonly ToolkitProfile[] = ["full", "curated", "lean"];

export interface HttpTokenPolicy {
  hash: string;
  /** Optional profile override for this token ("full", "curated", or "lean"). */
  profile?: ToolkitProfile;
  tools?: string[];
  requestsPerMinute?: number;
  maxSessions?: number;
  /** Allowed values per argument name, for any tool; an omitted argument is allowed. Example: {"depth": ["fast", "deep"]}. */
  allowedArgumentValues?: Record<string, string[]>;
}

interface HttpOptions {
  tokens: HttpTokenPolicy[];
  host?: string;
  allowedHosts?: string[];
  allowedOrigins?: string[];
  sessionTtlMs?: number;
  /** Serve each HTTP request with a fresh stateless MCP transport (no session expiry or restart 404s). */
  stateless?: boolean;
  /** Optional owner-only hook for POST /admin/reload; returns a freshly initialized SearchToolkit. */
  onReload?: () => Promise<SearchToolkit>;
  /** Optional owner-only hook for POST /admin/shutdown; runs graceful process exit after replying 200. */
  onShutdown?: () => Promise<void>;
}

interface Session {
  tokenId: number;
  transport: StreamableHTTPServerTransport;
  lastSeenAt: number;
}

interface ParsedTokenPolicy {
  hash: Buffer;
  profile?: ToolkitProfile;
  tools?: Set<string>;
  requestsPerMinute?: number;
  maxSessions?: number;
  allowedArgumentValues?: Map<string, Set<string>>;
}

export function createSearchToolkitHttpApp(toolkit: SearchToolkit, options: HttpOptions) {
  const tokens = options.tokens.map(parseTokenPolicy);
  if (!tokens.length) throw new Error("At least one Search Toolkit HTTP token policy is required");
  const host = options.host ?? "127.0.0.1";
  const app = createMcpExpressApp({ host, ...(options.allowedHosts ? { allowedHosts: options.allowedHosts } : {}) });
  app.disable("x-powered-by");
  const allowedOrigins = new Set(options.allowedOrigins ?? []);
  const sessions = new Map<string, Session>();
  const pendingInits = new Map<number, number>();
  const sessionTtlMs = boundedInteger(options.sessionTtlMs, 30 * 60_000, 1_000, 24 * 60 * 60_000);
  const stateless = options.stateless === true;
  const rateWindows = new Map<number, { startedAt: number; count: number }>();
  let currentToolkit = toolkit;
  let appClosed = false;
  const activeCalls = new WeakMap<SearchToolkit, number>();
  const retiredToolkits = new Map<SearchToolkit, NodeJS.Timeout>();
  let reloadInFlight: Promise<{ tools: number; warnings: string[] }> | undefined;

  const acquireToolkit = (): SearchToolkit => {
    const tk = currentToolkit;
    activeCalls.set(tk, (activeCalls.get(tk) ?? 0) + 1);
    return tk;
  };

  const releaseToolkit = (tk: SearchToolkit): void => {
    const remaining = Math.max(0, (activeCalls.get(tk) ?? 1) - 1);
    activeCalls.set(tk, remaining);
    if (remaining === 0 && retiredToolkits.has(tk)) {
      const timer = retiredToolkits.get(tk);
      if (timer) clearTimeout(timer);
      retiredToolkits.delete(tk);
      void tk.close().catch(() => undefined);
    }
  };

  const retireToolkit = (previous: SearchToolkit): void => {
    if ((activeCalls.get(previous) ?? 0) === 0) {
      void previous.close().catch(() => undefined);
      return;
    }
    const timer = setTimeout(() => {
      retiredToolkits.delete(previous);
      void previous.close().catch(() => undefined);
    }, 15_000);
    timer.unref();
    retiredToolkits.set(previous, timer);
  };

  const isOwnerPolicy = (policy: ParsedTokenPolicy | undefined): boolean =>
    Boolean(
      policy
      && !policy.tools
      && !policy.allowedArgumentValues
      && policy.requestsPerMinute === undefined
      && policy.maxSessions === undefined,
    );

  const protocolOptionsFor = (tokenId: number, policy: ParsedTokenPolicy) => ({
    maxToolInputElements: MAX_HTTP_TOOL_INPUT_ELEMENTS,
    ...(policy.profile ? { profile: policy.profile } : {}),
    ...(policy.tools ? { allowTool: (tool: { name: string }) => policy.tools?.has(tool.name) === true } : {}),
    ...(policy.tools || policy.requestsPerMinute || policy.allowedArgumentValues
      ? {
        beforeCall: (toolName: string, arguments_: Record<string, unknown>) => {
          if (policy.requestsPerMinute) enforceRateLimit(tokenId, policy.requestsPerMinute, rateWindows);
          if (toolName === "provider_call") {
            const target = typeof arguments_.name === "string" ? arguments_.name : "";
            if (policy.tools && !policy.tools.has(target)) {
              throw new Error(`Tool ${target || "(missing)"} is not available for this token`);
            }
            if (policy.allowedArgumentValues && arguments_.arguments && typeof arguments_.arguments === "object" && !Array.isArray(arguments_.arguments)) {
              enforceArgumentValues(target || toolName, arguments_.arguments as Record<string, unknown>, policy.allowedArgumentValues);
            }
          }
          if (toolName === "search_rotation_probe" && policy.tools && typeof arguments_.tool === "string" && !policy.tools.has(arguments_.tool)) {
            throw new Error(`Tool ${arguments_.tool} is not available for this token`);
          }
          if (policy.allowedArgumentValues) enforceArgumentValues(toolName, arguments_, policy.allowedArgumentValues);
        },
      }
      : {}),
  });

  app.get("/healthz", (_request: Request, response: Response) => {
    response.json({ ok: true, mode: stateless ? "stateless" : "stateful" });
  });

  if (options.onReload) {
    const reloadHandler = options.onReload;
    app.post("/admin/reload", async (request: Request, response: Response) => {
      const origin = request.get("origin");
      if (origin && !allowedOrigins.has(origin)) {
        response.status(403).json(protocolError(-32_000, "Origin is not allowed"));
        return;
      }
      const tokenId = authenticate(request.get("authorization"), tokens);
      if (tokenId === undefined) {
        response.set("WWW-Authenticate", "Bearer");
        response.status(401).json(protocolError(-32_001, "Unauthorized"));
        return;
      }
      if (!isOwnerPolicy(tokens[tokenId])) {
        response.status(403).json(protocolError(-32_001, "Owner token required"));
        return;
      }
      try {
        if (!reloadInFlight) {
          reloadInFlight = (async () => {
            const nextToolkit = await reloadHandler();
            if (appClosed) {
              await nextToolkit.close().catch(() => undefined);
              throw new Error("Server is shutting down");
            }
            const previous = currentToolkit;
            currentToolkit = nextToolkit;
            await Promise.allSettled(Array.from(sessions.values(), (session) => session.transport.close()));
            sessions.clear();
            if (previous !== nextToolkit) retireToolkit(previous);
            return {
              tools: currentToolkit.listTools().length,
              warnings: [...currentToolkit.warnings],
            };
          })().finally(() => { reloadInFlight = undefined; });
        }
        const summary = await reloadInFlight;
        response.json({ ok: true, ...summary });
      } catch (error) {
        response.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    });
  }

  if (options.onShutdown) {
    const shutdownHandler = options.onShutdown;
    app.post("/admin/shutdown", (request: Request, response: Response) => {
      const origin = request.get("origin");
      if (origin && !allowedOrigins.has(origin)) {
        response.status(403).json(protocolError(-32_000, "Origin is not allowed"));
        return;
      }
      const tokenId = authenticate(request.get("authorization"), tokens);
      if (tokenId === undefined) {
        response.set("WWW-Authenticate", "Bearer");
        response.status(401).json(protocolError(-32_001, "Unauthorized"));
        return;
      }
      if (!isOwnerPolicy(tokens[tokenId])) {
        response.status(403).json(protocolError(-32_001, "Owner token required"));
        return;
      }
      response.json({ ok: true });
      setTimeout(() => { void shutdownHandler().catch(() => undefined); }, 50).unref();
    });
  }

  app.all("/mcp", async (request: Request, response: Response) => {
    const origin = request.get("origin");
    if (origin && !allowedOrigins.has(origin)) {
      response.status(403).json(protocolError(-32_000, "Origin is not allowed"));
      return;
    }
    const tokenId = authenticate(request.get("authorization"), tokens);
    if (tokenId === undefined) {
      response.set("WWW-Authenticate", "Bearer");
      response.status(401).json(protocolError(-32_001, "Unauthorized"));
      return;
    }
    const policy = tokens[tokenId];
    if (!policy) {
      response.status(401).json(protocolError(-32_001, "Unauthorized"));
      return;
    }

    if (stateless) {
      if (request.method === "GET") {
        response.set("Allow", "POST, DELETE");
        response.status(405).json(protocolError(-32_000, "Method Not Allowed"));
        return;
      }
      if (request.method === "DELETE") {
        response.status(200).json({ ok: true });
        return;
      }
      if (request.method !== "POST") {
        response.set("Allow", "POST, DELETE");
        response.status(405).json(protocolError(-32_000, "Method Not Allowed"));
        return;
      }
      const active = acquireToolkit();
      const server = createProtocolServer(active, protocolOptionsFor(tokenId, policy));
      const transport = new StreamableHTTPServerTransport({
        maxRequestBodySize: MAX_HTTP_REQUEST_BYTES,
      });
      response.once("close", () => {
        void transport.close().catch(() => undefined);
        void server.close().catch(() => undefined);
      });
      try {
        await server.connect(transport);
        await transport.handleRequest(request, response, request.body);
      } catch (error) {
        console.error("Search Toolkit stateless HTTP request failed", error);
        if (!response.headersSent) response.status(500).json(protocolError(-32_603, "Internal server error"));
      } finally {
        await transport.close().catch(() => undefined);
        await server.close().catch(() => undefined);
        releaseToolkit(active);
      }
      return;
    }

    const sessionId = request.get("mcp-session-id");
    const existing = sessionId ? sessions.get(sessionId) : undefined;
    if (existing) {
      if (existing.tokenId !== tokenId) {
        response.status(403).json(protocolError(-32_001, "Session token mismatch"));
        return;
      }
      existing.lastSeenAt = Date.now();
      try {
        await existing.transport.handleRequest(request, response, request.body);
      } catch (error) {
        console.error("Search Toolkit HTTP session request failed", error);
        if (!response.headersSent) response.status(500).json(protocolError(-32_603, "Internal server error"));
      }
      return;
    }
    if (sessionId) {
      response.status(404).json(protocolError(-32_001, "Session not found"));
      return;
    }
    if (request.method !== "POST" || !isInitializeRequest(request.body)) {
      response.status(400).json(protocolError(-32_600, "An initialize request is required"));
      return;
    }

    const activeSessions = policy.maxSessions === undefined
      ? 0
      : Array.from(sessions.values()).filter((session) => session.tokenId === tokenId).length + (pendingInits.get(tokenId) ?? 0);
    if (policy.maxSessions !== undefined && activeSessions >= policy.maxSessions) {
      response.status(429).json(protocolError(-32_000, "Too many active sessions for this token"));
      return;
    }
    pendingInits.set(tokenId, (pendingInits.get(tokenId) ?? 0) + 1);
    const server = createProtocolServer(currentToolkit, protocolOptionsFor(tokenId, policy));
    const transport = new StreamableHTTPServerTransport({
      maxRequestBodySize: MAX_HTTP_REQUEST_BYTES,
      sessionIdGenerator: randomUUID,
      onsessioninitialized: (id) => {
        sessions.set(id, { tokenId, transport, lastSeenAt: Date.now() });
      },
    });
    transport.onclose = () => {
      const id = transport.sessionId;
      if (id) sessions.delete(id);
    };
    try {
      await server.connect(transport);
      await transport.handleRequest(request, response, request.body);
      if (!transport.sessionId) {
        await transport.close().catch(() => undefined);
      }
    } catch (error) {
      console.error("Search Toolkit HTTP request failed", error);
      await transport.close().catch(() => undefined);
      if (!response.headersSent) response.status(500).json(protocolError(-32_603, "Internal server error"));
    } finally {
      const remaining = (pendingInits.get(tokenId) ?? 1) - 1;
      if (remaining > 0) pendingInits.set(tokenId, remaining);
      else pendingInits.delete(tokenId);
    }
  });

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    if (response.headersSent) return;
    const status = typeof (error as { status?: unknown })?.status === "number"
      ? (error as { status: number }).status
      : typeof (error as { statusCode?: unknown })?.statusCode === "number"
        ? (error as { statusCode: number }).statusCode
        : 500;
    if (status === 413) {
      response.status(413).json(protocolError(-32_600, "Request body exceeds limit"));
      return;
    }
    if (status >= 400 && status < 500) {
      response.status(status).json(protocolError(-32_700, "Invalid request body"));
      return;
    }
    response.status(500).json(protocolError(-32_603, "Internal server error"));
  });

  const cleanupTimer = stateless
    ? undefined
    : setInterval(() => {
        const cutoff = Date.now() - sessionTtlMs;
        for (const session of sessions.values()) {
          if (session.lastSeenAt < cutoff) void session.transport.close().catch(() => undefined);
        }
      }, Math.min(sessionTtlMs, 60_000));
  cleanupTimer?.unref();

  return {
    app,
    currentToolkit: () => currentToolkit,
    close: async () => {
      appClosed = true;
      if (cleanupTimer) clearInterval(cleanupTimer);
      if (reloadInFlight) await reloadInFlight.catch(() => undefined);
      await Promise.allSettled(Array.from(sessions.values(), (session) => session.transport.close()));
      sessions.clear();
      const retired = Array.from(retiredToolkits.entries());
      retiredToolkits.clear();
      for (const [, timer] of retired) clearTimeout(timer);
      await Promise.allSettled(retired.map(([tk]) => tk.close()));
    },
  };
}

function authenticate(value: string | undefined, policies: ParsedTokenPolicy[]): number | undefined {
  if (!value?.startsWith("Bearer ")) return undefined;
  const digest = createHash("sha256").update(value.slice(7)).digest();
  const index = policies.findIndex((policy) => policy.hash.length === digest.length && timingSafeEqual(policy.hash, digest));
  return index >= 0 ? index : undefined;
}

function parseTokenPolicy(policy: HttpTokenPolicy): ParsedTokenPolicy {
  const profile = policy.profile;
  if (profile !== undefined && !PROFILES.includes(profile)) {
    throw new Error(`HTTP token profile must be "full", "curated", or "lean"`);
  }
  const tools = policy.tools ? new Set(policy.tools) : undefined;
  const requestsPerMinute = policy.requestsPerMinute;
  const maxSessions = policy.maxSessions;
  if (requestsPerMinute !== undefined && (!Number.isInteger(requestsPerMinute) || requestsPerMinute < 1)) {
    throw new Error("HTTP token requestsPerMinute must be a positive integer");
  }
  if (maxSessions !== undefined && (!Number.isInteger(maxSessions) || maxSessions < 1)) {
    throw new Error("HTTP token maxSessions must be a positive integer");
  }
  const allowedArgumentValues = policy.allowedArgumentValues
    ? new Map(Object.entries(policy.allowedArgumentValues).map(([name, values]) => [name, new Set(values)]))
    : undefined;
  return {
    hash: parseTokenHash(policy.hash),
    ...(profile ? { profile } : {}),
    ...(tools ? { tools } : {}),
    ...(requestsPerMinute !== undefined ? { requestsPerMinute } : {}),
    ...(maxSessions !== undefined ? { maxSessions } : {}),
    ...(allowedArgumentValues ? { allowedArgumentValues } : {}),
  };
}

function enforceArgumentValues(toolName: string, arguments_: Record<string, unknown>, allowed: Map<string, Set<string>>): void {
  for (const [name, values] of allowed) {
    const value = arguments_[name];
    if (value === undefined) continue;
    if (!values.has(String(value))) {
      throw new Error(`${toolName}: ${name}=${String(value)} is not allowed for this token (allowed: ${Array.from(values).join(", ")})`);
    }
  }
}

function parseTokenHash(value: string): Buffer {
  if (!/^[a-f0-9]{64}$/i.test(value)) throw new Error("HTTP token hashes must be SHA-256 hex strings");
  return Buffer.from(value, "hex");
}

function enforceRateLimit(
  tokenId: number,
  requestsPerMinute: number,
  windows: Map<number, { startedAt: number; count: number }>,
): void {
  const now = Date.now();
  const current = windows.get(tokenId);
  if (!current || now - current.startedAt >= 60_000) {
    windows.set(tokenId, { startedAt: now, count: 1 });
    return;
  }
  if (current.count >= requestsPerMinute) {
    throw new Error(`Rate limit exceeded for this token (${requestsPerMinute} tool calls per minute)`);
  }
  current.count += 1;
}

export function parseHttpTokenPolicies(value: string | undefined): HttpTokenPolicy[] {
  if (!value) throw new Error("SEARCH_TOOLKIT_HTTP_TOKENS is required");
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("SEARCH_TOOLKIT_HTTP_TOKENS must be a non-empty JSON array");
  }
  return parsed.map((value_, index) => {
    if (!value_ || typeof value_ !== "object") throw new Error(`HTTP token policy ${index} must be an object`);
    const record = value_ as Record<string, unknown>;
    if (typeof record.hash !== "string") throw new Error(`HTTP token policy ${index} requires hash`);
    if (record.profile !== undefined && !PROFILES.includes(record.profile as ToolkitProfile)) {
      throw new Error(`HTTP token policy ${index} profile must be "full", "curated", or "lean"`);
    }
    if (record.tools !== undefined && (!Array.isArray(record.tools) || record.tools.some((tool) => typeof tool !== "string"))) {
      throw new Error(`HTTP token policy ${index} tools must be a string array`);
    }
    if (record.requestsPerMinute !== undefined && (!Number.isInteger(record.requestsPerMinute) || Number(record.requestsPerMinute) < 1)) {
      throw new Error(`HTTP token policy ${index} requestsPerMinute must be a positive integer`);
    }
    if (record.maxSessions !== undefined && (!Number.isInteger(record.maxSessions) || Number(record.maxSessions) < 1)) {
      throw new Error(`HTTP token policy ${index} maxSessions must be a positive integer`);
    }
    const argumentValues = record.allowedArgumentValues;
    if (argumentValues !== undefined && (
      !argumentValues || typeof argumentValues !== "object" || Array.isArray(argumentValues)
      || Object.values(argumentValues).some((values) => !Array.isArray(values) || values.some((value) => typeof value !== "string"))
    )) {
      throw new Error(`HTTP token policy ${index} allowedArgumentValues must map argument names to string arrays`);
    }
    return {
      hash: record.hash,
      ...(record.profile !== undefined ? { profile: record.profile as ToolkitProfile } : {}),
      ...(record.tools !== undefined ? { tools: record.tools as string[] } : {}),
      ...(record.requestsPerMinute !== undefined ? { requestsPerMinute: Number(record.requestsPerMinute) } : {}),
      ...(record.maxSessions !== undefined ? { maxSessions: Number(record.maxSessions) } : {}),
      ...(argumentValues !== undefined ? { allowedArgumentValues: argumentValues as Record<string, string[]> } : {}),
    };
  });
}

export function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  return value !== undefined && Number.isFinite(value) && Number.isInteger(value) && value >= minimum && value <= maximum
    ? value
    : fallback;
}

function protocolError(code: number, message: string) {
  return { jsonrpc: "2.0", error: { code, message }, id: null };
}
