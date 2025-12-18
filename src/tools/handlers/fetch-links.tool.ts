import * as cheerio from 'cheerio';

import type {
  ExtractedLink,
  ExtractLinksOptions,
  FetchLinksInput,
  LinksTransformResult,
  LinkType,
  ToolResponseBase,
} from '../../config/types.js';

import { logDebug, logError } from '../../services/logger.js';

import {
  createToolErrorResponse,
  handleToolError,
} from '../../utils/tool-error-handler.js';
import { isInternalUrl } from '../../utils/url-validator.js';
import { executeFetchPipeline } from '../utils/fetch-pipeline.js';

export const FETCH_LINKS_TOOL_NAME = 'fetch-links';
export const FETCH_LINKS_TOOL_DESCRIPTION =
  'Extracts all hyperlinks from a webpage with anchor text and type classification. Supports filtering, image links, and link limits.';

function tryResolveUrl(href: string, baseUrl: string): string | null {
  try {
    return new URL(href, baseUrl).href;
  } catch {
    return null;
  }
}

function shouldIncludeLink(
  type: LinkType,
  url: string,
  options: ExtractLinksOptions,
  seen: Set<string>
): boolean {
  if (seen.has(url)) return false;
  if (options.filterPattern && !options.filterPattern.test(url)) return false;
  if (type === 'internal' && !options.includeInternal) return false;
  if (type === 'external' && !options.includeExternal) return false;
  return true;
}

function extractLinks(
  html: string,
  baseUrl: string,
  options: ExtractLinksOptions
): LinksTransformResult {
  const $ = cheerio.load(html);
  const links: ExtractedLink[] = [];
  const seen = new Set<string>();
  let filtered = 0;

  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href || href.startsWith('#') || href.startsWith('javascript:')) return;

    const url = tryResolveUrl(href, baseUrl);
    if (!url) return;

    const type: LinkType = isInternalUrl(url, baseUrl)
      ? 'internal'
      : 'external';
    if (!shouldIncludeLink(type, url, options, seen)) {
      if (!seen.has(url)) filtered++;
      return;
    }

    seen.add(url);
    links.push({ href: url, text: $(el).text().trim() || url, type });
  });

  if (options.includeImages) {
    $('img[src]').each((_, el) => {
      const src = $(el).attr('src');
      if (!src || src.startsWith('data:')) return;

      const url = tryResolveUrl(src, baseUrl);
      if (!url) return;

      if (!shouldIncludeLink('image', url, options, seen)) {
        if (!seen.has(url)) filtered++;
        return;
      }

      seen.add(url);
      links.push({
        href: url,
        text: $(el).attr('alt')?.trim() ?? url,
        type: 'image',
      });
    });
  }

  const truncated = options.maxLinks ? links.length > options.maxLinks : false;
  const resultLinks = truncated ? links.slice(0, options.maxLinks) : links;

  return {
    links: resultLinks,
    linkCount: resultLinks.length,
    filtered,
    truncated,
  };
}

export async function fetchLinksToolHandler(
  input: FetchLinksInput
): Promise<ToolResponseBase> {
  if (!input.url) {
    return createToolErrorResponse('URL is required', '', 'VALIDATION_ERROR');
  }

  let filterPattern: RegExp | undefined;
  if (input.filterPattern) {
    if (input.filterPattern.length > 200) {
      return createToolErrorResponse(
        'Filter pattern too long (max 200 characters)',
        input.url,
        'VALIDATION_ERROR'
      );
    }
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

  try {
    const options: ExtractLinksOptions = {
      includeInternal: input.includeInternal ?? true,
      includeExternal: input.includeExternal ?? true,
      includeImages: input.includeImages ?? false,
      maxLinks: input.maxLinks,
      filterPattern,
    };

    logDebug('Extracting links', {
      url: input.url,
      ...options,
      filterPattern: input.filterPattern,
    });

    const result = await executeFetchPipeline<LinksTransformResult>({
      url: input.url,
      cacheNamespace: 'links',
      customHeaders: input.customHeaders,
      retries: input.retries,
      transform: (html, url) => extractLinks(html, url, options),
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
