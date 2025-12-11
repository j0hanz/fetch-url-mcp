import type {
  FetchUrlInput,
  JsonlTransformResult,
} from '../../config/types.js';

import { extractContent } from '../../services/extractor.js';
import { logDebug, logError } from '../../services/logger.js';
import { parseHtml } from '../../services/parser.js';

import {
  createToolErrorResponse,
  handleToolError,
} from '../../utils/tool-error-handler.js';
import {
  buildMetadata,
  shouldUseArticle,
  truncateContent,
} from '../utils/common.js';
import { executeFetchPipeline } from '../utils/fetch-pipeline.js';

import { toJsonl } from '../../transformers/jsonl.transformer.js';

export const FETCH_URL_TOOL_NAME = 'fetch-url';
export const FETCH_URL_TOOL_DESCRIPTION =
  'Fetches a webpage and converts it to AI-readable JSONL format with semantic content blocks. Supports custom headers, retries, and content length limits.';

function transformToJsonl(
  html: string,
  url: string,
  options: { extractMainContent: boolean; includeMetadata: boolean }
): JsonlTransformResult {
  // Only invoke JSDOM when extractMainContent is true (lazy loading optimization)
  const { article, metadata: extractedMeta } = extractContent(html, url, {
    extractArticle: options.extractMainContent,
  });
  const useArticle = shouldUseArticle(options.extractMainContent, article);
  const sourceHtml = useArticle ? article.content : html;
  const contentBlocks = parseHtml(sourceHtml);
  const metadata = buildMetadata(
    url,
    article,
    extractedMeta,
    useArticle,
    options.includeMetadata
  );
  const title = useArticle ? article.title : extractedMeta.title;

  return {
    content: toJsonl(contentBlocks, metadata),
    contentBlocks: contentBlocks.length,
    title,
  };
}

export async function fetchUrlToolHandler(input: FetchUrlInput) {
  if (!input.url) {
    return createToolErrorResponse('URL is required', '', 'VALIDATION_ERROR');
  }

  try {
    const extractMainContent = input.extractMainContent ?? true;
    const includeMetadata = input.includeMetadata ?? true;

    logDebug('Fetching URL', {
      url: input.url,
      extractMainContent,
      includeMetadata,
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
        contentBlocks: 0,
        title: undefined,
      }),
    });

    const { content, truncated } = truncateContent(
      result.data.content,
      input.maxContentLength
    );

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
          text: JSON.stringify(
            structuredContent,
            result.fromCache ? undefined : null,
            result.fromCache ? undefined : 2
          ),
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
