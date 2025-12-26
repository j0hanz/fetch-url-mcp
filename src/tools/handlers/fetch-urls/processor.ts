import type {
  BatchUrlResult,
  FetchOptions,
  FetchUrlsInput,
  PipelineResult,
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
  if (!isRecord(value)) return false;
  return hasValidCachedFields(value);
}

function hasValidCachedFields(value: Record<string, unknown>): boolean {
  if (!isString(value.content)) return false;
  if (!isOptionalString(value.title)) return false;
  if (!isOptionalNumber(value.contentBlocks)) return false;
  if (!isOptionalBoolean(value.truncated)) return false;
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
    return await processSingleUrlInternal(url, options);
  } catch (error) {
    return mapProcessError(url, error);
  }
}

async function processSingleUrlInternal(
  url: string,
  options: SingleUrlProcessOptions
): Promise<BatchUrlResult> {
  const result = await runBatchPipeline(url, options);
  const inlineResult = applyInlineContentLimit(
    result.data.content,
    result.cacheKey ?? null,
    options.format
  );

  if (inlineResult.error) {
    return mapInlineFailure(result.url, inlineResult.error);
  }

  return mapInlineSuccess(result, inlineResult);
}

function mapProcessError(url: string, error: unknown): BatchUrlResult {
  const errorMessage = resolveErrorMessage(error);
  const errorCode = resolveErrorCode(error);
  logWarn('Batch URL processing failed', { url, error: errorMessage });

  return {
    url,
    success: false,
    cached: false,
    error: errorMessage,
    errorCode,
  };
}

function resolveErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error';
}

function resolveErrorCode(error: unknown): string {
  if (!isRecord(error)) return 'FETCH_ERROR';
  const { code } = error;
  return typeof code === 'string' ? code : 'FETCH_ERROR';
}

async function runBatchPipeline(
  url: string,
  options: SingleUrlProcessOptions
): Promise<PipelineResult<CachedUrlEntry>> {
  const cacheVary = buildCacheVary(
    options,
    options.requestOptions?.customHeaders
  );

  const cacheNamespace = options.format === 'markdown' ? 'markdown' : 'url';
  return executeFetchPipeline<CachedUrlEntry>({
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
}

function mapInlineSuccess(
  result: PipelineResult<CachedUrlEntry>,
  inlineResult: ReturnType<typeof applyInlineContentLimit>
): BatchUrlResult {
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
}

function mapInlineFailure(url: string, errorMessage: string): BatchUrlResult {
  return {
    url,
    success: false,
    cached: false,
    error: errorMessage,
    errorCode: 'INTERNAL_ERROR',
  };
}

export type { SingleUrlProcessOptions };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || isString(value);
}

function isOptionalNumber(value: unknown): boolean {
  return value === undefined || typeof value === 'number';
}

function isOptionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === 'boolean';
}
