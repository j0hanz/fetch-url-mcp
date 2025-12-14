import type {
  FetchPipelineOptions,
  PipelineResult,
} from '../../config/types.js';

import * as cache from '../../services/cache.js';
import { fetchUrlWithRetry } from '../../services/fetcher.js';
import { logDebug } from '../../services/logger.js';

import { validateAndNormalizeUrl } from '../../utils/url-validator.js';

// Request deduplication store to prevent concurrent identical requests
const pendingRequests = new Map<string, Promise<PipelineResult<unknown>>>();

export async function executeFetchPipeline<T>(
  options: FetchPipelineOptions<T>
): Promise<PipelineResult<T>> {
  const {
    url,
    cacheNamespace,
    customHeaders,
    retries,
    transform,
    serialize = JSON.stringify,
    deserialize = (cached: string) => JSON.parse(cached) as T,
  } = options;

  const normalizedUrl = validateAndNormalizeUrl(url);
  const cacheKey = cache.createCacheKey(cacheNamespace, normalizedUrl);

  // Check cache first
  if (cacheKey) {
    const cached = cache.get(cacheKey);
    if (cached) {
      logDebug('Cache hit', { namespace: cacheNamespace, url: normalizedUrl });
      const data = deserialize(cached.content);

      return {
        data,
        fromCache: true,
        url: normalizedUrl,
        fetchedAt: cached.fetchedAt,
      };
    }
  }

  // Check for pending request to prevent duplicate fetches
  const dedupeKey = `${cacheNamespace}:${normalizedUrl}`;
  const pending = pendingRequests.get(dedupeKey);
  if (pending) {
    logDebug('Request deduplication hit', { url: normalizedUrl });
    return pending as Promise<PipelineResult<T>>;
  }

  // Create new request
  const request = (async () => {
    try {
      logDebug('Fetching URL', { url: normalizedUrl, retries });
      const fetchResult = await fetchUrlWithRetry(
        normalizedUrl,
        customHeaders,
        retries
      );
      const { html } = fetchResult;
      const data = transform(html, normalizedUrl);

      if (cacheKey) {
        const serialized = serialize(data);
        cache.set(cacheKey, serialized);
      }

      return {
        data,
        fromCache: false,
        url: normalizedUrl,
        fetchedAt: new Date().toISOString(),
      };
    } finally {
      // Clean up pending request
      pendingRequests.delete(dedupeKey);
    }
  })();

  pendingRequests.set(dedupeKey, request as Promise<PipelineResult<unknown>>);
  return request;
}
