import axios, {
  type AxiosError,
  type AxiosRequestConfig,
  isCancel,
} from 'axios';
import crypto from 'crypto';
import http from 'http';
import https from 'https';
import os from 'os';

import { config } from '../config/index.js';
import type { FetchOptions } from '../config/types.js';

import { FetchError } from '../errors/app-error.js';

import { validateResolvedIps } from '../utils/url-validator.js';

import { logDebug, logError, logWarn } from './logger.js';

const REQUEST_START_TIME = Symbol('requestStartTime');
const REQUEST_ID = Symbol('requestId');

interface TimedAxiosRequestConfig extends AxiosRequestConfig {
  [REQUEST_START_TIME]?: number;
  [REQUEST_ID]?: string;
}

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
      // Prevent HTTP header injection via CRLF
      if (/[\r\n]/.test(key) || /[\r\n]/.test(value)) {
        continue;
      }
      sanitized[key] = value;
    }
  }

  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

const CPU_COUNT = os.cpus().length;
const MAX_SOCKETS = Math.max(CPU_COUNT * 2, 25);
const MAX_FREE_SOCKETS = Math.max(Math.floor(CPU_COUNT * 0.5), 10);

const httpAgent = new http.Agent({
  keepAlive: true,
  maxSockets: MAX_SOCKETS,
  maxFreeSockets: MAX_FREE_SOCKETS,
  timeout: 60000,
  scheduling: 'fifo',
});

const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: MAX_SOCKETS,
  maxFreeSockets: MAX_FREE_SOCKETS,
  timeout: 60000,
  scheduling: 'fifo',
});

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
    const timedConfig = requestConfig as TimedAxiosRequestConfig;
    timedConfig[REQUEST_START_TIME] = Date.now();
    timedConfig[REQUEST_ID] = crypto.randomUUID().substring(0, 8);

    logDebug('HTTP Request', {
      requestId: timedConfig[REQUEST_ID],
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
    const timedConfig = response.config as TimedAxiosRequestConfig;
    const startTime = timedConfig[REQUEST_START_TIME];
    const requestId = timedConfig[REQUEST_ID];
    const duration = startTime ? Date.now() - startTime : 0;

    if (timedConfig[REQUEST_START_TIME] !== undefined) {
      timedConfig[REQUEST_START_TIME] = undefined;
    }
    if (timedConfig[REQUEST_ID] !== undefined) {
      timedConfig[REQUEST_ID] = undefined;
    }

    const contentType: unknown = response.headers['content-type'];
    const contentTypeStr =
      typeof contentType === 'string' ? contentType : undefined;

    logDebug('HTTP Response', {
      requestId,
      status: response.status,
      url: response.config.url ?? 'unknown',
      contentType: contentTypeStr,
      duration: `${duration}ms`,
      size: response.headers['content-length'],
    });

    if (duration > 5000) {
      logWarn('Slow HTTP request detected', {
        requestId,
        url: response.config.url ?? 'unknown',
        duration: `${duration}ms`,
      });
    }

    return response;
  },
  (error: AxiosError) => {
    const url = error.config?.url ?? 'unknown';

    if (
      isCancel(error) ||
      error.name === 'AbortError' ||
      error.name === 'CanceledError'
    ) {
      logDebug('HTTP Request Aborted/Canceled', { url });
      throw new FetchError('Request was canceled', url, 499, {
        reason: 'aborted',
      });
    }

    if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
      logError('HTTP Timeout', { url, timeout: config.fetcher.timeout });
      throw new FetchError(
        `Request timeout after ${config.fetcher.timeout}ms`,
        url,
        504,
        { timeout: config.fetcher.timeout }
      );
    }

    if (error.response) {
      const { status, statusText, headers } = error.response;

      if (status === 429) {
        const retryAfterHeader = headers['retry-after'] as string | undefined;
        let retryAfterSeconds = 60;

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
        throw new FetchError('Too many requests', url, 429, {
          retryAfter: retryAfterSeconds,
        });
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
  try {
    const urlObj = new URL(url);
    await validateResolvedIps(urlObj.hostname);
  } catch (error) {
    if (error instanceof Error) {
      throw new FetchError(error.message, url);
    }
    throw error;
  }

  const requestConfig: AxiosRequestConfig = {
    method: 'GET',
    url,
    responseType: 'text',
  };

  if (options?.signal) {
    requestConfig.signal = options.signal;
  } else if (options?.timeout) {
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
    if (error instanceof FetchError) {
      throw error;
    }

    throw new FetchError(
      `Unexpected error: ${error instanceof Error ? error.message : 'Unknown'}`,
      url
    );
  }
}

function calculateRetryDelay(attempt: number): number {
  const baseDelayMs = 1000;
  const maxDelayMs = 10000;
  const jitterFactor = 0.25;

  const exponentialDelay = Math.min(
    baseDelayMs * Math.pow(2, attempt - 1),
    maxDelayMs
  );
  const jitter = exponentialDelay * jitterFactor * (Math.random() * 2 - 1);
  return Math.round(exponentialDelay + jitter);
}

function shouldRetryError(
  attempt: number,
  maxRetries: number,
  error: Error
): boolean {
  if (attempt >= maxRetries) return false;

  // Don't retry aborted requests
  if (error instanceof FetchError && error.details.reason === 'aborted')
    return false;

  // Don't retry on client errors (4xx except 429)
  if (error instanceof FetchError) {
    const status = error.details.httpStatus as number | undefined;
    if (status && status >= 400 && status < 500 && status !== 429) return false;
  }

  return true;
}

export async function fetchUrlWithRetry(
  url: string,
  options?: FetchOptions,
  maxRetries = 3
): Promise<string> {
  const retries = Math.min(Math.max(1, maxRetries), 10);
  let lastError: Error = new Error(`Failed to fetch ${url}`);

  for (let attempt = 1; attempt <= retries; attempt++) {
    if (options?.signal?.aborted) {
      throw new FetchError('Request was aborted before execution', url);
    }

    try {
      return await fetchUrl(url, options);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Handle rate limiting with smart retry (429 with Retry-After)
      if (error instanceof FetchError && error.details.httpStatus === 429) {
        const retryAfter = error.details.retryAfter as number;
        if (attempt < retries && retryAfter) {
          const waitTime = Math.min(retryAfter * 1000, 30000);
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

      if (shouldRetryError(attempt, retries, lastError)) {
        const delay = calculateRetryDelay(attempt);
        logDebug('Retrying request', { url, attempt, delay: `${delay}ms` });
        await new Promise((resolve) => setTimeout(resolve, delay));
      } else {
        throw error;
      }
    }
  }

  throw new FetchError(
    `Failed after ${retries} attempts: ${lastError.message}`,
    url
  );
}
