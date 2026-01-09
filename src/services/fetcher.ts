import type { Dispatcher } from 'undici';

import { config } from '../config/index.js';
import type { FetchOptions } from '../config/types/runtime.js';

import { dispatcher } from './fetcher/agents.js';
import {
  createHttpError,
  createRateLimitError,
  mapFetchError,
} from './fetcher/errors.js';
import {
  recordFetchError,
  recordFetchResponse,
  startFetchTelemetry,
} from './fetcher/interceptors.js';
import { fetchWithRedirects } from './fetcher/redirects.js';
import { readResponseText } from './fetcher/response.js';

const DEFAULT_HEADERS: Record<string, string> = {
  'User-Agent': config.fetcher.userAgent,
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
  'Accept-Encoding': 'gzip, deflate, br',
  Connection: 'keep-alive',
};

function buildHeaders(): Record<string, string> {
  return DEFAULT_HEADERS;
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
  headers: HeadersInit,
  signal: AbortSignal
): RequestInit & { dispatcher: Dispatcher } {
  return {
    method: 'GET',
    headers,
    signal,
    dispatcher,
  };
}

function cancelResponseBody(response: Response): void {
  const { body } = response;
  if (!body) return;
  body.cancel().catch(() => {
    // Best-effort cancellation; ignore failures.
  });
}

function resolveResponseError(
  response: Response,
  finalUrl: string
): ReturnType<typeof createHttpError> | null {
  return (
    resolveRateLimitError(response, finalUrl) ??
    resolveHttpError(response, finalUrl)
  );
}

function resolveRateLimitError(
  response: Response,
  finalUrl: string
): ReturnType<typeof createHttpError> | null {
  return response.status === 429
    ? createRateLimitError(finalUrl, response.headers.get('retry-after'))
    : null;
}

function resolveHttpError(
  response: Response,
  finalUrl: string
): ReturnType<typeof createHttpError> | null {
  return response.ok
    ? null
    : createHttpError(finalUrl, response.status, response.statusText);
}

async function handleFetchResponse(
  response: Response,
  finalUrl: string,
  telemetry: ReturnType<typeof startFetchTelemetry>,
  signal?: AbortSignal
): Promise<string> {
  const responseError = resolveResponseError(response, finalUrl);
  if (responseError) {
    cancelResponseBody(response);
    throw responseError;
  }

  const { text, size } = await readResponseText(
    response,
    finalUrl,
    config.fetcher.maxContentLength,
    signal
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
    return await fetchAndHandle(normalizedUrl, requestInit, telemetry);
  } catch (error) {
    const mapped = mapFetchError(error, normalizedUrl, timeoutMs);
    telemetry.url = mapped.url;
    recordFetchError(telemetry, mapped, mapped.statusCode);
    throw mapped;
  }
}

async function fetchAndHandle(
  normalizedUrl: string,
  requestInit: RequestInit,
  telemetry: ReturnType<typeof startFetchTelemetry>
): Promise<string> {
  const { response, url: finalUrl } = await fetchWithRedirects(
    normalizedUrl,
    requestInit,
    config.fetcher.maxRedirects
  );

  telemetry.url = finalUrl;
  return handleFetchResponse(
    response,
    finalUrl,
    telemetry,
    requestInit.signal ?? undefined
  );
}

export async function fetchNormalizedUrl(
  normalizedUrl: string,
  options?: FetchOptions
): Promise<string> {
  const timeoutMs = config.fetcher.timeout;
  const headers = buildHeaders();
  const signal = buildRequestSignal(timeoutMs, options?.signal);
  const requestInit = buildRequestInit(headers, signal);
  return fetchWithTelemetry(normalizedUrl, requestInit, timeoutMs);
}
