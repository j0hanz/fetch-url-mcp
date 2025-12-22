import axios, { type AxiosInstance, type AxiosRequestConfig } from 'axios';

import { config } from '../config/index.js';
import type { FetchOptions } from '../config/types.js';

import { FetchError } from '../errors/app-error.js';

import { validateAndNormalizeUrl } from '../utils/url-validator.js';

import { destroyAgents, httpAgent, httpsAgent } from './fetcher/agents.js';
import { sanitizeHeaders } from './fetcher/headers.js';
import {
  handleRequest,
  handleRequestError,
  handleResponse,
  handleResponseError,
} from './fetcher/interceptors.js';
import {
  type RedirectOptions,
  validateRedirectTarget,
} from './fetcher/redirects.js';
import { RetryPolicy } from './fetcher/retry-policy.js';

const client: AxiosInstance = axios.create({
  timeout: config.fetcher.timeout,
  maxRedirects: config.fetcher.maxRedirects,
  maxContentLength: config.fetcher.maxContentLength,
  httpAgent,
  httpsAgent,
  beforeRedirect: (options) => {
    validateRedirectTarget(options as RedirectOptions);
  },
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

export { destroyAgents };

export async function fetchUrlWithRetry(
  url: string,
  options?: FetchOptions,
  maxRetries = 3
): Promise<string> {
  const normalizedUrl = validateAndNormalizeUrl(url);
  const policy = new RetryPolicy(maxRetries, normalizedUrl);

  return policy.execute(async () => {
    const requestConfig: AxiosRequestConfig = {
      method: 'GET',
      url: normalizedUrl,
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
        normalizedUrl
      );
    }
  }, options?.signal);
}
