import { config } from '../config/index.js';
import type { FileDownloadInfo } from '../config/types/tools.js';

import * as cache from '../services/cache.js';

import { generateSafeFilename } from './filename-generator.js';

interface DownloadInfoOptions {
  cacheKey: string | null;
  url: string;
  title?: string;
}

interface DownloadInfoDeps {
  readonly config?: typeof config;
  readonly cache?: Pick<typeof cache, 'get' | 'parseCacheKey'>;
  readonly generateSafeFilename?: typeof generateSafeFilename;
}

export function buildFileDownloadInfo(
  options: DownloadInfoOptions,
  deps: DownloadInfoDeps = {}
): FileDownloadInfo | null {
  const resolvedConfig = deps.config ?? config;
  const resolvedCache = deps.cache ?? cache;
  const resolveFilename = deps.generateSafeFilename ?? generateSafeFilename;

  if (!resolvedConfig.runtime.httpMode) {
    return null;
  }

  if (!resolvedConfig.cache.enabled || !options.cacheKey) {
    return null;
  }

  const parts = resolvedCache.parseCacheKey(options.cacheKey);
  if (!parts) return null;

  const cacheEntry = resolvedCache.get(options.cacheKey);
  if (!cacheEntry) return null;

  const { expiresAt, title, url } = cacheEntry;

  const downloadUrl = buildDownloadUrl(parts.namespace, parts.urlHash);
  const fileName = resolveFilename(
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
