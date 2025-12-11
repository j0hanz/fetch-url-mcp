import { extractContent } from '../../services/extractor.js';
import { parseHtml } from '../../services/parser.js';
import { toJsonl } from '../../transformers/jsonl.transformer.js';
import { config } from '../../config/index.js';
import { logDebug, logError } from '../../services/logger.js';
import {
  createToolErrorResponse,
  handleToolError,
} from '../../utils/tool-error-handler.js';
import { executeFetchPipeline } from '../utils/fetch-pipeline.js';
import type {
  FetchUrlInput,
  MetadataBlock,
  ContentBlockUnion,
  JsonlTransformResult,
} from '../../config/types.js';

export const FETCH_URL_TOOL_NAME = 'fetch-url';
export const FETCH_URL_TOOL_DESCRIPTION =
  'Fetches a webpage and converts it to AI-readable JSONL format with semantic content blocks. Supports custom headers, retries, and content length limits.';

function transformToJsonl(
  html: string,
  url: string,
  options: { extractMainContent: boolean; includeMetadata: boolean }
): JsonlTransformResult {
  const { article, metadata: extractedMeta } = extractContent(html, url);

  let contentBlocks: ContentBlockUnion[];
  let metadata: MetadataBlock | undefined;
  let title: string | undefined;

  if (
    options.extractMainContent &&
    config.extraction.extractMainContent &&
    article
  ) {
    contentBlocks = parseHtml(article.content);
    metadata =
      options.includeMetadata && config.extraction.includeMetadata
        ? {
            type: 'metadata' as const,
            title: article.title,
            author: article.byline,
            url,
            fetchedAt: new Date().toISOString(),
          }
        : undefined;
    title = article.title;
  } else {
    contentBlocks = parseHtml(html);
    metadata =
      options.includeMetadata && config.extraction.includeMetadata
        ? {
            type: 'metadata' as const,
            title: extractedMeta.title,
            description: extractedMeta.description,
            author: extractedMeta.author,
            url,
            fetchedAt: new Date().toISOString(),
          }
        : undefined;
    title = extractedMeta.title;
  }

  return {
    content: toJsonl(contentBlocks, metadata),
    contentBlocks: contentBlocks.length,
    title,
  };
}

export async function fetchUrlToolHandler(input: FetchUrlInput) {
  try {
    if (!input.url) {
      return createToolErrorResponse('URL is required', '', 'VALIDATION_ERROR');
    }

    const extractMainContent = input.extractMainContent ?? true;
    const includeMetadata = input.includeMetadata ?? true;

    logDebug('Fetching URL', {
      url: input.url,
      extractMainContent,
      includeMetadata,
      maxContentLength: input.maxContentLength,
      retries: input.retries,
    });

    const result = await executeFetchPipeline<JsonlTransformResult>({
      url: input.url,
      cacheNamespace: 'url',
      customHeaders: input.customHeaders,
      retries: input.retries,
      transform: (html, url) =>
        transformToJsonl(html, url, { extractMainContent, includeMetadata }),
      serialize: (data) => data.content,
      deserialize: (cached) => ({
        content: cached,
        contentBlocks: 0, // Unknown from cache
        title: undefined,
      }),
    });

    let content = result.data.content;
    let truncated = false;

    // Apply max content length truncation
    if (
      input.maxContentLength &&
      input.maxContentLength > 0 &&
      content.length > input.maxContentLength
    ) {
      content =
        content.substring(0, input.maxContentLength) + '\n...[truncated]';
      truncated = true;
    }

    const structuredContent = {
      url: result.url,
      title: result.data.title,
      contentBlocks: result.data.contentBlocks,
      fetchedAt: result.fetchedAt,
      format: 'jsonl' as const,
      content,
      cached: result.fromCache,
      ...(truncated && { truncated }),
    };

    return {
      content: [
        {
          type: 'text' as const,
          text: result.fromCache
            ? JSON.stringify(structuredContent)
            : JSON.stringify(structuredContent, null, 2),
        },
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
