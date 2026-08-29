export class HttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function statusFromError(error: unknown): number | undefined {
  if (error instanceof HttpError) return error.status;
  const text = error instanceof Error ? error.message : String(error);
  const match = text.match(/(?:HTTP|status)\s*(\d{3})/i);
  if (match?.[1]) return Number(match[1]);
  if (/validation error|unexpected keyword argument|invalid (?:request|argument|parameter)/i.test(text)) return 422;
  return undefined;
}

export function shouldRetryWithNextKey(status: number | undefined): boolean {
  if (status === undefined) return true;
  if (status === 400 || status === 404 || status === 422) return false;
  return status === 401 || status === 402 || status === 403 || status === 429 || status >= 500;
}

export function shouldFailoverProvider(error: unknown): boolean {
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
  if (/validation error|unexpected keyword argument|invalid (?:request|argument|parameter)|unsupported parameter/i.test(text)) {
    return false;
  }
  return /abort|timeout|timed out|fetch failed|econnreset|econnrefused|enotfound|connection reset|rate limit|too many requests|temporar(?:y|ily) unavailable|service unavailable|overloaded|please retry|try again|no healthy key slots/i.test(text);
}
