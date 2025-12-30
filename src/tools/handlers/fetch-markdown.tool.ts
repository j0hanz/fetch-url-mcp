import type {
  MarkdownTransformResult,
  TransformOptions,
} from '../../config/types/content.js';
import type { PipelineResult } from '../../config/types/runtime.js';
import type {
  FetchMarkdownInput,
  FileDownloadInfo,
  ToolResponseBase,
} from '../../config/types/tools.js';

import { logDebug, logError } from '../../services/logger.js';

import {
  createToolErrorResponse,
  handleToolError,
} from '../../utils/tool-error-handler.js';
import { transformHtmlToMarkdown } from '../utils/content-transform.js';

import {
  applyInlineResultToStructuredContent,
  buildToolContentBlocks,
  getFileDownloadInfo,
  getInlineErrorResponse,
  type InlineResult,
  performSharedFetch,
} from './fetch-single.shared.js';

type MarkdownPipelineResult = MarkdownTransformResult & {
  readonly content: string;
};

export const FETCH_MARKDOWN_TOOL_NAME = 'fetch-markdown';
export const FETCH_MARKDOWN_TOOL_DESCRIPTION =
  'Fetches a webpage and converts it to clean Markdown format with optional frontmatter and content length limits';

interface MarkdownOptions {
  readonly extractMainContent: boolean;
  readonly includeMetadata: boolean;
  readonly maxContentLength?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function deserializeMarkdownPipelineResult(
  cached: string
): MarkdownPipelineResult | undefined {
  try {
    const parsed = JSON.parse(cached) as unknown;
    if (!isRecord(parsed)) return undefined;

    const { content, markdown, title, truncated } = parsed;
    if (typeof content !== 'string') return undefined;
    if (typeof markdown !== 'string') return undefined;
    if (title !== undefined && typeof title !== 'string') return undefined;
    if (truncated !== undefined && typeof truncated !== 'boolean') {
      return undefined;
    }

    const resolvedTitle = typeof title === 'string' ? title : undefined;

    return {
      content,
      markdown,
      title: resolvedTitle,
      truncated: truncated ?? false,
    };
  } catch {
    return undefined;
  }
}

function resolveMarkdownOptions(input: FetchMarkdownInput): MarkdownOptions {
  return {
    extractMainContent: input.extractMainContent ?? true,
    includeMetadata: input.includeMetadata ?? true,
    maxContentLength: input.maxContentLength,
  };
}

function buildMarkdownStructuredContent(
  pipeline: PipelineResult<MarkdownPipelineResult>,
  inlineResult: InlineResult,
  fileDownload: FileDownloadInfo | null
): Record<string, unknown> {
  const structuredContent: Record<string, unknown> = {
    url: pipeline.url,
    title: pipeline.data.title,
    fetchedAt: pipeline.fetchedAt,
    contentSize: inlineResult.contentSize,
    cached: pipeline.fromCache,
  };

  if (pipeline.data.truncated || inlineResult.truncated) {
    structuredContent.truncated = true;
  }

  applyInlineResultToStructuredContent(
    structuredContent,
    inlineResult,
    'markdown'
  );

  if (fileDownload) {
    structuredContent.file = fileDownload;
  }

  return structuredContent;
}

function logFetchMarkdownStart(url: string, options: TransformOptions): void {
  logDebug('Fetching markdown', { url, ...options });
}

function buildMarkdownTransform(options: TransformOptions) {
  return (html: string, url: string): MarkdownPipelineResult => {
    const markdownResult = transformHtmlToMarkdown(html, url, options);
    return { ...markdownResult, content: markdownResult.markdown };
  };
}

async function fetchMarkdownPipeline(
  url: string,
  input: FetchMarkdownInput,
  options: MarkdownOptions,
  transformOptions: TransformOptions
): Promise<{
  pipeline: PipelineResult<MarkdownPipelineResult>;
  inlineResult: InlineResult;
}> {
  return performSharedFetch<MarkdownPipelineResult>({
    url,
    format: 'markdown',
    extractMainContent: options.extractMainContent,
    includeMetadata: options.includeMetadata,
    maxContentLength: options.maxContentLength,
    customHeaders: input.customHeaders,
    retries: input.retries,
    timeout: input.timeout,
    transform: buildMarkdownTransform(transformOptions),
    deserialize: deserializeMarkdownPipelineResult,
  });
}

function buildMarkdownResponse(
  pipeline: PipelineResult<MarkdownPipelineResult>,
  inlineResult: InlineResult,
  fileDownload: FileDownloadInfo | null
): ToolResponseBase {
  const structuredContent = buildMarkdownStructuredContent(
    pipeline,
    inlineResult,
    fileDownload
  );

  return {
    content: buildToolContentBlocks(
      structuredContent,
      pipeline.fromCache,
      inlineResult,
      'Fetched markdown',
      pipeline.cacheKey,
      pipeline.data.content,
      'markdown',
      pipeline.url,
      pipeline.data.title
    ),
    structuredContent,
  };
}

export async function fetchMarkdownToolHandler(
  input: FetchMarkdownInput
): Promise<ToolResponseBase> {
  try {
    return await executeFetchMarkdown(input);
  } catch (error) {
    logError(
      'fetch-markdown tool error',
      error instanceof Error ? error : undefined
    );
    return handleToolError(error, input.url, 'Failed to fetch markdown');
  }
}

async function executeFetchMarkdown(
  input: FetchMarkdownInput
): Promise<ToolResponseBase> {
  const { url } = input;
  if (!url) {
    return createToolErrorResponse('URL is required', '', 'VALIDATION_ERROR');
  }

  const options = resolveMarkdownOptions(input);
  const transformOptions: TransformOptions = { ...options };

  logFetchMarkdownStart(url, transformOptions);

  const { pipeline, inlineResult } = await fetchMarkdownPipeline(
    url,
    input,
    options,
    transformOptions
  );

  const inlineError = getInlineErrorResponse(inlineResult, url);
  if (inlineError) return inlineError;

  const fileDownload = inlineResult.resourceUri
    ? getFileDownloadInfo({
        cacheKey: pipeline.cacheKey ?? null,
        url: pipeline.url,
        title: pipeline.data.title,
      })
    : null;

  return buildMarkdownResponse(pipeline, inlineResult, fileDownload);
}
