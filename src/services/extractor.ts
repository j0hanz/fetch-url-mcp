import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import type { ExtractedArticle } from '../types/index.js';
import { logError } from './logger.js';

/**
 * Metadata extracted from HTML document
 */
export interface ExtractedMetadata {
  title?: string;
  description?: string;
  author?: string;
}

/**
 * Combined extraction result from a single JSDOM parse
 */
export interface ExtractionResult {
  article: ExtractedArticle | null;
  metadata: ExtractedMetadata;
}

function getMetaContent(document: Document, selectors: string[]): string | undefined {
  for (const selector of selectors) {
    const content = document.querySelector(selector)?.getAttribute('content');
    if (content) return content;
  }
  return undefined;
}

/**
 * Extracts metadata from a pre-parsed Document
 */
function extractMetadataFromDocument(document: Document): ExtractedMetadata {
  const title =
    getMetaContent(document, [
      'meta[property="og:title"]',
      'meta[name="twitter:title"]',
    ]) ?? document.querySelector('title')?.textContent ?? undefined;

  const description = getMetaContent(document, [
    'meta[property="og:description"]',
    'meta[name="twitter:description"]',
    'meta[name="description"]',
  ]);

  const author = getMetaContent(document, [
    'meta[name="author"]',
    'meta[property="article:author"]',
  ]);

  return { title, description, author };
}

/**
 * Extracts article content from a pre-parsed Document using Readability
 */
function extractArticleFromDocument(document: Document): ExtractedArticle | null {
  // Clone the document since Readability mutates it
  const clonedDoc = document.cloneNode(true) as Document;
  const reader = new Readability(clonedDoc);
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
}

/**
 * Extracts both article content and metadata from HTML in a single JSDOM parse.
 * This is more efficient than calling extractArticle and extractMetadata separately.
 */
export function extractContent(html: string, url: string): ExtractionResult {
  try {
    const dom = new JSDOM(html, { url });
    const document = dom.window.document;

    // Extract metadata first (non-destructive)
    const metadata = extractMetadataFromDocument(document);

    // Extract article (uses cloned document since Readability mutates)
    const article = extractArticleFromDocument(document);

    return { article, metadata };
  } catch (error) {
    logError('Failed to extract content', error instanceof Error ? error : undefined);
    return { article: null, metadata: {} };
  }
}

/**
 * Extracts main article content using Mozilla Readability
 * @deprecated Use extractContent() for better performance when you need both article and metadata
 */
export function extractArticle(html: string, url: string): ExtractedArticle | null {
  try {
    const dom = new JSDOM(html, { url });
    return extractArticleFromDocument(dom.window.document);
  } catch (error) {
    logError('Failed to extract article', error instanceof Error ? error : undefined);
    return null;
  }
}

/**
 * Extracts metadata from HTML
 * @deprecated Use extractContent() for better performance when you need both article and metadata
 */
export function extractMetadata(html: string): ExtractedMetadata {
  try {
    const { document } = new JSDOM(html).window;
    return extractMetadataFromDocument(document);
  } catch (error) {
    logError('Failed to extract metadata', error instanceof Error ? error : undefined);
    return {};
  }
}
