import { config } from '../../config/index.js';

import * as cache from '../../services/cache.js';

export type InlineContentFormat = 'jsonl' | 'markdown';

export interface InlineContentResult {
  content?: string;
  contentSize: number;
  resourceUri?: string;
  resourceMimeType?: string;
  error?: string;
}

export function applyInlineContentLimit(
  content: string,
  cacheKey: string | null,
  format: InlineContentFormat
): InlineContentResult {
  const contentSize = content.length;
  const inlineLimit = config.constants.maxInlineContentChars;

  if (contentSize <= inlineLimit) {
    return { content, contentSize };
  }

  const resourceUri = resolveResourceUri(cacheKey);
  if (!resourceUri) {
    return buildCacheError(contentSize, inlineLimit);
  }

  return {
    contentSize,
    resourceUri,
    resourceMimeType: resolveResourceMimeType(format),
  };
}

function resolveResourceUri(cacheKey: string | null): string | null {
  if (!config.cache.enabled || !cacheKey) return null;
  return cache.toResourceUri(cacheKey);
}

function resolveResourceMimeType(format: InlineContentFormat): string {
  return format === 'markdown' ? 'text/markdown' : 'application/jsonl';
}

function buildCacheError(
  contentSize: number,
  inlineLimit: number
): InlineContentResult {
  return {
    contentSize,
    error: `Content exceeds inline limit (${inlineLimit} chars) and cannot be cached`,
  };
}
