import type { ImageSearchItem, SearchItem } from "../types.js";

export const numberArg = (args: Record<string, unknown>, name: string, fallback: number) =>
  typeof args[name] === "number" ? args[name] : fallback;

export const stringArg = (args: Record<string, unknown>, name: string, fallback = "") =>
  typeof args[name] === "string" ? args[name] : fallback;

export function arrayArg(args: Record<string, unknown>, name: string): string[] {
  return Array.isArray(args[name]) ? args[name].map(String).map((value) => value.trim()).filter(Boolean) : [];
}

export function objectValue(value: unknown, key: string): string {
  return value && typeof value === "object" ? String((value as Record<string, unknown>)[key] ?? "") : "";
}

export function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

export function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

const DATE_KEYS = ["page_age", "publish_date", "published_date", "publishedDate", "published", "page_time", "date", "age"];

/** First usable date-like field; ISO timestamps are shortened to the calendar date. */
export function pickDate(item: Record<string, unknown>, keys: readonly string[] = DATE_KEYS): string | undefined {
  for (const key of keys) {
    const value = item[key];
    if (typeof value !== "string") continue;
    const text = value.trim();
    if (!text) continue;
    return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : text.slice(0, 40);
  }
  return undefined;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** Remove search-highlight markup and decode the entities Brave returns in titles and descriptions. */
export function cleanHighlightText(value: string): string {
  return value
    .replace(/<\/?(?:strong|b|em|i|mark)>/gi, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
      if (entity.startsWith("#x") || entity.startsWith("#X")) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
      if (entity.startsWith("#")) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
      return ENTITIES[entity.toLowerCase()] ?? match;
    });
}

export interface NormalizeOptions {
  dateKeys?: readonly string[];
  /** Strip highlight tags and decode entities (Brave). */
  html?: boolean;
}

export function normalizeItem(value: unknown, options: NormalizeOptions = {}): SearchItem {
  const item = objectRecord(value);
  const clean = options.html ? cleanHighlightText : (text: string) => text;
  const date = pickDate(item, options.dateKeys);
  return {
    title: clean(String(item.title ?? item.name ?? item.Title ?? item.url ?? "")),
    url: String(item.url ?? item.link ?? item.Url ?? ""),
    text: clean(String(item.text ?? item.snippet ?? item.description ?? item.content ?? item.Summary ?? "").slice(0, 4_000)),
    ...(date ? { date } : {}),
  };
}

export function normalizeYouSection(value: unknown, section: "web" | "news"): Array<SearchItem & { section: string }> {
  if (!Array.isArray(value)) return [];
  return value.map((row) => {
    const item = objectRecord(row);
    const contents = objectRecord(item.contents);
    const highlights = Array.isArray(contents.highlights) ? contents.highlights.map(String) : [];
    const snippets = Array.isArray(item.snippets) ? item.snippets.map(String) : [];
    const date = pickDate(item, ["page_age", "publish_date", "date"]);
    return {
      section,
      title: String(item.title ?? item.url ?? ""),
      url: String(item.url ?? ""),
      text: (highlights.length ? highlights : snippets.length ? snippets : [String(item.description ?? "")]).join("\n").slice(0, 12_000),
      ...(date ? { date } : {}),
    };
  });
}

export function normalizeParallelItem(value: unknown): SearchItem {
  const item = objectRecord(value);
  const excerpts = Array.isArray(item.excerpts) ? item.excerpts.map(String) : [];
  const date = pickDate(item, ["publish_date", "published_date", "date"]);
  return {
    title: String(item.title ?? item.url ?? ""),
    url: String(item.url ?? ""),
    text: excerpts.join("\n").slice(0, 20_000),
    ...(date ? { date } : {}),
  };
}

export function normalizeSerperImage(value: unknown): ImageSearchItem {
  const item = objectRecord(value);
  return compactImageItem({
    title: String(item.title ?? item.imageUrl ?? ""),
    url: String(item.link ?? item.url ?? ""),
    text: String(item.source ?? item.domain ?? ""),
    imageUrl: String(item.imageUrl ?? ""),
    thumbnailUrl: stringValue(item.thumbnailUrl),
    width: numberValue(item.imageWidth),
    height: numberValue(item.imageHeight),
    thumbnailWidth: numberValue(item.thumbnailWidth),
    thumbnailHeight: numberValue(item.thumbnailHeight),
    source: stringValue(item.source),
    domain: stringValue(item.domain),
    position: numberValue(item.position),
  });
}

export function normalizeBraveImage(value: unknown): ImageSearchItem {
  const item = objectRecord(value);
  const properties = objectRecord(item.properties);
  const thumbnail = objectRecord(item.thumbnail);
  return compactImageItem({
    title: String(item.title ?? properties.url ?? ""),
    url: String(item.url ?? ""),
    text: String(item.description ?? item.source ?? ""),
    imageUrl: String(properties.url ?? thumbnail.original ?? ""),
    thumbnailUrl: stringValue(thumbnail.src) ?? stringValue(properties.placeholder),
    width: numberValue(properties.width),
    height: numberValue(properties.height),
    source: stringValue(item.source),
  });
}

function compactImageItem(item: Record<string, unknown>): ImageSearchItem {
  return Object.fromEntries(Object.entries(item).filter(([, value]) => value !== undefined && value !== "")) as unknown as ImageSearchItem;
}

export function extractResponseText(data: Record<string, unknown>): string {
  if (typeof data.output_text === "string") return data.output_text;
  if (!Array.isArray(data.output)) return "";
  const parts: string[] = [];
  for (const item of data.output) {
    const content = objectRecord(item).content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      const text = objectRecord(block).text;
      if (typeof text === "string") parts.push(text);
    }
  }
  return parts.join("\n");
}

export function collectCitations(data: Record<string, unknown>): unknown[] {
  const found: unknown[] = [];
  if (Array.isArray(data.citations)) found.push(...data.citations);
  if (!Array.isArray(data.output)) return found;
  for (const item of data.output) {
    const content = objectRecord(item).content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      const annotations = objectRecord(block).annotations;
      if (Array.isArray(annotations)) found.push(...annotations);
    }
  }
  return found;
}
