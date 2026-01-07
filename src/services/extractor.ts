import { parseHTML } from 'linkedom';

import { Readability } from '@mozilla/readability';

import type {
  ExtractedArticle,
  ExtractionResult,
} from '../config/types/content.js';

import { getErrorMessage } from '../utils/error-utils.js';
import { isRecord } from '../utils/guards.js';
import { truncateHtml } from '../utils/html-truncator.js';

import { logError, logInfo, logWarn } from './logger.js';
import { extractMetadata } from './metadata-collector.js';

function isReadabilityCompatible(doc: unknown): doc is Document {
  if (!isRecord(doc)) return false;
  if (!('documentElement' in doc)) return false;
  if (typeof doc.querySelectorAll !== 'function') return false;
  if (typeof doc.querySelector !== 'function') return false;
  return true;
}

function extractArticle(document: unknown): ExtractedArticle | null {
  if (!isReadabilityCompatible(document)) {
    logWarn('Document not compatible with Readability');
    return null;
  }
  const parsed = parseReadabilityArticle(document);
  return parsed ? mapReadabilityResult(parsed) : null;
}

function parseReadabilityArticle(
  document: Document
): ReturnType<Readability['parse']> | null {
  try {
    // Type assertion is safe here due to isReadabilityCompatible check
    const reader = new Readability(document);
    return reader.parse();
  } catch (error) {
    logError(
      'Failed to extract article with Readability',
      error instanceof Error ? error : undefined
    );
    return null;
  }
}

function mapReadabilityResult(
  parsed: NonNullable<ReturnType<Readability['parse']>>
): ExtractedArticle {
  const article: ExtractedArticle = {
    content: parsed.content ?? '',
    textContent: parsed.textContent ?? '',
  };

  const title = toOptional(parsed.title);
  if (title !== undefined) article.title = title;

  const byline = toOptional(parsed.byline);
  if (byline !== undefined) article.byline = byline;

  const excerpt = toOptional(parsed.excerpt);
  if (excerpt !== undefined) article.excerpt = excerpt;

  const siteName = toOptional(parsed.siteName);
  if (siteName !== undefined) article.siteName = siteName;

  return article;
}

function toOptional(value: string | null | undefined): string | undefined {
  return value ?? undefined;
}

export function extractContent(
  html: string,
  url: string,
  options: { extractArticle?: boolean } = { extractArticle: true }
): ExtractionResult {
  if (!isValidInput(html, url)) {
    return { article: null, metadata: {} };
  }

  return tryExtractContent(html, url, options);
}

function tryExtractContent(
  html: string,
  url: string,
  options: { extractArticle?: boolean }
): ExtractionResult {
  try {
    const { document } = parseHTML(truncateHtml(html));

    applyBaseUri(document, url);

    const metadata = extractMetadata(document);
    return {
      article: options.extractArticle ? extractArticle(document) : null,
      metadata,
    };
  } catch (error) {
    logError(
      'Failed to extract content',
      error instanceof Error ? error : undefined
    );
    return { article: null, metadata: {} };
  }
}

function isValidInput(html: string, url: string): boolean {
  if (!html || typeof html !== 'string') {
    logWarn('extractContent called with invalid HTML input');
    return false;
  }

  if (!url || typeof url !== 'string') {
    logWarn('extractContent called with invalid URL');
    return false;
  }

  return true;
}

function applyBaseUri(document: Document, url: string): void {
  try {
    Object.defineProperty(document, 'baseURI', {
      value: url,
      writable: true,
    });
  } catch (error) {
    logInfo('Failed to set baseURI (non-critical)', {
      url: url.substring(0, 100),
      error: getErrorMessage(error),
    });
  }
}
