import axios, { type AxiosRequestConfig, type AxiosError } from 'axios';
import http from 'http';
import https from 'https';
import { config } from '../config/index.js';
import { FetchError, TimeoutError } from '../errors/app-error.js';
import { logDebug, logError } from './logger.js';
import { getHtml, setHtml } from './cache.js';

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
    logDebug('HTTP Request', {
      method: requestConfig.method?.toUpperCase(),
      url: requestConfig.url,
    });
    return requestConfig;
  },
  async (error: AxiosError) => {
    logError('HTTP Request Error', error);
    return Promise.reject(error);
  }
);

client.interceptors.response.use(
  (response) => {
    logDebug('HTTP Response', {
      status: response.status,
      url: response.config.url,
      contentType: response.headers['content-type'],
    });
    return response;
  },
  async (error: AxiosError) => {
    const url = error.config?.url ?? 'unknown';

    if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
      logError('HTTP Timeout', { url, timeout: config.fetcher.timeout });
      return Promise.reject(new TimeoutError(config.fetcher.timeout, true));
    }

    if (error.response) {
      const status = error.response.status;
      const statusText = error.response.statusText;
      logError('HTTP Error Response', { url, status, statusText });
      return Promise.reject(
        new FetchError(`HTTP ${status}: ${statusText}`, url, status)
      );
    }

    if (error.request) {
      logError('HTTP Network Error', { url, code: error.code });
      return Promise.reject(
        new FetchError(`Network error: Could not reach ${url}`, url)
      );
    }

    logError('HTTP Unknown Error', { url, message: error.message });
    return Promise.reject(new FetchError(error.message, url));
  }
);

async function fetchUrl(
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
    const contentType = response.headers['content-type'] as string | undefined;
    if (contentType && !isHtmlContentType(contentType)) {
      throw new FetchError(
        `Unexpected content type: ${contentType}. Expected HTML content.`,
        url
      );
    }

    return response.data;
  } catch (error) {
    if (error instanceof FetchError || error instanceof TimeoutError) {
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
  customHeaders?: Record<string, string>,
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
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const html = await fetchUrl(url, customHeaders);
      setHtml(url, html);
      logDebug('HTML Cache Set', { url });

      return { html, fromHtmlCache: false };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error('Unknown error');

      if (error instanceof FetchError && error.httpStatus) {
        const status = error.httpStatus;
        if (status >= 400 && status < 500 && status !== 429) {
          throw error;
        }
      }

      if (attempt < retries) {
        const delay = calculateBackoff(attempt);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw new FetchError(
    `Failed after ${retries} attempts: ${lastError?.message ?? 'Unknown error'}`,
    url
  );
}
