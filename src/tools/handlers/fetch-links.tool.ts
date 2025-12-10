import {
  validateAndNormalizeUrl,
  isInternalUrl,
} from '../../utils/url-validator.js';
import { fetchUrlWithRetry } from '../../services/fetcher.js';
import * as cache from '../../services/cache.js';
import * as cheerio from 'cheerio';
import { logError } from '../../services/logger.js';
import {
  createToolErrorResponse,
  handleToolError,
} from '../../utils/tool-error-handler.js';
import type { FetchLinksInput, ExtractedLink } from '../../types/index.js';

export const FETCH_LINKS_TOOL_NAME = 'fetch-links';
export const FETCH_LINKS_TOOL_DESCRIPTION =
  'Extracts all hyperlinks from a webpage with anchor text and type classification';

/**
 * Extracts links from HTML, filtering by type and deduplicating
 */
function extractLinksFromHtml(
  html: string,
  baseUrl: string,
  options: { includeInternal: boolean; includeExternal: boolean }
): ExtractedLink[] {
  const $ = cheerio.load(html);
  const links: ExtractedLink[] = [];
  const seenUrls = new Set<string>();

  $('a[href]').each((_, element) => {
    const href = $(element).attr('href');
    const text = $(element).text().trim();

    // Skip invalid hrefs
    if (!href || href.startsWith('#') || href.startsWith('javascript:')) {
      return;
    }

    try {
      const absoluteUrl = new URL(href, baseUrl).href;

      // Skip duplicates
      if (seenUrls.has(absoluteUrl)) {
        return;
      }
      seenUrls.add(absoluteUrl);

      const type = isInternalUrl(absoluteUrl, baseUrl)
        ? 'internal'
        : 'external';

      // Filter based on options
      if (type === 'internal' && !options.includeInternal) return;
      if (type === 'external' && !options.includeExternal) return;

      links.push({
        href: absoluteUrl,
        text: text || absoluteUrl,
        type,
      });
    } catch {
      // Skip invalid URLs silently
    }
  });

  return links;
}

/**
 * Tool handler for extracting links from a URL
 */
export async function fetchLinksToolHandler(input: FetchLinksInput) {
  try {
    // Validate URL input
    if (!input.url) {
      return createToolErrorResponse('URL is required', '', 'VALIDATION_ERROR');
    }

    const url = validateAndNormalizeUrl(input.url);
    const cacheKey = cache.createCacheKey('links', url);

    // Check cache first
    if (cacheKey) {
      const cached = cache.get(cacheKey);
      if (cached) {
        // Parse the cached content to return as structuredContent
        try {
          const structuredContent = JSON.parse(cached.content) as {
            url: string;
            linkCount: number;
            links: ExtractedLink[];
          };
          return {
            content: [{ type: 'text' as const, text: cached.content }],
            structuredContent,
          };
        } catch {
          return {
            content: [{ type: 'text' as const, text: cached.content }],
          };
        }
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

    // Extract links
    const links = extractLinksFromHtml(html, url, {
      includeInternal: input.includeInternal ?? true,
      includeExternal: input.includeExternal ?? true,
    });

    const structuredContent = {
      url,
      linkCount: links.length,
      links,
    };

    const outputText = JSON.stringify(structuredContent, null, 2);

    // Cache the result
    if (cacheKey) {
      cache.set(cacheKey, outputText);
    }

    return {
      content: [{ type: 'text' as const, text: outputText }],
      structuredContent,
    };
  } catch (error) {
    logError(
      'fetch-links tool error',
      error instanceof Error ? error : undefined
    );
    return handleToolError(error, input.url, 'Failed to extract links');
  }
}
