import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import type {
  ExtractedArticle,
  ExtractedMetadata,
  ExtractionResult,
} from '../config/types.js';
import { logError, logWarn } from './logger.js';

const MAX_HTML_SIZE = 10 * 1024 * 1024;

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

function extractArticleFromDocument(
  document: Document
): ExtractedArticle | null {
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

export function extractContent(html: string, url: string): ExtractionResult {
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
    const dom = new JSDOM(processedHtml, { url });
    const document = dom.window.document;
    const metadata = extractMetadataFromDocument(document);
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
