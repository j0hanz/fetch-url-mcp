import { validateAndNormalizeUrl } from '../../utils/url-validator.js';
import { fetchUrlWithRetry } from '../../services/fetcher.js';
import { extractContent } from '../../services/extractor.js';
import { parseHtml } from '../../services/parser.js';
import { toJsonl } from '../../transformers/jsonl.transformer.js';
import * as cache from '../../services/cache.js';
import { config } from '../../config/index.js';
import { logError } from '../../services/logger.js';
import {
  createToolErrorResponse,
  handleToolError,
} from '../../utils/tool-error-handler.js';
import type {
  FetchUrlInput,
  MetadataBlock,
  ContentBlockUnion,
} from '../../types/index.js';

export const FETCH_URL_TOOL_NAME = 'fetch-url';
export const FETCH_URL_TOOL_DESCRIPTION =
  'Fetches a webpage and converts it to AI-readable JSONL format with semantic content blocks';

interface ExtractedContentResult {
  contentBlocks: ContentBlockUnion[];
  metadata: MetadataBlock | undefined;
  title: string | undefined;
}

function extractContentFromHtml(
  html: string,
  url: string,
  options: { extractMainContent: boolean; includeMetadata: boolean }
): ExtractedContentResult {
  // Use the optimized extractContent that parses JSDOM only once
  const { article, metadata: extractedMeta } = extractContent(html, url);

  if (
    options.extractMainContent &&
    config.extraction.extractMainContent &&
    article
  ) {
    const contentBlocks = parseHtml(article.content);
    const metadata =
      options.includeMetadata && config.extraction.includeMetadata
        ? {
            type: 'metadata' as const,
            title: article.title,
            author: article.byline,
            url,
            fetchedAt: new Date().toISOString(),
          }
        : undefined;

    return { contentBlocks, metadata, title: article.title };
  }

  // Fallback: use parsed HTML directly
  const contentBlocks = parseHtml(html);

  const metadata =
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

  return { contentBlocks, metadata, title: extractedMeta.title };
}

export async function fetchUrlToolHandler(input: FetchUrlInput) {
  try {
    // Validate URL input
    if (!input.url) {
      return createToolErrorResponse('URL is required', '', 'VALIDATION_ERROR');
    }

    const url = validateAndNormalizeUrl(input.url);
    const cacheKey = cache.createCacheKey('url', url);

    // Check cache first
    if (cacheKey) {
      const cached = cache.get(cacheKey);
      if (cached) {
        const structuredContent = {
          url,
          cached: true,
          fetchedAt: cached.fetchedAt,
          content: cached.content,
          format: 'jsonl' as const,
          contentBlocks: 0, // Unknown from cache
        };
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(structuredContent),
            },
          ],
          structuredContent,
        };
      }
    }

    const html = await fetchUrlWithRetry(url, input.customHeaders);

    // Validate HTML content was received
    if (!html) {
      return createToolErrorResponse(
        'No content received from URL',
        url,
        'EMPTY_CONTENT'
      );
    }

    const { contentBlocks, metadata, title } = extractContentFromHtml(
      html,
      url,
      {
        extractMainContent: input.extractMainContent ?? true,
        includeMetadata: input.includeMetadata ?? true,
      }
    );

    let jsonlContent = toJsonl(contentBlocks, metadata);

    if (
      input.maxContentLength &&
      input.maxContentLength > 0 &&
      jsonlContent.length > input.maxContentLength
    ) {
      jsonlContent =
        jsonlContent.substring(0, input.maxContentLength) + '\n...[truncated]';
    }

    // Cache the result
    if (cacheKey) {
      cache.set(cacheKey, jsonlContent);
    }

    const structuredContent = {
      url,
      title,
      contentBlocks: contentBlocks.length,
      fetchedAt: new Date().toISOString(),
      format: 'jsonl' as const,
      content: jsonlContent,
      cached: false,
    };

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(structuredContent, null, 2),
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
