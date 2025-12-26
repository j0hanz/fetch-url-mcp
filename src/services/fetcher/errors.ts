import { FetchError } from '../../errors/app-error.js';

function parseRetryAfter(header: string | null): number {
  if (!header) return 60;
  const parsed = parseInt(header, 10);
  return Number.isNaN(parsed) ? 60 : parsed;
}

function createCanceledError(url: string): FetchError {
  return new FetchError('Request was canceled', url, 499, {
    reason: 'aborted',
  });
}

function createTimeoutError(url: string, timeoutMs: number): FetchError {
  return new FetchError(`Request timeout after ${timeoutMs}ms`, url, 504, {
    timeout: timeoutMs,
  });
}

export function createRateLimitError(
  url: string,
  headerValue: string | null
): FetchError {
  const retryAfter = parseRetryAfter(headerValue);
  return new FetchError('Too many requests', url, 429, { retryAfter });
}

export function createHttpError(
  url: string,
  status: number,
  statusText: string
): FetchError {
  return new FetchError(`HTTP ${status}: ${statusText}`, url, status);
}

function createNetworkError(url: string, message?: string): FetchError {
  const details = message ? { message } : undefined;
  return new FetchError(
    `Network error: Could not reach ${url}`,
    url,
    undefined,
    details ?? {}
  );
}

function createUnknownError(url: string, message: string): FetchError {
  return new FetchError(message, url);
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' || error.name === 'TimeoutError')
  );
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.name === 'TimeoutError';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function getRequestUrl(record: Record<string, unknown>): string | null {
  const value = record.requestUrl;
  return typeof value === 'string' ? value : null;
}

function resolveErrorUrl(error: unknown, fallback: string): string {
  if (error instanceof FetchError) return error.url;
  if (!isRecord(error)) return fallback;
  const requestUrl = getRequestUrl(error);
  if (requestUrl) return requestUrl;
  return fallback;
}

export function mapFetchError(
  error: unknown,
  fallbackUrl: string,
  timeoutMs: number
): FetchError {
  if (error instanceof FetchError) return error;

  const url = resolveErrorUrl(error, fallbackUrl);

  if (isAbortError(error)) {
    if (isTimeoutError(error)) {
      return createTimeoutError(url, timeoutMs);
    }
    return createCanceledError(url);
  }

  if (error instanceof Error) {
    return createNetworkError(url, error.message);
  }

  return createUnknownError(url, 'Unexpected error');
}
