import type { JsonlTransformResult } from '../../config/types/content.js';
import type { PipelineResult } from '../../config/types/runtime.js';
import type {
  FetchUrlInput,
  ToolResponseBase,
} from '../../config/types/tools.js';

import { logDebug, logError } from '../../services/logger.js';

import {
  createToolErrorResponse,
  handleToolError,
} from '../../utils/tool-error-handler.js';
import {
  transformHtmlToJsonl,
  transformHtmlToMarkdownWithBlocks,
} from '../utils/content-transform.js';

import {
  applyInlineResultToStructuredContent,
  buildToolContentBlocks,
  getInlineErrorResponse,
  type InlineResult,
  performSharedFetch,
} from './fetch-single.shared.js';

export const FETCH_URL_TOOL_NAME = 'fetch-url';
export const FETCH_URL_TOOL_DESCRIPTION =
  'Fetches a webpage and converts it to AI-readable JSONL format with semantic content blocks. Supports custom headers, retries, and content length limits.';

type Format = NonNullable<FetchUrlInput['format']>;

interface FetchUrlOptions {
  readonly extractMainContent: boolean;
  readonly includeMetadata: boolean;
  readonly maxContentLength?: number;
  readonly format: Format;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function deserializeJsonlTransformResult(
  cached: string
): JsonlTransformResult | undefined {
  try {
    const parsed = JSON.parse(cached) as unknown;
    if (!isRecord(parsed)) return undefined;

    const { content, contentBlocks, title, truncated } = parsed;
    if (typeof content !== 'string') return undefined;
    if (typeof contentBlocks !== 'number' || !Number.isFinite(contentBlocks)) {
      return undefined;
    }
    if (title !== undefined && typeof title !== 'string') return undefined;
    if (truncated !== undefined && typeof truncated !== 'boolean') {
      return undefined;
    }

    const resolvedTitle = typeof title === 'string' ? title : undefined;

    return {
      content,
      contentBlocks,
      title: resolvedTitle,
      ...(truncated !== undefined ? { truncated } : {}),
    };
  } catch {
    return undefined;
  }
}

function resolveFetchUrlOptions(input: FetchUrlInput): FetchUrlOptions {
  return {
    extractMainContent: input.extractMainContent ?? true,
    includeMetadata: input.includeMetadata ?? true,
    maxContentLength: input.maxContentLength,
    format: input.format ?? 'jsonl',
  };
}

function buildFetchUrlTransform(options: FetchUrlOptions) {
  return (html: string, url: string) =>
    options.format === 'markdown'
      ? transformHtmlToMarkdownWithBlocks(html, url, options)
      : transformHtmlToJsonl(html, url, options);
}

function buildFetchUrlStructuredContent(
  format: Format,
  pipeline: PipelineResult<JsonlTransformResult>,
  inlineResult: InlineResult
): Record<string, unknown> {
  const structuredContent: Record<string, unknown> = {
    url: pipeline.url,
    title: pipeline.data.title,
    contentBlocks: pipeline.data.contentBlocks,
    fetchedAt: pipeline.fetchedAt,
    format,
    contentSize: inlineResult.contentSize,
    cached: pipeline.fromCache,
  };

  if (pipeline.data.truncated) {
    structuredContent.truncated = true;
  }

  if (inlineResult.truncated) {
    structuredContent.truncated = true;
  }

  applyInlineResultToStructuredContent(
    structuredContent,
    inlineResult,
    'content'
  );

  return structuredContent;
}

function logFetchUrlStart(url: string, options: FetchUrlOptions): void {
  logDebug('Fetching URL', {
    url,
    extractMainContent: options.extractMainContent,
    includeMetadata: options.includeMetadata,
    format: options.format,
  });
}

async function fetchUrlPipeline(
  url: string,
  input: FetchUrlInput,
  options: FetchUrlOptions
): Promise<{
  pipeline: PipelineResult<JsonlTransformResult>;
  inlineResult: InlineResult;
}> {
  return performSharedFetch<JsonlTransformResult>({
    url,
    format: options.format,
    extractMainContent: options.extractMainContent,
    includeMetadata: options.includeMetadata,
    maxContentLength: options.maxContentLength,
    customHeaders: input.customHeaders,
    retries: input.retries,
    timeout: input.timeout,
    transform: buildFetchUrlTransform(options),
    deserialize: deserializeJsonlTransformResult,
  });
}

function buildFetchUrlResponse(
  pipeline: PipelineResult<JsonlTransformResult>,
  inlineResult: InlineResult,
  format: Format
): ToolResponseBase {
  const structuredContent = buildFetchUrlStructuredContent(
    format,
    pipeline,
    inlineResult
  );

  return {
    content: buildToolContentBlocks(
      structuredContent,
      pipeline.fromCache,
      inlineResult,
      'Fetched content',
      pipeline.cacheKey,
      pipeline.data.content,
      format,
      pipeline.url,
      pipeline.data.title
    ),
    structuredContent,
  };
}

export async function fetchUrlToolHandler(
  input: FetchUrlInput
): Promise<ToolResponseBase> {
  try {
    return await executeFetchUrl(input);
  } catch (error) {
    logError(
      'fetch-url tool error',
      error instanceof Error ? error : undefined
    );
    return handleToolError(error, input.url, 'Failed to fetch URL');
  }
}

async function executeFetchUrl(
  input: FetchUrlInput
): Promise<ToolResponseBase> {
  const { url } = input;
  if (!url) {
    return createToolErrorResponse('URL is required', '', 'VALIDATION_ERROR');
  }

  const options = resolveFetchUrlOptions(input);
  logFetchUrlStart(url, options);

  const { pipeline, inlineResult } = await fetchUrlPipeline(
    url,
    input,
    options
  );

  const inlineError = getInlineErrorResponse(inlineResult, url);
  if (inlineError) return inlineError;
  return buildFetchUrlResponse(pipeline, inlineResult, options.format);
}
