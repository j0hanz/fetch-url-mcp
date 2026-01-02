import { parseHTML } from 'linkedom';

import { Readability } from '@mozilla/readability';

import type {
  ExtractedArticle,
  ExtractedMetadata,
  ExtractionResult,
} from '../config/types/content.js';

import { getErrorMessage } from '../utils/error-utils.js';
import { truncateHtml } from '../utils/html-truncator.js';

import { logError, logInfo, logWarn } from './logger.js';
import {
  createMetaCollectorState,
  type MetaCollectorState,
  resolveMetaField,
} from './metadata-collector.js';

function collectMetaTag(state: MetaCollectorState, tag: HTMLMetaElement): void {
  const content = getMetaContent(tag);
  if (!content) return;

  if (collectOpenGraphMeta(state, tag, content)) return;
  if (collectTwitterMeta(state, tag, content)) return;
  collectStandardMeta(state, tag, content);
}

function getMetaContent(tag: HTMLMetaElement): string | null {
  return tag.getAttribute('content')?.trim() ?? null;
}

function collectOpenGraphMeta(
  state: MetaCollectorState,
  tag: HTMLMetaElement,
  content: string
): boolean {
  const property = tag.getAttribute('property');
  if (!property?.startsWith('og:')) return false;

  const key = property.replace('og:', '');
  if (key === 'title') state.title.og = content;
  if (key === 'description') state.description.og = content;
  return true;
}

function collectTwitterMeta(
  state: MetaCollectorState,
  tag: HTMLMetaElement,
  content: string
): boolean {
  const name = tag.getAttribute('name');
  if (!name?.startsWith('twitter:')) return false;

  const key = name.replace('twitter:', '');
  if (key === 'title') state.title.twitter = content;
  if (key === 'description') state.description.twitter = content;
  return true;
}

function collectStandardMeta(
  state: MetaCollectorState,
  tag: HTMLMetaElement,
  content: string
): void {
  const name = tag.getAttribute('name');
  if (name === 'description') {
    state.description.standard = content;
  }

  if (name === 'author') {
    state.author.standard = content;
  }
}

function scanMetaTags(document: Document, state: MetaCollectorState): void {
  const metaTags = document.querySelectorAll('meta');
  for (const tag of metaTags) {
    collectMetaTag(state, tag);
  }
}

function ensureTitleFallback(
  document: Document,
  state: MetaCollectorState
): void {
  if (state.title.standard) return;
  const titleEl = document.querySelector('title');
  if (titleEl?.textContent) {
    state.title.standard = titleEl.textContent.trim();
  }
}

function extractMetadata(document: Document): ExtractedMetadata {
  const state = createMetaCollectorState();

  scanMetaTags(document, state);
  ensureTitleFallback(document, state);

  const metadata: ExtractedMetadata = {};
  const title = resolveMetaField(state, 'title');
  const description = resolveMetaField(state, 'description');
  const author = resolveMetaField(state, 'author');

  if (title !== undefined) metadata.title = title;
  if (description !== undefined) metadata.description = description;
  if (author !== undefined) metadata.author = author;

  return metadata;
}

function isReadabilityCompatible(doc: unknown): doc is Document {
  if (!doc || typeof doc !== 'object') return false;
  if (!('documentElement' in doc)) return false;
  if (!('querySelectorAll' in doc)) return false;
  if (!('querySelector' in doc)) return false;
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
    const processedHtml = truncateHtml(html);
    const { document } = parseHTML(processedHtml);

    applyBaseUri(document, url);

    const metadata = extractMetadata(document);
    const article = options.extractArticle ? extractArticle(document) : null;

    return { article, metadata };
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
