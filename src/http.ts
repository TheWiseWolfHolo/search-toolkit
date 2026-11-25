import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import express, { type NextFunction, type Request, type Response } from "express";
import { createProtocolServer } from "./server-factory.js";
import { SearchToolkit } from "./toolkit.js";
import type { ToolkitProfile } from "./types.js";

const MAX_HTTP_REQUEST_BYTES = 100 * 1024;
const MAX_HTTP_TOOL_INPUT_ELEMENTS = 10_000;
const DEFAULT_MAX_TOTAL_SESSIONS = 256;
const DEFAULT_AUTH_FAILURES_PER_MINUTE = 30;
const DEFAULT_INITS_PER_MINUTE = 60;
const MAX_TRACKED_AUTH_IPS = 10_000;
const PROFILES: readonly ToolkitProfile[] = ["full", "curated", "lean"];
const ROLES = new Set(["owner", "client"]);

export interface HttpTokenPolicy {
  hash: string;
  /** Explicit access role; "owner" grants admin endpoints and live quota refresh. */
  role?: "owner" | "client";
  /** Optional profile override for this token ("full", "curated", or "lean"). */
  profile?: ToolkitProfile;
  tools?: string[];
  requestsPerMinute?: number;
  maxSessions?: number;
  /** Allowed values per argument name, for any tool; an omitted argument is allowed. Example: {"depth": ["fast", "deep"]}. */
  allowedArgumentValues?: Record<string, string[]>;
  /** Allowed argument values scoped to an exact tool name or "prefix_*" glob. Example: {"grok_*": {"depth": ["fast", "deep"]}}. */
  allowedToolArguments?: Record<string, Record<string, readonly string[]>>;
}

interface HttpOptions {
  tokens: HttpTokenPolicy[];
  host?: string;
  allowedHosts?: string[];
  allowedOrigins?: string[];
  sessionTtlMs?: number;
  /** Hard global limit on concurrent stateful MCP sessions across all tokens (default 256). */
  maxTotalSessions?: number;
  /** Failed Bearer authentication attempts per minute per client IP before returning 429 (default 30). */
  authFailuresPerMinute?: number;
  /** Stateful MCP initialize calls per minute per token before returning 429 (default 60). */
  initsPerMinute?: number;
  /** Serve each HTTP request with a fresh stateless MCP transport (no session expiry or restart 404s). */
  stateless?: boolean;
  /** Optional owner-only hook for POST /admin/reload; returns a freshly initialized SearchToolkit. */
  onReload?: () => Promise<SearchToolkit>;
  /** Optional owner-only hook for POST /admin/shutdown; runs graceful process exit after replying 200. */
  onShutdown?: () => Promise<void>;
}

interface Session {
  tokenId: number;
  toolkit: SearchToolkit;
  transport: StreamableHTTPServerTransport;
  server: Server;
  lastSeenAt: number;
  inFlight: number;
  retired?: boolean;
  retireTimer?: NodeJS.Timeout | undefined;
}

interface ScopedArgumentRule {
  pattern: string;
  prefix?: string;
  args: Map<string, Set<string>>;
}

interface ParsedTokenPolicy {
  hash: Buffer;
  role?: "owner" | "client";
  profile?: ToolkitProfile;
  tools?: Set<string>;
  requestsPerMinute?: number;
  maxSessions?: number;
  allowedArgumentValues?: Map<string, Set<string>>;
  allowedToolArguments?: ScopedArgumentRule[];
}

class SlidingWindowLimiter<K> {
  private readonly windows = new Map<K, number[]>();

  constructor(private readonly windowMs: number, private readonly maxKeys = 10_000) {}

  /** Check whether a new event is allowed; returns remaining retry seconds when blocked, or undefined when allowed. */
  check(key: K, limit: number, record = true): number | undefined {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    const list = this.windows.get(key) ?? [];
    while (list.length > 0 && (list[0] as number) <= cutoff) list.shift();
    if (list.length >= limit) {
      this.windows.set(key, list);
      return Math.max(1, Math.ceil(((list[0] as number) + this.windowMs - now) / 1_000));
    }
    if (record) {
      list.push(now);
      if (!this.windows.has(key) && this.windows.size >= this.maxKeys) this.prune(cutoff);
      this.windows.set(key, list);
    } else if (list.length === 0) {
      this.windows.delete(key);
    }
    return undefined;
  }

  record(key: K): void {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    const list = this.windows.get(key) ?? [];
    while (list.length > 0 && (list[0] as number) <= cutoff) list.shift();
    list.push(now);
    if (!this.windows.has(key) && this.windows.size >= this.maxKeys) this.prune(cutoff);
    this.windows.set(key, list);
  }

  private prune(cutoff: number): void {
    for (const [key, list] of this.windows) {
      while (list.length > 0 && (list[0] as number) <= cutoff) list.shift();
      if (list.length === 0) this.windows.delete(key);
    }
    while (this.windows.size >= this.maxKeys) {
      const oldest = this.windows.keys().next().value;
      if (oldest === undefined) break;
      this.windows.delete(oldest);
    }
  }
}

export function createSearchToolkitHttpApp(toolkit: SearchToolkit, options: HttpOptions) {
  const tokens = options.tokens.map(parseTokenPolicy);
  if (!tokens.length) throw new Error("At least one Search Toolkit HTTP token policy is required");
  const host = options.host ?? "127.0.0.1";
  const normalizedAllowedHosts = options.allowedHosts
    ? options.allowedHosts.map((item) => item.trim().toLowerCase()).filter(Boolean)
    : undefined;

  const app = express();
  app.disable("x-powered-by");

  // Host header DNS-rebinding protection (case-insensitive hostname match).
  if (normalizedAllowedHosts && normalizedAllowedHosts.length > 0) {
    app.use(hostHeaderValidationMiddleware(normalizedAllowedHosts));
  } else if (isLoopbackHost(host.toLowerCase())) {
    app.use(hostHeaderValidationMiddleware(["localhost", "127.0.0.1", "[::1]"]));
  } else if (host === "0.0.0.0" || host === "::") {
    console.warn(
      `Warning: Server is binding to ${host} without DNS rebinding protection. `
      + "Consider setting SEARCH_TOOLKIT_HTTP_ALLOWED_HOSTS to restrict allowed hosts.",
    );
  }

  const allowedOrigins = new Set((options.allowedOrigins ?? []).map((item) => item.trim()).filter(Boolean));
  const sessions = new Map<string, Session>();
  const retiredSessions = new Set<Session>();
  const pendingInits = new Map<number, number>();
  const sessionTtlMs = boundedInteger(options.sessionTtlMs, 30 * 60_000, 1_000, 24 * 60 * 60_000);
  const maxTotalSessions = boundedInteger(options.maxTotalSessions, DEFAULT_MAX_TOTAL_SESSIONS, 1, 10_000);
  const authFailuresPerMinute = boundedInteger(options.authFailuresPerMinute, DEFAULT_AUTH_FAILURES_PER_MINUTE, 1, 10_000);
  const initsPerMinute = boundedInteger(options.initsPerMinute, DEFAULT_INITS_PER_MINUTE, 1, 10_000);
  const stateless = options.stateless === true;

  const toolRateLimiter = new SlidingWindowLimiter<number>(60_000);
  const initRateLimiter = new SlidingWindowLimiter<number>(60_000);
  const authFailureLimiter = new SlidingWindowLimiter<string>(60_000, MAX_TRACKED_AUTH_IPS);

  let currentToolkit = toolkit;
  let reloadEpoch = 0;
  let appClosed = false;
  const activeCalls = new WeakMap<SearchToolkit, number>();
  const retiredToolkits = new Map<SearchToolkit, NodeJS.Timeout>();
  let reloadInFlight: Promise<{ tools: number; warnings: string[] }> | undefined;

  const acquireToolkitInstance = (tk: SearchToolkit): SearchToolkit => {
    activeCalls.set(tk, (activeCalls.get(tk) ?? 0) + 1);
    return tk;
  };

  const acquireToolkit = (): SearchToolkit => acquireToolkitInstance(currentToolkit);

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

  const closeSession = async (session: Session): Promise<void> => {
    if (session.retireTimer) {
      clearTimeout(session.retireTimer);
      session.retireTimer = undefined;
    }
    retiredSessions.delete(session);
    await session.transport.close().catch(() => undefined);
    await session.server.close().catch(() => undefined);
  };

  const drainAndCloseSession = (session: Session): Promise<void> => {
    session.retired = true;
    if (session.inFlight <= 0) {
      return closeSession(session);
    }
    retiredSessions.add(session);
    session.retireTimer = setTimeout(() => {
      void closeSession(session);
    }, 15_000);
    session.retireTimer.unref();
    return Promise.resolve();
  };

  const finishSessionActivity = (session: Session): void => {
    session.inFlight = Math.max(0, session.inFlight - 1);
    session.lastSeenAt = Date.now();
    if (session.retired && session.inFlight === 0) {
      void closeSession(session);
    }
  };

  const isOwnerPolicy = (policy: ParsedTokenPolicy | undefined): boolean => {
    if (!policy) return false;
    if (policy.role !== undefined) return policy.role === "owner";
    return !policy.tools
      && !policy.allowedArgumentValues
      && !policy.allowedToolArguments
      && policy.requestsPerMinute === undefined
      && policy.maxSessions === undefined;
  };

  const protocolOptionsFor = (
    tokenId: number,
    policy: ParsedTokenPolicy,
    extra: { listChanged?: boolean; onCallStart?: () => void; onCallEnd?: () => void } = {},
  ) => ({
    maxToolInputElements: MAX_HTTP_TOOL_INPUT_ELEMENTS,
    isOwner: isOwnerPolicy(policy),
    ...(extra.listChanged !== undefined ? { listChanged: extra.listChanged } : {}),
    ...(extra.onCallStart ? { onCallStart: extra.onCallStart } : {}),
    ...(extra.onCallEnd ? { onCallEnd: extra.onCallEnd } : {}),
    ...(policy.profile ? { profile: policy.profile } : {}),
    ...(policy.tools ? { allowTool: (tool: { name: string }) => policy.tools?.has(tool.name) === true } : {}),
    ...(policy.tools || policy.requestsPerMinute || policy.allowedArgumentValues || policy.allowedToolArguments
      ? {
        beforeCall: (toolName: string, arguments_: Record<string, unknown>) => {
          if (policy.requestsPerMinute) {
            const retrySec = toolRateLimiter.check(tokenId, policy.requestsPerMinute);
            if (retrySec !== undefined) {
              throw new Error(`Rate limit exceeded for this token (${policy.requestsPerMinute} tool calls per minute; retry in ${retrySec}s)`);
            }
          }
          if (toolName === "provider_call") {
            const target = typeof arguments_.name === "string" ? arguments_.name : "";
            if (policy.tools && !policy.tools.has(target)) {
              throw new Error(`Tool ${target || "(missing)"} is not available for this token`);
            }
            if (arguments_.arguments && typeof arguments_.arguments === "object" && !Array.isArray(arguments_.arguments)) {
              const innerArgs = arguments_.arguments as Record<string, unknown>;
              if (policy.allowedArgumentValues) enforceArgumentValues(target || toolName, innerArgs, policy.allowedArgumentValues);
              if (policy.allowedToolArguments) enforceScopedArgumentValues(target || toolName, innerArgs, policy.allowedToolArguments);
            }
          }
          if (toolName === "search_rotation_probe" && policy.tools && typeof arguments_.tool === "string" && !policy.tools.has(arguments_.tool)) {
            throw new Error(`Tool ${arguments_.tool} is not available for this token`);
          }
          if (policy.allowedArgumentValues) enforceArgumentValues(toolName, arguments_, policy.allowedArgumentValues);
          if (policy.allowedToolArguments) enforceScopedArgumentValues(toolName, arguments_, policy.allowedToolArguments);
        },
      }
      : {}),
  });

  const handleOriginAndCors = (request: Request, response: Response, allowedMethods: string): boolean => {
    const origin = request.get("origin");
    if (origin) {
      if (!allowedOrigins.has(origin)) {
        response.status(403).json(protocolError(-32_000, "Origin is not allowed"));
        return false;
      }
      response.set("Access-Control-Allow-Origin", origin);
      response.set("Vary", "Origin");
      response.set("Access-Control-Expose-Headers", "MCP-Session-Id");
      if (request.method === "OPTIONS") {
        response.set("Access-Control-Allow-Methods", allowedMethods);
        response.set("Access-Control-Allow-Headers", "Authorization, Content-Type, Accept, MCP-Session-Id, MCP-Protocol-Version, Last-Event-ID");
        response.set("Access-Control-Max-Age", "600");
        response.status(204).end();
        return false;
      }
    } else if (request.method === "OPTIONS") {
      response.set("Allow", allowedMethods);
      response.status(405).json(protocolError(-32_000, "Method Not Allowed"));
      return false;
    }
    return true;
  };

  const authenticateRequest = (request: Request, response: Response): number | undefined => {
    const ip = request.ip || request.socket.remoteAddress || "unknown";
    const blockedRetry = authFailureLimiter.check(ip, authFailuresPerMinute, false);
    if (blockedRetry !== undefined) {
      response.set("Retry-After", String(blockedRetry));
      response.status(429).json(protocolError(-32_000, `Too many failed authentication attempts; retry in ${blockedRetry}s`));
      return undefined;
    }
    const tokenId = authenticate(request.get("authorization"), tokens);
    if (tokenId === undefined) {
      authFailureLimiter.record(ip);
      response.set("WWW-Authenticate", "Bearer");
      response.status(401).json(protocolError(-32_001, "Unauthorized"));
      return undefined;
    }
    return tokenId;
  };

  const jsonBodyParser = express.json({ limit: MAX_HTTP_REQUEST_BYTES });

  app.get("/healthz", (_request: Request, response: Response) => {
    response.json({ ok: true, mode: stateless ? "stateless" : "stateful" });
  });

  if (options.onReload) {
    const reloadHandler = options.onReload;
    app.all("/admin/reload", async (request: Request, response: Response) => {
      if (!handleOriginAndCors(request, response, "POST, OPTIONS")) return;
      if (request.method !== "POST") {
        response.set("Allow", "POST");
        response.status(405).json(protocolError(-32_000, "Method Not Allowed"));
        return;
      }
      const tokenId = authenticateRequest(request, response);
      if (tokenId === undefined) return;
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
            reloadEpoch += 1;
            const oldSessions = Array.from(sessions.values());
            sessions.clear();
            await Promise.allSettled(oldSessions.map((session) => drainAndCloseSession(session)));
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
    app.all("/admin/shutdown", (request: Request, response: Response) => {
      if (!handleOriginAndCors(request, response, "POST, OPTIONS")) return;
      if (request.method !== "POST") {
        response.set("Allow", "POST");
        response.status(405).json(protocolError(-32_000, "Method Not Allowed"));
        return;
      }
      const tokenId = authenticateRequest(request, response);
      if (tokenId === undefined) return;
      if (!isOwnerPolicy(tokens[tokenId])) {
        response.status(403).json(protocolError(-32_001, "Owner token required"));
        return;
      }
      response.json({ ok: true });
      setTimeout(() => { void shutdownHandler().catch(() => undefined); }, 50).unref();
    });
  }

  // Enforce Origin/CORS and Bearer auth BEFORE parsing the JSON body so unauthenticated
  // clients cannot trigger JSON parsing CPU work, and MAX_HTTP_REQUEST_BYTES is enforced directly.
  app.all("/mcp", (request: Request, response: Response, next: NextFunction) => {
    const allowedMethods = stateless ? "POST, DELETE, OPTIONS" : "GET, POST, DELETE, OPTIONS";
    if (!handleOriginAndCors(request, response, allowedMethods)) return;
    const tokenId = authenticateRequest(request, response);
    if (tokenId === undefined) return;
    response.locals.tokenId = tokenId;
    if (request.method === "POST") {
      jsonBodyParser(request, response, next);
      return;
    }
    next();
  }, async (request: Request, response: Response) => {
    const tokenId = response.locals.tokenId as number | undefined;
    const policy = tokenId !== undefined ? tokens[tokenId] : undefined;
    if (tokenId === undefined || !policy) {
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
      const server = createProtocolServer(active, protocolOptionsFor(tokenId, policy, {
        listChanged: false,
        onCallStart: () => { acquireToolkitInstance(active); },
        onCallEnd: () => { releaseToolkit(active); },
      }));
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
      // Passive standalone GET SSE streams stay open while idle and must not block TTL eviction or toolkit retirement.
      const isPassiveStream = request.method === "GET";
      existing.lastSeenAt = Date.now();
      if (!isPassiveStream) {
        existing.inFlight += 1;
        acquireToolkitInstance(existing.toolkit);
      }
      try {
        await existing.transport.handleRequest(request, response, request.body);
      } catch (error) {
        console.error("Search Toolkit HTTP session request failed", error);
        if (!response.headersSent) response.status(500).json(protocolError(-32_603, "Internal server error"));
      } finally {
        if (!isPassiveStream) {
          finishSessionActivity(existing);
          releaseToolkit(existing.toolkit);
        }
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

    const initRetrySec = initRateLimiter.check(tokenId, initsPerMinute);
    if (initRetrySec !== undefined) {
      response.set("Retry-After", String(initRetrySec));
      response.status(429).json(protocolError(-32_000, `Too many session initializations; retry in ${initRetrySec}s`));
      return;
    }

    let totalPending = 0;
    for (const count of pendingInits.values()) totalPending += count;
    if (sessions.size + totalPending >= maxTotalSessions) {
      response.status(429).json(protocolError(-32_000, "Too many active sessions on this server"));
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
    const initEpoch = reloadEpoch;
    const active = acquireToolkit();
    let registeredSession: Session | undefined;
    const server = createProtocolServer(active, protocolOptionsFor(tokenId, policy, {
      onCallStart: () => {
        acquireToolkitInstance(active);
        if (registeredSession) {
          registeredSession.inFlight += 1;
          registeredSession.lastSeenAt = Date.now();
        }
      },
      onCallEnd: () => {
        if (registeredSession) {
          finishSessionActivity(registeredSession);
        }
        releaseToolkit(active);
      },
    }));
    const transport = new StreamableHTTPServerTransport({
      maxRequestBodySize: MAX_HTTP_REQUEST_BYTES,
      sessionIdGenerator: randomUUID,
      onsessioninitialized: (id) => {
        if (appClosed || initEpoch !== reloadEpoch) {
          void transport.close().catch(() => undefined);
          void server.close().catch(() => undefined);
          return;
        }
        registeredSession = {
          tokenId,
          toolkit: active,
          transport,
          server,
          lastSeenAt: Date.now(),
          inFlight: 1,
        };
        sessions.set(id, registeredSession);
      },
    });
    transport.onclose = () => {
      const id = transport.sessionId;
      if (id) sessions.delete(id);
    };
    try {
      await server.connect(transport);
      await transport.handleRequest(request, response, request.body);
      if (!transport.sessionId || appClosed || initEpoch !== reloadEpoch) {
        await transport.close().catch(() => undefined);
        await server.close().catch(() => undefined);
      }
    } catch (error) {
      console.error("Search Toolkit HTTP request failed", error);
      await transport.close().catch(() => undefined);
      await server.close().catch(() => undefined);
      if (!response.headersSent) response.status(500).json(protocolError(-32_603, "Internal server error"));
    } finally {
      if (registeredSession) {
        finishSessionActivity(registeredSession);
      }
      const remaining = (pendingInits.get(tokenId) ?? 1) - 1;
      if (remaining > 0) pendingInits.set(tokenId, remaining);
      else pendingInits.delete(tokenId);
      releaseToolkit(active);
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
          if (session.inFlight === 0 && session.lastSeenAt < cutoff) {
            void session.transport.close().catch(() => undefined);
            void session.server.close().catch(() => undefined);
          }
        }
      }, Math.min(sessionTtlMs, 60_000));
  cleanupTimer?.unref();

  return {
    app,
    currentToolkit: () => currentToolkit,
    close: async () => {
      appClosed = true;
      reloadEpoch += 1;
      if (cleanupTimer) clearInterval(cleanupTimer);
      if (reloadInFlight) await reloadInFlight.catch(() => undefined);
      const activeSessionsList = Array.from(sessions.values());
      sessions.clear();
      const drainingSessions = Array.from(retiredSessions);
      retiredSessions.clear();
      await Promise.allSettled([...activeSessionsList, ...drainingSessions].map((session) => closeSession(session)));
      const retired = Array.from(retiredToolkits.entries());
      retiredToolkits.clear();
      for (const [, timer] of retired) clearTimeout(timer);
      await Promise.allSettled(retired.map(([tk]) => tk.close()));
    },
  };
}

export function isLoopbackHost(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "[::1]" || normalized === "localhost";
}

function normalizeAllowedHostname(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (trimmed.includes(":") && !trimmed.startsWith("[")) return `[${trimmed}]`;
  return trimmed;
}

function hostHeaderValidationMiddleware(allowedHostnames: string[]) {
  const allowed = new Set(allowedHostnames.map(normalizeAllowedHostname));
  return (request: Request, response: Response, next: NextFunction): void => {
    const hostHeader = request.headers.host;
    if (!hostHeader) {
      response.status(403).json(protocolError(-32_000, "Missing Host header"));
      return;
    }
    let hostname: string;
    try {
      hostname = new URL(`http://${hostHeader}`).hostname.toLowerCase();
    } catch {
      response.status(403).json(protocolError(-32_000, `Invalid Host header: ${hostHeader}`));
      return;
    }
    if (!allowed.has(hostname)) {
      response.status(403).json(protocolError(-32_000, `Invalid Host: ${hostname}`));
      return;
    }
    next();
  };
}

function authenticate(value: string | undefined, policies: ParsedTokenPolicy[]): number | undefined {
  const match = value?.match(/^Bearer\s+(\S+)\s*$/i);
  if (!match?.[1]) return undefined;
  const digest = createHash("sha256").update(match[1]).digest();
  let matched = -1;
  for (let index = 0; index < policies.length; index += 1) {
    const policy = policies[index]!;
    if (policy.hash.length === digest.length && timingSafeEqual(policy.hash, digest)) {
      matched = index;
    }
  }
  return matched >= 0 ? matched : undefined;
}

function parseTokenPolicy(policy: HttpTokenPolicy): ParsedTokenPolicy {
  const role = policy.role;
  if (role !== undefined && !ROLES.has(role)) {
    throw new Error('HTTP token role must be "owner" or "client"');
  }
  const profile = policy.profile;
  if (profile !== undefined && !PROFILES.includes(profile)) {
    throw new Error('HTTP token profile must be "full", "curated", or "lean"');
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
  const allowedToolArguments = policy.allowedToolArguments
    ? Object.entries(policy.allowedToolArguments).map(([pattern, rules]): ScopedArgumentRule => {
      const trimmed = pattern.trim();
      if (!trimmed) throw new Error("HTTP token allowedToolArguments pattern must be non-empty");
      const prefix = trimmed.endsWith("*") ? trimmed.slice(0, -1) : undefined;
      return {
        pattern: trimmed,
        ...(prefix !== undefined ? { prefix } : {}),
        args: new Map(Object.entries(rules).map(([name, values]) => [name, new Set(values)])),
      };
    })
    : undefined;
  return {
    hash: parseTokenHash(policy.hash),
    ...(role ? { role } : {}),
    ...(profile ? { profile } : {}),
    ...(tools ? { tools } : {}),
    ...(requestsPerMinute !== undefined ? { requestsPerMinute } : {}),
    ...(maxSessions !== undefined ? { maxSessions } : {}),
    ...(allowedArgumentValues ? { allowedArgumentValues } : {}),
    ...(allowedToolArguments ? { allowedToolArguments } : {}),
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

function enforceScopedArgumentValues(
  toolName: string,
  arguments_: Record<string, unknown>,
  rules: ScopedArgumentRule[],
): void {
  for (const rule of rules) {
    const matches = rule.prefix !== undefined ? toolName.startsWith(rule.prefix) : toolName === rule.pattern;
    if (matches) enforceArgumentValues(toolName, arguments_, rule.args);
  }
}

function parseTokenHash(value: string): Buffer {
  if (!/^[a-f0-9]{64}$/i.test(value)) throw new Error("HTTP token hashes must be SHA-256 hex strings");
  return Buffer.from(value, "hex");
}

function isStringArrayMap(value: unknown): value is Record<string, string[]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).every((items) => Array.isArray(items) && items.every((item) => typeof item === "string"));
}

export function parseHttpTokenPolicies(value: string | undefined): HttpTokenPolicy[] {
  if (!value) throw new Error("SEARCH_TOOLKIT_HTTP_TOKENS is required");
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("SEARCH_TOOLKIT_HTTP_TOKENS must be a non-empty JSON array");
  }
  return parsed.map((value_, index) => {
    if (!value_ || typeof value_ !== "object" || Array.isArray(value_)) {
      throw new Error(`HTTP token policy ${index} must be an object`);
    }
    const record = value_ as Record<string, unknown>;
    if (typeof record.hash !== "string") throw new Error(`HTTP token policy ${index} requires hash`);
    if (record.role !== undefined && (typeof record.role !== "string" || !ROLES.has(record.role))) {
      throw new Error(`HTTP token policy ${index} role must be "owner" or "client"`);
    }
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
    if (argumentValues !== undefined && !isStringArrayMap(argumentValues)) {
      throw new Error(`HTTP token policy ${index} allowedArgumentValues must map argument names to string arrays`);
    }
    const toolArguments = record.allowedToolArguments;
    if (toolArguments !== undefined) {
      if (
        !toolArguments || typeof toolArguments !== "object" || Array.isArray(toolArguments)
        || Object.entries(toolArguments).some(([pattern, map]) => !pattern.trim() || !isStringArrayMap(map))
      ) {
        throw new Error(`HTTP token policy ${index} allowedToolArguments must map tool patterns to argument allowlists`);
      }
    }
    return {
      hash: record.hash,
      ...(record.role !== undefined ? { role: record.role as "owner" | "client" } : {}),
      ...(record.profile !== undefined ? { profile: record.profile as ToolkitProfile } : {}),
      ...(record.tools !== undefined ? { tools: record.tools as string[] } : {}),
      ...(record.requestsPerMinute !== undefined ? { requestsPerMinute: Number(record.requestsPerMinute) } : {}),
      ...(record.maxSessions !== undefined ? { maxSessions: Number(record.maxSessions) } : {}),
      ...(argumentValues !== undefined ? { allowedArgumentValues: argumentValues } : {}),
      ...(toolArguments !== undefined ? { allowedToolArguments: toolArguments as Record<string, Record<string, readonly string[]>> } : {}),
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
