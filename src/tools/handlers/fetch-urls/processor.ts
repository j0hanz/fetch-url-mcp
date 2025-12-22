import type {
  BatchUrlResult,
  FetchOptions,
  FetchUrlsInput,
} from '../../../config/types.js';

import { logWarn } from '../../../services/logger.js';

import { appendHeaderVary } from '../../utils/cache-vary.js';
import { enforceContentLengthLimit } from '../../utils/common.js';
import {
  transformHtmlToJsonl,
  transformHtmlToMarkdown,
} from '../../utils/content-transform.js';
import { executeFetchPipeline } from '../../utils/fetch-pipeline.js';
import { applyInlineContentLimit } from '../../utils/inline-content.js';

type Format = NonNullable<FetchUrlsInput['format']>;

interface SingleUrlProcessOptions {
  readonly extractMainContent: boolean;
  readonly includeMetadata: boolean;
  readonly maxContentLength?: number;
  readonly format: Format;
  readonly requestOptions?: FetchOptions;
  readonly maxRetries?: number;
}

interface CachedUrlEntry {
  content: string;
  title?: string;
  contentBlocks?: number;
  truncated?: boolean;
}

function isCachedUrlEntry(value: unknown): value is CachedUrlEntry {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const record = value as Record<string, unknown>;
  if (typeof record.content !== 'string') {
    return false;
  }

  if (record.title !== undefined && typeof record.title !== 'string') {
    return false;
  }

  if (
    record.contentBlocks !== undefined &&
    typeof record.contentBlocks !== 'number'
  ) {
    return false;
  }

  if (record.truncated !== undefined && typeof record.truncated !== 'boolean') {
    return false;
  }

  return true;
}

function deserializeCachedEntry(payload: string): CachedUrlEntry | undefined {
  try {
    const parsed: unknown = JSON.parse(payload);
    return isCachedUrlEntry(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function buildCacheVary(
  options: SingleUrlProcessOptions,
  customHeaders?: Record<string, string>
): Record<string, unknown> | undefined {
  return appendHeaderVary(
    {
      format: options.format,
      extractMainContent: options.extractMainContent,
      includeMetadata: options.includeMetadata,
      maxContentLength: options.maxContentLength ?? null,
      ...(options.format === 'markdown' ? {} : { contentBlocks: true }),
    },
    customHeaders
  ) as Record<string, unknown> | undefined;
}

function transformHtmlForBatch(
  html: string,
  url: string,
  options: SingleUrlProcessOptions
): CachedUrlEntry {
  if (options.format === 'markdown') {
    const { markdown, title, truncated } = transformHtmlToMarkdown(html, url, {
      extractMainContent: options.extractMainContent,
      includeMetadata: options.includeMetadata,
      maxContentLength: options.maxContentLength,
      generateToc: false,
    });
    return { content: markdown, title, truncated };
  }

  const { content, contentBlocks, title, truncated } = transformHtmlToJsonl(
    html,
    url,
    {
      extractMainContent: options.extractMainContent,
      includeMetadata: options.includeMetadata,
      maxContentLength: options.maxContentLength,
    }
  );
  return { content, contentBlocks, title, truncated };
}

export async function processSingleUrl(
  url: string,
  options: SingleUrlProcessOptions
): Promise<BatchUrlResult> {
  try {
    const cacheVary = buildCacheVary(
      options,
      options.requestOptions?.customHeaders
    );

    const cacheNamespace = options.format === 'markdown' ? 'markdown' : 'url';
    const result = await executeFetchPipeline<CachedUrlEntry>({
      url,
      cacheNamespace,
      customHeaders: options.requestOptions?.customHeaders,
      retries: options.maxRetries,
      timeout: options.requestOptions?.timeout,
      cacheVary,
      serialize: JSON.stringify,
      deserialize: deserializeCachedEntry,
      transform: (html, normalizedUrl) => {
        const transformed = transformHtmlForBatch(html, normalizedUrl, options);
        const { content } = enforceContentLengthLimit(
          transformed.content,
          options.maxContentLength
        );
        return { ...transformed, content };
      },
    });

    const inlineResult = applyInlineContentLimit(
      result.data.content,
      result.cacheKey ?? null,
      options.format
    );

    if (inlineResult.error) {
      return {
        url: result.url,
        success: false,
        cached: false,
        error: inlineResult.error,
        errorCode: 'INTERNAL_ERROR',
      };
    }

    return {
      url: result.url,
      success: true,
      title: result.data.title,
      content: inlineResult.content,
      contentSize: inlineResult.contentSize,
      resourceUri: inlineResult.resourceUri,
      resourceMimeType: inlineResult.resourceMimeType,
      contentBlocks: result.data.contentBlocks,
      cached: result.fromCache,
    };
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : 'Unknown error';
    const errorCode =
      error instanceof Error &&
      'code' in error &&
      typeof error.code === 'string'
        ? error.code
        : 'FETCH_ERROR';

    logWarn('Batch URL processing failed', { url, error: errorMessage });

    return {
      url,
      success: false,
      cached: false,
      error: errorMessage,
      errorCode,
    };
  }
}

export type { SingleUrlProcessOptions };
