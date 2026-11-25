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
  const head = safeSlice(value, 0, max);
  const paragraph = head.lastIndexOf("\n\n");
  // Latin sentences end with ". "; CJK ones end with 。！？ and no space.
  const sentence = Math.max(head.lastIndexOf(". "), head.lastIndexOf(".\n"), head.lastIndexOf("。"), head.lastIndexOf("！"), head.lastIndexOf("？"));
  const cut = paragraph > max * 0.5 ? paragraph : sentence > max * 0.5 ? sentence + 1 : head.lastIndexOf(" ") > max * 0.5 ? head.lastIndexOf(" ") : head.length;
  return `${safeSlice(head, 0, cut).trimEnd()} …`;
}

/**
 * Slice a UTF-16 string without splitting a surrogate pair (e.g. emoji or rare
 * CJK ideographs) at either the start or end boundary.
 */
export function safeSlice(text: string, start: number, end?: number): string {
  const len = text.length;
  let from = Math.max(0, Math.min(len, Math.trunc(start)));
  let to = end === undefined ? len : Math.max(0, Math.min(len, Math.trunc(end)));
  if (from >= to) return "";
  if (from > 0 && from < len) {
    const code = text.charCodeAt(from);
    const prev = text.charCodeAt(from - 1);
    if (code >= 0xdc00 && code <= 0xdfff && prev >= 0xd800 && prev <= 0xdbff) {
      from += 1;
    }
  }
  if (to > from && to < len) {
    const code = text.charCodeAt(to - 1);
    const next = text.charCodeAt(to);
    if (code >= 0xd800 && code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
      to -= 1;
    }
  }
  return from < to ? text.slice(from, to) : "";
}

const DATA_KEYWORDS = new Set(["enum", "const", "default", "examples"]);
const SCHEMA_MAP_KEYWORDS = new Set(["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"]);

function capParamDescriptions(node: unknown, max: number, root = true): unknown {
  if (Array.isArray(node)) return node.map((item) => capParamDescriptions(item, max, false));
  if (!node || typeof node !== "object") return node;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (root && key === "$schema") continue;
    if (key === "description" && typeof value === "string") {
      result[key] = trimText(value, max);
    } else if (DATA_KEYWORDS.has(key)) {
      // Never recurse into data keywords whose values are literal data, not schema.
      result[key] = value;
    } else if (SCHEMA_MAP_KEYWORDS.has(key) && value && typeof value === "object" && !Array.isArray(value)) {
      // Map keys are user-defined property/definition names (which may literally be named
      // "default", "enum", "const", or "examples"); each entry's value is a sub-schema.
      const mapped: Record<string, unknown> = {};
      for (const [entryKey, entrySchema] of Object.entries(value as Record<string, unknown>)) {
        mapped[entryKey] = capParamDescriptions(entrySchema, max, false);
      }
      result[key] = mapped;
    } else {
      result[key] = capParamDescriptions(value, max, false);
    }
  }
  return result;
}
