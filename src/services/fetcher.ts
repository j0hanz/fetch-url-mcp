import { config } from '../config/index.js';
import type { FetchOptions } from '../config/types.js';

import { validateAndNormalizeUrl } from '../utils/url-validator.js';

import { destroyAgents, dispatcher } from './fetcher/agents.js';
import {
  createHttpError,
  createRateLimitError,
  mapFetchError,
} from './fetcher/errors.js';
import { sanitizeHeaders } from './fetcher/headers.js';
import {
  recordFetchError,
  recordFetchResponse,
  startFetchTelemetry,
} from './fetcher/interceptors.js';
import { fetchWithRedirects } from './fetcher/redirects.js';
import { readResponseText } from './fetcher/response.js';
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

function buildRequestInit(
  headers: Headers,
  signal: AbortSignal
): RequestInit & { dispatcher?: unknown } {
  return {
    method: 'GET',
    headers,
    signal,
    dispatcher,
  };
}

async function handleFetchResponse(
  response: Response,
  finalUrl: string,
  telemetry: ReturnType<typeof startFetchTelemetry>
): Promise<string> {
  if (response.status === 429) {
    void response.body?.cancel();
    throw createRateLimitError(finalUrl, response.headers.get('retry-after'));
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
}

async function fetchWithTelemetry(
  normalizedUrl: string,
  requestInit: RequestInit,
  timeoutMs: number
): Promise<string> {
  const telemetry = startFetchTelemetry(normalizedUrl, 'GET');

  try {
    const { response, url: finalUrl } = await fetchWithRedirects(
      normalizedUrl,
      requestInit,
      config.fetcher.maxRedirects
    );

    telemetry.url = finalUrl;
    return await handleFetchResponse(response, finalUrl, telemetry);
  } catch (error) {
    const mapped = mapFetchError(error, normalizedUrl, timeoutMs);
    telemetry.url = mapped.url;
    recordFetchError(telemetry, mapped, mapped.statusCode);
    throw mapped;
  }
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
    const signal = buildRequestSignal(timeoutMs, options?.signal);
    const requestInit = buildRequestInit(headers, signal);
    return fetchWithTelemetry(normalizedUrl, requestInit, timeoutMs);
  }, options?.signal);
}
