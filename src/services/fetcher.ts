import { config } from '../config/index.js';
import type { FetchOptions } from '../config/types.js';

import { FetchError } from '../errors/app-error.js';

import { validateAndNormalizeUrl } from '../utils/url-validator.js';

import { destroyAgents, dispatcher } from './fetcher/agents.js';
import { sanitizeHeaders } from './fetcher/headers.js';
import {
  recordFetchError,
  recordFetchResponse,
  startFetchTelemetry,
} from './fetcher/interceptors.js';
import { resolveRedirectTarget } from './fetcher/redirects.js';
import { RetryPolicy } from './fetcher/retry-policy.js';

export { destroyAgents };

const DEFAULT_HEADERS = {
  'User-Agent': config.fetcher.userAgent,
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
  'Accept-Encoding': 'gzip, deflate, br',
  Connection: 'keep-alive',
} as const;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function isRedirectStatus(status: number): boolean {
  return REDIRECT_STATUSES.has(status);
}

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

function createRateLimitError(
  url: string,
  headerValue: string | null
): FetchError {
  const retryAfter = parseRetryAfter(headerValue);
  return new FetchError('Too many requests', url, 429, { retryAfter });
}

function createHttpError(
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

function resolveErrorUrl(error: unknown, fallback: string): string {
  if (error instanceof FetchError) return error.url;
  if (error && typeof error === 'object' && 'requestUrl' in error) {
    const value = (error as { requestUrl?: unknown }).requestUrl;
    if (typeof value === 'string') return value;
  }
  return fallback;
}

function mapFetchError(
  error: unknown,
  fallbackUrl: string,
  timeoutMs: number
): FetchError {
  if (error instanceof FetchError) return error;

  const url = resolveErrorUrl(error, fallbackUrl);

  if (isAbortError(error)) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      return createTimeoutError(url, timeoutMs);
    }
    return createCanceledError(url);
  }

  if (error instanceof Error) {
    return createNetworkError(url, error.message);
  }

  return createUnknownError(url, 'Unexpected error');
}

function buildHeaders(customHeaders?: Record<string, string>): Headers {
  const headers = new Headers(DEFAULT_HEADERS);
  const sanitized = sanitizeHeaders(customHeaders);
  if (sanitized) {
    for (const [key, value] of Object.entries(sanitized)) {
      headers.set(key, value);
    }
  }
  return headers;
}

function buildRequestSignal(
  timeoutMs: number,
  external?: AbortSignal
): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  if (!external) return timeoutSignal;
  return AbortSignal.any([external, timeoutSignal]);
}

function assertContentLengthWithinLimit(
  response: Response,
  url: string,
  maxBytes: number
): void {
  const contentLengthHeader = response.headers.get('content-length');
  if (!contentLengthHeader) return;
  const contentLength = Number.parseInt(contentLengthHeader, 10);
  if (Number.isNaN(contentLength) || contentLength <= maxBytes) {
    return;
  }

  throw new FetchError(
    `Response exceeds maximum size of ${maxBytes} bytes`,
    url
  );
}

async function readStreamWithLimit(
  stream: ReadableStream<Uint8Array>,
  url: string,
  maxBytes: number
): Promise<{ text: string; size: number }> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = '';

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;

    total += value.byteLength;

    if (total > maxBytes) {
      await reader.cancel();
      throw new FetchError(
        `Response exceeds maximum size of ${maxBytes} bytes`,
        url
      );
    }

    text += decoder.decode(value, { stream: true });
  }

  text += decoder.decode();
  return { text, size: total };
}

async function readResponseText(
  response: Response,
  url: string,
  maxBytes: number
): Promise<{ text: string; size: number }> {
  assertContentLengthWithinLimit(response, url, maxBytes);

  if (!response.body) {
    const text = await response.text();
    return { text, size: Buffer.byteLength(text) };
  }

  return readStreamWithLimit(response.body, url, maxBytes);
}

interface FetchCycleResult {
  response: Response;
  nextUrl?: string;
}

async function performFetchCycle(
  currentUrl: string,
  init: RequestInit,
  redirectLimit: number,
  redirectCount: number
): Promise<FetchCycleResult> {
  const response = await fetch(currentUrl, { ...init, redirect: 'manual' });

  if (!isRedirectStatus(response.status)) {
    return { response };
  }

  if (redirectCount >= redirectLimit) {
    void response.body?.cancel();
    throw new FetchError('Too many redirects', currentUrl);
  }

  const location = response.headers.get('location');
  if (!location) {
    void response.body?.cancel();
    throw new FetchError(
      'Redirect response missing Location header',
      currentUrl
    );
  }

  void response.body?.cancel();
  return {
    response,
    nextUrl: resolveRedirectTarget(currentUrl, location),
  };
}

async function fetchWithRedirects(
  url: string,
  init: RequestInit,
  maxRedirects: number
): Promise<{ response: Response; url: string }> {
  let currentUrl = url;
  const redirectLimit = Math.max(0, maxRedirects);

  for (
    let redirectCount = 0;
    redirectCount <= redirectLimit;
    redirectCount += 1
  ) {
    try {
      const { response, nextUrl } = await performFetchCycle(
        currentUrl,
        init,
        redirectLimit,
        redirectCount
      );

      if (!nextUrl) {
        return { response, url: currentUrl };
      }

      currentUrl = nextUrl;
    } catch (error) {
      if (error && typeof error === 'object') {
        (error as { requestUrl?: string }).requestUrl = currentUrl;
      }
      throw error;
    }
  }

  throw new FetchError('Too many redirects', currentUrl);
}

export async function fetchUrlWithRetry(
  url: string,
  options?: FetchOptions,
  maxRetries = 3
): Promise<string> {
  const normalizedUrl = validateAndNormalizeUrl(url);
  const policy = new RetryPolicy(maxRetries, normalizedUrl);
  const timeoutMs = options?.timeout ?? config.fetcher.timeout;
  const headers = buildHeaders(options?.customHeaders);

  return policy.execute(async () => {
    const telemetry = startFetchTelemetry(normalizedUrl, 'GET');
    const signal = buildRequestSignal(timeoutMs, options?.signal);
    const requestInit: RequestInit & { dispatcher?: unknown } = {
      method: 'GET',
      headers,
      signal,
      dispatcher,
    };

    try {
      const { response, url: finalUrl } = await fetchWithRedirects(
        normalizedUrl,
        requestInit,
        config.fetcher.maxRedirects
      );

      telemetry.url = finalUrl;

      if (response.status === 429) {
        void response.body?.cancel();
        throw createRateLimitError(
          finalUrl,
          response.headers.get('retry-after')
        );
      }

      if (!response.ok) {
        void response.body?.cancel();
        throw createHttpError(finalUrl, response.status, response.statusText);
      }

      const { text, size } = await readResponseText(
        response,
        finalUrl,
        config.fetcher.maxContentLength
      );
      recordFetchResponse(telemetry, response, size);
      return text;
    } catch (error) {
      const mapped = mapFetchError(error, normalizedUrl, timeoutMs);
      telemetry.url = mapped.url;
      recordFetchError(telemetry, mapped, mapped.statusCode);
      throw mapped;
    }
  }, options?.signal);
}
