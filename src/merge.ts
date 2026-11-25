import type { SearchItem } from "./types.js";

export interface MergedItem extends SearchItem {
  foundBy: string[];
}

const TRACKING_PARAM = /^(?:utm_|fbclid$|gclid$|msclkid$|mc_|ref$|ref_src$|spm$|si$|vd_source$|share_source$|share_medium$|ved$|ei$|usg$)/i;
const RRF_K = 20;
const SCORE_EPSILON = 1e-12;

/**
 * URL identity for de-duplication: scheme, www, fragment, trailing slash,
 * doc suffix (.md/.html, /index.md, /index.html) and tracking parameters are
 * ignored while non-default ports are preserved and query params are sorted
 * deterministically by [key, value].
 */
export function canonicalUrl(value: string): string {
  try {
    const url = new URL(value);
    const params = Array.from(url.searchParams.entries()).filter(([key]) => !TRACKING_PARAM.test(key));
    params.sort(([ak, av], [bk, bv]) => (ak < bk ? -1 : ak > bk ? 1 : av < bv ? -1 : av > bv ? 1 : 0));
    const query = params.length ? `?${params.map(([key, val]) => `${key}=${val}`).join("&")}` : "";
    const path = url.pathname
      .replace(/\/+$/, "")
      .replace(/\/index\.(?:html?|md)$/i, "")
      .replace(/\.(?:md|html?)$/i, "");
    return `${url.host.toLowerCase().replace(/^www\./, "")}${path}${query}`;
  } catch {
    return value.trim().toLowerCase();
  }
}

const RELEASE_VERSION = /\bv?(\d+)\.\d+\.\d+\b/gi;
const PATH_MAJOR_VERSION = /\/(v\d+)(?:\.\d+)*(?:\/|$)/i;
const TITLE_HAS_VERSION = /\bv\d+(?:\.\d+)*\b/i;
const HAS_CJK = /[\u3400-\u9fff]/;

const GENERIC_TITLE_WORDS = new Set([
  "docs", "doc", "documentation", "api", "reference", "guide", "guides",
  "home", "homepage", "welcome", "overview", "index", "main", "page",
  "help", "support", "blog", "news", "forum", "community", "status",
  "portal", "console", "dashboard", "platform", "cloud", "developer", "developers",
  "pricing", "about", "contact", "search", "results", "login", "signin", "sign",
  "in", "log", "register", "signup", "account", "settings", "profile",
  "privacy", "terms", "legal", "changelog", "releases", "release", "notes",
  "untitled", "loading", "error", "not", "found", "web", "site", "official",
]);

function isGenericOrShortTitle(title: string, hostname: string): boolean {
  if (!title) return true;
  const cjk = HAS_CJK.test(title);
  if (title.length < (cjk ? 6 : 12)) return true;
  const hostTokens = new Set(
    hostname
      .toLowerCase()
      .replace(/^www\./, "")
      .split(/[.\-:]+/)
      .filter(Boolean),
  );
  let informativeChars = 0;
  for (const token of title.split(" ")) {
    if (!token) continue;
    const stripped = token.replace(/[^a-z0-9\u3400-\u9fff]/g, "");
    if (!stripped) continue;
    if (GENERIC_TITLE_WORDS.has(stripped) || hostTokens.has(stripped)) continue;
    informativeChars += stripped.length;
  }
  return informativeChars < (cjk ? 2 : 4);
}

/**
 * Identity for "the same page in another minor/patch release or mirror":
 * the same site (including non-default port) and the same non-generic title
 * with x.y.z release numbers normalized to their major version (vX). Node's
 * v24.13.1 and v24.17.0 docs for one module collapse, while v20.x vs v24.x
 * stay distinct; two-part versions (V4.1 vs V4.2) and distinct pages sharing
 * generic site titles ("GitHub", "Stripe Docs") do not collapse.
 */
export function nearDuplicateKey(item: { title?: string | undefined; url?: string | undefined }): string {
  const url = item.url ?? "";
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return canonicalUrl(url);
  }
  const host = parsed.host.toLowerCase().replace(/^www\./, "");
  const title = (item.title ?? "")
    .toLowerCase()
    .replace(RELEASE_VERSION, "v$1")
    .replace(/[\s|·:_\-–—/]+/g, " ")
    .trim();
  if (isGenericOrShortTitle(title, parsed.hostname)) {
    return canonicalUrl(url);
  }
  // If the title omits a version string, preserve a major-version path segment (/v1/ vs /v2/).
  const pathVersion = !TITLE_HAS_VERSION.test(title) ? parsed.pathname.match(PATH_MAJOR_VERSION)?.[1]?.toLowerCase() : undefined;
  return pathVersion ? `${host}|${title}|${pathVersion}` : `${host}|${title}`;
}

function isMarkdownUrl(url: string | undefined): boolean {
  return Boolean(url && /\.md(?:$|[?#])/i.test(url));
}

function mergeItemFields<T extends SearchItem>(target: T, incoming: T): void {
  if ((incoming.text?.length ?? 0) > (target.text?.length ?? 0)) target.text = incoming.text;
  if (!target.date && incoming.date) target.date = incoming.date;
  if (!target.title && incoming.title) target.title = incoming.title;
  if (isMarkdownUrl(target.url) && incoming.url && !isMarkdownUrl(incoming.url)) {
    target.url = incoming.url;
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
    mergeItemFields(existing, item);
  }
  // Second pass: collapse release/mirror near-duplicates while merging richer fields and cleaner URLs.
  const pages = new Map<string, T>();
  const result: T[] = [];
  for (const item of seen.values()) {
    if (("imageUrl" in item && item.imageUrl) || !item?.url) {
      result.push(item);
      continue;
    }
    const key = nearDuplicateKey(item);
    const existing = pages.get(key);
    if (!existing) {
      pages.set(key, item);
      result.push(item);
      continue;
    }
    mergeItemFields(existing, item);
  }
  return limit !== undefined ? result.slice(0, limit) : result;
}

interface MergeEntry extends MergedItem {
  firstSeenRank: number;
  providerRanks: Map<string, number>;
}

function rrfScore(providerRanks: ReadonlyMap<string, number>): number {
  let score = 0;
  for (const rank of providerRanks.values()) {
    score += 1 / (RRF_K + rank);
  }
  return score;
}

function compareMerged(a: MergeEntry, b: MergeEntry): number {
  const diff = rrfScore(b.providerRanks) - rrfScore(a.providerRanks);
  if (Math.abs(diff) > SCORE_EPSILON) return diff;
  return (b.foundBy.length - a.foundBy.length) || (a.firstSeenRank - b.firstSeenRank);
}

/**
 * Merge ranked lists from different indexes using Reciprocal Rank Fusion
 * `sum(1 / (20 + rank_p))`, breaking ties deterministically by provider
 * corroboration count DESC and first-seen rank ASC.
 */
export function mergeItems(lists: Array<{ provider: string; items: SearchItem[] }>, limit: number): MergedItem[] {
  const merged = new Map<string, MergeEntry>();
  const depth = Math.max(0, ...lists.map((list) => list.items.length));
  for (let rank = 0; rank < depth; rank += 1) {
    const oneBasedRank = rank + 1;
    for (const list of lists) {
      const item = list.items[rank];
      if (!item?.url) continue;
      const key = canonicalUrl(item.url);
      const existing = merged.get(key);
      if (!existing) {
        merged.set(key, {
          ...item,
          foundBy: [list.provider],
          firstSeenRank: merged.size,
          providerRanks: new Map([[list.provider, oneBasedRank]]),
        });
        continue;
      }
      if (!existing.providerRanks.has(list.provider)) {
        existing.providerRanks.set(list.provider, oneBasedRank);
        existing.foundBy.push(list.provider);
      }
      mergeItemFields(existing, item);
    }
  }
  const ranked = Array.from(merged.values()).sort(compareMerged);
  // Collapse release/mirror near-duplicates across indexes while merging corroboration, best ranks, and richer excerpts.
  const collapsed = new Map<string, MergeEntry>();
  for (const entry of ranked) {
    const nearKey = nearDuplicateKey(entry);
    const existing = collapsed.get(nearKey);
    if (!existing) {
      collapsed.set(nearKey, {
        ...entry,
        foundBy: [...entry.foundBy],
        providerRanks: new Map(entry.providerRanks),
      });
      continue;
    }
    for (const [provider, rank] of entry.providerRanks) {
      const prev = existing.providerRanks.get(provider);
      if (prev === undefined) {
        existing.providerRanks.set(provider, rank);
        existing.foundBy.push(provider);
      } else if (rank < prev) {
        existing.providerRanks.set(provider, rank);
      }
    }
    if (entry.firstSeenRank < existing.firstSeenRank) existing.firstSeenRank = entry.firstSeenRank;
    mergeItemFields(existing, entry);
  }
  return Array.from(collapsed.values())
    .sort(compareMerged)
    .slice(0, limit)
    .map(({ firstSeenRank: _firstSeenRank, providerRanks: _providerRanks, ...item }) => item);
}
