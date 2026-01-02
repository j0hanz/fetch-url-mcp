import { config } from '../../config/index.js';
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
import { transformHtmlToMarkdownAsync } from '../utils/content-transform-async.js';

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

interface FetchMarkdownDeps {
  readonly performSharedFetch?: typeof performSharedFetch;
  readonly transformHtmlToMarkdown?: typeof transformHtmlToMarkdownAsync;
}

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
    const parsed: unknown = JSON.parse(cached);
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
    extractMainContent:
      input.extractMainContent ?? config.extraction.extractMainContent,
    includeMetadata: input.includeMetadata ?? config.extraction.includeMetadata,
    ...(input.maxContentLength !== undefined && {
      maxContentLength: input.maxContentLength,
    }),
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

function buildMarkdownTransform(
  options: TransformOptions,
  transform: typeof transformHtmlToMarkdownAsync
) {
  return async (html: string, url: string): Promise<MarkdownPipelineResult> => {
    const markdownResult = await transform(html, url, options);
    return { ...markdownResult, content: markdownResult.markdown };
  };
}

async function fetchMarkdownPipeline(
  url: string,
  input: FetchMarkdownInput,
  options: MarkdownOptions,
  transformOptions: TransformOptions,
  performSharedFetchImpl: typeof performSharedFetch,
  transformImpl: typeof transformHtmlToMarkdownAsync
): Promise<{
  pipeline: PipelineResult<MarkdownPipelineResult>;
  inlineResult: InlineResult;
}> {
  const sharedOptions = {
    url,
    format: 'markdown' as const,
    extractMainContent: options.extractMainContent,
    includeMetadata: options.includeMetadata,
    ...(options.maxContentLength !== undefined && {
      maxContentLength: options.maxContentLength,
    }),
    ...(input.customHeaders !== undefined && {
      customHeaders: input.customHeaders,
    }),
    ...(input.retries !== undefined && { retries: input.retries }),
    ...(input.timeout !== undefined && { timeout: input.timeout }),
    transform: buildMarkdownTransform(transformOptions, transformImpl),
    deserialize: deserializeMarkdownPipelineResult,
  };

  return performSharedFetchImpl<MarkdownPipelineResult>(sharedOptions);
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

export function createFetchMarkdownToolHandler(
  deps: FetchMarkdownDeps = {}
): (input: FetchMarkdownInput) => Promise<ToolResponseBase> {
  const performSharedFetchImpl = deps.performSharedFetch ?? performSharedFetch;
  const transformImpl =
    deps.transformHtmlToMarkdown ?? transformHtmlToMarkdownAsync;

  return async (input: FetchMarkdownInput): Promise<ToolResponseBase> => {
    try {
      return await executeFetchMarkdown(
        input,
        performSharedFetchImpl,
        transformImpl
      );
    } catch (error) {
      logError(
        'fetch-markdown tool error',
        error instanceof Error ? error : undefined
      );
      return handleToolError(error, input.url, 'Failed to fetch markdown');
    }
  };
}

export const fetchMarkdownToolHandler = createFetchMarkdownToolHandler();

async function executeFetchMarkdown(
  input: FetchMarkdownInput,
  performSharedFetchImpl: typeof performSharedFetch,
  transformImpl: typeof transformHtmlToMarkdownAsync
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
    transformOptions,
    performSharedFetchImpl,
    transformImpl
  );

  const inlineError = getInlineErrorResponse(inlineResult, url);
  if (inlineError) return inlineError;

  let fileDownload: FileDownloadInfo | null = null;
  if (inlineResult.resourceUri) {
    const downloadContext = {
      cacheKey: pipeline.cacheKey ?? null,
      url: pipeline.url,
    };

    if (pipeline.data.title !== undefined) {
      fileDownload = getFileDownloadInfo({
        ...downloadContext,
        title: pipeline.data.title,
      });
    } else {
      fileDownload = getFileDownloadInfo(downloadContext);
    }
  }

  return buildMarkdownResponse(pipeline, inlineResult, fileDownload);
}
