import type { MarkdownTransformResult } from '../../config/types/content.js';
import type { PipelineResult } from '../../config/types/runtime.js';
import type {
  FetchUrlInput,
  ToolResponseBase,
} from '../../config/types/tools.js';

import { logDebug, logError } from '../../services/logger.js';

import { isRecord } from '../../utils/guards.js';
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

export const FETCH_URL_TOOL_NAME = 'fetch-url';
export const FETCH_URL_TOOL_DESCRIPTION =
  'Fetches a webpage and converts it to clean Markdown format';

type MarkdownPipelineResult = MarkdownTransformResult & {
  readonly content: string;
};

function deserializeMarkdownResult(
  cached: string
): MarkdownPipelineResult | undefined {
  try {
    const parsed: unknown = JSON.parse(cached);
    if (!isRecord(parsed)) return undefined;

    const { content, markdown, title, truncated } = parsed;
    const resolvedContent =
      typeof markdown === 'string'
        ? markdown
        : typeof content === 'string'
          ? content
          : undefined;
    if (resolvedContent === undefined) return undefined;
    if (title !== undefined && typeof title !== 'string') return undefined;

    return {
      content: resolvedContent,
      markdown: resolvedContent,
      title: typeof title === 'string' ? title : undefined,
      truncated: typeof truncated === 'boolean' ? truncated : false,
    };
  } catch {
    return undefined;
  }
}

function buildMarkdownTransform() {
  return (html: string, url: string): MarkdownPipelineResult => {
    const result = transformHtmlToMarkdown(html, url, {
      includeMetadata: true,
    });
    return { ...result, content: result.markdown };
  };
}

function serializeMarkdownResult(result: MarkdownPipelineResult): string {
  return JSON.stringify({
    markdown: result.markdown,
    title: result.title,
    truncated: result.truncated,
  });
}

function buildStructuredContent(
  pipeline: PipelineResult<MarkdownPipelineResult>,
  inlineResult: InlineResult
): Record<string, unknown> {
  return {
    url: pipeline.url,
    title: pipeline.data.title,
    markdown: inlineResult.content,
  };
}

function logFetchStart(url: string): void {
  logDebug('Fetching URL', { url });
}

async function fetchPipeline(url: string): Promise<{
  pipeline: PipelineResult<MarkdownPipelineResult>;
  inlineResult: InlineResult;
}> {
  return performSharedFetch<MarkdownPipelineResult>({
    url,
    transform: buildMarkdownTransform(),
    serialize: serializeMarkdownResult,
    deserialize: deserializeMarkdownResult,
  });
}

function buildResponse(
  pipeline: PipelineResult<MarkdownPipelineResult>,
  inlineResult: InlineResult
): ToolResponseBase {
  const structuredContent = buildStructuredContent(pipeline, inlineResult);

  return {
    content: buildToolContentBlocks(
      structuredContent,
      pipeline.fromCache,
      inlineResult,
      'Fetched markdown',
      pipeline.cacheKey,
      pipeline.data.content,
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
    return await executeFetch(input);
  } catch (error) {
    logError(
      'fetch-url tool error',
      error instanceof Error ? error : undefined
    );
    return handleToolError(error, input.url, 'Failed to fetch URL');
  }
}

async function executeFetch(input: FetchUrlInput): Promise<ToolResponseBase> {
  const { url } = input;
  if (!url) {
    return createToolErrorResponse('URL is required', '');
  }

  logFetchStart(url);

  const { pipeline, inlineResult } = await fetchPipeline(url);

  if (inlineResult.error) {
    return createToolErrorResponse(inlineResult.error, url);
  }

  return buildResponse(pipeline, inlineResult);
}
