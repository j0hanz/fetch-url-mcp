import type {
  FetchMarkdownInput,
  MarkdownTransformResult,
  PipelineResult,
  ToolResponseBase,
  TransformOptions,
} from '../../config/types.js';

import { logDebug, logError } from '../../services/logger.js';

import {
  createToolErrorResponse,
  handleToolError,
} from '../../utils/tool-error-handler.js';
import { transformHtmlToMarkdown } from '../utils/content-transform.js';

import {
  buildToolContentBlocks,
  type InlineResult,
  performSharedFetch,
} from './fetch-single.shared.js';

type MarkdownPipelineResult = MarkdownTransformResult & {
  readonly content: string;
};

export const FETCH_MARKDOWN_TOOL_NAME = 'fetch-markdown';
export const FETCH_MARKDOWN_TOOL_DESCRIPTION =
  'Fetches a webpage and converts it to clean Markdown format with optional frontmatter, table of contents, and content length limits';

interface MarkdownOptions {
  readonly extractMainContent: boolean;
  readonly includeMetadata: boolean;
  readonly generateToc: boolean;
  readonly maxContentLength?: number;
}

function resolveMarkdownOptions(input: FetchMarkdownInput): MarkdownOptions {
  return {
    extractMainContent: input.extractMainContent ?? true,
    includeMetadata: input.includeMetadata ?? true,
    generateToc: input.generateToc ?? false,
    maxContentLength: input.maxContentLength,
  };
}

function buildMarkdownStructuredContent(
  pipeline: PipelineResult<MarkdownPipelineResult>,
  inlineResult: InlineResult
): Record<string, unknown> {
  const structuredContent: Record<string, unknown> = {
    url: pipeline.url,
    title: pipeline.data.title,
    fetchedAt: pipeline.fetchedAt,
    contentSize: inlineResult.contentSize,
    cached: pipeline.fromCache,
  };

  if (pipeline.data.toc) {
    structuredContent.toc = pipeline.data.toc;
  }

  if (pipeline.data.truncated) {
    structuredContent.truncated = pipeline.data.truncated;
  }

  if (typeof inlineResult.content === 'string') {
    structuredContent.markdown = inlineResult.content;
  }

  if (inlineResult.resourceUri) {
    structuredContent.resourceUri = inlineResult.resourceUri;
    structuredContent.resourceMimeType = inlineResult.resourceMimeType;
  }

  return structuredContent;
}

function getInlineErrorResponse(
  inlineResult: InlineResult,
  url: string
): ToolResponseBase | null {
  if (!inlineResult.error) return null;
  return createToolErrorResponse(inlineResult.error, url, 'INTERNAL_ERROR');
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
    transform: buildMarkdownTransform(transformOptions),
  });
}

function buildMarkdownResponse(
  pipeline: PipelineResult<MarkdownPipelineResult>,
  inlineResult: InlineResult
): ToolResponseBase {
  const structuredContent = buildMarkdownStructuredContent(
    pipeline,
    inlineResult
  );

  return {
    content: buildToolContentBlocks(
      structuredContent,
      pipeline.fromCache,
      inlineResult,
      'Fetched markdown'
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
  return buildMarkdownResponse(pipeline, inlineResult);
}
