import axios, {
  type AxiosError,
  type AxiosInstance,
  type AxiosRequestConfig,
  type AxiosResponse,
  type AxiosResponseHeaders,
  type InternalAxiosRequestConfig,
  isCancel,
  type RawAxiosResponseHeaders,
} from 'axios';
import crypto from 'crypto';
import dns from 'dns';
import http from 'http';
import https from 'https';
import os from 'os';

import { config } from '../config/index.js';
import type { FetchOptions } from '../config/types.js';

import { FetchError } from '../errors/app-error.js';

import { isBlockedIp } from '../utils/url-validator.js';

import { logDebug, logError, logWarn } from './logger.js';

// --- Constants & Types ---

const REQUEST_START_TIME = Symbol('requestStartTime');
const REQUEST_ID = Symbol('requestId');

interface TimedAxiosRequestConfig extends InternalAxiosRequestConfig {
  [REQUEST_START_TIME]?: number;
  [REQUEST_ID]?: string;
}

// --- Helper Functions ---

function sanitizeHeaders(
  headers?: Record<string, string>
): Record<string, string> | undefined {
  if (!headers || Object.keys(headers).length === 0) {
    return undefined;
  }

  const { blockedHeaders } = config.security;
  const crlfRegex = /[\r\n]/;
  const sanitized: Record<string, string> = {};

  for (const [key, value] of Object.entries(headers)) {
    if (
      !blockedHeaders.has(key.toLowerCase()) &&
      !crlfRegex.test(key) &&
      !crlfRegex.test(value)
    ) {
      sanitized[key] = value;
    }
  }

  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

function resolveDns(
  hostname: string,
  options: dns.LookupOptions,
  callback: (
    err: NodeJS.ErrnoException | null,
    address: string | dns.LookupAddress[],
    family?: number
  ) => void
): void {
  dns.lookup(hostname, options, (err, address, family) => {
    if (err) {
      callback(err, address, family);
      return;
    }

    const addresses = Array.isArray(address) ? address : [{ address, family }];

    for (const addr of addresses) {
      const ip = typeof addr === 'string' ? addr : addr.address;
      if (isBlockedIp(ip)) {
        const error = new Error(
          `Blocked IP detected for ${hostname}`
        ) as NodeJS.ErrnoException;
        error.code = 'EBLOCKED';
        callback(error, address, family);
        return;
      }
    }

    callback(null, address, family);
  });
}

function getAgentOptions(): http.AgentOptions {
  const cpuCount = os.cpus().length;
  return {
    keepAlive: true,
    maxSockets: Math.max(cpuCount * 2, 25),
    maxFreeSockets: Math.max(Math.floor(cpuCount * 0.5), 10),
    timeout: 60000,
    scheduling: 'fifo',
    lookup: resolveDns,
  };
}

function handleRequest(
  config: InternalAxiosRequestConfig
): InternalAxiosRequestConfig {
  const timedConfig = config as TimedAxiosRequestConfig;
  timedConfig[REQUEST_START_TIME] = Date.now();
  timedConfig[REQUEST_ID] = crypto.randomUUID().substring(0, 8);

  logDebug('HTTP Request', {
    requestId: timedConfig[REQUEST_ID],
    method: config.method?.toUpperCase(),
    url: config.url,
  });

  return config;
}

function handleRequestError(error: AxiosError): Promise<never> {
  logError('HTTP Request Error', error);
  throw error;
}

function calculateDuration(config: TimedAxiosRequestConfig): number {
  const startTime = config[REQUEST_START_TIME];
  return startTime ? Date.now() - startTime : 0;
}

function logResponse(
  response: AxiosResponse,
  requestId: string | undefined,
  duration: number
): void {
  const headers = response.headers as
    | AxiosResponseHeaders
    | RawAxiosResponseHeaders;
  const contentType = headers['content-type'] as unknown;
  const contentTypeStr =
    typeof contentType === 'string' ? contentType : undefined;

  logDebug('HTTP Response', {
    requestId,
    status: response.status,
    url: response.config.url ?? 'unknown',
    contentType: contentTypeStr,
    duration: `${duration}ms`,
    size: headers['content-length'],
  });

  if (duration > 5000) {
    logWarn('Slow HTTP request detected', {
      requestId,
      url: response.config.url ?? 'unknown',
      duration: `${duration}ms`,
    });
  }
}

function parseRetryAfter(header: unknown): number {
  if (!header) return 60;
  const parsed =
    typeof header === 'string' ? parseInt(header, 10) : Number(header);
  return isNaN(parsed) ? 60 : parsed;
}

function handleResponseError(error: AxiosError): Promise<never> {
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
    const responseHeaders = headers as
      | AxiosResponseHeaders
      | RawAxiosResponseHeaders;

    if (status === 429) {
      const retryAfter = parseRetryAfter(responseHeaders['retry-after']);
      logWarn('Rate limited by server', { url, retryAfter: `${retryAfter}s` });
      throw new FetchError('Too many requests', url, 429, { retryAfter });
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

function handleResponse(response: AxiosResponse): AxiosResponse {
  const timedConfig = response.config as TimedAxiosRequestConfig;
  const duration = calculateDuration(timedConfig);
  const requestId = timedConfig[REQUEST_ID];

  // Cleanup symbols safely
  timedConfig[REQUEST_START_TIME] = undefined;
  timedConfig[REQUEST_ID] = undefined;

  logResponse(response, requestId, duration);

  return response;
}

class RetryPolicy {
  private static readonly BASE_DELAY_MS = 1000;
  private static readonly MAX_DELAY_MS = 10000;
  private static readonly JITTER_FACTOR = 0.25;

  constructor(
    private readonly maxRetries: number,
    private readonly url: string
  ) {}

  async execute<T>(
    operation: () => Promise<T>,
    signal?: AbortSignal
  ): Promise<T> {
    let lastError: Error = new Error(`Failed to fetch ${this.url}`);
    const retries = Math.min(Math.max(1, this.maxRetries), 10);

    for (let attempt = 1; attempt <= retries; attempt++) {
      if (signal?.aborted) {
        throw new FetchError('Request was aborted before execution', this.url);
      }

      try {
        return await operation();
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (!this.shouldRetry(attempt, retries, lastError)) {
          throw lastError;
        }

        await this.wait(attempt, lastError);
      }
    }

    throw new FetchError(
      `Failed after ${retries} attempts: ${lastError.message}`,
      this.url
    );
  }

  private shouldRetry(
    attempt: number,
    maxRetries: number,
    error: Error
  ): boolean {
    if (attempt >= maxRetries) return false;

    if (error instanceof FetchError) {
      if (error.details.reason === 'aborted') return false;
      if (error.details.httpStatus === 429) return true;

      const status = error.details.httpStatus as number | undefined;
      if (status && status >= 400 && status < 500) return false;
    }

    return true;
  }

  private async wait(attempt: number, error: Error): Promise<void> {
    let delay: number;

    if (error instanceof FetchError && error.details.httpStatus === 429) {
      const retryAfter = (error.details.retryAfter as number) || 60;
      delay = Math.min(retryAfter * 1000, 30000);
      logWarn('Rate limited, waiting before retry', {
        url: this.url,
        attempt,
        waitTime: `${delay}ms`,
      });
    } else {
      delay = this.calculateBackoff(attempt);
      logDebug('Retrying request', {
        url: this.url,
        attempt,
        delay: `${delay}ms`,
      });
    }

    await new Promise((resolve) => setTimeout(resolve, delay));
  }

  private calculateBackoff(attempt: number): number {
    const exponentialDelay = Math.min(
      RetryPolicy.BASE_DELAY_MS * Math.pow(2, attempt - 1),
      RetryPolicy.MAX_DELAY_MS
    );
    const jitter =
      exponentialDelay * RetryPolicy.JITTER_FACTOR * (Math.random() * 2 - 1);
    return Math.round(exponentialDelay + jitter);
  }
}

const httpAgent = new http.Agent(getAgentOptions());
const httpsAgent = new https.Agent(getAgentOptions());

const client: AxiosInstance = axios.create({
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

client.interceptors.request.use(handleRequest, handleRequestError);
client.interceptors.response.use(handleResponse, handleResponseError);

export function destroyAgents(): void {
  httpAgent.destroy();
  httpsAgent.destroy();
}

export async function fetchUrlWithRetry(
  url: string,
  options?: FetchOptions,
  maxRetries = 3
): Promise<string> {
  const policy = new RetryPolicy(maxRetries, url);

  return policy.execute(async () => {
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

    const sanitizedHeaders = sanitizeHeaders(options?.customHeaders);
    if (sanitizedHeaders) {
      const existingHeaders = (requestConfig.headers ?? {}) as Record<
        string,
        string
      >;
      requestConfig.headers = { ...existingHeaders, ...sanitizedHeaders };
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
  }, options?.signal);
}
