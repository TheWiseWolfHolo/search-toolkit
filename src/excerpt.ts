import { trimText } from "./shape.js";

// Lines that are page furniture rather than content: copy buttons, anchors, table rules, TOC labels.
const FURNITURE_LINE = /^(?:copy|copied|#|¶|edit|编辑|目录|table of contents|skip to (?:main )?content|on this page|[\s|:*#=_\-–—]+)$/i;
const STOPWORDS = new Set([
  "the", "and", "for", "how", "what", "why", "does", "with", "from", "this", "that", "are", "was", "were",
  "you", "your", "can", "use", "using", "about", "into", "when", "which", "who", "best", "vs", "via",
]);
const CJK_RUN = /[㐀-鿿]+/g;

/** Remove page furniture from a search excerpt: images, link syntax, anchors, copy buttons, and padded spacing. */
export function cleanExcerpt(text: string): string {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[\s*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\((?:https?:|\/|#)[^)]*\)/g, "$1")
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+(?:#|¶)\s*$/, "").replace(/[ \t ]{2,}/g, " ").trim())
    .filter((line) => line && !FURNITURE_LINE.test(line))
    .join("\n");
}

/** Words worth matching: Latin terms of 3+ characters and CJK character pairs. Operators and quotes are dropped. */
export function queryTerms(query: string): string[] {
  const plain = query.toLowerCase().replace(/-?site:\S+/g, " ").replace(/["“”'()]/g, " ");
  const terms = new Set<string>();
  for (const word of plain.match(/[a-z0-9][a-z0-9._+-]{2,}/g) ?? []) {
    if (!STOPWORDS.has(word)) terms.add(word);
  }
  for (const run of plain.match(CJK_RUN) ?? []) {
    if (run.length === 1) terms.add(run);
    for (let index = 0; index + 1 < run.length; index += 1) terms.add(run.slice(index, index + 2));
  }
  return Array.from(terms);
}

interface Segment {
  text: string;
  line: number;
  index: number;
}

/**
 * Fit an excerpt into `max` characters. When it is too long, keep the
 * sentences that mention the query (plus the opening one, which usually says
 * what the page is) in their original order, instead of only the head.
 */
export function focusExcerpt(text: string, query: string | undefined, max: number): string {
  if (text.length <= max) return text;
  const terms = query ? queryTerms(query) : [];
  if (!terms.length) return trimText(text, max);
  const segments: Segment[] = [];
  text.split("\n").forEach((line, lineNumber) => {
    for (const piece of line.split(/(?<=[.!?])(?:\s+|$)|(?<=[。！？；;])/)) {
      if (piece.trim()) segments.push({ text: piece.trim(), line: lineNumber, index: segments.length });
    }
  });
  const scored = segments.map((segment) => {
    const lower = segment.text.toLowerCase();
    const hits = terms.filter((term) => lower.includes(term)).length;
    return { segment, score: hits + (segment.index === 0 ? 0.5 : 0) };
  });
  if (!scored.some((entry) => entry.score >= 1)) return trimText(text, max);
  const ranked = [...scored].sort((a, b) => b.score - a.score || a.segment.index - b.segment.index);
  const picked: Segment[] = [];
  let used = 0;
  for (const { segment, score } of ranked) {
    if (score <= 0) break;
    const cost = segment.text.length + 3;
    if (used + cost > max) continue;
    picked.push(segment);
    used += cost;
  }
  if (!picked.length) {
    const best = ranked[0];
    if (best && best.score >= 1) return windowAroundMatch(best.segment.text, terms, max);
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

function windowAroundMatch(segment: string, terms: string[], max: number): string {
  const lower = segment.toLowerCase();
  let matchPos = -1;
  for (const term of terms) {
    const idx = lower.indexOf(term);
    if (idx >= 0 && (matchPos < 0 || idx < matchPos)) matchPos = idx;
  }
  if (matchPos < 0) return trimText(segment, max);
  const budget = Math.max(40, max - 4);
  let start = Math.max(0, matchPos - Math.floor(budget / 3));
  if (start + budget > segment.length) start = Math.max(0, segment.length - budget);
  if (start > 0) {
    const boundary = segment.indexOf(" ", start);
    if (boundary > start && boundary - start < 20) start = boundary + 1;
  }
  let end = Math.min(segment.length, start + budget);
  if (end < segment.length) {
    const boundary = segment.lastIndexOf(" ", end);
    if (boundary > start + budget * 0.6) end = boundary;
  }
  const core = segment.slice(start, end).trim();
  return `${start > 0 ? "… " : ""}${core}${end < segment.length ? " …" : ""}`;
}
