import type { SearchItem } from "./types.js";

export interface MergedItem extends SearchItem {
  foundBy: string[];
}

const TRACKING_PARAM = /^(?:utm_|fbclid$|gclid$|mc_|ref$|ref_src$|spm$)/i;

/** URL identity for de-duplication: scheme, www, fragment, trailing slash, doc suffix (.md/.html) and tracking parameters are ignored. */
export function canonicalUrl(value: string): string {
  try {
    const url = new URL(value);
    const params = Array.from(url.searchParams.entries()).filter(([key]) => !TRACKING_PARAM.test(key));
    params.sort(([a], [b]) => a.localeCompare(b));
    const query = params.length ? `?${params.map(([key, val]) => `${key}=${val}`).join("&")}` : "";
    const path = url.pathname
      .replace(/\/+$/, "")
      .replace(/\/index\.html?$/i, "")
      .replace(/\.(?:md|html?)$/i, "");
    return `${url.hostname.toLowerCase().replace(/^www\./, "")}${path}${query}`;
  } catch {
    return value.trim().toLowerCase();
  }
}

/**
 * De-duplicate items within a single provider response by canonical URL (or imageUrl for images),
 * keeping the richer excerpt, preserving dates, and preferring cleaner canonical URLs.
 */
export function dedupeItems<T extends SearchItem>(items: T[], limit?: number): T[] {
  const seen = new Map<string, T>();
  for (const item of items) {
    const rawKey = ("imageUrl" in item && typeof item.imageUrl === "string" && item.imageUrl)
      ? item.imageUrl
      : item?.url;
    if (!rawKey) {
      seen.set(`__anon_${seen.size}`, item);
      continue;
    }
    const key = canonicalUrl(rawKey);
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, { ...item });
      continue;
    }
    if ((item.text?.length ?? 0) > (existing.text?.length ?? 0)) existing.text = item.text;
    if (!existing.date && item.date) existing.date = item.date;
    if (!existing.title && item.title) existing.title = item.title;
    if (/\.md(?:$|[?#])/i.test(existing.url) && item.url && !/\.md(?:$|[?#])/i.test(item.url)) {
      existing.url = item.url;
    }
  }
  const result = Array.from(seen.values());
  return limit !== undefined ? result.slice(0, limit) : result;
}

/**
 * Merge ranked lists from different indexes. Results found by more than one
 * provider come first (independent corroboration), then the rest interleaved by
 * rank so no single provider dominates.
 */
export function mergeItems(lists: Array<{ provider: string; items: SearchItem[] }>, limit: number): MergedItem[] {
  const merged = new Map<string, MergedItem & { rank: number }>();
  const depth = Math.max(0, ...lists.map((list) => list.items.length));
  for (let rank = 0; rank < depth; rank += 1) {
    for (const list of lists) {
      const item = list.items[rank];
      if (!item?.url) continue;
      const key = canonicalUrl(item.url);
      const existing = merged.get(key);
      if (!existing) {
        merged.set(key, { ...item, foundBy: [list.provider], rank: merged.size });
        continue;
      }
      if (!existing.foundBy.includes(list.provider)) existing.foundBy.push(list.provider);
      if (item.text.length > existing.text.length) existing.text = item.text;
      if (!existing.date && item.date) existing.date = item.date;
      if (/\.md(?:$|[?#])/i.test(existing.url) && !/\.md(?:$|[?#])/i.test(item.url)) {
        existing.url = item.url;
      }
    }
  }
  return Array.from(merged.values())
    .sort((a, b) => (b.foundBy.length - a.foundBy.length) || (a.rank - b.rank))
    .slice(0, limit)
    .map(({ rank: _rank, ...item }) => item);
}
