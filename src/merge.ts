import type { SearchItem } from "./types.js";

export interface MergedItem extends SearchItem {
  foundBy: string[];
}

const TRACKING_PARAM = /^(?:utm_|fbclid$|gclid$|mc_|ref$|ref_src$|spm$)/i;

/** URL identity for de-duplication: scheme, www, fragment, trailing slash and tracking parameters are ignored. */
export function canonicalUrl(value: string): string {
  try {
    const url = new URL(value);
    const params = Array.from(url.searchParams.entries()).filter(([key]) => !TRACKING_PARAM.test(key));
    params.sort(([a], [b]) => a.localeCompare(b));
    const query = params.length ? `?${params.map(([key, val]) => `${key}=${val}`).join("&")}` : "";
    const path = url.pathname.replace(/\/+$/, "");
    return `${url.hostname.toLowerCase().replace(/^www\./, "")}${path}${query}`;
  } catch {
    return value.trim().toLowerCase();
  }
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
    }
  }
  return Array.from(merged.values())
    .sort((a, b) => (b.foundBy.length - a.foundBy.length) || (a.rank - b.rank))
    .slice(0, limit)
    .map(({ rank: _rank, ...item }) => item);
}
