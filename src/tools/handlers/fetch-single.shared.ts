import type { PipelineResult } from '../../config/types.js';

import { appendHeaderVary } from '../utils/cache-vary.js';
import { executeFetchPipeline } from '../utils/fetch-pipeline.js';
import { applyInlineContentLimit } from '../utils/inline-content.js';

type SharedFetchFormat = 'jsonl' | 'markdown';

interface SharedFetchOptions<T extends { content: string }> {
  readonly url: string;
  readonly format: SharedFetchFormat;
  readonly extractMainContent: boolean;
  readonly includeMetadata: boolean;
  readonly maxContentLength?: number;
  readonly customHeaders?: Record<string, string>;
  readonly retries?: number;
  readonly transform: (html: string, normalizedUrl: string) => T;
}

export async function performSharedFetch<T extends { content: string }>(
  options: SharedFetchOptions<T>
): Promise<{
  pipeline: PipelineResult<T>;
  inlineResult: ReturnType<typeof applyInlineContentLimit>;
}> {
  const cacheNamespace = options.format === 'markdown' ? 'markdown' : 'url';
  const cacheVary = appendHeaderVary(
    {
      format: options.format,
      extractMainContent: options.extractMainContent,
      includeMetadata: options.includeMetadata,
      maxContentLength: options.maxContentLength,
      ...(options.format === 'markdown' ? {} : { contentBlocks: true }),
    },
    options.customHeaders
  );

  const pipeline = await executeFetchPipeline<T>({
    url: options.url,
    cacheNamespace,
    customHeaders: options.customHeaders,
    retries: options.retries,
    cacheVary,
    transform: options.transform,
  });

  const inlineResult = applyInlineContentLimit(
    pipeline.data.content,
    pipeline.cacheKey ?? null,
    options.format
  );

  return { pipeline, inlineResult };
}
