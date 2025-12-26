import { config } from '../config/index.js';
import type { FileDownloadInfo } from '../config/types.js';

import * as cache from '../services/cache.js';

import { generateSafeFilename } from './filename-generator.js';

interface DownloadInfoOptions {
  cacheKey: string | null;
  url: string;
  title?: string;
}

export function buildFileDownloadInfo(
  options: DownloadInfoOptions
): FileDownloadInfo | null {
  if (!config.cache.enabled || !options.cacheKey) {
    return null;
  }

  const parts = cache.parseCacheKey(options.cacheKey);
  if (!parts) return null;

  const cacheEntry = cache.get(options.cacheKey);
  if (!cacheEntry) return null;

  const { expiresAt, title, url } = cacheEntry;

  const downloadUrl = buildDownloadUrl(parts.namespace, parts.urlHash);
  const fileName = generateSafeFilename(
    url,
    title ?? options.title,
    parts.urlHash,
    resolveExtension(parts.namespace)
  );

  return { downloadUrl, fileName, expiresAt };
}

function buildDownloadUrl(namespace: string, hash: string): string {
  return `/mcp/downloads/${namespace}/${hash}`;
}

function resolveExtension(namespace: string): string {
  return namespace === 'markdown' ? '.md' : '.jsonl';
}
