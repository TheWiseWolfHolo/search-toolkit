import { safeSlice, trimText } from "./shape.js";

// Lines that are page furniture rather than content: copy buttons, anchors, table rules, TOC labels.
const FURNITURE_LINE = /^(?:copy|copied|#|¶|edit|编辑|目录|table of contents|skip to (?:main )?content|on this page|[\s|:*#=_\-–—]+)$/i;
const STOPWORDS = new Set([
  // 2-char English stopwords (kept out so 2-char technical terms like go/ai/ts/js/db/ip/v2/c# stay).
  "is", "in", "on", "at", "to", "of", "or", "as", "by", "be", "do", "an", "if", "it",
  "no", "so", "up", "we", "he", "me", "my", "us", "am", "vs", "re", "ll", "ve",
  // Common 3+ char stopwords.
  "the", "and", "for", "how", "what", "why", "does", "with", "from", "this", "that", "are", "was", "were",
  "you", "your", "can", "use", "using", "about", "into", "when", "which", "who", "best", "via",
]);
const SEARCH_OPERATOR = /(?<=^|\s)-?(?:site|inurl|intitle|filetype|ext|after|before|lang|language):(?:"[^"]*"|\S+)/g;
const LATIN_TERM = /[a-z0-9][a-z0-9._+#-]*[a-z0-9+#]/g;
const CJK_RUN = /[㐀-鿿]+/g;
const IS_CJK_TERM = /[㐀-鿿]/;

/** Remove page furniture from a search excerpt: images, link syntax, anchors, copy buttons, and padded spacing. */
export function cleanExcerpt(text: string): string {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[\s*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\((?:https?:|\/|#)[^)]*\)/g, "$1")
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+(?:#|¶)\s*$/, "").replace(/[ \t\u00a0]{2,}/g, " ").trim())
    .filter((line) => line && !FURNITURE_LINE.test(line))
    .join("\n");
}

function sampleEvenly(items: string[], maxCount: number): string[] {
  if (items.length <= maxCount) return items;
  if (maxCount <= 1) return items.slice(0, maxCount);
  const picked: string[] = [];
  const step = (items.length - 1) / (maxCount - 1);
  for (let i = 0; i < maxCount; i += 1) {
    const candidate = items[Math.round(i * step)];
    if (candidate && !picked.includes(candidate)) picked.push(candidate);
  }
  return picked;
}

/**
 * Words worth matching: Latin/technical terms of 2+ characters (excluding
 * stopwords and search operators) and CJK character pairs. In bilingual
 * queries, CJK bigram count is bounded so English terms are not drowned out.
 */
export function queryTerms(query: string): string[] {
  const plain = query
    .toLowerCase()
    .replace(SEARCH_OPERATOR, " ")
    .replace(/["“”'()]/g, " ");

  const latinTerms = new Set<string>();
  for (const word of plain.match(LATIN_TERM) ?? []) {
    if (!STOPWORDS.has(word)) latinTerms.add(word);
  }

  const runs = plain.match(CJK_RUN) ?? [];
  const allCjkTerms = new Set<string>();
  for (const run of runs) {
    if (run.length === 1) allCjkTerms.add(run);
    for (let index = 0; index + 1 < run.length; index += 1) {
      allCjkTerms.add(run.slice(index, index + 2));
    }
  }

  let cjkTerms = Array.from(allCjkTerms);
  if (latinTerms.size > 0 && cjkTerms.length > 0) {
    const maxCjk = Math.max(6, latinTerms.size * 3);
    if (cjkTerms.length > maxCjk) {
      // Prefer non-overlapping stride-2 bigrams round-robin across CJK runs so every run is represented.
      const runBuckets = runs.map((run) => {
        if (run.length === 1) return [run];
        const pairs: string[] = [];
        for (let i = 0; i + 1 < run.length; i += 2) {
          pairs.push(run.slice(i, i + 2));
        }
        if (run.length % 2 === 1 && run.length >= 3) {
          const tail = run.slice(run.length - 2);
          if (!pairs.includes(tail)) pairs.push(tail);
        }
        return pairs;
      });
      const balanced: string[] = [];
      const seen = new Set<string>();
      const maxLen = Math.max(0, ...runBuckets.map((bucket) => bucket.length));
      for (let i = 0; i < maxLen; i += 1) {
        for (const bucket of runBuckets) {
          const gram = bucket[i];
          if (gram && !seen.has(gram)) {
            seen.add(gram);
            balanced.push(gram);
          }
        }
      }
      cjkTerms = sampleEvenly(balanced, maxCjk);
    }
  }

  return [...latinTerms, ...cjkTerms];
}

interface TermMatcher {
  id: number;
  term: string;
  weight: number;
  regex: RegExp;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildTermMatchers(terms: string[]): TermMatcher[] {
  const latinCount = terms.filter((term) => !IS_CJK_TERM.test(term)).length;
  const cjkCount = terms.length - latinCount;
  // In bilingual queries, cap total CJK bigram weight below the Latin term total
  // (0.75 per Latin term, up to 1.0 per CJK term) so English technical terms are not drowned out.
  const cjkWeight = latinCount > 0 && cjkCount > 0
    ? Math.min(1, (latinCount * 0.75) / cjkCount)
    : 1;

  return terms.map((term, id) => {
    const isCjk = IS_CJK_TERM.test(term);
    const escaped = escapeRegExp(term);
    let pattern: string;
    if (isCjk) {
      pattern = escaped;
    } else {
      const endsWithSymbol = /[+#]$/.test(term);
      const rightBoundary = endsWithSymbol ? "(?![a-z+#])" : "(?![a-z0-9])";
      pattern = `(?<![a-z0-9])${escaped}${rightBoundary}`;
    }
    return {
      id,
      term,
      weight: isCjk ? cjkWeight : 1,
      regex: new RegExp(pattern, "gi"),
    };
  });
}

function matchScoreForText(text: string, matchers: TermMatcher[]): number {
  let total = 0;
  for (const matcher of matchers) {
    matcher.regex.lastIndex = 0;
    if (matcher.regex.test(text)) {
      total += matcher.weight;
    }
  }
  return total;
}

interface Segment {
  text: string;
  line: number;
  index: number;
}

/**
 * Fit an excerpt into `max` characters. When it is too long, keep the
 * sentences that mention the query (plus the opening one, which usually says
 * what the page is, as long as at least one matching sentence fits) in their
 * original order, instead of only the head.
 */
export function focusExcerpt(text: string, query: string | undefined, max: number): string {
  if (text.length <= max) return text;
  const terms = query ? queryTerms(query) : [];
  if (!terms.length) return trimText(text, max);
  const matchers = buildTermMatchers(terms);

  const segments: Segment[] = [];
  text.split("\n").forEach((line, lineNumber) => {
    for (const piece of line.split(/(?<=[.!?])(?:\s+|$)|(?<=[。！？；;])/)) {
      if (piece.trim()) segments.push({ text: piece.trim(), line: lineNumber, index: segments.length });
    }
  });
  const scored = segments.map((segment) => {
    const matchScore = matchScoreForText(segment.text, matchers);
    return { segment, matchScore };
  });
  if (!scored.some((entry) => entry.matchScore > 0)) return trimText(text, max);

  const ranked = [...scored].sort((a, b) => {
    // Any matching segment strictly outranks a 0-hit opening segment.
    const aHas = a.matchScore > 0 ? 1 : 0;
    const bHas = b.matchScore > 0 ? 1 : 0;
    if (bHas !== aHas) return bHas - aHas;
    const aRank = a.matchScore + (a.segment.index === 0 ? 0.1 : 0);
    const bRank = b.matchScore + (b.segment.index === 0 ? 0.1 : 0);
    if (Math.abs(bRank - aRank) > 1e-9) return bRank - aRank;
    return a.segment.index - b.segment.index;
  });

  const picked: Segment[] = [];
  let used = 0;
  let pickedMatches = 0;
  for (const entry of ranked) {
    if (entry.matchScore <= 0) {
      // Only keep a 0-hit opening segment when at least one real query match fits.
      if (entry.segment.index !== 0 || pickedMatches === 0) continue;
    }
    const cost = entry.segment.text.length + 3;
    if (used + cost > max) continue;
    picked.push(entry.segment);
    used += cost;
    if (entry.matchScore > 0) pickedMatches += 1;
  }
  const best = ranked.find((entry) => entry.matchScore > 0);
  const pickedScore = pickedMatches > 0
    ? matchScoreForText(picked.map((segment) => segment.text).join("\n"), matchers)
    : 0;
  if (pickedMatches === 0 || (best && best.matchScore > pickedScore + 1e-9)) {
    if (best) return windowAroundMatch(best.segment.text, matchers, max);
    return trimText(text, max);
  }
  picked.sort((a, b) => a.index - b.index);
  let output = "";
  picked.forEach((segment, position) => {
    const previous = picked[position - 1];
    if (!previous) output = segment.index > 0 ? `… ${segment.text}` : segment.text;
    else if (segment.index === previous.index + 1) output += segment.line === previous.line ? ` ${segment.text}` : `\n${segment.text}`;
    else output += ` … ${segment.text}`;
  });
  const last = picked[picked.length - 1] as Segment;
  return last.index < segments.length - 1 ? `${output} …` : output;
}

interface Occurrence {
  pos: number;
  end: number;
  termId: number;
  weight: number;
}

function windowAroundMatch(segment: string, matchers: TermMatcher[], max: number): string {
  const occurrences: Occurrence[] = [];
  for (const matcher of matchers) {
    matcher.regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = matcher.regex.exec(segment)) !== null) {
      if (match[0].length === 0) {
        matcher.regex.lastIndex += 1;
        continue;
      }
      occurrences.push({
        pos: match.index,
        end: match.index + match[0].length,
        termId: matcher.id,
        weight: matcher.weight,
      });
    }
  }
  if (!occurrences.length) return trimText(segment, max);
  occurrences.sort((a, b) => a.pos - b.pos || a.end - b.end);

  const budget = Math.max(40, max - 4);
  const termCounts = new Map<number, number>();
  let distinctWeight = 0;
  let totalWeight = 0;

  let bestStart = occurrences[0]!.pos;
  let bestEnd = occurrences[0]!.end;
  let bestDistinct = -1;
  let bestTotal = -1;
  let bestSpan = Number.POSITIVE_INFINITY;

  let left = 0;
  for (let right = 0; right < occurrences.length; right += 1) {
    const rightOcc = occurrences[right]!;
    const prevCount = termCounts.get(rightOcc.termId) ?? 0;
    if (prevCount === 0) distinctWeight += rightOcc.weight;
    termCounts.set(rightOcc.termId, prevCount + 1);
    totalWeight += rightOcc.weight;

    while (left < right && rightOcc.end - occurrences[left]!.pos > budget) {
      const leftOcc = occurrences[left]!;
      const count = (termCounts.get(leftOcc.termId) ?? 1) - 1;
      if (count <= 0) {
        termCounts.delete(leftOcc.termId);
        distinctWeight -= leftOcc.weight;
      } else {
        termCounts.set(leftOcc.termId, count);
      }
      totalWeight -= leftOcc.weight;
      left += 1;
    }

    const clusterStart = occurrences[left]!.pos;
    const clusterEnd = rightOcc.end;
    const span = clusterEnd - clusterStart;
    const betterDistinct = distinctWeight > bestDistinct + 1e-9;
    const tiedDistinct = Math.abs(distinctWeight - bestDistinct) <= 1e-9;
    const betterTotal = tiedDistinct && totalWeight > bestTotal + 1e-9;
    const tiedTotal = tiedDistinct && Math.abs(totalWeight - bestTotal) <= 1e-9;
    const tighterSpan = tiedTotal && span < bestSpan;

    if (betterDistinct || betterTotal || tighterSpan) {
      bestDistinct = distinctWeight;
      bestTotal = totalWeight;
      bestSpan = span;
      bestStart = clusterStart;
      bestEnd = clusterEnd;
    }
  }

  const clusterLen = bestEnd - bestStart;
  let start = clusterLen < budget
    ? Math.max(0, bestStart - Math.floor((budget - clusterLen) / 2))
    : bestStart;
  if (start + budget > segment.length) start = Math.max(0, segment.length - budget);
  if (start > bestStart) start = bestStart;

  if (start > 0) {
    const boundary = segment.indexOf(" ", start);
    if (boundary > start && boundary - start < 20 && boundary + 1 <= bestStart) {
      start = boundary + 1;
    }
  }
  let end = Math.min(segment.length, start + budget);
  if (end < segment.length) {
    const boundary = segment.lastIndexOf(" ", end);
    if (boundary > start + budget * 0.6 && boundary >= bestEnd) {
      end = boundary;
    }
  }
  const core = safeSlice(segment, start, end).trim();
  return `${start > 0 ? "… " : ""}${core}${end < segment.length ? " …" : ""}`;
}
