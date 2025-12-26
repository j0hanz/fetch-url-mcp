import { config } from '../../config/index.js';
import type {
  FetchMarkdownInput,
  MarkdownTransformResult,
  ToolResponseBase,
  TransformOptions,
} from '../../config/types.js';

import { logDebug, logError } from '../../services/logger.js';

import {
  createToolErrorResponse,
  handleToolError,
} from '../../utils/tool-error-handler.js';
import { transformHtmlToMarkdown } from '../utils/content-transform.js';

import { performSharedFetch } from './fetch-single.shared.js';

type MarkdownPipelineResult = MarkdownTransformResult & {
  readonly content: string;
};

export const FETCH_MARKDOWN_TOOL_NAME = 'fetch-markdown';
export const FETCH_MARKDOWN_TOOL_DESCRIPTION =
  'Fetches a webpage and converts it to clean Markdown format with optional frontmatter, table of contents, and content length limits';

export async function fetchMarkdownToolHandler(
  input: FetchMarkdownInput
): Promise<ToolResponseBase> {
  if (!input.url) {
    return createToolErrorResponse('URL is required', '', 'VALIDATION_ERROR');
  }

  const options: TransformOptions = {
    extractMainContent: input.extractMainContent ?? true,
    includeMetadata: input.includeMetadata ?? true,
    generateToc: input.generateToc ?? false,
    maxContentLength: input.maxContentLength,
  };

  logDebug('Fetching markdown', { url: input.url, ...options });

  try {
    const { pipeline, inlineResult } =
      await performSharedFetch<MarkdownPipelineResult>({
        url: input.url,
        format: 'markdown',
        extractMainContent: options.extractMainContent,
        includeMetadata: options.includeMetadata,
        maxContentLength: options.maxContentLength,
        customHeaders: input.customHeaders,
        retries: input.retries,
        transform: (html, url) => {
          const markdownResult = transformHtmlToMarkdown(html, url, options);
          return { ...markdownResult, content: markdownResult.markdown };
        },
      });

    if (inlineResult.error) {
      return createToolErrorResponse(
        inlineResult.error,
        input.url,
        'INTERNAL_ERROR'
      );
    }

    const shouldInline = typeof inlineResult.content === 'string';

    const structuredContent = {
      url: pipeline.url,
      title: pipeline.data.title,
      fetchedAt: pipeline.fetchedAt,
      contentSize: inlineResult.contentSize,
      ...(pipeline.data.toc && { toc: pipeline.data.toc }),
      cached: pipeline.fromCache,
      ...(pipeline.data.truncated && { truncated: pipeline.data.truncated }),
      ...(shouldInline ? { markdown: inlineResult.content } : {}),
      ...(inlineResult.resourceUri && {
        resourceUri: inlineResult.resourceUri,
        resourceMimeType: inlineResult.resourceMimeType,
      }),
    };

    const jsonOutput = JSON.stringify(
      structuredContent,
      pipeline.fromCache ? undefined : null,
      pipeline.fromCache ? undefined : 2
    );

    return {
      content: [
        { type: 'text' as const, text: jsonOutput },
        ...(inlineResult.resourceUri
          ? [
              {
                type: 'resource_link' as const,
                uri: inlineResult.resourceUri,
                name: 'Fetched markdown',
                mimeType: inlineResult.resourceMimeType,
                description: `Content exceeds inline limit (${config.constants.maxInlineContentChars} chars)`,
              },
            ]
          : []),
      ],
      structuredContent,
    };
  } catch (error) {
    logError(
      'fetch-markdown tool error',
      error instanceof Error ? error : undefined
    );
    return handleToolError(error, input.url, 'Failed to fetch markdown');
  }
}
