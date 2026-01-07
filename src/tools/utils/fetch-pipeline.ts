import type {
  FetchOptions,
  FetchPipelineOptions,
  PipelineResult,
} from '../../config/types/runtime.js';

import * as cache from '../../services/cache.js';
import { fetchNormalizedUrl } from '../../services/fetcher.js';
import { logDebug } from '../../services/logger.js';

import { isRecord } from '../../utils/guards.js';
import { transformToRawUrl } from '../../utils/url-transformer.js';
import { normalizeUrl } from '../../utils/url-validator.js';

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

export async function executeFetchPipeline<T>(
  options: FetchPipelineOptions<T>
): Promise<PipelineResult<T>> {
  const { normalizedUrl: validatedUrl } = normalizeUrl(options.url);
  const { url: normalizedUrl, transformed } = transformToRawUrl(validatedUrl);
  if (transformed) {
    logDebug('Using transformed raw content URL', { original: validatedUrl });
  }

  const cacheKey = resolveCacheKey(options, normalizedUrl);

  const cachedResult = attemptCacheRetrieval<T>(
    cacheKey,
    options.deserialize,
    options.cacheNamespace,
    normalizedUrl
  );
  if (cachedResult) return cachedResult;

  const fetchOptions = buildFetchOptions(options);
  logDebug('Fetching URL', { url: normalizedUrl });

  const html = await fetchNormalizedUrl(normalizedUrl, fetchOptions);
  const data = await options.transform(html, normalizedUrl);
  if (cache.isEnabled()) {
    persistCache(cacheKey, data, options.serialize, normalizedUrl);
  }

  return buildPipelineResult(normalizedUrl, data, cacheKey);
}

function resolveCacheKey<T>(
  options: FetchPipelineOptions<T>,
  normalizedUrl: string
): string | null {
  return cache.createCacheKey(
    options.cacheNamespace,
    normalizedUrl,
    options.cacheVary
  );
}

function buildFetchOptions<T>(options: FetchPipelineOptions<T>): FetchOptions {
  const fetchOptions: FetchOptions = {};

  if (options.signal !== undefined) {
    fetchOptions.signal = options.signal;
  }

  return fetchOptions;
}

function persistCache<T>(
  cacheKey: string | null,
  data: T,
  serialize: ((result: T) => string) | undefined,
  normalizedUrl: string
): void {
  if (!cacheKey) return;
  const serializer = serialize ?? JSON.stringify;
  const metadata: { url: string; title?: string } = { url: normalizedUrl };
  const title = extractTitle(data);
  if (title !== undefined) {
    metadata.title = title;
  }
  cache.set(cacheKey, serializer(data), metadata);
}

function extractTitle(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const { title } = value;
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
