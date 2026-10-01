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
  const head = value.slice(0, max);
  const paragraph = head.lastIndexOf("\n\n");
  const sentence = Math.max(head.lastIndexOf(". "), head.lastIndexOf(".\n"));
  const cut = paragraph > max * 0.5 ? paragraph : sentence > max * 0.5 ? sentence + 1 : head.lastIndexOf(" ") > max * 0.5 ? head.lastIndexOf(" ") : max;
  return `${head.slice(0, cut).trimEnd()} …`;
}

function capParamDescriptions(node: unknown, max: number): unknown {
  if (Array.isArray(node)) return node.map((item) => capParamDescriptions(item, max));
  if (!node || typeof node !== "object") return node;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === "$schema") continue;
    if (key === "description" && typeof value === "string") result[key] = trimText(value, max);
    // Never recurse into data keywords whose values are literal data, not schema.
    else if (key === "enum" || key === "const" || key === "default" || key === "examples") result[key] = value;
    else result[key] = capParamDescriptions(value, max);
  }
  return result;
}
