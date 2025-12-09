import axios, { AxiosRequestConfig } from 'axios';
import { config } from '../config/index.js';
import { FetchError, TimeoutError } from '../errors/app-error.js';

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

const client = axios.create({
  timeout: config.fetcher.timeout,
  maxRedirects: config.fetcher.maxRedirects,
  maxContentLength: config.fetcher.maxContentLength,
  headers: {
    'User-Agent': config.fetcher.userAgent,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5',
    'Accept-Encoding': 'gzip, deflate, br',
    Connection: 'keep-alive',
  },
  validateStatus: (status) => status >= 200 && status < 300,
});

/**
 * Fetches HTML content from a URL
 */
export async function fetchUrl(
  url: string,
  customHeaders?: Record<string, string>
): Promise<string> {
  const requestConfig: AxiosRequestConfig = {
    method: 'GET',
    url,
    responseType: 'text',
  };

  const sanitized = sanitizeHeaders(customHeaders);
  if (sanitized) {
    requestConfig.headers = { ...requestConfig.headers, ...sanitized };
  }

  try {
    const response = await client.request<string>(requestConfig);
    return response.data;
  } catch (error) {
    if (!axios.isAxiosError(error)) {
      throw new FetchError(
        `Unexpected error: ${error instanceof Error ? error.message : 'Unknown'}`,
        url
      );
    }

    if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
      throw new TimeoutError(config.fetcher.timeout, true);
    }

    if (error.response) {
      throw new FetchError(
        `HTTP ${error.response.status}: ${error.response.statusText}`,
        url,
        error.response.status
      );
    }

    if (error.request) {
      throw new FetchError(`Network error: Could not reach ${url}`, url);
    }

    throw new FetchError(error.message, url);
  }
}

/**
 * Fetches URL with exponential backoff retry logic
 */
export async function fetchUrlWithRetry(
  url: string,
  customHeaders?: Record<string, string>,
  maxRetries = 3
): Promise<string> {
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fetchUrl(url, customHeaders);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error('Unknown error');

      // Don't retry on client errors (4xx) except 429 (rate limited)
      if (error instanceof FetchError && error.httpStatus) {
        const status = error.httpStatus;
        if (status >= 400 && status < 500 && status !== 429) {
          throw error;
        }
      }

      if (attempt < maxRetries) {
        const delay = calculateBackoff(attempt);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw new FetchError(
    `Failed after ${maxRetries} attempts: ${lastError?.message ?? 'Unknown error'}`,
    url
  );
}
