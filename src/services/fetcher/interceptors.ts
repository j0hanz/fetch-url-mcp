import { randomUUID } from 'node:crypto';
import diagnosticsChannel from 'node:diagnostics_channel';
import { performance } from 'node:perf_hooks';

import type {
  AxiosError,
  AxiosResponse,
  AxiosResponseHeaders,
  InternalAxiosRequestConfig,
  RawAxiosResponseHeaders,
} from 'axios';
import { isCancel } from 'axios';

import { config } from '../../config/index.js';

import { FetchError } from '../../errors/app-error.js';

import { logDebug, logError, logWarn } from '../logger.js';

const REQUEST_START_TIME = Symbol('requestStartTime');
const REQUEST_ID = Symbol('requestId');
const fetchChannel = diagnosticsChannel.channel('superfetch.fetch');

interface TimedAxiosRequestConfig extends InternalAxiosRequestConfig {
  [REQUEST_START_TIME]?: number;
  [REQUEST_ID]?: string;
}

function calculateDuration(config: TimedAxiosRequestConfig): number {
  const startTime = config[REQUEST_START_TIME];
  return startTime ? performance.now() - startTime : 0;
}

function publishErrorEvent(error: AxiosError): void {
  if (!fetchChannel.hasSubscribers) return;
  const timedConfig = error.config as TimedAxiosRequestConfig | undefined;
  const requestId = timedConfig?.[REQUEST_ID];
  const duration = timedConfig ? calculateDuration(timedConfig) : 0;
  const url = error.config?.url ?? 'unknown';

  fetchChannel.publish({
    type: 'error',
    requestId,
    url,
    error: error.message,
    code: error.code,
    status: error.response?.status,
    duration,
  });
}

function publishResponseEvent(
  config: TimedAxiosRequestConfig,
  status: number,
  duration: number
): void {
  if (!fetchChannel.hasSubscribers) return;
  fetchChannel.publish({
    type: 'end',
    requestId: config[REQUEST_ID],
    status,
    duration,
  });
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
  return Number.isNaN(parsed) ? 60 : parsed;
}

function createCanceledError(url: string): FetchError {
  logDebug('HTTP Request Aborted/Canceled', { url });
  return new FetchError('Request was canceled', url, 499, {
    reason: 'aborted',
  });
}

function createTimeoutError(url: string): FetchError {
  logError('HTTP Timeout', { url, timeout: config.fetcher.timeout });
  return new FetchError(
    `Request timeout after ${config.fetcher.timeout}ms`,
    url,
    504,
    { timeout: config.fetcher.timeout }
  );
}

function createRateLimitError(url: string, headerValue: unknown): FetchError {
  const retryAfter = parseRetryAfter(headerValue);
  logWarn('Rate limited by server', { url, retryAfter: `${retryAfter}s` });
  return new FetchError('Too many requests', url, 429, { retryAfter });
}

function createHttpError(
  url: string,
  status: number,
  statusText: string
): FetchError {
  logError('HTTP Error Response', { url, status, statusText });
  return new FetchError(`HTTP ${status}: ${statusText}`, url, status);
}

function createNetworkError(url: string, code: string | undefined): FetchError {
  logError('HTTP Network Error', { url, code });
  return new FetchError(`Network error: Could not reach ${url}`, url);
}

function createUnknownError(url: string, message: string): FetchError {
  logError('HTTP Unknown Error', { url, message });
  return new FetchError(message, url);
}

export function handleRequest(
  config: InternalAxiosRequestConfig
): InternalAxiosRequestConfig {
  const timedConfig = config as TimedAxiosRequestConfig;
  timedConfig[REQUEST_START_TIME] = performance.now();
  timedConfig[REQUEST_ID] = randomUUID().substring(0, 8);

  const eventData = {
    requestId: timedConfig[REQUEST_ID],
    method: config.method?.toUpperCase(),
    url: config.url,
  };

  if (fetchChannel.hasSubscribers) {
    fetchChannel.publish({ type: 'start', ...eventData });
  }

  logDebug('HTTP Request', eventData);

  return config;
}

export function handleRequestError(error: AxiosError): Promise<never> {
  logError('HTTP Request Error', error);
  throw error;
}

export function handleResponse(response: AxiosResponse): AxiosResponse {
  const timedConfig = response.config as TimedAxiosRequestConfig;
  const duration = calculateDuration(timedConfig);
  const requestId = timedConfig[REQUEST_ID];

  timedConfig[REQUEST_START_TIME] = undefined;
  timedConfig[REQUEST_ID] = undefined;

  publishResponseEvent(timedConfig, response.status, duration);
  logResponse(response, requestId, duration);

  return response;
}

export function handleResponseError(error: AxiosError): Promise<never> {
  const url = error.config?.url ?? 'unknown';

  publishErrorEvent(error);

  if (
    isCancel(error) ||
    error.name === 'AbortError' ||
    error.name === 'CanceledError'
  ) {
    return Promise.reject(createCanceledError(url));
  }

  if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
    return Promise.reject(createTimeoutError(url));
  }

  if (error.response) {
    const { status, statusText, headers } = error.response;
    if (status === 429) {
      return Promise.reject(createRateLimitError(url, headers['retry-after']));
    }
    return Promise.reject(createHttpError(url, status, statusText));
  }

  if (error.request) {
    return Promise.reject(createNetworkError(url, error.code));
  }

  return Promise.reject(createUnknownError(url, error.message));
}
