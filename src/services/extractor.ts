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
  return hasDocumentElement(doc) && hasQuerySelectors(doc);
}

function hasDocumentElement(record: Record<string, unknown>): boolean {
  return 'documentElement' in record;
}

function hasQuerySelectors(record: Record<string, unknown>): boolean {
  return (
    typeof record.querySelectorAll === 'function' &&
    typeof record.querySelector === 'function'
  );
}

function extractArticle(document: unknown): ExtractedArticle | null {
  if (!isReadabilityCompatible(document)) {
    logWarn('Document not compatible with Readability');
    return null;
  }
  return mapParsedArticle(parseReadabilityArticle(document));
}

function parseReadabilityArticle(
  document: Document
): ReturnType<Readability['parse']> | null {
  try {
    // Type assertion is safe here due to isReadabilityCompatible check
    const reader = new Readability(document);
    return reader.parse();
  } catch (error) {
    logError('Failed to extract article with Readability', asError(error));
    return null;
  }
}

function asError(error: unknown): Error | undefined {
  if (error instanceof Error) {
    return error;
  }
  return undefined;
}

function mapParsedArticle(
  parsed: ReturnType<Readability['parse']> | null
): ExtractedArticle | null {
  return parsed ? mapReadabilityResult(parsed) : null;
}

function mapReadabilityResult(
  parsed: NonNullable<ReturnType<Readability['parse']>>
): ExtractedArticle {
  return {
    content: parsed.content ?? '',
    textContent: parsed.textContent ?? '',
    ...buildOptionalArticleFields(parsed),
  };
}

function buildOptionalArticleFields(
  parsed: NonNullable<ReturnType<Readability['parse']>>
): Partial<ExtractedArticle> {
  const optional: Partial<ExtractedArticle> = {};
  addOptionalField(optional, 'title', parsed.title);
  addOptionalField(optional, 'byline', parsed.byline);
  addOptionalField(optional, 'excerpt', parsed.excerpt);
  addOptionalField(optional, 'siteName', parsed.siteName);
  return optional;
}

function addOptionalField<Key extends keyof ExtractedArticle>(
  target: Partial<ExtractedArticle>,
  key: Key,
  value: ExtractedArticle[Key] | null | undefined
): void {
  if (value == null) return;
  target[key] = value;
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
      article: resolveArticleExtraction(document, options.extractArticle),
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
  return (
    validateRequiredString(
      html,
      'extractContent called with invalid HTML input'
    ) && validateRequiredString(url, 'extractContent called with invalid URL')
  );
}

function validateRequiredString(value: unknown, message: string): boolean {
  if (isNonEmptyString(value)) return true;
  logWarn(message);
  return false;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function resolveArticleExtraction(
  document: Document,
  shouldExtract: boolean | undefined
): ExtractedArticle | null {
  return shouldExtract ? extractArticle(document) : null;
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
