import { validateAndNormalizeUrl } from '../../utils/url-validator.js';
import { fetchUrlWithRetry } from '../../services/fetcher.js';
import { extractContent } from '../../services/extractor.js';
import { htmlToMarkdown } from '../../transformers/markdown.transformer.js';
import * as cache from '../../services/cache.js';
import { config } from '../../config/index.js';
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
    const url = validateAndNormalizeUrl(input.url);
    const cacheKey = cache.createCacheKey('markdown', url);

    const cached = cache.get(cacheKey);
    if (cached) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              url,
              cached: true,
              fetchedAt: cached.fetchedAt,
              markdown: cached.content,
            }),
          },
        ],
      };
    }

    const html = await fetchUrlWithRetry(url);

    const { markdown, title } = extractAndConvertToMarkdown(html, url, {
      extractMainContent: input.extractMainContent ?? true,
      includeMetadata: input.includeMetadata ?? true,
    });

    cache.set(cacheKey, markdown);

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              url,
              title,
              fetchedAt: new Date().toISOString(),
              markdown,
              cached: false,
            },
            null,
            2
          ),
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            error: `Failed to fetch markdown: ${error instanceof Error ? error.message : 'Unknown error'}`,
            url: input.url,
          }),
        },
      ],
      isError: true,
    };
  }
}
