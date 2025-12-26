import * as cheerio from 'cheerio';
import type { Element } from 'domhandler';
import safeRegex from 'safe-regex';

import type {
  ExtractedLink,
  ExtractLinksOptions,
  LinksTransformResult,
  LinkType,
  ToolResponseBase,
} from '../../../config/types.js';

import { createToolErrorResponse } from '../../../utils/tool-error-handler.js';
import { isInternalUrl } from '../../../utils/url-validator.js';

function isLinkAllowed(type: LinkType, options: ExtractLinksOptions): boolean {
  const allowed: Record<LinkType, boolean> = {
    internal: options.includeInternal,
    external: options.includeExternal,
    image: options.includeImages,
  };
  return allowed[type];
}

function matchesFilter(
  url: string,
  filterPattern: RegExp | undefined
): boolean {
  if (!filterPattern) return true;
  return filterPattern.test(url);
}

function evaluateLink(
  link: ExtractedLink,
  options: ExtractLinksOptions,
  seen: Set<string>
): { accepted: boolean; filtered: boolean } {
  if (seen.has(link.href)) {
    return { accepted: false, filtered: false };
  }

  if (!matchesFilter(link.href, options.filterPattern)) {
    return { accepted: false, filtered: true };
  }

  if (!isLinkAllowed(link.type, options)) {
    return { accepted: false, filtered: true };
  }

  return { accepted: true, filtered: false };
}

export function resolveFilterPattern(
  pattern: string | undefined,
  url: string
): RegExp | undefined | ToolResponseBase {
  if (!pattern) return undefined;

  const lengthError = validatePatternLength(pattern, url);
  if (lengthError) return lengthError;

  const filterPattern = buildFilterRegex(pattern, url);
  if (isToolResponseBase(filterPattern)) return filterPattern;

  const safetyError = validatePatternSafety(filterPattern, url);
  if (safetyError) return safetyError;

  return filterPattern;
}

function validatePatternLength(
  pattern: string,
  url: string
): ToolResponseBase | null {
  if (pattern.length <= 200) return null;
  return createToolErrorResponse(
    'Filter pattern too long (max 200 characters)',
    url,
    'VALIDATION_ERROR'
  );
}

function buildFilterRegex(
  pattern: string,
  url: string
): RegExp | ToolResponseBase {
  try {
    return new RegExp(pattern, 'i');
  } catch {
    return createToolErrorResponse(
      `Invalid filter pattern: ${pattern}`,
      url,
      'VALIDATION_ERROR'
    );
  }
}

function validatePatternSafety(
  pattern: RegExp,
  url: string
): ToolResponseBase | null {
  if (safeRegex(pattern)) return null;
  return createToolErrorResponse(
    'Filter pattern is unsafe (potential catastrophic backtracking)',
    url,
    'VALIDATION_ERROR'
  );
}

function isToolResponseBase(value: unknown): value is ToolResponseBase {
  return (
    value !== null &&
    typeof value === 'object' &&
    'content' in value &&
    Array.isArray((value as ToolResponseBase).content)
  );
}

function tryResolveUrl(href: string, baseUrl: string): string | null {
  if (!URL.canParse(href, baseUrl)) {
    return null;
  }
  return new URL(href, baseUrl).href;
}

function buildLinkType(url: string, baseUrl: string): LinkType {
  return isInternalUrl(url, baseUrl) ? 'internal' : 'external';
}

function isSkippableHref(href: string): boolean {
  return href.startsWith('#') || href.startsWith('javascript:');
}

function getAnchorHref($: cheerio.CheerioAPI, el: Element): string | null {
  const href = $(el).attr('href');
  if (!href) return null;
  if (isSkippableHref(href)) return null;
  return href;
}

function resolveAnchorLink(
  $: cheerio.CheerioAPI,
  el: Element,
  baseUrl: string
): ExtractedLink | null {
  const href = getAnchorHref($, el);
  if (!href) return null;

  const url = tryResolveUrl(href, baseUrl);
  if (!url) return null;

  return {
    href: url,
    text: $(el).text().trim() || url,
    type: buildLinkType(url, baseUrl),
  };
}

function resolveImageLink(
  $: cheerio.CheerioAPI,
  el: Element,
  baseUrl: string
): ExtractedLink | null {
  const src = $(el).attr('src');
  if (!src || src.startsWith('data:')) return null;

  const url = tryResolveUrl(src, baseUrl);
  if (!url) return null;

  return {
    href: url,
    text: $(el).attr('alt')?.trim() ?? url,
    type: 'image',
  };
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
    const link = resolveAnchorLink($, el, baseUrl);
    if (!link) return;

    const result = evaluateLink(link, options, seen);
    if (result.filtered) filtered += 1;
    if (!result.accepted) return;

    seen.add(link.href);
    links.push(link);
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
    const link = resolveImageLink($, el, baseUrl);
    if (!link) return;

    const result = evaluateLink(link, options, seen);
    if (result.filtered) filtered += 1;
    if (!result.accepted) return;

    seen.add(link.href);
    links.push(link);
  });

  return filtered;
}

export function extractLinks(
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
