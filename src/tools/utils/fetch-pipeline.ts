import type {
  FetchOptions,
  FetchPipelineOptions,
  PipelineResult,
} from '../../config/types/runtime.js';

import * as cache from '../../services/cache.js';
import { fetchUrlWithRetry } from '../../services/fetcher.js';
import { logDebug } from '../../services/logger.js';

import { validateAndNormalizeUrl } from '../../utils/url-validator.js';

import { appendHeaderVary } from './cache-vary.js';

function attemptCacheRetrieval<T>(
  cacheKey: string | null,
  deserialize: ((cached: string) => T | undefined) | undefined,
  cacheNamespace: string,
  normalizedUrl: string
): PipelineResult<T> | null {
  if (!cacheKey) return null;

  const cached = cache.get(cacheKey);
  if (!cached) return null;

  if (!deserialize) {
    logDebug('Cache miss due to missing deserializer', {
      namespace: cacheNamespace,
      url: normalizedUrl,
    });
    return null;
  }

  const data = deserialize(cached.content);

  if (data === undefined) {
    logDebug('Cache miss due to deserialize failure', {
      namespace: cacheNamespace,
      url: normalizedUrl,
    });
    return null;
  }

  logDebug('Cache hit', { namespace: cacheNamespace, url: normalizedUrl });

  return {
    data,
    fromCache: true,
    url: normalizedUrl,
    fetchedAt: cached.fetchedAt,
    cacheKey,
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
  const normalizedUrl = validateAndNormalizeUrl(options.url);
  const cacheKey = resolveCacheKey(options, normalizedUrl);

  const cachedResult = attemptCacheRetrieval<T>(
    cacheKey,
    options.deserialize,
    options.cacheNamespace,
    normalizedUrl
  );
  if (cachedResult) return cachedResult;

  const fetchOptions = buildFetchOptions(options);
  logDebug('Fetching URL', { url: normalizedUrl, retries: options.retries });

  const html = await fetchUrlWithRetry(
    normalizedUrl,
    fetchOptions,
    options.retries
  );
  const data = options.transform(html, normalizedUrl);
  persistCache(cacheKey, data, options.serialize, normalizedUrl);

  return buildPipelineResult(normalizedUrl, data, cacheKey);
}

function resolveCacheKey<T>(
  options: FetchPipelineOptions<T>,
  normalizedUrl: string
): string | null {
  const cacheVary = appendHeaderVary(options.cacheVary, options.customHeaders);
  return cache.createCacheKey(options.cacheNamespace, normalizedUrl, cacheVary);
}

function buildFetchOptions<T>(options: FetchPipelineOptions<T>): FetchOptions {
  return {
    customHeaders: options.customHeaders,
    signal: options.signal,
    timeout: options.timeout,
  };
}

function persistCache<T>(
  cacheKey: string | null,
  data: T,
  serialize: ((result: T) => string) | undefined,
  normalizedUrl: string
): void {
  if (!cacheKey) return;
  const serializer = serialize ?? JSON.stringify;
  cache.set(cacheKey, serializer(data), {
    url: normalizedUrl,
    title: extractTitle(data),
  });
}

function extractTitle(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  if (!('title' in value)) return undefined;
  const { title } = value as { title?: unknown };
  return typeof title === 'string' ? title : undefined;
}

function buildPipelineResult<T>(
  url: string,
  data: T,
  cacheKey: string | null
): PipelineResult<T> {
  return {
    data,
    fromCache: false,
    url,
    fetchedAt: new Date().toISOString(),
    cacheKey,
  };
}
