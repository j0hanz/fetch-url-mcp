import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import type { ExtractedArticle } from '../types/index.js';
import { logError, logWarn } from './logger.js';

// Maximum HTML size to process (10MB)
const MAX_HTML_SIZE = 10 * 1024 * 1024;

/** Metadata extracted from HTML document (internal) */
interface ExtractedMetadata {
  title?: string | undefined;
  description?: string | undefined;
  author?: string | undefined;
}

/** Combined extraction result (internal) */
interface ExtractionResult {
  article: ExtractedArticle | null;
  metadata: ExtractedMetadata;
}

function getMetaContent(
  document: Document,
  selectors: string[]
): string | undefined {
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
    ]) ??
    document.querySelector('title')?.textContent ??
    undefined;

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
function extractArticleFromDocument(
  document: Document
): ExtractedArticle | null {
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
 * @param html - HTML string to extract content from
 * @param url - URL of the page (used for resolving relative links)
 * @returns Extraction result with article and metadata
 */
export function extractContent(html: string, url: string): ExtractionResult {
  // Input validation
  if (!html || typeof html !== 'string') {
    logWarn('extractContent called with invalid HTML input');
    return { article: null, metadata: {} };
  }

  if (!url || typeof url !== 'string') {
    logWarn('extractContent called with invalid URL');
    return { article: null, metadata: {} };
  }

  // Size validation to prevent memory issues
  let processedHtml = html;
  if (html.length > MAX_HTML_SIZE) {
    logWarn('HTML content exceeds maximum size for extraction, truncating', {
      size: html.length,
      maxSize: MAX_HTML_SIZE,
    });
    processedHtml = html.substring(0, MAX_HTML_SIZE);
  }

  try {
    const dom = new JSDOM(processedHtml, { url });
    const document = dom.window.document;

    // Extract metadata first (non-destructive)
    const metadata = extractMetadataFromDocument(document);

    // Extract article (uses cloned document since Readability mutates)
    const article = extractArticleFromDocument(document);

    return { article, metadata };
  } catch (error) {
    logError(
      'Failed to extract content',
      error instanceof Error ? error : undefined
    );
    return { article: null, metadata: {} };
  }
}
