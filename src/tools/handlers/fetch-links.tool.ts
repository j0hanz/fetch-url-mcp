import {
  validateAndNormalizeUrl,
  isInternalUrl,
} from '../../utils/url-validator.js';
import { fetchUrlWithRetry } from '../../services/fetcher.js';
import * as cache from '../../services/cache.js';
import * as cheerio from 'cheerio';
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

      const type = isInternalUrl(absoluteUrl, baseUrl) ? 'internal' : 'external';

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
    const url = validateAndNormalizeUrl(input.url);
    const cacheKey = cache.createCacheKey('links', url);

    const cached = cache.get(cacheKey);
    if (cached) {
      return {
        content: [{ type: 'text' as const, text: cached.content }],
      };
    }

    const html = await fetchUrlWithRetry(url);

    // Extract links
    const links = extractLinksFromHtml(html, url, {
      includeInternal: input.includeInternal ?? true,
      includeExternal: input.includeExternal ?? true,
    });

    const output = {
      url,
      linkCount: links.length,
      links,
    };

    const outputText = JSON.stringify(output, null, 2);

    cache.set(cacheKey, outputText);

    return {
      content: [{ type: 'text' as const, text: outputText }],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            error: `Failed to extract links: ${error instanceof Error ? error.message : 'Unknown error'}`,
            url: input.url,
          }),
        },
      ],
      isError: true,
    };
  }
}
