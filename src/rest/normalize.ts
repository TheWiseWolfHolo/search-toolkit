import type { ImageSearchItem, SearchItem } from "../types.js";

export const DEFAULT_ITEM_TEXT_CHARS = 16_000;

export const numberArg = (args: Record<string, unknown>, name: string, fallback: number) => {
  const value = args[name];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
};

export const stringArg = (args: Record<string, unknown>, name: string, fallback = "") =>
  typeof args[name] === "string" ? args[name] : fallback;

export function arrayArg(args: Record<string, unknown>, name: string): string[] {
  return Array.isArray(args[name]) ? args[name].map(String).map((value) => value.trim()).filter(Boolean) : [];
}

export function objectValue(value: unknown, key: string): string {
  if (!value || typeof value !== "object") return "";
  const field = (value as Record<string, unknown>)[key];
  if (typeof field === "string") return field;
  if (typeof field === "number" || typeof field === "boolean") return String(field);
  return "";
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
const PLACEHOLDER_DATE = /^(?:n\/a|null|none|unknown|undefined|-+)$/i;

/** Safely convert a numeric Unix epoch (seconds, ms, us, or ns) to YYYY-MM-DD, returning undefined when out of bounds. */
export function formatEpochDate(raw: number): string | undefined {
  if (!Number.isFinite(raw) || raw <= 1e8) return undefined;
  let ms = raw;
  if (ms < 1e11) ms = raw * 1000;
  else if (ms >= 1e17) ms = raw / 1e6;
  else if (ms >= 1e14) ms = raw / 1e3;
  if (!Number.isFinite(ms) || Math.abs(ms) > 8.64e15) return undefined;
  const date = new Date(ms);
  const time = date.getTime();
  if (!Number.isFinite(time)) return undefined;
  const year = date.getUTCFullYear();
  if (year < 1970 || year > 2100) return undefined;
  return date.toISOString().slice(0, 10);
}

/** First usable date-like field; ISO timestamps and Unix epochs are shortened to the calendar date. */
export function pickDate(item: Record<string, unknown>, keys: readonly string[] = DATE_KEYS): string | undefined {
  for (const key of keys) {
    const value = item[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      if (Number.isInteger(value) && value >= 1900 && value <= 2100) return String(value);
      const epoch = formatEpochDate(value);
      if (epoch) return epoch;
      continue;
    }
    if (typeof value !== "string") continue;
    const text = value.replace(/[\r\n]+/g, " ").trim();
    if (!text || PLACEHOLDER_DATE.test(text)) continue;
    if (/^\d{10}$/.test(text) || /^\d{13}$/.test(text)) {
      const epoch = formatEpochDate(Number(text));
      if (epoch) return epoch;
      continue;
    }
    return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : text.slice(0, 40);
  }
  return undefined;
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  middot: "·",
  bull: "•",
  copy: "©",
  reg: "®",
  trade: "™",
};

/** Remove search-highlight markup and safely decode the entities Brave returns in titles and descriptions. */
export function cleanHighlightText(value: string): string {
  return value
    .replace(/<\/?(?:strong|b|em|i|mark)(?:\s[^>]*)?>/gi, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
      if (entity.startsWith("#x") || entity.startsWith("#X")) {
        const cp = Number.parseInt(entity.slice(2), 16);
        if (Number.isInteger(cp) && cp >= 0 && cp <= 0x10ffff && (cp < 0xd800 || cp > 0xdfff)) {
          return String.fromCodePoint(cp);
        }
        return match;
      }
      if (entity.startsWith("#")) {
        const cp = Number.parseInt(entity.slice(1), 10);
        if (Number.isInteger(cp) && cp >= 0 && cp <= 0x10ffff && (cp < 0xd800 || cp > 0xdfff)) {
          return String.fromCodePoint(cp);
        }
        return match;
      }
      return ENTITIES[entity.toLowerCase()] ?? match;
    });
}

export interface NormalizeOptions {
  dateKeys?: readonly string[];
  /** Strip highlight tags and decode entities (Brave). */
  html?: boolean;
  /** Maximum characters to retain in `item.text` (defaults to DEFAULT_ITEM_TEXT_CHARS). */
  maxChars?: number;
}

function firstNonEmptyString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry === "string" && entry.trim()) out.push(entry.trim());
  }
  return out;
}

export function normalizeItem(value: unknown, options: NormalizeOptions = {}): SearchItem {
  const item = objectRecord(value);
  const clean = options.html ? cleanHighlightText : (text: string) => text;
  const maxChars = options.maxChars ?? DEFAULT_ITEM_TEXT_CHARS;
  const date = pickDate(item, options.dateKeys);
  const primaryText = firstNonEmptyString(item.text, item.snippet, item.description, item.content, item.summary, item.Summary);
  const extraSnippets = stringList(item.extra_snippets);
  const scholarMeta = [
    typeof item.publicationInfo === "string" ? item.publicationInfo.trim() : "",
    typeof item.citedBy === "number" ? `Cited by ${item.citedBy}` : "",
    // Serper Scholar names an open-access copy when one exists.
    typeof item.pdfUrl === "string" && item.pdfUrl.trim() ? `PDF: ${item.pdfUrl.trim()}` : "",
  ].filter(Boolean).join(" · ");
  const combined = [scholarMeta, primaryText, ...extraSnippets].filter(Boolean).join("\n");
  return {
    title: clean(firstNonEmptyString(item.title, item.name, item.Title, item.url, item.link, item.Url)),
    url: firstNonEmptyString(item.url, item.link, item.Url),
    text: clean(combined).slice(0, maxChars),
    ...(date ? { date } : {}),
  };
}

export function normalizeYouSection(
  value: unknown,
  section: "web" | "news",
  maxChars = DEFAULT_ITEM_TEXT_CHARS,
): Array<SearchItem & { section: string }> {
  if (!Array.isArray(value)) return [];
  return value.map((row) => {
    const item = objectRecord(row);
    const contents = objectRecord(item.contents);
    const highlights = stringList(contents.highlights);
    const markdown = typeof contents.markdown === "string" && contents.markdown.trim() ? [contents.markdown.trim()] : [];
    const snippets = stringList(item.snippets);
    const date = pickDate(item, ["page_age", "publish_date", "date"]);
    const description = firstNonEmptyString(item.description);
    const body = highlights.length
      ? highlights
      : markdown.length
        ? markdown
        : snippets.length
          ? snippets
          : description
            ? [description]
            : [];
    const url = firstNonEmptyString(item.url);
    return {
      section,
      title: firstNonEmptyString(item.title, url),
      url,
      text: body.join("\n").slice(0, maxChars),
      ...(date ? { date } : {}),
    };
  });
}

export function normalizeYouKnowledge(
  value: unknown,
  maxChars = DEFAULT_ITEM_TEXT_CHARS,
): Array<SearchItem & { section: string }> {
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
      title: firstNonEmptyString(item.title) || "Knowledge",
      url: firstNonEmptyString(item.url),
      text: `${firstNonEmptyString(item.description)}${credit}`.slice(0, maxChars),
      ...(date ? { date } : {}),
    };
  });
}

export function normalizeParallelItem(value: unknown, maxChars = DEFAULT_ITEM_TEXT_CHARS): SearchItem {
  const item = objectRecord(value);
  const excerpts = stringList(item.excerpts);
  const date = pickDate(item, ["publish_date", "published_date", "date"]);
  const url = firstNonEmptyString(item.url);
  return {
    title: firstNonEmptyString(item.title, url),
    url,
    text: excerpts.join("\n").slice(0, maxChars),
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
  let foundEmptyList = fromStructured?.length === 0;

  const content = Array.isArray(record.content) ? record.content : [];
  const texts = content
    .map((block) => objectRecord(block))
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => String(block.text).trim())
    .filter(Boolean);
  if (!texts.length) return fromStructured;

  for (const text of texts) {
    if (text.startsWith("{") || text.startsWith("[")) {
      try {
        const parsed = JSON.parse(text) as unknown;
        if (parsed && typeof parsed === "object" && "searchToolkitRoute" in (parsed as Record<string, unknown>)) continue;
        const items = itemsFromObject(parsed);
        if (items?.length) return items;
        if (items?.length === 0) foundEmptyList = true;
      } catch {
        // Not JSON; try structured text parsing below.
      }
    }
  }

  const combined = texts
    .filter((text) => !text.startsWith('{"searchToolkitRoute"'))
    .join("\n\n");
  return parseTitleUrlBlocks(combined) ?? parseMarkdownResultBlocks(combined) ?? (foundEmptyList ? [] : undefined);
}

/** AnySearch-style Markdown: `### 1. Title`, then `- **URL**: …`, then bullet text ending in `date: …`. */
function parseMarkdownResultBlocks(text: string): SearchItem[] | undefined {
  const blocks = text.split(/\r?\n(?=###\s+\d+\.\s)/).filter((block) => /^###\s+\d+\.\s/.test(block.trim()));
  const items: SearchItem[] = [];
  for (const block of blocks) {
    const match = block.trim().match(/^###\s+\d+\.\s+([^\r\n]+)\r?\n-\s+\*\*URL\*\*:\s*(https?:\/\/\S+)([\s\S]*)$/);
    if (!match) continue;
    let body = (match[3] ?? "").split(/\r?\n/).map((line) => line.replace(/^\s*-\s+/, "").trim()).filter(Boolean).join("\n");
    let date: string | undefined;
    const dated = body.match(/\s*date:\s*([^\n]+)$/i);
    if (dated?.[1]) {
      const rawDate = dated[1].trim();
      if (rawDate && !PLACEHOLDER_DATE.test(rawDate)) {
        date = /^\d{4}-\d{2}-\d{2}/.test(rawDate) ? rawDate.slice(0, 10) : rawDate.slice(0, 40);
      }
      body = body.slice(0, dated.index).trim();
    }
    items.push({
      title: (match[1] ?? "").trim(),
      url: (match[2] ?? "").trim(),
      text: body.slice(0, DEFAULT_ITEM_TEXT_CHARS),
      ...(date ? { date } : {}),
    });
  }
  return items.length ? items : undefined;
}

const ITEM_LIST_KEYS = ["results", "result", "items", "data", "organic", "web", "news"] as const;

function itemsFromObject(value: unknown, depth = 0): SearchItem[] | undefined {
  if (depth > 2) return undefined;
  if (Array.isArray(value)) {
    if (!value.length) return [];
    const items = value.map((entry) => normalizeItem(entry)).filter((item) => Boolean(item.url));
    return items.length ? items : undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const obj = value as Record<string, unknown>;
  let foundEmptyList = false;
  for (const key of ITEM_LIST_KEYS) {
    const candidate = obj[key];
    if (Array.isArray(candidate)) {
      if (!candidate.length) foundEmptyList = true;
      const items = candidate.map((entry) => normalizeItem(entry)).filter((item) => Boolean(item.url));
      if (items.length) return items;
    } else if (candidate && typeof candidate === "object") {
      const nested = itemsFromObject(candidate, depth + 1);
      if (nested?.length) return nested;
      if (nested?.length === 0) foundEmptyList = true;
    }
  }
  return foundEmptyList ? [] : undefined;
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
        if (rawDate && !PLACEHOLDER_DATE.test(rawDate)) {
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
      text: rest.slice(0, DEFAULT_ITEM_TEXT_CHARS),
      ...(date ? { date } : {}),
    });
  }
  return items.length ? items : undefined;
}

export function normalizeSerperImage(value: unknown): ImageSearchItem {
  const item = objectRecord(value);
  const imageUrl = firstNonEmptyString(item.imageUrl);
  return compactImageItem({
    title: firstNonEmptyString(item.title, imageUrl),
    url: firstNonEmptyString(item.link, item.url),
    text: firstNonEmptyString(item.source, item.domain),
    imageUrl,
    thumbnailUrl: firstNonEmptyString(item.thumbnailUrl) || undefined,
    width: numberValue(item.imageWidth),
    height: numberValue(item.imageHeight),
    thumbnailWidth: numberValue(item.thumbnailWidth),
    thumbnailHeight: numberValue(item.thumbnailHeight),
    source: firstNonEmptyString(item.source) || undefined,
    domain: firstNonEmptyString(item.domain) || undefined,
    position: numberValue(item.position),
  });
}

export function normalizeBraveImage(value: unknown): ImageSearchItem {
  const item = objectRecord(value);
  const properties = objectRecord(item.properties);
  const thumbnail = objectRecord(item.thumbnail);
  const imageUrl = firstNonEmptyString(properties.url, thumbnail.original);
  return compactImageItem({
    title: cleanHighlightText(firstNonEmptyString(item.title, properties.url, thumbnail.original)),
    url: firstNonEmptyString(item.url),
    text: cleanHighlightText(firstNonEmptyString(item.description, item.source)),
    imageUrl,
    thumbnailUrl: firstNonEmptyString(thumbnail.src, properties.placeholder) || undefined,
    width: numberValue(properties.width),
    height: numberValue(properties.height),
    source: firstNonEmptyString(item.source) || undefined,
  });
}

export function normalizeParallelImage(value: unknown): ImageSearchItem {
  const item = objectRecord(value);
  const imageUrl = firstNonEmptyString(item.image_url);
  return compactImageItem({
    title: firstNonEmptyString(item.title, imageUrl),
    url: firstNonEmptyString(item.source_page_url, item.url),
    text: firstNonEmptyString(item.title),
    imageUrl,
    width: numberValue(item.width),
    height: numberValue(item.height),
  });
}

const REQUIRED_IMAGE_KEYS = new Set(["title", "url", "text", "imageUrl"]);

function compactImageItem(item: Record<string, unknown>): ImageSearchItem {
  return Object.fromEntries(
    Object.entries(item).filter(([key, value]) => REQUIRED_IMAGE_KEYS.has(key) || (value !== undefined && value !== "")),
  ) as unknown as ImageSearchItem;
}

export function extractResponseText(data: Record<string, unknown>): string {
  if (typeof data.output_text === "string" && data.output_text.trim()) return data.output_text;
  if (!Array.isArray(data.output)) return "";
  const parts: string[] = [];
  for (const rawItem of data.output) {
    const item = objectRecord(rawItem);
    const itemType = stringValue(item.type);
    if (itemType && itemType !== "message") continue;
    const content = item.content;
    if (!Array.isArray(content)) continue;
    for (const rawBlock of content) {
      const block = objectRecord(rawBlock);
      const blockType = stringValue(block.type);
      if (blockType && blockType !== "output_text" && blockType !== "text") continue;
      const text = block.text;
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
