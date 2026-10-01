import type { ToolBinding } from "./types.js";

export function result(value: unknown): unknown {
  return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value };
}

export function cleanError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/[A-Za-z0-9_-]{24,}/g, "<redacted>").slice(0, 500);
}

export function attachRouteMetadata(
  binding: ToolBinding,
  output: unknown,
  auto?: Record<string, unknown>,
): unknown {
  const route = {
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
    content: [{
      type: "text",
      text: JSON.stringify({ searchToolkitRoute: route, ...(auto ? { searchToolkitAuto: auto } : {}) }),
    }, ...resultContent],
    structuredContent: { route, ...(auto ? { searchAuto: auto } : {}), result: record.structuredContent ?? null },
    _meta: { ...meta, searchToolkit: { ...searchToolkitMeta, route, ...(auto ? { auto } : {}) } },
  };
}

export function isRouteContentBlock(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const block = value as Record<string, unknown>;
  if (block.type !== "text" || typeof block.text !== "string") return false;
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
