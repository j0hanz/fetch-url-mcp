import type {
  ContentTransformOptions,
  FetchUrlInput,
  JsonlTransformResult,
  ToolResponseBase,
} from '../../config/types.js';

import { extractContent } from '../../services/extractor.js';
import { logDebug, logError } from '../../services/logger.js';
import { parseHtml } from '../../services/parser.js';

import {
  createToolErrorResponse,
  handleToolError,
} from '../../utils/tool-error-handler.js';
import {
  createContentMetadataBlock,
  determineContentExtractionSource,
  enforceContentLengthLimit,
} from '../utils/common.js';
import { executeFetchPipeline } from '../utils/fetch-pipeline.js';

import { toJsonl } from '../../transformers/jsonl.transformer.js';

export const FETCH_URL_TOOL_NAME = 'fetch-url';
export const FETCH_URL_TOOL_DESCRIPTION =
  'Fetches a webpage and converts it to AI-readable JSONL format with semantic content blocks. Supports custom headers, retries, and content length limits.';

function transformToJsonl(
  html: string,
  url: string,
  options: ContentTransformOptions
): JsonlTransformResult {
  const { article, metadata: extractedMeta } = extractContent(html, url, {
    extractArticle: options.extractMainContent,
  });

  const shouldExtractFromArticle = determineContentExtractionSource(
    options.extractMainContent,
    article
  );

  const sourceHtml = shouldExtractFromArticle ? article.content : html;
  const contentBlocks = parseHtml(sourceHtml);

  const metadata = createContentMetadataBlock(
    url,
    article,
    extractedMeta,
    shouldExtractFromArticle,
    options.includeMetadata
  );

  const title = shouldExtractFromArticle ? article.title : extractedMeta.title;

  return {
    content: toJsonl(contentBlocks, metadata),
    contentBlocks: contentBlocks.length,
    title,
  };
}

export async function fetchUrlToolHandler(
  input: FetchUrlInput
): Promise<ToolResponseBase> {
  if (!input.url) {
    return createToolErrorResponse('URL is required', '', 'VALIDATION_ERROR');
  }

  const extractMainContent = input.extractMainContent ?? true;
  const includeMetadata = input.includeMetadata ?? true;

  logDebug('Fetching URL', {
    url: input.url,
    extractMainContent,
    includeMetadata,
  });

  try {
    const result = await executeFetchPipeline<JsonlTransformResult>({
      url: input.url,
      cacheNamespace: 'url',
      customHeaders: input.customHeaders,
      retries: input.retries,
      transform: (html, url) =>
        transformToJsonl(html, url, { extractMainContent, includeMetadata }),
      serialize: (data) =>
        enforceContentLengthLimit(data.content, input.maxContentLength).content,
      deserialize: (cached) => ({
        content: cached,
        contentBlocks: 0,
        title: undefined,
      }),
    });

    const { content, truncated } = enforceContentLengthLimit(
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

    const jsonOutput = JSON.stringify(
      structuredContent,
      result.fromCache ? undefined : null,
      result.fromCache ? undefined : 2
    );

    return {
      content: [{ type: 'text' as const, text: jsonOutput }],
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
