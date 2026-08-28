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
  if (/validation error|unexpected keyword argument|invalid (?:request|argument|parameter)/i.test(text)) return 422;
  const match = text.match(/(?:HTTP|status)\s*(\d{3})/i);
  return match?.[1] ? Number(match[1]) : undefined;
}

export function shouldRetryWithNextKey(status: number | undefined): boolean {
  if (status === undefined) return true;
  if (status === 400 || status === 404 || status === 422) return false;
  return status === 401 || status === 402 || status === 403 || status === 429 || status >= 500;
}
