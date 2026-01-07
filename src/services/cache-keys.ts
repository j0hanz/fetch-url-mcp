import { CACHE_HASH } from '../config/constants.js';

import { sha256Hex } from '../utils/crypto.js';
import { isRecord } from '../utils/guards.js';

export interface CacheKeyParts {
  namespace: string;
  urlHash: string;
}

function stableStringify(value: unknown): string {
  if (!isRecord(value)) {
    if (value === null || value === undefined) {
      return '';
    }
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }

  const entries = Object.entries(value)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([key, entryValue]) =>
        `${JSON.stringify(key)}:${stableStringify(entryValue)}`
    );

  return `{${entries.join(',')}}`;
}

function createHashFragment(input: string, length: number): string {
  return sha256Hex(input).substring(0, length);
}

function buildCacheKey(
  namespace: string,
  urlHash: string,
  varyHash?: string
): string {
  return varyHash
    ? `${namespace}:${urlHash}.${varyHash}`
    : `${namespace}:${urlHash}`;
}

function getVaryHash(
  vary?: Record<string, unknown> | string
): string | undefined {
  if (!vary) return undefined;
  const varyString = typeof vary === 'string' ? vary : stableStringify(vary);
  if (!varyString) return undefined;
  return createHashFragment(varyString, CACHE_HASH.VARY_HASH_LENGTH);
}

export function createCacheKey(
  namespace: string,
  url: string,
  vary?: Record<string, unknown> | string
): string | null {
  if (!namespace || !url) return null;

  const urlHash = createHashFragment(url, CACHE_HASH.URL_HASH_LENGTH);
  const varyHash = getVaryHash(vary);
  return buildCacheKey(namespace, urlHash, varyHash);
}

export function parseCacheKey(cacheKey: string): CacheKeyParts | null {
  if (!cacheKey) return null;
  const [namespace, ...rest] = cacheKey.split(':');
  const urlHash = rest.join(':');
  if (!namespace || !urlHash) return null;
  return { namespace, urlHash };
}

export function toResourceUri(cacheKey: string): string | null {
  const parts = parseCacheKey(cacheKey);
  if (!parts) return null;
  return `superfetch://cache/${parts.namespace}/${parts.urlHash}`;
}
