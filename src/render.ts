import { objectRecord, stringValue } from "./rest/normalize.js";

/**
 * Turn a normalized provider payload into compact text for the model. The full
 * payload stays in structuredContent; this is only what the model reads, so it
 * avoids JSON escaping, repeated metadata, and fields the model cannot use.
 */
export function renderPayload(payload: unknown): string {
  const record = objectRecord(payload);
  const parts: string[] = [];
  if (Array.isArray(record.items)) parts.push(renderItems(record.items));
  else if (record.grounding && typeof record.grounding === "object") parts.push(renderGrounding(record));
  else if (typeof record.text === "string") parts.push(renderAnswer(record));
  else return JSON.stringify(payload);
  const warnings = Array.isArray(record.warnings) ? record.warnings.map((item) => stringValue(objectRecord(item).message) ?? String(typeof item === "string" ? item : JSON.stringify(item))) : [];
  if (warnings.length) parts.push(`Warnings: ${warnings.join("; ")}`);
  return parts.filter(Boolean).join("\n\n");
}

export function renderItems(items: unknown[]): string {
  if (!items.length) return "No results.";
  return items.map((value, index) => {
    const item = objectRecord(value);
    const title = String(item.title ?? "").trim() || String(item.url ?? "").trim() || "(untitled)";
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
    const text = stringValue(item.text)?.trim();
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
    const source = objectRecord(sources[url]);
    const title = stringValue(group.title) ?? stringValue(group.name) ?? stringValue(source.title) ?? url;
    const host = stringValue(source.hostname);
    const age = Array.isArray(source.age) ? source.age.map(String).find((entry) => /^\d{4}-\d{2}-\d{2}/.test(entry)) ?? source.age.map(String)[0] : undefined;
    const meta = [host, age?.slice(0, 10)].filter(Boolean).join(", ");
    const snippets = Array.isArray(group.snippets) ? group.snippets.map(String).filter(Boolean) : [];
    return [`### ${title}${meta ? ` (${meta})` : ""}`, url, ...snippets.map((snippet) => `- ${snippet.trim()}`)].filter(Boolean).join("\n");
  }).join("\n\n");
}

function renderAnswer(data: Record<string, unknown>): string {
  const text = String(data.text ?? "").trim() || "(empty answer)";
  const seen = new Set<string>();
  const sources: string[] = [];
  for (const entry of Array.isArray(data.citations) ? data.citations : []) {
    const citation = typeof entry === "string" ? { url: entry } : objectRecord(entry);
    const url = stringValue(citation.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const title = stringValue(citation.title);
    sources.push(`${sources.length + 1}. ${title ? `${title} — ` : ""}${url}`);
  }
  return sources.length ? `${text}\n\nSources:\n${sources.join("\n")}` : text;
}

function indent(text: string): string {
  return text.split("\n").map((line) => `   ${line}`).join("\n");
}
