import * as cheerio from 'cheerio';
import safeRegex from 'safe-regex';

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
import { appendHeaderVary } from '../utils/cache-vary.js';
import { executeFetchPipeline } from '../utils/fetch-pipeline.js';

export const FETCH_LINKS_TOOL_NAME = 'fetch-links';
export const FETCH_LINKS_TOOL_DESCRIPTION =
  'Extracts all hyperlinks from a webpage with anchor text and type classification. Supports filtering, image links, and link limits.';

function isToolResponseBase(value: unknown): value is ToolResponseBase {
  return (
    typeof value === 'object' &&
    value !== null &&
    'content' in value &&
    Array.isArray((value as ToolResponseBase).content)
  );
}

function resolveFilterPattern(
  pattern: string | undefined,
  url: string
): RegExp | undefined | ToolResponseBase {
  if (!pattern) return undefined;
  if (pattern.length > 200) {
    return createToolErrorResponse(
      'Filter pattern too long (max 200 characters)',
      url,
      'VALIDATION_ERROR'
    );
  }

  let filterPattern: RegExp;
  try {
    filterPattern = new RegExp(pattern, 'i');
  } catch {
    return createToolErrorResponse(
      `Invalid filter pattern: ${pattern}`,
      url,
      'VALIDATION_ERROR'
    );
  }

  if (!safeRegex(filterPattern)) {
    return createToolErrorResponse(
      'Filter pattern is unsafe (potential catastrophic backtracking)',
      url,
      'VALIDATION_ERROR'
    );
  }

  return filterPattern;
}

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

function tryAddLink(
  link: ExtractedLink,
  options: ExtractLinksOptions,
  seen: Set<string>
): { added: boolean; filtered: boolean } {
  if (!shouldIncludeLink(link.type, link.href, options, seen)) {
    return { added: false, filtered: !seen.has(link.href) };
  }

  seen.add(link.href);
  return { added: true, filtered: false };
}

function collectAnchorLinks(
  $: cheerio.CheerioAPI,
  baseUrl: string,
  options: ExtractLinksOptions,
  seen: Set<string>,
  links: ExtractedLink[]
): number {
  let filtered = 0;

  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href || href.startsWith('#') || href.startsWith('javascript:')) return;

    const url = tryResolveUrl(href, baseUrl);
    if (!url) return;

    const type: LinkType = isInternalUrl(url, baseUrl)
      ? 'internal'
      : 'external';

    const link: ExtractedLink = {
      href: url,
      text: $(el).text().trim() || url,
      type,
    };
    const result = tryAddLink(link, options, seen);
    if (result.filtered) filtered += 1;
    if (result.added) {
      links.push(link);
    }
  });

  return filtered;
}

function collectImageLinks(
  $: cheerio.CheerioAPI,
  baseUrl: string,
  options: ExtractLinksOptions,
  seen: Set<string>,
  links: ExtractedLink[]
): number {
  if (!options.includeImages) return 0;

  let filtered = 0;
  $('img[src]').each((_, el) => {
    const src = $(el).attr('src');
    if (!src || src.startsWith('data:')) return;

    const url = tryResolveUrl(src, baseUrl);
    if (!url) return;

    const link: ExtractedLink = {
      href: url,
      text: $(el).attr('alt')?.trim() ?? url,
      type: 'image',
    };

    const result = tryAddLink(link, options, seen);
    if (result.filtered) filtered += 1;
    if (result.added) {
      links.push(link);
    }
  });

  return filtered;
}

function extractLinks(
  html: string,
  baseUrl: string,
  options: ExtractLinksOptions
): LinksTransformResult {
  const $ = cheerio.load(html);
  const links: ExtractedLink[] = [];
  const seen = new Set<string>();

  let filtered = collectAnchorLinks($, baseUrl, options, seen, links);
  filtered += collectImageLinks($, baseUrl, options, seen, links);

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
  const filterPattern = resolveFilterPattern(input.filterPattern, input.url);
  if (isToolResponseBase(filterPattern)) {
    return filterPattern;
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
      cacheVary: appendHeaderVary(
        {
          includeInternal: options.includeInternal,
          includeExternal: options.includeExternal,
          includeImages: options.includeImages,
          maxLinks: options.maxLinks,
          filterPattern: input.filterPattern ?? null,
        },
        input.customHeaders
      ),
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
