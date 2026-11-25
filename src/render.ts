import { cleanExcerpt, focusExcerpt } from "./excerpt.js";
import { canonicalUrl, dedupeItems } from "./merge.js";
import { objectRecord, stringValue } from "./rest/normalize.js";
import type { SearchItem } from "./types.js";

export interface RenderOptions {
  maxCharsPerItem?: number | undefined;
  dedupe?: boolean | undefined;
  /** The search query; long excerpts keep the sentences that mention it. */
  query?: string | undefined;
}

/**
 * Turn a normalized provider payload into compact text for the model. The full
 * payload stays in structuredContent; this is only what the model reads, so it
 * avoids JSON escaping, repeated metadata, and fields the model cannot use.
 */
export function renderPayload(payload: unknown, options: RenderOptions = {}): string {
  const record = objectRecord(payload);
  const parts: string[] = [];
  if (Array.isArray(record.items)) parts.push(renderItems(record.items, options));
  else if (record.grounding && typeof record.grounding === "object") parts.push(renderGrounding(record));
  else if (typeof record.text === "string") parts.push(renderAnswer(record));
  else return JSON.stringify(payload);
  const warnings = extractWarnings(record.warnings);
  if (warnings.length) parts.push(`Warnings: ${warnings.join("; ")}`);
  return parts.filter(Boolean).join("\n\n");
}

function extractWarnings(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    const text = typeof item === "string"
      ? item.trim()
      : (stringValue(objectRecord(item).message)?.trim() ?? (item !== null && item !== undefined ? JSON.stringify(item) : ""));
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

export function renderItems(items: unknown[], options: RenderOptions = {}): string {
  const list = options.dedupe === false ? items : dedupeItems(items as SearchItem[]);
  if (!list.length) return "No results.";
  const maxChars = options.maxCharsPerItem && options.maxCharsPerItem > 0 ? options.maxCharsPerItem : 0;
  return list.map((value, index) => {
    const item = objectRecord(value);
    const title = String(item.title ?? "").replace(/\s+/g, " ").trim() || String(item.url ?? "").trim() || "(untitled)";
    const date = stringValue(item.date);
    const lines = [`${index + 1}. ${title}${date ? ` (${date})` : ""}`];
    const imageUrl = stringValue(item.imageUrl);
    if (imageUrl) {
      const size = typeof item.width === "number" && typeof item.height === "number" ? ` (${item.width}×${item.height})` : "";
      lines.push(`   image: ${imageUrl}${size}`);
      const thumbnail = stringValue(item.thumbnailUrl);
      if (thumbnail) lines.push(`   thumbnail: ${thumbnail}`);
      const url = stringValue(item.url);
      if (url) lines.push(`   page: ${url}`);
      const source = stringValue(item.source) ?? stringValue(item.domain);
      if (source) lines.push(`   source: ${source}`);
      return lines.join("\n");
    }
    const url = stringValue(item.url);
    if (url && url !== title) lines.push(`   ${url}`);
    if (Array.isArray(item.foundBy) && item.foundBy.length) lines.push(`   found by: ${item.foundBy.join(", ")}`);
    const cleaned = cleanExcerpt(stringValue(item.text) ?? "");
    const text = cleaned && maxChars > 0 ? focusExcerpt(cleaned, options.query, maxChars) : cleaned;
    if (text) lines.push(indent(text));
    return lines.join("\n");
  }).join("\n");
}

function renderGrounding(data: Record<string, unknown>): string {
  const grounding = objectRecord(data.grounding);
  const sources = objectRecord(data.sources);
  const groups = [
    ...(Array.isArray(grounding.generic) ? grounding.generic : []),
    ...(Array.isArray(grounding.map) ? grounding.map : []),
    ...(grounding.poi && typeof grounding.poi === "object" ? [grounding.poi] : []),
  ];
  if (!groups.length) return "No grounding results.";
  return groups.map((value) => {
    const group = objectRecord(value);
    const url = stringValue(group.url) ?? "";
    const source = Object.hasOwn(sources, url) ? objectRecord(sources[url]) : {};
    const title = (stringValue(group.title) ?? stringValue(group.name) ?? stringValue(source.title) ?? url).replace(/\s+/g, " ").trim();
    const host = stringValue(source.hostname);
    const rawAge = Array.isArray(source.age)
      ? source.age.map(String).find((entry) => /^\d{4}-\d{2}-\d{2}/.test(entry)) ?? source.age.map(String)[0]
      : undefined;
    const age = rawAge && /^\d{4}-\d{2}-\d{2}/.test(rawAge) ? rawAge.slice(0, 10) : rawAge;
    const meta = [host, age].filter(Boolean).join(", ");
    const snippets = Array.isArray(group.snippets) ? group.snippets.map(String).filter(Boolean) : [];
    return [
      `### ${title}${meta ? ` (${meta})` : ""}`,
      url,
      ...snippets.map((snippet) => `- ${snippet.trim().replace(/\r?\n/g, "\n  ")}`),
    ].filter(Boolean).join("\n");
  }).join("\n\n");
}

function renderAnswer(data: Record<string, unknown>): string {
  const text = String(data.text ?? "").trim() || "(empty answer)";
  const seen = new Map<string, { url: string; title?: string }>();
  for (const entry of Array.isArray(data.citations) ? data.citations : []) {
    const citation = typeof entry === "string" ? { url: entry } : objectRecord(entry);
    const url = stringValue(citation.url);
    if (!url) continue;
    const key = canonicalUrl(url);
    const title = stringValue(citation.title);
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, title ? { url, title } : { url });
      continue;
    }
    if (!existing.title && title) existing.title = title;
    if (/\.md(?:$|[?#])/i.test(existing.url) && !/\.md(?:$|[?#])/i.test(url)) {
      existing.url = url;
    }
  }
  const sources = Array.from(seen.values()).map(
    (entry, index) => `${index + 1}. ${entry.title ? `${entry.title} — ` : ""}${entry.url}`,
  );
  return sources.length ? `${text}\n\nSources:\n${sources.join("\n")}` : text;
}

function indent(text: string): string {
  return text.split("\n").map((line) => `   ${line}`).join("\n");
}
