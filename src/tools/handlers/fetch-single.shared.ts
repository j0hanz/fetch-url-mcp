import { config } from '../../config/index.js';
import type { PipelineResult, ToolContentBlock } from '../../config/types.js';

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

export type InlineResult = ReturnType<typeof applyInlineContentLimit>;

function serializeStructuredContent(
  structuredContent: Record<string, unknown>,
  fromCache: boolean
): string {
  return JSON.stringify(
    structuredContent,
    fromCache ? undefined : null,
    fromCache ? undefined : 2
  );
}

function buildResourceLink(
  inlineResult: InlineResult,
  name: string
): ToolContentBlock | null {
  if (!inlineResult.resourceUri) {
    return null;
  }

  return {
    type: 'resource_link',
    uri: inlineResult.resourceUri,
    name,
    mimeType: inlineResult.resourceMimeType,
    description: `Content exceeds inline limit (${config.constants.maxInlineContentChars} chars)`,
  };
}

export function buildToolContentBlocks(
  structuredContent: Record<string, unknown>,
  fromCache: boolean,
  inlineResult: InlineResult,
  resourceName: string
): ToolContentBlock[] {
  const textBlock: ToolContentBlock = {
    type: 'text',
    text: serializeStructuredContent(structuredContent, fromCache),
  };

  const resourceLink = buildResourceLink(inlineResult, resourceName);
  return resourceLink ? [textBlock, resourceLink] : [textBlock];
}
