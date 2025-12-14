import axios, {
  type AxiosError,
  type AxiosRequestConfig,
  isCancel,
} from 'axios';
import http from 'http';
import https from 'https';

import { config } from '../config/index.js';

import {
  AbortError,
  FetchError,
  RateLimitError,
  TimeoutError,
} from '../errors/app-error.js';

import { getHtml, setHtml } from './cache.js';
import { logDebug, logError, logWarn } from './logger.js';

/** Options for fetch operations */
export interface FetchOptions {
  /** Custom HTTP headers to include in the request */
  customHeaders?: Record<string, string>;
  /** AbortSignal for request cancellation */
  signal?: AbortSignal;
  /** Per-request timeout override in milliseconds */
  timeout?: number;
}

// Use WeakMap for request timings to avoid modifying request objects
const requestTimings = new WeakMap<AxiosRequestConfig, number>();

const BLOCKED_HEADERS = new Set([
  'host',
  'authorization',
  'cookie',
  'x-forwarded-for',
  'x-real-ip',
  'proxy-authorization',
]);

function sanitizeHeaders(
  headers?: Record<string, string>
): Record<string, string> | undefined {
  if (!headers || Object.keys(headers).length === 0) return undefined;

  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!BLOCKED_HEADERS.has(key.toLowerCase())) {
      sanitized[key] = value;
    }
  }

  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

function calculateBackoff(attempt: number, maxDelay = 10000): number {
  const baseDelay = Math.min(1000 * Math.pow(2, attempt - 1), maxDelay);
  const jitter = baseDelay * 0.25 * (Math.random() * 2 - 1);
  return Math.round(baseDelay + jitter);
}

const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 25 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 25 });

export function destroyAgents(): void {
  httpAgent.destroy();
  httpsAgent.destroy();
}

const client = axios.create({
  timeout: config.fetcher.timeout,
  maxRedirects: config.fetcher.maxRedirects,
  maxContentLength: config.fetcher.maxContentLength,
  httpAgent,
  httpsAgent,
  headers: {
    'User-Agent': config.fetcher.userAgent,
    Accept:
      'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5',
    'Accept-Encoding': 'gzip, deflate, br',
    Connection: 'keep-alive',
  },
  validateStatus: (status) => status >= 200 && status < 300,
});

client.interceptors.request.use(
  (requestConfig) => {
    // Store timing in WeakMap instead of modifying config
    requestTimings.set(requestConfig, Date.now());

    logDebug('HTTP Request', {
      method: requestConfig.method?.toUpperCase(),
      url: requestConfig.url,
    });
    return requestConfig;
  },
  (error: AxiosError) => {
    logError('HTTP Request Error', error);
    throw error;
  }
);

client.interceptors.response.use(
  (response) => {
    const startTime = requestTimings.get(response.config);
    const duration = startTime ? Date.now() - startTime : 0;
    requestTimings.delete(response.config); // Clean up

    const contentType: unknown = response.headers['content-type'];
    const contentTypeStr =
      typeof contentType === 'string' ? contentType : undefined;

    logDebug('HTTP Response', {
      status: response.status,
      url: response.config.url ?? 'unknown',
      contentType: contentTypeStr,
      duration: `${duration}ms`,
      size: response.headers['content-length'],
    });

    // Log slow requests
    if (duration > 5000) {
      logWarn('Slow HTTP request detected', {
        url: response.config.url ?? 'unknown',
        duration: `${duration}ms`,
      });
    }

    // Early content-type validation before processing
    if (contentTypeStr && !isHtmlContentType(contentTypeStr)) {
      throw new FetchError(
        `Unexpected content type: ${contentTypeStr}. Expected HTML content.`,
        response.config.url ?? 'unknown'
      );
    }

    return response;
  },
  (error: AxiosError) => {
    const url = error.config?.url ?? 'unknown';

    // Handle request cancellation (AbortController)
    if (isCancel(error) || error.name === 'AbortError') {
      logDebug('HTTP Request Aborted', { url });
      throw new AbortError('Request was canceled');
    }

    // Handle CanceledError from AbortSignal.timeout()
    if (error.name === 'CanceledError') {
      logDebug('HTTP Request Canceled (timeout signal)', { url });
      throw new TimeoutError(config.fetcher.timeout, true);
    }

    if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
      logError('HTTP Timeout', { url, timeout: config.fetcher.timeout });
      throw new TimeoutError(config.fetcher.timeout, true);
    }

    if (error.response) {
      const { status, statusText, headers } = error.response;

      // Handle 429 Too Many Requests with Retry-After header
      if (status === 429) {
        const retryAfterHeader = headers['retry-after'] as string | undefined;
        let retryAfterSeconds = 60; // Default 60 seconds

        if (retryAfterHeader) {
          const parsed = parseInt(retryAfterHeader, 10);
          if (!isNaN(parsed)) {
            retryAfterSeconds = parsed;
          }
        }

        logWarn('Rate limited by server', {
          url,
          retryAfter: `${retryAfterSeconds}s`,
        });
        throw new RateLimitError(retryAfterSeconds);
      }

      logError('HTTP Error Response', { url, status, statusText });
      throw new FetchError(`HTTP ${status}: ${statusText}`, url, status);
    }

    if (error.request) {
      logError('HTTP Network Error', { url, code: error.code });
      throw new FetchError(`Network error: Could not reach ${url}`, url);
    }

    logError('HTTP Unknown Error', { url, message: error.message });
    throw new FetchError(error.message, url);
  }
);

async function fetchUrl(url: string, options?: FetchOptions): Promise<string> {
  const requestConfig: AxiosRequestConfig = {
    method: 'GET',
    url,
    responseType: 'text',
  };

  // Apply per-request timeout via AbortSignal.timeout() if provided
  // This is cleaner than axios timeout as it properly cancels the request
  if (options?.signal) {
    requestConfig.signal = options.signal;
  } else if (options?.timeout) {
    // Use AbortSignal.timeout() for per-request timeout (Node 17.3+)
    requestConfig.signal = AbortSignal.timeout(options.timeout);
  }

  const sanitized = sanitizeHeaders(options?.customHeaders);
  if (sanitized) {
    const existingHeaders =
      requestConfig.headers && typeof requestConfig.headers === 'object'
        ? (requestConfig.headers as Record<string, string>)
        : {};
    requestConfig.headers = { ...existingHeaders, ...sanitized };
  }

  try {
    const response = await client.request<string>(requestConfig);
    return response.data;
  } catch (error) {
    if (
      error instanceof FetchError ||
      error instanceof TimeoutError ||
      error instanceof AbortError ||
      error instanceof RateLimitError
    ) {
      throw error;
    }

    throw new FetchError(
      `Unexpected error: ${error instanceof Error ? error.message : 'Unknown'}`,
      url
    );
  }
}

function isHtmlContentType(contentType: string): boolean {
  const normalized = contentType.toLowerCase();
  return (
    normalized.includes('text/html') ||
    normalized.includes('application/xhtml') ||
    normalized.includes('text/plain')
  );
}

export async function fetchUrlWithRetry(
  url: string,
  options?: FetchOptions,
  maxRetries = 3,
  skipCache = false
): Promise<{ html: string; fromHtmlCache: boolean }> {
  if (!skipCache) {
    const cachedHtml = getHtml(url);
    if (cachedHtml) {
      logDebug('HTML Cache Hit', { url });
      return { html: cachedHtml, fromHtmlCache: true };
    }
  }

  const retries = Math.min(Math.max(1, maxRetries), 10);
  let lastError: Error = new Error(`Failed to fetch ${url}`);

  for (let attempt = 1; attempt <= retries; attempt++) {
    // Check if aborted before attempting (early exit for batch operations)
    if (options?.signal?.aborted) {
      const abortError = new AbortError('Request was aborted before execution');
      throw abortError;
    }

    try {
      const html = await fetchUrl(url, options);
      setHtml(url, html);
      logDebug('HTML Cache Set', { url });

      return { html, fromHtmlCache: false };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Don't retry on abort - exit immediately
      if (error instanceof AbortError) {
        throw error;
      }

      // Handle rate limiting with smart retry
      if (error instanceof RateLimitError) {
        if (attempt < retries) {
          const waitTime = Math.min(error.retryAfter * 1000, 30000); // Cap at 30s
          logWarn('Rate limited, waiting before retry', {
            url,
            attempt,
            waitTime: `${waitTime}ms`,
          });
          await new Promise((resolve) => setTimeout(resolve, waitTime));
          continue;
        }
        throw error;
      }

      if (error instanceof FetchError && error.httpStatus) {
        const status = error.httpStatus;
        // Don't retry client errors (except 429 which is handled above)
        if (status >= 400 && status < 500 && status !== 429) {
          throw error;
        }
      }

      if (attempt < retries) {
        const delay = calculateBackoff(attempt);
        logDebug('Retrying request', { url, attempt, delay: `${delay}ms` });
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw new FetchError(
    `Failed after ${retries} attempts: ${lastError.message}`,
    url
  );
}
