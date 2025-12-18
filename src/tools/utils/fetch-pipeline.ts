import type {
  FetchOptions,
  FetchPipelineOptions,
  PipelineResult,
} from '../../config/types.js';

import * as cache from '../../services/cache.js';
import { fetchUrlWithRetry } from '../../services/fetcher.js';
import { logDebug, logWarn } from '../../services/logger.js';

import { validateAndNormalizeUrl } from '../../utils/url-validator.js';

function safeJsonParse(cached: string, cacheKey: string): unknown {
  try {
    return JSON.parse(cached);
  } catch {
    logWarn('Cache deserialize failed, treating as miss', {
      key: cacheKey.substring(0, 100),
    });
    return undefined;
  }
}

function attemptCacheRetrieval<T>(
  cacheKey: string | null,
  deserialize: ((cached: string) => T) | undefined,
  cacheNamespace: string,
  normalizedUrl: string
): PipelineResult<T> | null {
  if (!cacheKey) return null;

  const cached = cache.get(cacheKey);
  if (!cached) return null;

  logDebug('Cache hit', { namespace: cacheNamespace, url: normalizedUrl });

  const data = deserialize
    ? deserialize(cached.content)
    : (safeJsonParse(cached.content, cacheKey) as T | undefined);

  if (data === undefined) {
    logDebug('Cache miss due to deserialize failure', {
      namespace: cacheNamespace,
      url: normalizedUrl,
    });
    return null;
  }

  return {
    data,
    fromCache: true,
    url: normalizedUrl,
    fetchedAt: cached.fetchedAt,
  };
}

/**
 * Unified fetch pipeline that handles caching, fetching, and transformation.
 * Implements cache-first strategy with automatic serialization.
 *
 * @template T - Type of the transformed result
 * @param options - Pipeline configuration options
 * @returns Promise resolving to the pipeline result
 */
export async function executeFetchPipeline<T>(
  options: FetchPipelineOptions<T>
): Promise<PipelineResult<T>> {
  const {
    url,
    cacheNamespace,
    customHeaders,
    retries,
    signal,
    timeout,
    transform,
    serialize = JSON.stringify,
    deserialize,
  } = options;

  const normalizedUrl = validateAndNormalizeUrl(url);
  const cacheKey = cache.createCacheKey(cacheNamespace, normalizedUrl);

  const cachedResult = attemptCacheRetrieval<T>(
    cacheKey,
    deserialize,
    cacheNamespace,
    normalizedUrl
  );

  if (cachedResult) {
    return cachedResult;
  }

  const fetchOptions: FetchOptions = {
    customHeaders,
    signal,
    timeout,
  };

  logDebug('Fetching URL', { url: normalizedUrl, retries });

  const html = await fetchUrlWithRetry(normalizedUrl, fetchOptions, retries);
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
}
