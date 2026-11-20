import type { ToolBinding } from "./types.js";

export interface Route {
  provider: string;
  tool: string;
  upstreamTool: string;
}

const ROUTE_PREFIX = '{"searchToolkitRoute":';

export function result(value: unknown): unknown {
  return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value };
}

const KNOWN_SECRETS = new Set<string>();
const KNOWN_KEY_PREFIX = /\b(?:sk-[A-Za-z0-9_-]{12,}|tvly-[A-Za-z0-9_-]{12,}|fc-[A-Za-z0-9_-]{12,}|vck_[A-Za-z0-9_-]{12,}|BSA[A-Za-z0-9_-]{16,}|pplx-[A-Za-z0-9_-]{12,}|xai-[A-Za-z0-9_-]{12,}|exa-[A-Za-z0-9_-]{12,})/g;
const BEARER_HEADER = /\b(Bearer\s+)[^\s"'`<>]+/gi;
const SECRET_QUERY_PARAM = /([?&][a-z0-9_-]*(?:api[_-]?key|access[_-]?token|auth[_-]?token|token|secret|key)=)[^&\s"'`<>]+/gi;
const PLAIN_SNAKE_IDENTIFIER = /^[a-z]+(?:_[a-z]+)+$/;

/** Register configured key literals so `redact()` always masks them regardless of shape. */
export function registerKnownSecrets(keys: Iterable<string>): void {
  for (const raw of keys) {
    const value = raw.trim();
    if (value.length >= 6 && !value.startsWith("env:") && !value.startsWith("file:")) {
      KNOWN_SECRETS.add(value);
    }
  }
}

/**
 * Hide configured secrets, bearer tokens, secret query parameters, known key
 * prefixes, and high-entropy key-like runs while preserving plain lowercase
 * snake_case identifiers such as error codes and tool names.
 */
export function redact(text: string): string {
  let out = text;
  if (KNOWN_SECRETS.size > 0) {
    for (const secret of Array.from(KNOWN_SECRETS).sort((a, b) => b.length - a.length)) {
      if (out.includes(secret)) out = out.split(secret).join("<redacted>");
    }
  }
  return out
    .replace(BEARER_HEADER, "$1<redacted>")
    .replace(SECRET_QUERY_PARAM, "$1<redacted>")
    .replace(KNOWN_KEY_PREFIX, "<redacted>")
    .replace(/[A-Za-z0-9_-]{24,}/g, (token) => (PLAIN_SNAKE_IDENTIFIER.test(token) ? token : "<redacted>"));
}

export function cleanError(error: unknown): string {
  return redact(error instanceof Error ? error.message : String(error)).slice(0, 500);
}

/**
 * The single leading text block that tells the model which route answered.
 * It carries only what the model can act on; the full route and attempt
 * details stay in structuredContent and _meta.
 */
export function routeBlock(route: Route, auto?: Record<string, unknown>): { type: "text"; text: string } {
  const visible: Record<string, unknown> = { searchToolkitRoute: { provider: route.provider, tool: route.tool } };
  if (auto) visible.searchToolkitAuto = modelVisibleAuto(auto);
  return { type: "text", text: JSON.stringify(visible) };
}

function modelVisibleAuto(auto: Record<string, unknown>): Record<string, unknown> {
  const { candidateRank: _rank, providerAttempt: _attempt, attempts, crossCheck, batch, ...rest } = auto;
  const visible: Record<string, unknown> = { ...rest };
  if (Array.isArray(attempts)) {
    const list = (attempts as Array<{ tool?: string; outcome?: string; status?: number }>)
      .filter((attempt) => attempt.outcome !== "skipped");
    // A first-try success (ignoring zero-cost optional probes) says nothing the route does not already say.
    if (list.length > 1 || list.some((attempt) => attempt.outcome !== "success")) {
      visible.attempts = list.map((attempt) => `${attempt.tool}:${attempt.status ?? attempt.outcome}`);
    }
  }
  if (crossCheck && typeof crossCheck === "object") {
    const check = crossCheck as {
      routes?: Array<{ provider?: string }>; failed?: unknown; empty?: unknown; status?: unknown; corroborated?: unknown;
    };
    visible.crossCheck = {
      providers: (check.routes ?? []).map((item) => item.provider),
      ...(Array.isArray(check.failed) && check.failed.length ? { failed: check.failed } : {}),
      ...(Array.isArray(check.empty) && check.empty.length ? { empty: check.empty } : {}),
      status: check.status,
      corroborated: check.corroborated,
    };
  }
  if (batch && typeof batch === "object") {
    const summary = batch as { total?: number; succeeded?: number; partial?: string[]; failed?: Array<{ url?: string }> };
    visible.batch = {
      total: summary.total,
      succeeded: summary.succeeded,
      ...(summary.partial?.length ? { partial: summary.partial } : {}),
      ...(summary.failed?.length ? { failed: summary.failed.map((item) => item.url) } : {}),
    };
  }
  return visible;
}

/** Update the same route metadata in the text, structured result, and MCP _meta. */
export function updateAutoMetadata(output: unknown, fields: Record<string, unknown>): unknown {
  const record = output as {
    content?: unknown[];
    structuredContent?: { route?: Route; searchAuto?: Record<string, unknown> };
    _meta?: { searchToolkit?: Record<string, unknown> };
  } | undefined;
  const route = record?.structuredContent?.route;
  if (!route || !Array.isArray(record?.content)) return output;
  const auto = { ...record.structuredContent?.searchAuto, ...fields };
  const body = isRouteContentBlock(record.content[0]) ? record.content.slice(1) : record.content;
  return {
    ...record,
    content: [routeBlock(route, auto), ...body],
    structuredContent: { ...record.structuredContent, searchAuto: auto },
    _meta: { ...record._meta, searchToolkit: { ...record._meta?.searchToolkit, auto } },
  };
}

export function attachRouteMetadata(
  binding: ToolBinding,
  output: unknown,
  auto?: Record<string, unknown>,
): unknown {
  const route: Route = {
    provider: binding.provider,
    tool: binding.exposed.name,
    upstreamTool: binding.upstreamName,
  };
  if (!output || typeof output !== "object") return result({ route, result: output });
  const record = output as Record<string, unknown>;
  const content = Array.isArray(record.content) ? record.content : [];
  const resultContent = isRouteContentBlock(content[0]) ? content.slice(1) : content;
  const meta = record._meta && typeof record._meta === "object"
    ? record._meta as Record<string, unknown>
    : {};
  const searchToolkitMeta = meta.searchToolkit && typeof meta.searchToolkit === "object"
    ? meta.searchToolkit as Record<string, unknown>
    : {};
  return {
    ...record,
    content: [routeBlock(route, auto), ...resultContent],
    structuredContent: { route, ...(auto ? { searchAuto: auto } : {}), result: record.structuredContent ?? null },
    _meta: { ...meta, searchToolkit: { ...searchToolkitMeta, route, ...(auto ? { auto } : {}) } },
  };
}

export function isRouteContentBlock(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const block = value as Record<string, unknown>;
  // Checking the prefix first avoids parsing a large JSON body on every call.
  if (block.type !== "text" || typeof block.text !== "string" || !block.text.startsWith(ROUTE_PREFIX)) return false;
  try {
    const parsed = JSON.parse(block.text) as Record<string, unknown>;
    return Boolean(parsed.searchToolkitRoute && typeof parsed.searchToolkitRoute === "object");
  } catch {
    return false;
  }
}

/** Content blocks of a tool result after the leading route block. */
export function bodyBlocks(output: unknown): Array<{ type: string; text?: string }> {
  const content = output && typeof output === "object" ? (output as { content?: unknown }).content : undefined;
  if (!Array.isArray(content)) return [];
  return (isRouteContentBlock(content[0]) ? content.slice(1) : content) as Array<{ type: string; text?: string }>;
}

export function isToolErrorResult(output: unknown): boolean {
  return Boolean(output && typeof output === "object" && (output as { isError?: unknown }).isError === true);
}
