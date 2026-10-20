/** An HTTP-level failure from a provider API. */
export class HttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/**
 * An upstream MCP tool answered with `isError: true`. The key worked and the
 * transport worked; the tool refused or failed the request itself, so this is
 * never counted against the key unless `status` was recognised as a key fault.
 */
export class ToolResultError extends Error {
  constructor(
    message: string,
    public readonly content: unknown[],
    public readonly status?: number,
  ) {
    super(message);
    this.name = "ToolResultError";
  }
}

/**
 * The provider API worked, but the page it was asked to read failed (blocked,
 * missing, or unreachable). The page's HTTP status says nothing about the key,
 * so this never benches a key or rotates to another one; a different reader
 * may still get through, so automatic routes may fail over.
 */
export class TargetPageError extends Error {
  constructor(
    message: string,
    public readonly pageStatus?: number,
  ) {
    super(message);
    this.name = "TargetPageError";
  }
}

const REQUEST_SHAPE_PATTERN = /validation error|unexpected keyword argument|invalid (?:request|argument|parameter)|unsupported parameter/i;

// JSON-RPC "method not found" / "invalid params" from an upstream MCP server.
const REQUEST_SHAPE_RPC_CODES = new Set([-32_601, -32_602]);

export function statusFromError(error: unknown): number | undefined {
  if (error instanceof HttpError) return error.status;
  if (error instanceof ToolResultError) return error.status;
  if (error instanceof TargetPageError) return undefined;
  const text = error instanceof Error ? error.message : String(error);
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    // StreamableHTTPError carries the real HTTP status in `code`.
    if (typeof code === "number" && Number.isInteger(code) && code >= 400 && code <= 599) return code;
    if (typeof code === "number" && REQUEST_SHAPE_RPC_CODES.has(code)) return 422;
    // Any other JSON-RPC error came from inside the upstream tool. A status
    // number in its text usually belongs to the page being read, so only
    // wording that names the key counts.
    if (typeof code === "number" && code < 0) {
      return keyFaultStatusFromToolText(text) ?? (REQUEST_SHAPE_PATTERN.test(text) ? 422 : undefined);
    }
  }
  const match = text.match(/(?:HTTP|status)\s*(\d{3})/i);
  if (match?.[1]) return Number(match[1]);
  if (REQUEST_SHAPE_PATTERN.test(text)) return 422;
  return undefined;
}

/**
 * Recognise key-attributable failures in the text of an upstream tool error.
 * Deliberately narrow: a scraped page answering "403 Forbidden" must not
 * disable the API key that fetched it.
 */
export function keyFaultStatusFromToolText(text: string): number | undefined {
  if (/(?:invalid|missing|incorrect|expired|revoked|unknown|bad)\s+(?:api[\s_-]?key|access[\s_-]?token|credentials?)|api[\s_-]?key\s+(?:is\s+)?(?:invalid|missing|not\s+(?:valid|found))|unauthori[sz]ed|authentication\s+(?:failed|required)/i.test(text)) return 401;
  if (/insufficient\s+(?:credits?|balance|funds)|out\s+of\s+credits?|credits?\s+(?:exhausted|depleted)|payment\s+required|(?:quota|usage\s+limit|plan\s+limit)\s+(?:exceeded|reached)|exceeded\s+(?:your\s+)?(?:quota|usage\s+limit|plan)/i.test(text)) return 402;
  if (/rate[\s_-]?limit(?:ed)?|too\s+many\s+requests/i.test(text)) return 429;
  return undefined;
}

export function textOfContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => block && typeof block === "object" && typeof (block as { text?: unknown }).text === "string"
      ? (block as { text: string }).text
      : "")
    .filter(Boolean)
    .join("\n");
}

export function shouldRetryWithNextKey(status: number | undefined): boolean {
  if (status === undefined) return true;
  if (status === 400 || status === 404 || status === 422) return false;
  return isKeyFaultStatus(status) || status >= 500;
}

/** Statuses that describe the key itself: another key can fix them. */
export function isKeyFaultStatus(status: number | undefined): boolean {
  return status === 401 || status === 402 || status === 403 || status === 429;
}

/** The request ran out of time. Another key would wait just as long. */
export function isTimeout(error: unknown): boolean {
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) return true;
  if (error && typeof error === "object" && (error as { code?: unknown }).code === -32_001) return true; // MCP RequestTimeout
  const text = error instanceof Error ? error.message : String(error);
  return /timed out|timeout/i.test(text);
}

export function shouldFailoverProvider(error: unknown): boolean {
  // Another reader may get past a block or render the page; a page that is gone stays gone.
  if (error instanceof TargetPageError) return ![404, 410, 451].includes(error.pageStatus ?? 0);
  const status = statusFromError(error);
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  if (status !== undefined) {
    if ([400, 404, 405, 409, 415, 422, 451].includes(status)) return false;
    if (status === 403) {
      if (/policy|safety|legal|robots|content block|blocked by|restricted content/i.test(text)) return false;
      return /api[\s_-]?key|credential|auth(?:entication|orization)?|subscription|plan|feature|permission|access denied/i.test(text);
    }
    return status === 401 || status === 402 || status === 408 || status === 425 || status === 429 || status >= 500;
  }
  if (REQUEST_SHAPE_PATTERN.test(text)) return false;
  return /abort|timeout|timed out|fetch failed|econnreset|econnrefused|enotfound|connection reset|connection closed|rate limit|too many requests|temporar(?:y|ily) unavailable|service unavailable|overloaded|please retry|try again|no healthy key slots|crawl_not_found|crawl_failed|extract_failed|scrape_failed/i.test(text);
}

/**
 * A reader could not get the page: blocked, challenged, rate limited, or the
 * site errored. A different reader often can, so fetch chains move on. A page
 * that does not exist (404/410) does not count.
 */
export function isPageFailure(error: unknown): boolean {
  if (error instanceof TargetPageError) return ![404, 410, 451].includes(error.pageStatus ?? 0);
  if (!(error instanceof ToolResultError)) return false;
  if (/status(?:\s+code)?:?\s*(?:404|410|451)\b|not found/i.test(error.message)) return false;
  return /status(?:\s+code)?:?\s*(?:403|429|5\d\d)\b|forbidden|access denied|blocked|captcha|cloudflare|timed?\s?out/i.test(error.message);
}

/** Transport-level failures where the cached upstream client should be rebuilt. */
export function isConnectionFailure(error: unknown): boolean {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (code === -32_000) return true; // MCP ConnectionClosed
    if (code === 404) return true; // Streamable HTTP session expired
  }
  const text = error instanceof Error ? error.message : String(error);
  return /not connected|connection closed|fetch failed|econnreset|econnrefused|epipe|socket hang up|terminated|session (?:not found|expired)/i.test(text);
}

export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}
