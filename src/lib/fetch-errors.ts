import { FetchError, isSystemError } from './errors.js';
import { isError, isObject } from './type-guards.js';
import { VALIDATION_ERROR_CODE } from './url-security.js';

// ---------------------------------------------------------------------------
// Retry-After parsing
// ---------------------------------------------------------------------------

export function parseRetryAfter(header: string | null): number {
  if (!header) return 60;

  const trimmed = header.trim();

  // Retry-After can be seconds or an HTTP-date.
  const seconds = Number.parseInt(trimmed, 10);
  if (!Number.isNaN(seconds) && seconds >= 0) return seconds;

  const dateMs = Date.parse(trimmed);
  if (Number.isNaN(dateMs)) return 60;

  const deltaMs = dateMs - Date.now();
  if (deltaMs <= 0) return 0;

  return Math.ceil(deltaMs / 1000);
}

// ---------------------------------------------------------------------------
// FetchError factory (discriminated union)
// ---------------------------------------------------------------------------

export type FetchErrorInput =
  | { kind: 'canceled' }
  | { kind: 'aborted' }
  | { kind: 'timeout'; timeout: number }
  | { kind: 'rate-limited'; retryAfter: string | null }
  | { kind: 'http'; status: number; statusText: string }
  | { kind: 'too-many-redirects' }
  | { kind: 'missing-redirect-location' }
  | { kind: 'network'; message: string }
  | { kind: 'unknown'; message?: string };

export function createFetchError(
  input: FetchErrorInput,
  url: string
): FetchError {
  switch (input.kind) {
    case 'canceled':
      return new FetchError('Request was canceled', url, 499, {
        reason: 'aborted',
      });
    case 'aborted':
      return new FetchError(
        'Request was aborted during response read',
        url,
        499,
        { reason: 'aborted' }
      );
    case 'timeout':
      return new FetchError(
        `Request timeout after ${input.timeout}ms`,
        url,
        504,
        { timeout: input.timeout }
      );
    case 'rate-limited':
      return new FetchError('Too many requests', url, 429, {
        retryAfter: parseRetryAfter(input.retryAfter),
      });
    case 'http':
      return new FetchError(
        `HTTP ${input.status}: ${input.statusText}`,
        url,
        input.status
      );
    case 'too-many-redirects':
      return new FetchError('Too many redirects', url);
    case 'missing-redirect-location':
      return new FetchError('Redirect response missing Location header', url);
    case 'network':
      return new FetchError(
        `Network error: Could not reach ${url}`,
        url,
        undefined,
        { message: input.message }
      );
    case 'unknown':
      return new FetchError(input.message ?? 'Unexpected error', url);
  }
}

// ---------------------------------------------------------------------------
// Error classification helpers
// ---------------------------------------------------------------------------

export function isAbortError(error: unknown): boolean {
  return (
    isError(error) &&
    (error.name === 'AbortError' || error.name === 'TimeoutError')
  );
}

export function isTimeoutError(error: unknown): boolean {
  return isError(error) && error.name === 'TimeoutError';
}

function resolveErrorUrl(error: unknown, fallback: string): string {
  if (error instanceof FetchError) return error.url;
  if (!isObject(error)) return fallback;

  const { requestUrl } = error as Record<string, unknown>;
  return typeof requestUrl === 'string' ? requestUrl : fallback;
}

// ---------------------------------------------------------------------------
// Error mapper (classifies raw errors into FetchError)
// ---------------------------------------------------------------------------

export function mapFetchError(
  error: unknown,
  fallbackUrl: string,
  timeoutMs: number
): FetchError {
  if (error instanceof FetchError) return error;

  const url = resolveErrorUrl(error, fallbackUrl);

  if (isAbortError(error)) {
    return isTimeoutError(error)
      ? createFetchError({ kind: 'timeout', timeout: timeoutMs }, url)
      : createFetchError({ kind: 'canceled' }, url);
  }

  if (!isError(error))
    return createFetchError(
      { kind: 'unknown', message: 'Unexpected error' },
      url
    );

  if (!isSystemError(error)) {
    const err = error as { message: string; cause?: unknown };
    const causeStr =
      err.cause instanceof Error ? err.cause.message : String(err.cause);
    return createFetchError(
      { kind: 'network', message: `${err.message}. Cause: ${causeStr}` },
      url
    );
  }

  const { code } = error;

  if (code === 'ETIMEOUT') {
    return new FetchError(error.message, url, 504, { code });
  }

  if (
    code === VALIDATION_ERROR_CODE ||
    code === 'EBADREDIRECT' ||
    code === 'EBLOCKED' ||
    code === 'ENODATA' ||
    code === 'EINVAL'
  ) {
    return new FetchError(error.message, url, 400, { code });
  }

  return createFetchError({ kind: 'network', message: error.message }, url);
}
