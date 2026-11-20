import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ShapingConfig } from "./types.js";

export const DEFAULT_SHAPING: Required<ShapingConfig> = {
  maxDescriptionChars: 700,
  maxParamDescriptionChars: 220,
};

/**
 * Shrink what a tool costs in the model's context without touching what it
 * accepts: descriptions are trimmed at a paragraph or sentence boundary, and
 * per-parameter descriptions are capped. Types, enums, defaults, and required
 * lists are left exactly as the upstream server defined them.
 */
export function shapeTool(tool: Tool, shaping: ShapingConfig = {}, override?: string): Tool {
  const limits = { ...DEFAULT_SHAPING, ...shaping };
  const description = override ?? (limits.maxDescriptionChars > 0
    ? trimText(tool.description ?? "", limits.maxDescriptionChars)
    : tool.description ?? "");
  const schema = limits.maxParamDescriptionChars > 0
    ? capParamDescriptions(tool.inputSchema, limits.maxParamDescriptionChars)
    : tool.inputSchema;
  return { ...tool, description, inputSchema: schema as Tool["inputSchema"] };
}

export function trimText(text: string, max: number): string {
  const value = text.trim();
  if (value.length <= max) return value;
  const head = safeSlice(value, max);
  const paragraph = head.lastIndexOf("\n\n");
  // Latin sentences end with ". "; CJK ones end with 。！？ and no space.
  const sentence = Math.max(head.lastIndexOf(". "), head.lastIndexOf(".\n"), head.lastIndexOf("。"), head.lastIndexOf("！"), head.lastIndexOf("？"));
  const cut = paragraph > max * 0.5 ? paragraph : sentence > max * 0.5 ? sentence + 1 : head.lastIndexOf(" ") > max * 0.5 ? head.lastIndexOf(" ") : head.length;
  return `${safeSlice(head, cut).trimEnd()} …`;
}

/** Avoid splitting a UTF-16 surrogate pair (e.g. emoji or rare CJK ideographs) at the slice boundary. */
function safeSlice(text: string, end: number): string {
  if (end <= 0 || end >= text.length) return text.slice(0, Math.max(0, end));
  const code = text.charCodeAt(end - 1);
  return code >= 0xd800 && code <= 0xdbff ? text.slice(0, end - 1) : text.slice(0, end);
}

function capParamDescriptions(node: unknown, max: number, root = true): unknown {
  if (Array.isArray(node)) return node.map((item) => capParamDescriptions(item, max, false));
  if (!node || typeof node !== "object") return node;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (root && key === "$schema") continue;
    if (key === "description" && typeof value === "string") result[key] = trimText(value, max);
    // Never recurse into data keywords whose values are literal data, not schema.
    else if (key === "enum" || key === "const" || key === "default" || key === "examples") result[key] = value;
    else result[key] = capParamDescriptions(value, max, false);
  }
  return result;
}
