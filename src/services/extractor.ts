import * as cheerio from 'cheerio';
import type { CheerioAPI } from 'cheerio';
import { JSDOM, VirtualConsole } from 'jsdom';

import { Readability } from '@mozilla/readability';

import type {
  ExtractedArticle,
  ExtractedMetadata,
  ExtractionResult,
} from '../config/types.js';

import { preserveCardLinks } from './card-extractor.js';
import { logError, logWarn } from './logger.js';

const MAX_HTML_SIZE = 10 * 1024 * 1024;

/**
 * Extract metadata using Cheerio (fast, no full DOM)
 * This avoids JSDOM overhead for simple meta tag extraction
 */
export function extractMetadataWithCheerio($: CheerioAPI): ExtractedMetadata {
  const getMetaContent = (selectors: string[]): string | undefined => {
    for (const selector of selectors) {
      const content = $(selector).attr('content');
      if (content) return content;
    }
    return undefined;
  };

  const title =
    getMetaContent([
      'meta[property="og:title"]',
      'meta[name="twitter:title"]',
    ]) ??
    ($('title').text() || undefined);

  const description = getMetaContent([
    'meta[property="og:description"]',
    'meta[name="twitter:description"]',
    'meta[name="description"]',
  ]);

  const author = getMetaContent([
    'meta[name="author"]',
    'meta[property="article:author"]',
  ]);

  return { title, description, author };
}

/**
 * Extract article content using JSDOM + Readability
 * Only called when extractMainContent is true (lazy loading)
 */
function extractArticleWithJsdom(
  html: string,
  url: string
): ExtractedArticle | null {
  try {
    // virtualConsole suppresses CSS parsing warnings from modern CSS features
    const virtualConsole = new VirtualConsole();
    const dom = new JSDOM(html, { url, virtualConsole });
    const { document } = dom.window;

    preserveCardLinks(document);
    const reader = new Readability(document);
    const article = reader.parse();

    if (!article) return null;

    return {
      title: article.title ?? undefined,
      byline: article.byline ?? undefined,
      content: article.content ?? '',
      textContent: article.textContent ?? '',
      excerpt: article.excerpt ?? undefined,
      siteName: article.siteName ?? undefined,
    };
  } catch (error) {
    logError(
      'Failed to extract article with JSDOM',
      error instanceof Error ? error : undefined
    );
    return null;
  }
}

/**
 * Main extraction function - uses Cheerio for metadata (fast)
 * and lazy-loads JSDOM only when article extraction is needed
 */
export function extractContent(
  html: string,
  url: string,
  options: { extractArticle?: boolean } = { extractArticle: true }
): ExtractionResult {
  if (!html || typeof html !== 'string') {
    logWarn('extractContent called with invalid HTML input');
    return { article: null, metadata: {} };
  }

  if (!url || typeof url !== 'string') {
    logWarn('extractContent called with invalid URL');
    return { article: null, metadata: {} };
  }

  let processedHtml = html;
  if (html.length > MAX_HTML_SIZE) {
    logWarn('HTML content exceeds maximum size for extraction, truncating', {
      size: html.length,
      maxSize: MAX_HTML_SIZE,
    });
    processedHtml = html.substring(0, MAX_HTML_SIZE);
  }

  try {
    // Fast path: Extract metadata with Cheerio (no full DOM parsing)
    const $ = cheerio.load(processedHtml);
    const metadata = extractMetadataWithCheerio($);

    // Lazy path: Only use JSDOM when article extraction is requested
    const article = options.extractArticle
      ? extractArticleWithJsdom(processedHtml, url)
      : null;

    return { article, metadata };
  } catch (error) {
    logError(
      'Failed to extract content',
      error instanceof Error ? error : undefined
    );
    return { article: null, metadata: {} };
  }
}
