import { config } from '../../config/index.js';
import type {
  PipelineResult,
  ToolContentBlock,
} from '../../config/types/runtime.js';
import type {
  FileDownloadInfo,
  ToolResponseBase,
} from '../../config/types/tools.js';

import { buildFileDownloadInfo } from '../../utils/download-url.js';
import { generateSafeFilename } from '../../utils/filename-generator.js';
import { createToolErrorResponse } from '../../utils/tool-error-handler.js';
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
  readonly timeout?: number;
  readonly transform: (html: string, normalizedUrl: string) => T;
  readonly serialize?: (result: T) => string;
  readonly deserialize?: (cached: string) => T | undefined;
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
    timeout: options.timeout,
    cacheVary,
    transform: options.transform,
    serialize: options.serialize,
    deserialize: options.deserialize,
  });

  const inlineResult = applyInlineContentLimit(
    pipeline.data.content,
    pipeline.cacheKey ?? null,
    options.format
  );

  return { pipeline, inlineResult };
}

export type InlineResult = ReturnType<typeof applyInlineContentLimit>;

interface DownloadContext {
  cacheKey: string | null;
  url: string;
  title?: string;
}

export function getFileDownloadInfo(
  context: DownloadContext
): FileDownloadInfo | null {
  return buildFileDownloadInfo({
    cacheKey: context.cacheKey,
    url: context.url,
    title: context.title,
  });
}

export function getInlineErrorResponse(
  inlineResult: InlineResult,
  url: string
): ToolResponseBase | null {
  if (!inlineResult.error) return null;
  return createToolErrorResponse(inlineResult.error, url, 'INTERNAL_ERROR');
}

export function applyInlineResultToStructuredContent(
  structuredContent: Record<string, unknown>,
  inlineResult: InlineResult,
  contentKey: string
): void {
  if (inlineResult.truncated) {
    structuredContent.truncated = true;
  }

  if (typeof inlineResult.content === 'string') {
    structuredContent[contentKey] = inlineResult.content;
  }

  if (inlineResult.resourceUri) {
    structuredContent.resourceUri = inlineResult.resourceUri;
    structuredContent.resourceMimeType = inlineResult.resourceMimeType;
  }
}

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

function buildEmbeddedResource(
  content: string,
  mimeType: string,
  url: string,
  title?: string
): ToolContentBlock | null {
  if (!content) {
    return null;
  }

  // Generate a proper filename with extension
  const extension = mimeType === 'text/markdown' ? '.md' : '.jsonl';
  const filename = generateSafeFilename(url, title, undefined, extension);

  // Use file: URI scheme with filename for better VS Code integration
  const uri = `file:///${filename}`;

  return {
    type: 'resource',
    resource: {
      uri,
      mimeType,
      text: content,
    },
  };
}

export function buildToolContentBlocks(
  structuredContent: Record<string, unknown>,
  fromCache: boolean,
  inlineResult: InlineResult,
  resourceName: string,
  cacheKey?: string | null,
  fullContent?: string,
  format?: SharedFetchFormat,
  url?: string,
  title?: string
): ToolContentBlock[] {
  const textBlock: ToolContentBlock = {
    type: 'text',
    text: serializeStructuredContent(structuredContent, fromCache),
  };

  const blocks: ToolContentBlock[] = [textBlock];

  // Always add embedded resource for saveable content (works in stdio mode)
  const mimeType =
    format === 'markdown' ? 'text/markdown' : 'application/jsonl';
  const contentToEmbed = fullContent ?? inlineResult.content;
  if (contentToEmbed && url) {
    const embeddedResource = buildEmbeddedResource(
      contentToEmbed,
      mimeType,
      url,
      title
    );
    if (embeddedResource) {
      blocks.push(embeddedResource);
    }
  }

  // Add resource link for HTTP mode downloads (only when truncated)
  const resourceLink = buildResourceLink(inlineResult, resourceName);
  if (resourceLink) {
    blocks.push(resourceLink);
  }

  return blocks;
}
