import { config } from '../../config/index.js';
import type {
  ContentTransformOptions,
  FetchUrlInput,
  JsonlTransformResult,
  ToolResponseBase,
} from '../../config/types.js';

import * as cache from '../../services/cache.js';
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
import { htmlToMarkdown } from '../../transformers/markdown.transformer.js';

export const FETCH_URL_TOOL_NAME = 'fetch-url';
export const FETCH_URL_TOOL_DESCRIPTION =
  'Fetches a webpage and converts it to AI-readable JSONL format with semantic content blocks. Supports custom headers, retries, and content length limits.';

type ContentTransformOptionsWithLimits = ContentTransformOptions & {
  maxContentLength?: number;
};

function transformToJsonl(
  html: string,
  url: string,
  options: ContentTransformOptionsWithLimits
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

  const { content, truncated } = enforceContentLengthLimit(
    toJsonl(contentBlocks, metadata),
    options.maxContentLength
  );

  return {
    content,
    contentBlocks: contentBlocks.length,
    title,
    ...(truncated && { truncated }),
  };
}

function transformToMarkdown(
  html: string,
  url: string,
  options: ContentTransformOptionsWithLimits
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

  let markdown = htmlToMarkdown(sourceHtml, metadata);
  let truncated = false;
  if (options.maxContentLength && markdown.length > options.maxContentLength) {
    markdown = `${markdown.substring(0, options.maxContentLength)}\n\n...[truncated]`;
    truncated = true;
  }

  return {
    content: markdown,
    contentBlocks: contentBlocks.length,
    title,
    ...(truncated && { truncated }),
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
      cacheVary: {
        format,
        extractMainContent,
        includeMetadata,
        maxContentLength: input.maxContentLength,
      },
      transform: (html, url) =>
        format === 'markdown'
          ? transformToMarkdown(html, url, {
              extractMainContent,
              includeMetadata,
              maxContentLength: input.maxContentLength,
            })
          : transformToJsonl(html, url, {
              extractMainContent,
              includeMetadata,
              maxContentLength: input.maxContentLength,
            }),
    });

    const inlineLimit = config.constants.maxInlineContentChars;
    const contentSize = result.data.content.length;
    const shouldInline = contentSize <= inlineLimit;
    const resourceMimeType =
      format === 'markdown' ? 'text/markdown' : 'application/jsonl';
    const resourceUri =
      !shouldInline && config.cache.enabled && result.cacheKey
        ? cache.toResourceUri(result.cacheKey)
        : undefined;

    if (!shouldInline) {
      if (!resourceUri) {
        return createToolErrorResponse(
          `Content exceeds inline limit (${inlineLimit} chars) and cannot be cached`,
          input.url,
          'INTERNAL_ERROR'
        );
      }
    }

    const structuredContent = {
      url: result.url,
      title: result.data.title,
      contentBlocks: result.data.contentBlocks,
      fetchedAt: result.fetchedAt,
      format,
      contentSize,
      cached: result.fromCache,
      ...(result.data.truncated && { truncated: result.data.truncated }),
      ...(shouldInline ? { content: result.data.content } : {}),
      ...(resourceUri && {
        resourceUri,
        resourceMimeType,
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
        ...(resourceUri
          ? [
              {
                type: 'resource_link' as const,
                uri: resourceUri,
                name: 'Fetched content',
                mimeType: resourceMimeType,
                description: `Content exceeds inline limit (${inlineLimit} chars)`,
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
