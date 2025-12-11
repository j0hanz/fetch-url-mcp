import { validateAndNormalizeUrl } from '../../utils/url-validator.js';
import { fetchUrlWithRetry } from '../../services/fetcher.js';
import * as cache from '../../services/cache.js';
import { logDebug } from '../../services/logger.js';
import type {
  FetchPipelineOptions,
  PipelineResult,
} from '../../config/types.js';

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
    deserialize,
  } = options;

  const normalizedUrl = validateAndNormalizeUrl(url);
  const cacheKey = cache.createCacheKey(cacheNamespace, normalizedUrl);

  if (cacheKey) {
    const cached = cache.get(cacheKey);
    if (cached) {
      logDebug('Cache hit', { namespace: cacheNamespace, url: normalizedUrl });
      const data = deserialize
        ? deserialize(cached.content)
        : (cached.content as unknown as T);

      return {
        data,
        fromCache: true,
        url: normalizedUrl,
        fetchedAt: cached.fetchedAt,
      };
    }
  }

  logDebug('Fetching URL', { url: normalizedUrl, retries });
  const fetchResult = await fetchUrlWithRetry(
    normalizedUrl,
    customHeaders,
    retries
  );
  const html = fetchResult.html;
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
