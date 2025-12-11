import { isInternalUrl } from '../../utils/url-validator.js';
import * as cheerio from 'cheerio';
import { logError, logDebug } from '../../services/logger.js';
import {
  createToolErrorResponse,
  handleToolError,
} from '../../utils/tool-error-handler.js';
import { executeFetchPipeline } from '../utils/fetch-pipeline.js';
import type { FetchLinksInput, ExtractedLink } from '../../types/index.js';

export const FETCH_LINKS_TOOL_NAME = 'fetch-links';
export const FETCH_LINKS_TOOL_DESCRIPTION =
  'Extracts all hyperlinks from a webpage with anchor text and type classification. Supports filtering, image links, and link limits.';

interface LinksTransformResult {
  links: ExtractedLink[];
  linkCount: number;
  filtered: number;
  truncated: boolean;
}

interface ExtractLinksOptions {
  includeInternal: boolean;
  includeExternal: boolean;
  includeImages: boolean;
  maxLinks?: number | undefined;
  filterPattern?: RegExp | undefined;
}

/**
 * Extracts and classifies links from HTML
 */
function extractLinks(
  html: string,
  baseUrl: string,
  options: ExtractLinksOptions
): LinksTransformResult {
  const $ = cheerio.load(html);
  const links: ExtractedLink[] = [];
  const seenUrls = new Set<string>();
  let filtered = 0;

  // Extract anchor links
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

      // Apply filter pattern
      if (options.filterPattern && !options.filterPattern.test(absoluteUrl)) {
        filtered++;
        return;
      }

      const type = isInternalUrl(absoluteUrl, baseUrl)
        ? ('internal' as const)
        : ('external' as const);

      // Filter based on options
      if (type === 'internal' && !options.includeInternal) {
        filtered++;
        return;
      }
      if (type === 'external' && !options.includeExternal) {
        filtered++;
        return;
      }

      links.push({
        href: absoluteUrl,
        text: text || absoluteUrl,
        type,
      });
    } catch {
      // Skip invalid URLs silently
    }
  });

  // Extract image links if requested
  if (options.includeImages) {
    $('img[src]').each((_, element) => {
      const src = $(element).attr('src');
      const alt = $(element).attr('alt')?.trim() ?? '';

      if (!src || src.startsWith('data:')) {
        return;
      }

      try {
        const absoluteUrl = new URL(src, baseUrl).href;

        // Skip duplicates
        if (seenUrls.has(absoluteUrl)) {
          return;
        }
        seenUrls.add(absoluteUrl);

        // Apply filter pattern
        if (options.filterPattern && !options.filterPattern.test(absoluteUrl)) {
          filtered++;
          return;
        }

        links.push({
          href: absoluteUrl,
          text: alt || absoluteUrl,
          type: 'image' as const,
        });
      } catch {
        // Skip invalid URLs silently
      }
    });
  }

  // Apply maxLinks truncation
  let truncated = false;
  let resultLinks = links;
  if (options.maxLinks && links.length > options.maxLinks) {
    resultLinks = links.slice(0, options.maxLinks);
    truncated = true;
  }

  return {
    links: resultLinks,
    linkCount: resultLinks.length,
    filtered,
    truncated,
  };
}

export async function fetchLinksToolHandler(input: FetchLinksInput) {
  try {
    if (!input.url) {
      return createToolErrorResponse('URL is required', '', 'VALIDATION_ERROR');
    }

    const includeInternal = input.includeInternal ?? true;
    const includeExternal = input.includeExternal ?? true;
    const includeImages = input.includeImages ?? false;
    const maxLinks = input.maxLinks;

    // Parse filter pattern if provided
    let filterPattern: RegExp | undefined;
    if (input.filterPattern) {
      try {
        filterPattern = new RegExp(input.filterPattern, 'i');
      } catch {
        return createToolErrorResponse(
          `Invalid filter pattern: ${input.filterPattern}`,
          input.url,
          'VALIDATION_ERROR'
        );
      }
    }

    logDebug('Extracting links', {
      url: input.url,
      includeInternal,
      includeExternal,
      includeImages,
      maxLinks,
      filterPattern: input.filterPattern,
    });

    const result = await executeFetchPipeline<LinksTransformResult>({
      url: input.url,
      cacheNamespace: 'links',
      customHeaders: input.customHeaders,
      retries: input.retries,
      transform: (html, url) =>
        extractLinks(html, url, {
          includeInternal,
          includeExternal,
          includeImages,
          maxLinks,
          filterPattern,
        }),
    });

    const structuredContent = {
      url: result.url,
      linkCount: result.data.linkCount,
      links: result.data.links,
      ...(result.data.filtered > 0 && { filtered: result.data.filtered }),
      ...(result.data.truncated && { truncated: result.data.truncated }),
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
      'fetch-links tool error',
      error instanceof Error ? error : undefined
    );
    return handleToolError(error, input.url, 'Failed to extract links');
  }
}
