import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { Request, Response } from "express";
import { createProtocolServer } from "./server-factory.js";
import { SearchToolkit } from "./toolkit.js";

export interface HttpTokenPolicy {
  hash: string;
  tools?: string[];
  requestsPerMinute?: number;
  maxSessions?: number;
}

interface HttpOptions {
  tokens: HttpTokenPolicy[];
  host?: string;
  allowedHosts?: string[];
  allowedOrigins?: string[];
  sessionTtlMs?: number;
}

interface Session {
  tokenId: number;
  transport: StreamableHTTPServerTransport;
  lastSeenAt: number;
}

interface ParsedTokenPolicy {
  hash: Buffer;
  tools?: Set<string>;
  requestsPerMinute?: number;
  maxSessions?: number;
}

export function createSearchToolkitHttpApp(toolkit: SearchToolkit, options: HttpOptions) {
  const tokens = options.tokens.map(parseTokenPolicy);
  if (!tokens.length) throw new Error("At least one Search Toolkit HTTP token policy is required");
  const host = options.host ?? "127.0.0.1";
  const app = createMcpExpressApp({ host, ...(options.allowedHosts ? { allowedHosts: options.allowedHosts } : {}) });
  const allowedOrigins = new Set(options.allowedOrigins ?? []);
  const sessions = new Map<string, Session>();
  const sessionTtlMs = boundedInteger(options.sessionTtlMs, 30 * 60_000, 1_000, 24 * 60 * 60_000);
  const rateWindows = new Map<number, { startedAt: number; count: number }>();

  app.get("/healthz", (_request: Request, response: Response) => response.json({ ok: true }));
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

    const sessionId = request.get("mcp-session-id");
    const existing = sessionId ? sessions.get(sessionId) : undefined;
    if (existing) {
      if (existing.tokenId !== tokenId) {
        response.status(403).json(protocolError(-32_001, "Session token mismatch"));
        return;
      }
      existing.lastSeenAt = Date.now();
      await existing.transport.handleRequest(request, response, request.body);
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

    const policy = tokens[tokenId];
    if (!policy) {
      response.status(401).json(protocolError(-32_001, "Unauthorized"));
      return;
    }
    const activeSessions = policy.maxSessions === undefined
      ? 0
      : Array.from(sessions.values()).filter((session) => session.tokenId === tokenId).length;
    if (policy.maxSessions !== undefined && activeSessions >= policy.maxSessions) {
      response.status(429).json(protocolError(-32_000, "Too many active sessions for this token"));
      return;
    }
    const protocolOptions = {
      ...(policy.tools ? { allowTool: (tool: { name: string }) => policy.tools?.has(tool.name) === true } : {}),
      ...(policy.requestsPerMinute
        ? { beforeCall: () => enforceRateLimit(tokenId, policy.requestsPerMinute as number, rateWindows) }
        : {}),
    };
    const server = createProtocolServer(toolkit, protocolOptions);
    const transport = new StreamableHTTPServerTransport({
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
      await server.connect(transport as unknown as Parameters<typeof server.connect>[0]);
      await transport.handleRequest(request, response, request.body);
    } catch (error) {
      console.error("Search Toolkit HTTP request failed", error);
      await transport.close();
      if (!response.headersSent) response.status(500).json(protocolError(-32_603, "Internal server error"));
    }
  });

  const cleanupTimer = setInterval(() => {
    const cutoff = Date.now() - sessionTtlMs;
    for (const session of sessions.values()) {
      if (session.lastSeenAt < cutoff) void session.transport.close();
    }
  }, Math.min(sessionTtlMs, 60_000));
  cleanupTimer.unref();

  return {
    app,
    close: async () => {
      clearInterval(cleanupTimer);
      await Promise.allSettled(Array.from(sessions.values(), (session) => session.transport.close()));
      sessions.clear();
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
  const tools = policy.tools ? new Set(policy.tools) : undefined;
  const requestsPerMinute = policy.requestsPerMinute;
  const maxSessions = policy.maxSessions;
  if (requestsPerMinute !== undefined && (!Number.isInteger(requestsPerMinute) || requestsPerMinute < 1)) {
    throw new Error("HTTP token requestsPerMinute must be a positive integer");
  }
  if (maxSessions !== undefined && (!Number.isInteger(maxSessions) || maxSessions < 1)) {
    throw new Error("HTTP token maxSessions must be a positive integer");
  }
  return {
    hash: parseTokenHash(policy.hash),
    ...(tools ? { tools } : {}),
    ...(requestsPerMinute !== undefined ? { requestsPerMinute } : {}),
    ...(maxSessions !== undefined ? { maxSessions } : {}),
  };
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
    if (record.tools !== undefined && (!Array.isArray(record.tools) || record.tools.some((tool) => typeof tool !== "string"))) {
      throw new Error(`HTTP token policy ${index} tools must be a string array`);
    }
    if (record.requestsPerMinute !== undefined && (!Number.isInteger(record.requestsPerMinute) || Number(record.requestsPerMinute) < 1)) {
      throw new Error(`HTTP token policy ${index} requestsPerMinute must be a positive integer`);
    }
    if (record.maxSessions !== undefined && (!Number.isInteger(record.maxSessions) || Number(record.maxSessions) < 1)) {
      throw new Error(`HTTP token policy ${index} maxSessions must be a positive integer`);
    }
    return {
      hash: record.hash,
      ...(record.tools !== undefined ? { tools: record.tools as string[] } : {}),
      ...(record.requestsPerMinute !== undefined ? { requestsPerMinute: Number(record.requestsPerMinute) } : {}),
      ...(record.maxSessions !== undefined ? { maxSessions: Number(record.maxSessions) } : {}),
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
