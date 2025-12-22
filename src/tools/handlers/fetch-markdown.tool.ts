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
import { appendHeaderVary } from '../utils/cache-vary.js';
import { transformHtmlToMarkdown } from '../utils/content-transform.js';
import { executeFetchPipeline } from '../utils/fetch-pipeline.js';
import { applyInlineContentLimit } from '../utils/inline-content.js';

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
    const result = await executeFetchPipeline<MarkdownTransformResult>({
      url: input.url,
      cacheNamespace: 'markdown',
      customHeaders: input.customHeaders,
      retries: input.retries,
      cacheVary: appendHeaderVary(
        {
          extractMainContent: options.extractMainContent,
          includeMetadata: options.includeMetadata,
          generateToc: options.generateToc,
          maxContentLength: options.maxContentLength,
        },
        input.customHeaders
      ),
      transform: (html, url) => transformHtmlToMarkdown(html, url, options),
    });

    const inlineResult = applyInlineContentLimit(
      result.data.markdown,
      result.cacheKey ?? null,
      'markdown'
    );

    if (inlineResult.error) {
      return createToolErrorResponse(
        inlineResult.error,
        input.url,
        'INTERNAL_ERROR'
      );
    }

    const shouldInline = typeof inlineResult.content === 'string';

    const structuredContent = {
      url: result.url,
      title: result.data.title,
      fetchedAt: result.fetchedAt,
      contentSize: inlineResult.contentSize,
      ...(result.data.toc && { toc: result.data.toc }),
      cached: result.fromCache,
      ...(result.data.truncated && { truncated: result.data.truncated }),
      ...(shouldInline ? { markdown: inlineResult.content } : {}),
      ...(inlineResult.resourceUri && {
        resourceUri: inlineResult.resourceUri,
        resourceMimeType: inlineResult.resourceMimeType,
      }),
    };

    const jsonOutput = JSON.stringify(
      structuredContent,
      result.fromCache ? undefined : null,
      result.fromCache ? undefined : 2
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
