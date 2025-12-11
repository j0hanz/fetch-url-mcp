import { validateAndNormalizeUrl } from '../../utils/url-validator.js';
import { fetchUrlWithRetry } from '../../services/fetcher.js';
import * as cache from '../../services/cache.js';
import { logDebug } from '../../services/logger.js';

/**
 * Options for the fetch pipeline
 */
export interface FetchPipelineOptions<T> {
  /** URL to fetch */
  url: string;
  /** Cache namespace (e.g., 'url', 'links', 'markdown') */
  cacheNamespace: string;
  /** Optional custom HTTP headers */
  customHeaders?: Record<string, string> | undefined;
  /** Optional: number of retry attempts (1-10, defaults to 3) */
  retries?: number | undefined;
  /** Transform function to process HTML into desired format */
  transform: (html: string, url: string) => T;
  /** Optional: serialize result for caching (defaults to JSON.stringify) */
  serialize?: ((result: T) => string) | undefined;
  /** Optional: deserialize cached content */
  deserialize?: ((cached: string) => T) | undefined;
}

/**
 * Result from the fetch pipeline
 */
export interface PipelineResult<T> {
  /** The transformed data */
  data: T;
  /** Whether result came from cache */
  fromCache: boolean;
  /** The normalized URL that was fetched */
  url: string;
  /** Timestamp of when content was fetched/cached */
  fetchedAt: string;
}

/**
 * Executes a standardized fetch pipeline:
 * 1. Validate and normalize URL
 * 2. Check cache
 * 3. Fetch HTML with retry
 * 4. Transform content
 * 5. Cache result
 *
 * @param options - Pipeline configuration
 * @returns Pipeline result with transformed data
 * @throws {UrlValidationError} if URL is invalid
 * @throws {FetchError} if fetch fails after retries
 */
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

  // 1. Validate and normalize URL
  const normalizedUrl = validateAndNormalizeUrl(url);

  // 2. Check cache
  const cacheKey = cache.createCacheKey(cacheNamespace, normalizedUrl);

  if (cacheKey) {
    const cached = cache.get(cacheKey);
    if (cached) {
      logDebug('Cache hit', { namespace: cacheNamespace, url: normalizedUrl });

      // If deserialize is provided, use it; otherwise return raw content
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

  // 3. Fetch HTML with retry (leverages HTML cache internally)
  logDebug('Fetching URL', { url: normalizedUrl, retries });
  const fetchResult = await fetchUrlWithRetry(
    normalizedUrl,
    customHeaders,
    retries
  );
  const html = fetchResult.html;

  // 4. Transform content
  const data = transform(html, normalizedUrl);

  // 5. Cache result
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
