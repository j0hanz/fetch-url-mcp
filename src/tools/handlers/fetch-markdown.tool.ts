import { validateAndNormalizeUrl } from '../../utils/url-validator.js';
import { fetchUrlWithRetry } from '../../services/fetcher.js';
import { extractContent } from '../../services/extractor.js';
import { htmlToMarkdown } from '../../transformers/markdown.transformer.js';
import * as cache from '../../services/cache.js';
import { config } from '../../config/index.js';
import { logError } from '../../services/logger.js';
import {
  createToolErrorResponse,
  handleToolError,
} from '../../utils/tool-error-handler.js';
import type { FetchMarkdownInput } from '../../types/index.js';

export const FETCH_MARKDOWN_TOOL_NAME = 'fetch-markdown';
export const FETCH_MARKDOWN_TOOL_DESCRIPTION =
  'Fetches a webpage and converts it to clean Markdown format with optional frontmatter';

function extractAndConvertToMarkdown(
  html: string,
  url: string,
  options: { extractMainContent: boolean; includeMetadata: boolean }
): { markdown: string; title: string | undefined } {
  // Use the optimized extractContent that parses JSDOM only once
  const { article, metadata: extractedMeta } = extractContent(html, url);

  if (
    options.extractMainContent &&
    config.extraction.extractMainContent &&
    article
  ) {
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

    return {
      markdown: htmlToMarkdown(article.content, metadata),
      title: article.title,
    };
  }

  // Fallback: convert full HTML
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

  return {
    markdown: htmlToMarkdown(html, metadata),
    title: extractedMeta.title,
  };
}

export async function fetchMarkdownToolHandler(input: FetchMarkdownInput) {
  try {
    // Validate URL input
    if (!input.url) {
      return createToolErrorResponse('URL is required', '', 'VALIDATION_ERROR');
    }

    const url = validateAndNormalizeUrl(input.url);
    const cacheKey = cache.createCacheKey('markdown', url);

    // Check cache first
    if (cacheKey) {
      const cached = cache.get(cacheKey);
      if (cached) {
        const structuredContent = {
          url,
          cached: true,
          fetchedAt: cached.fetchedAt,
          markdown: cached.content,
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

    const html = await fetchUrlWithRetry(url);

    // Validate HTML content was received
    if (!html) {
      return createToolErrorResponse(
        'No content received from URL',
        url,
        'EMPTY_CONTENT'
      );
    }

    const { markdown, title } = extractAndConvertToMarkdown(html, url, {
      extractMainContent: input.extractMainContent ?? true,
      includeMetadata: input.includeMetadata ?? true,
    });

    // Cache the result
    if (cacheKey) {
      cache.set(cacheKey, markdown);
    }

    const structuredContent = {
      url,
      title,
      fetchedAt: new Date().toISOString(),
      markdown,
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
      'fetch-markdown tool error',
      error instanceof Error ? error : undefined
    );
    return handleToolError(error, input.url, 'Failed to fetch markdown');
  }
}
