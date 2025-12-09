import { validateAndNormalizeUrl } from '../../utils/url-validator.js';
import { fetchUrlWithRetry } from '../../services/fetcher.js';
import { extractContent } from '../../services/extractor.js';
import { parseHtml } from '../../services/parser.js';
import { toJsonl } from '../../transformers/jsonl.transformer.js';
import * as cache from '../../services/cache.js';
import { config } from '../../config/index.js';
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

  if (options.extractMainContent && config.extraction.extractMainContent && article) {
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
    const url = validateAndNormalizeUrl(input.url);
    const cacheKey = cache.createCacheKey('url', url);

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
              content: cached.content,
            }),
          },
        ],
      };
    }

    const html = await fetchUrlWithRetry(url, input.customHeaders);

    const { contentBlocks, metadata, title } = extractContentFromHtml(html, url, {
      extractMainContent: input.extractMainContent ?? true,
      includeMetadata: input.includeMetadata ?? true,
    });

    let jsonlContent = toJsonl(contentBlocks, metadata);

    if (input.maxContentLength && jsonlContent.length > input.maxContentLength) {
      jsonlContent =
        jsonlContent.substring(0, input.maxContentLength) + '\n...[truncated]';
    }

    cache.set(cacheKey, jsonlContent);

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              url,
              title,
              contentBlocks: contentBlocks.length,
              fetchedAt: new Date().toISOString(),
              format: 'jsonl',
              content: jsonlContent,
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
            error: `Failed to fetch URL: ${error instanceof Error ? error.message : 'Unknown error'}`,
            url: input.url,
          }),
        },
      ],
      isError: true,
    };
  }
}
