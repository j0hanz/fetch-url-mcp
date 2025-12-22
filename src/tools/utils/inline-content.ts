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

  if (!config.cache.enabled || !cacheKey) {
    return {
      contentSize,
      error: `Content exceeds inline limit (${inlineLimit} chars) and cannot be cached`,
    };
  }

  const resourceUri = cache.toResourceUri(cacheKey);
  if (!resourceUri) {
    return {
      contentSize,
      error: `Content exceeds inline limit (${inlineLimit} chars) and cannot be cached`,
    };
  }

  return {
    contentSize,
    resourceUri,
    resourceMimeType:
      format === 'markdown' ? 'text/markdown' : 'application/jsonl',
  };
}
