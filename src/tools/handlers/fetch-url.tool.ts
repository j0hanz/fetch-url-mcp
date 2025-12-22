import { config } from '../../config/index.js';
import type {
  FetchUrlInput,
  JsonlTransformResult,
  ToolResponseBase,
} from '../../config/types.js';

import { logDebug, logError } from '../../services/logger.js';

import {
  createToolErrorResponse,
  handleToolError,
} from '../../utils/tool-error-handler.js';
import { appendHeaderVary } from '../utils/cache-vary.js';
import {
  transformHtmlToJsonl,
  transformHtmlToMarkdownWithBlocks,
} from '../utils/content-transform.js';
import { executeFetchPipeline } from '../utils/fetch-pipeline.js';
import { applyInlineContentLimit } from '../utils/inline-content.js';

export const FETCH_URL_TOOL_NAME = 'fetch-url';
export const FETCH_URL_TOOL_DESCRIPTION =
  'Fetches a webpage and converts it to AI-readable JSONL format with semantic content blocks. Supports custom headers, retries, and content length limits.';

export async function fetchUrlToolHandler(
  input: FetchUrlInput
): Promise<ToolResponseBase> {
  if (!input.url) {
    return createToolErrorResponse('URL is required', '', 'VALIDATION_ERROR');
  }

  const extractMainContent = input.extractMainContent ?? true;
  const includeMetadata = input.includeMetadata ?? true;
  const format = input.format ?? 'jsonl';

  logDebug('Fetching URL', {
    url: input.url,
    extractMainContent,
    includeMetadata,
    format,
  });

  try {
    const result = await executeFetchPipeline<JsonlTransformResult>({
      url: input.url,
      cacheNamespace: format === 'markdown' ? 'markdown' : 'url',
      customHeaders: input.customHeaders,
      retries: input.retries,
      cacheVary: appendHeaderVary(
        {
          format,
          extractMainContent,
          includeMetadata,
          maxContentLength: input.maxContentLength,
        },
        input.customHeaders
      ),
      transform: (html, url) =>
        format === 'markdown'
          ? transformHtmlToMarkdownWithBlocks(html, url, {
              extractMainContent,
              includeMetadata,
              maxContentLength: input.maxContentLength,
            })
          : transformHtmlToJsonl(html, url, {
              extractMainContent,
              includeMetadata,
              maxContentLength: input.maxContentLength,
            }),
    });

    const inlineResult = applyInlineContentLimit(
      result.data.content,
      result.cacheKey ?? null,
      format
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
      contentBlocks: result.data.contentBlocks,
      fetchedAt: result.fetchedAt,
      format,
      contentSize: inlineResult.contentSize,
      cached: result.fromCache,
      ...(result.data.truncated && { truncated: result.data.truncated }),
      ...(shouldInline ? { content: inlineResult.content } : {}),
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
                name: 'Fetched content',
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
      'fetch-url tool error',
      error instanceof Error ? error : undefined
    );
    return handleToolError(error, input.url, 'Failed to fetch URL');
  }
}
