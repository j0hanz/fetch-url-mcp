import { parseHTML } from 'linkedom';

import { Readability } from '@mozilla/readability';

import type {
  ExtractedArticle,
  ExtractedMetadata,
  ExtractionResult,
} from '../config/types.js';

import { truncateHtml } from '../utils/html-truncator.js';

import { logError, logWarn } from './logger.js';

type MetaSource = 'og' | 'twitter' | 'standard';
type MetaField = keyof ExtractedMetadata;

interface MetaCollectorState {
  title: Partial<Record<MetaSource, string>>;
  description: Partial<Record<MetaSource, string>>;
  author: Partial<Record<MetaSource, string>>;
}

function resolveMetaField(
  state: MetaCollectorState,
  field: MetaField
): string | undefined {
  const sources = state[field];
  return sources.og ?? sources.twitter ?? sources.standard;
}

function createMetaCollectorState(): MetaCollectorState {
  return {
    title: {},
    description: {},
    author: {},
  };
}

function collectMetaTag(state: MetaCollectorState, tag: HTMLMetaElement): void {
  const name = tag.getAttribute('name');
  const property = tag.getAttribute('property');
  const content = tag.getAttribute('content')?.trim();

  if (!content) return;

  if (property?.startsWith('og:')) {
    const key = property.replace('og:', '');
    if (key === 'title') state.title.og = content;
    if (key === 'description') state.description.og = content;
    return;
  }

  if (name?.startsWith('twitter:')) {
    const key = name.replace('twitter:', '');
    if (key === 'title') state.title.twitter = content;
    if (key === 'description') state.description.twitter = content;
    return;
  }

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

  return {
    title: resolveMetaField(state, 'title'),
    description: resolveMetaField(state, 'description'),
    author: resolveMetaField(state, 'author'),
  };
}

function extractArticle(document: Document): ExtractedArticle | null {
  try {
    const reader = new Readability(document as unknown as Document);
    const parsed = reader.parse();

    if (!parsed) return null;

    return {
      title: parsed.title ?? undefined,
      byline: parsed.byline ?? undefined,
      content: parsed.content ?? '',
      textContent: parsed.textContent ?? '',
      excerpt: parsed.excerpt ?? undefined,
      siteName: parsed.siteName ?? undefined,
    };
  } catch (error) {
    logError(
      'Failed to extract article with Readability',
      error instanceof Error ? error : undefined
    );
    return null;
  }
}

export function extractContent(
  html: string,
  url: string,
  options: { extractArticle?: boolean } = { extractArticle: true }
): ExtractionResult {
  if (!isValidInput(html, url)) {
    return { article: null, metadata: {} };
  }

  try {
    const processedHtml = truncateHtml(html);
    const { document } = parseHTML(processedHtml);

    applyBaseUri(document, url);

    const metadata = extractMetadata(document as unknown as Document);
    const article = options.extractArticle
      ? extractArticle(document as unknown as Document)
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
  } catch {
    // Ignore errors in setting baseURI
  }
}
