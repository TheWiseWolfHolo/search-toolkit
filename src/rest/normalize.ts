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
    if (typeof value === "number" && Number.isInteger(value) && value >= 1900 && value <= 2100) {
      return String(value);
    }
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
  const primaryText = String(item.text ?? item.snippet ?? item.description ?? item.content ?? item.Summary ?? "");
  const extraSnippets = Array.isArray(item.extra_snippets)
    ? item.extra_snippets.map((entry) => String(entry ?? "").trim()).filter(Boolean)
    : [];
  const scholarMeta = [
    typeof item.publicationInfo === "string" ? item.publicationInfo.trim() : "",
    typeof item.citedBy === "number" ? `Cited by ${item.citedBy}` : "",
  ].filter(Boolean).join(" · ");
  const combined = [scholarMeta, primaryText, ...extraSnippets].filter(Boolean).join("\n");
  return {
    title: clean(String(item.title ?? item.name ?? item.Title ?? item.url ?? "")),
    url: String(item.url ?? item.link ?? item.Url ?? ""),
    text: clean(combined.slice(0, 4_000)),
    ...(date ? { date } : {}),
  };
}

export function normalizeYouSection(value: unknown, section: "web" | "news"): Array<SearchItem & { section: string }> {
  if (!Array.isArray(value)) return [];
  return value.map((row) => {
    const item = objectRecord(row);
    const contents = objectRecord(item.contents);
    const highlights = Array.isArray(contents.highlights) ? contents.highlights.map(String) : [];
    const markdown = typeof contents.markdown === "string" && contents.markdown.trim() ? [contents.markdown.trim()] : [];
    const snippets = Array.isArray(item.snippets) ? item.snippets.map(String) : [];
    const date = pickDate(item, ["page_age", "publish_date", "date"]);
    const body = highlights.length
      ? highlights
      : markdown.length
        ? markdown
        : snippets.length
          ? snippets
          : [String(item.description ?? "")];
    return {
      section,
      title: String(item.title ?? item.url ?? ""),
      url: String(item.url ?? ""),
      text: body.join("\n").slice(0, 4_000),
      ...(date ? { date } : {}),
    };
  });
}

export function normalizeYouKnowledge(value: unknown): Array<SearchItem & { section: string }> {
  if (!Array.isArray(value)) return [];
  return value.map((row) => {
    const item = objectRecord(row);
    const attributions = Array.isArray(item.attribution)
      ? item.attribution
          .map((entry) => stringValue(objectRecord(entry).name))
          .filter((name): name is string => Boolean(name))
      : [];
    const credit = attributions.length ? ` (Source: ${attributions.join(", ")})` : "";
    const date = pickDate(item, ["as_of", "date"]);
    return {
      section: "knowledge",
      title: String(item.title ?? "Knowledge"),
      url: String(item.url ?? ""),
      text: `${String(item.description ?? "").trim()}${credit}`.slice(0, 4_000),
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
    text: excerpts.join("\n").slice(0, 4_000),
    ...(date ? { date } : {}),
  };
}

/**
 * Parse search results from an upstream MCP tool response (Exa text blocks,
 * Tavily/Firecrawl/AnySearch JSON or structuredContent) into normalized SearchItems.
 */
export function extractUpstreamSearchItems(upstreamTool: string, output: unknown): SearchItem[] | undefined {
  if (!/search/i.test(upstreamTool) || /(?:fetch|extract|scrape|crawl|map)/i.test(upstreamTool)) return undefined;
  const record = objectRecord(output);
  if (record.isError === true) return undefined;

  const fromStructured = itemsFromObject(record.structuredContent);
  if (fromStructured?.length) return fromStructured;

  const content = Array.isArray(record.content) ? record.content : [];
  const texts = content
    .map((block) => objectRecord(block))
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => String(block.text).trim())
    .filter(Boolean);
  if (!texts.length) return undefined;

  for (const text of texts) {
    if (text.startsWith("{") || text.startsWith("[")) {
      try {
        const parsed = JSON.parse(text) as unknown;
        if (parsed && typeof parsed === "object" && "searchToolkitRoute" in (parsed as Record<string, unknown>)) continue;
        const items = itemsFromObject(parsed);
        if (items?.length) return items;
      } catch {
        // Not JSON; try structured text parsing below.
      }
    }
  }

  const combined = texts
    .filter((text) => !text.startsWith('{"searchToolkitRoute"'))
    .join("\n\n");
  return parseTitleUrlBlocks(combined);
}

function itemsFromObject(value: unknown): SearchItem[] | undefined {
  if (Array.isArray(value)) {
    const items = value.map((entry) => normalizeItem(entry)).filter((item) => Boolean(item.url));
    return items.length ? items : undefined;
  }
  const obj = objectRecord(value);
  for (const key of ["results", "items", "data", "organic", "web"]) {
    const candidate = obj[key];
    if (Array.isArray(candidate)) {
      const items = candidate.map((entry) => normalizeItem(entry)).filter((item) => Boolean(item.url));
      if (items.length) return items;
    }
  }
  return undefined;
}

function parseTitleUrlBlocks(text: string): SearchItem[] | undefined {
  if (!/(?:^|\n)Title:\s*.+\r?\nURL:\s*https?:\/\//i.test(text)) return undefined;
  const chunks = text
    .split(/(?:^|\r?\n(?:---\r?\n\s*)?)(?=Title:\s*[^\r\n]+\r?\nURL:\s*https?:\/\/)/i)
    .map((chunk) => chunk.trim())
    .filter(Boolean);
  const items: SearchItem[] = [];
  for (const chunk of chunks) {
    const match = chunk.match(/^Title:\s*([^\r\n]+)\r?\nURL:\s*(https?:\/\/[^\s\r\n]+)([\s\S]*)$/i);
    if (!match) continue;
    const title = (match[1] ?? "").trim();
    const url = (match[2] ?? "").trim();
    let rest = (match[3] ?? "").trim();
    let date: string | undefined;
    const headerLines = rest.split(/\r?\n/);
    let bodyStart = 0;
    for (; bodyStart < headerLines.length; bodyStart += 1) {
      const line = (headerLines[bodyStart] ?? "").trim();
      if (!line) continue;
      const pubMatch = line.match(/^(?:Published(?:\s+Date)?|Date):\s*(.*)$/i);
      if (pubMatch) {
        const rawDate = (pubMatch[1] ?? "").trim();
        if (rawDate && !/^(?:N\/A|null|none|unknown)$/i.test(rawDate)) {
          date = /^\d{4}-\d{2}-\d{2}/.test(rawDate) ? rawDate.slice(0, 10) : rawDate.slice(0, 40);
        }
        continue;
      }
      if (/^(?:Author|Score|ID|Favicon|Image):\s*/i.test(line)) continue;
      if (/^(?:Highlights|Text|Content|Snippet|Summary):\s*$/i.test(line)) {
        bodyStart += 1;
        break;
      }
      const inlineBody = line.match(/^(?:Highlights|Text|Content|Snippet|Summary):\s+(.+)$/i);
      if (inlineBody) {
        headerLines[bodyStart] = inlineBody[1] ?? "";
        break;
      }
      break;
    }
    rest = headerLines.slice(bodyStart).join("\n").replace(/\r?\n---\s*$/, "").trim();
    items.push({
      title: title || url,
      url,
      text: rest.slice(0, 4_000),
      ...(date ? { date } : {}),
    });
  }
  return items.length ? items : undefined;
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

export function normalizeParallelImage(value: unknown): ImageSearchItem {
  const item = objectRecord(value);
  return compactImageItem({
    title: String(item.title ?? item.image_url ?? ""),
    url: String(item.source_page_url ?? item.url ?? ""),
    text: String(item.title ?? ""),
    imageUrl: String(item.image_url ?? ""),
    width: numberValue(item.width),
    height: numberValue(item.height),
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
