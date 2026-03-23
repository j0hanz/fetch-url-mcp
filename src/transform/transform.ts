import diagnosticsChannel from 'node:diagnostics_channel';

import { isProbablyReaderable, Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';

import { config } from '../lib/core.js';
import {
  getOperationId,
  getRequestId,
  logDebug,
  logError,
  logInfo,
  logWarn,
  redactUrl,
} from '../lib/core.js';
import {
  evaluateArticleContent,
  extractNoscriptImages,
  getVisibleTextLength,
  normalizeTabContent,
  prepareDocumentForMarkdown,
  removeNoiseFromHtml,
  serializeDocumentForMarkdown,
} from '../lib/dom-prep.js';
import { isRawTextContentUrl } from '../lib/http.js';
import {
  composeAbortSignal,
  FetchError,
  getErrorMessage,
  getUtf8ByteLength,
  isAsciiOnly,
  isObject,
  throwIfAborted,
  toError,
  trimDanglingTagFragment,
  truncateToUtf8Boundary,
} from '../lib/utils.js';

import { extractLanguageFromClassName } from './html-translators.js';
import { translateHtmlFragmentToMarkdown } from './html-translators.js';
import {
  addSourceToMarkdown,
  buildMetadataFooter,
  extractTitleFromRawMarkdown,
  isRawTextContent,
} from './metadata.js';
import {
  extractMetadata,
  extractMetadataFromHead,
  mergeMetadata,
  normalizeDocumentTitle,
} from './metadata.js';
import { supplementMarkdownFromNextFlight } from './next-flight.js';
import {
  isGithubRepositoryRootUrl,
  maybePrependSyntheticTitle,
  maybeStripGithubPrimaryHeading,
  normalizeSyntheticTitleToken,
  shouldPreferPrimaryHeadingTitle,
} from './title-policy.js';
import type {
  ExtractedArticle,
  ExtractedMetadata,
  ExtractionResult,
  MarkdownTransformResult,
  MetadataBlock,
  TransformOptions,
  TransformStageContext,
  TransformStageEvent,
} from './types.js';
import {
  getOrCreateWorkerPool,
  getWorkerPoolStats,
  shutdownWorkerPool,
} from './worker-pool.js';

function decodeInput(input: string | Uint8Array, encoding?: string): string {
  if (typeof input === 'string') return input;

  const normalizedEncoding = encoding?.trim().toLowerCase();

  if (
    !normalizedEncoding ||
    normalizedEncoding === 'utf-8' ||
    normalizedEncoding === 'utf8'
  ) {
    return new TextDecoder('utf-8').decode(input);
  }
  try {
    return new TextDecoder(normalizedEncoding, { fatal: true }).decode(input);
  } catch {
    return new TextDecoder('utf-8').decode(input);
  }
}

interface ExtractionContext extends ExtractionResult {
  document: Document;
  truncated?: boolean;
}

interface StageBudget {
  totalBudgetMs: number;
  elapsedMs: number;
}

function buildTransformSignal(signal?: AbortSignal): AbortSignal | undefined {
  return composeAbortSignal(signal, config.transform.timeoutMs);
}

class StageTracker {
  private readonly channel = diagnosticsChannel.channel(
    'fetch-url-mcp.transform'
  );

  start(
    url: string,
    stage: string,
    budget?: StageBudget
  ): TransformStageContext | null {
    if (this.shouldSkipTracking(budget)) return null;

    const remainingBudgetMs = budget
      ? budget.totalBudgetMs - budget.elapsedMs
      : undefined;

    const base: TransformStageContext = {
      stage,
      startTime: performance.now(),
      url: redactUrl(url),
    };

    if (remainingBudgetMs !== undefined && budget) {
      return {
        ...base,
        budgetMs: remainingBudgetMs,
        totalBudgetMs: budget.totalBudgetMs,
      };
    }

    return base;
  }

  end(
    context: TransformStageContext | null,
    options?: { truncated?: boolean }
  ): number {
    if (!context) return 0;

    const durationMs = performance.now() - context.startTime;
    const requestId = getRequestId();
    const operationId = getOperationId();

    if (context.totalBudgetMs !== undefined) {
      const warnThresholdMs =
        context.totalBudgetMs * config.transform.stageWarnRatio;
      if (durationMs > warnThresholdMs) {
        logWarn('Transform stage exceeded warning threshold', {
          stage: context.stage,
          durationMs: Math.round(durationMs),
          thresholdMs: Math.round(warnThresholdMs),
          url: context.url,
        });
      }
    }

    const event: TransformStageEvent = {
      v: 1,
      type: 'stage',
      stage: context.stage,
      durationMs,
      url: context.url,
      ...(requestId ? { requestId } : {}),
      ...(operationId ? { operationId } : {}),
      ...(options?.truncated !== undefined
        ? { truncated: options.truncated }
        : {}),
    };

    this.publish(event);
    return durationMs;
  }

  private checkBudget(url: string, stage: string, budget?: StageBudget): void {
    if (budget && budget.elapsedMs >= budget.totalBudgetMs) {
      throw new FetchError('Transform budget exhausted', url, 504, {
        reason: 'timeout',
        stage: `${stage}:budget_exhausted`,
        elapsedMs: budget.elapsedMs,
        totalBudgetMs: budget.totalBudgetMs,
      });
    }
  }

  run<T>(url: string, stage: string, fn: () => T, budget?: StageBudget): T {
    if (this.shouldSkipTracking(budget)) {
      return fn();
    }

    this.checkBudget(url, stage, budget);

    const ctx = this.start(url, stage, budget);
    try {
      return fn();
    } finally {
      this.end(ctx);
    }
  }

  async runAsync<T>(
    url: string,
    stage: string,
    fn: () => Promise<T>,
    budget?: StageBudget
  ): Promise<T> {
    if (this.shouldSkipTracking(budget)) {
      return fn();
    }

    this.checkBudget(url, stage, budget);

    const ctx = this.start(url, stage, budget);
    try {
      return await fn();
    } finally {
      this.end(ctx);
    }
  }

  private shouldSkipTracking(budget?: StageBudget): boolean {
    return !this.channel.hasSubscribers && !budget;
  }

  private publish(event: TransformStageEvent): void {
    if (!this.channel.hasSubscribers) return;
    try {
      this.channel.publish(event);
    } catch (error: unknown) {
      logDebug('Diagnostic channel publish failed', {
        stage: event.stage,
        error: getErrorMessage(error),
      });
    }
  }
}

const stageTracker = new StageTracker();

export function startTransformStage(
  url: string,
  stage: string,
  budget?: StageBudget
): TransformStageContext | null {
  return stageTracker.start(url, stage, budget);
}

export function endTransformStage(
  context: TransformStageContext | null,
  options?: { truncated?: boolean }
): number {
  return stageTracker.end(context, options);
}

function truncateHtml(
  html: string,
  inputTruncated = false
): { html: string; truncated: boolean } {
  const maxSize = config.constants.maxHtmlSize;
  if (maxSize <= 0) return { html, truncated: false };

  if (html.length <= maxSize) {
    if (isAsciiOnly(html) && !inputTruncated) return { html, truncated: false };
    const byteLength = getUtf8ByteLength(html);
    if (byteLength <= maxSize && !inputTruncated)
      return { html, truncated: false };
  }

  const sliced = html.slice(0, maxSize);
  if (getUtf8ByteLength(sliced) <= maxSize) {
    return { html: trimDanglingTagFragment(sliced), truncated: true };
  }

  const content = truncateToUtf8Boundary(sliced, maxSize);

  logWarn('HTML content exceeds maximum size, truncating', {
    size: getUtf8ByteLength(html),
    maxSize,
    truncatedSize: getUtf8ByteLength(content),
  });
  return { html: content, truncated: true };
}

const MIN_SPA_CONTENT_LENGTH = 100;
const MIN_READERABLE_TEXT_LENGTH = 400;
const MAX_READABILITY_ELEMENTS = 20_000;

function isReadabilityCompatible(doc: unknown): doc is Document {
  if (!isObject(doc)) return false;
  const record = doc as Record<string, unknown>;
  return (
    'documentElement' in record &&
    typeof (record as { querySelectorAll?: unknown }).querySelectorAll ===
      'function' &&
    typeof (record as { querySelector?: unknown }).querySelector === 'function'
  );
}

function resolveCollapsedTextLengthUpTo(text: string, max: number): number {
  if (max <= 0) return 0;

  let length = 0;
  let seenNonWhitespace = false;
  let pendingSpace = false;

  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    const isWhitespace = code <= 0x20;

    if (isWhitespace) {
      if (seenNonWhitespace) pendingSpace = true;
      continue;
    }

    if (!seenNonWhitespace) {
      seenNonWhitespace = true;
    } else if (pendingSpace) {
      length += 1;
      pendingSpace = false;
      if (length >= max) return length;
    }

    length += 1;
    if (length >= max) return length;
  }

  return length;
}

function preserveGalleryImages(doc: Document): void {
  const galleries = doc.querySelectorAll(
    '[class*="gallery"],[class*="slideshow"],[class*="carousel"]'
  );
  for (const gallery of galleries) {
    const images = gallery.querySelectorAll('img');
    if (images.length === 0) continue;

    const fragment = doc.createDocumentFragment();
    for (const img of images) {
      const figure = doc.createElement('figure');
      figure.appendChild(img.cloneNode(true));
      fragment.appendChild(figure);
    }
    gallery.replaceWith(fragment);
  }
}

function preserveAlertElements(doc: Document): void {
  const alerts = doc.querySelectorAll(
    '[role="alert"], .admonition, [class*="callout"]'
  );
  for (const el of alerts) {
    const bq = doc.createElement('blockquote');
    bq.innerHTML = (el as HTMLElement).innerHTML;
    el.replaceWith(bq);
  }
}

function preserveCodeLanguageAttributes(doc: Document): void {
  for (const el of doc.querySelectorAll('pre, code')) {
    if (el.getAttribute('data-language')) continue;
    const lang = extractLanguageFromClassName(el.getAttribute('class') ?? '');
    if (lang) el.setAttribute('data-language', lang);
  }
}

function prepareReadabilityDocument(readabilityDoc: Document): void {
  extractNoscriptImages(readabilityDoc);
  preserveGalleryImages(readabilityDoc);
  preserveAlertElements(readabilityDoc);
  preserveCodeLanguageAttributes(readabilityDoc);
  normalizeTabContent(readabilityDoc);

  for (const el of readabilityDoc.querySelectorAll(
    '[class*="breadcrumb"],[class*="pagination"]'
  )) {
    if (el.tagName === 'HTML' || el.tagName === 'BODY') continue;
    el.remove();
  }
}

function validateReaderability(
  doc: Document,
  url: string,
  signal?: AbortSignal
): boolean {
  throwIfAborted(signal, url, 'extract:article:textCheck');

  const rawText =
    doc.querySelector('body')?.textContent ??
    (doc.documentElement.textContent as string | null | undefined) ??
    '';
  const textLength = resolveCollapsedTextLengthUpTo(
    rawText,
    MIN_READERABLE_TEXT_LENGTH + 1
  );

  if (textLength < MIN_SPA_CONTENT_LENGTH) {
    logWarn(
      'Very minimal server-rendered content detected (< 100 chars). ' +
        'This might be a client-side rendered (SPA) application. ' +
        'Content extraction may be incomplete.',
      { textLength }
    );
  }

  throwIfAborted(signal, url, 'extract:article:readabilityCheck');

  if (textLength >= MIN_READERABLE_TEXT_LENGTH && !isProbablyReaderable(doc)) {
    return false;
  }
  return true;
}

function invokeReadability(
  doc: Document,
  url: string,
  signal?: AbortSignal
): ReturnType<InstanceType<typeof Readability>['parse']> {
  throwIfAborted(signal, url, 'extract:article:clone');

  const readabilityDoc =
    typeof doc.cloneNode === 'function'
      ? (doc.cloneNode(true) as Document)
      : doc;

  prepareReadabilityDocument(readabilityDoc);

  throwIfAborted(signal, url, 'extract:article:parse');

  const reader = new Readability(readabilityDoc, {
    charThreshold: 140,
    maxElemsToParse: MAX_READABILITY_ELEMENTS,
    classesToPreserve: [
      'admonition',
      'callout',
      'custom-block',
      'alert',
      'note',
      'tip',
      'info',
      'warning',
      'danger',
      'caution',
      'important',
      'mermaid',
    ],
  });
  return reader.parse();
}

function mapReadabilityResult(
  parsed: NonNullable<ReturnType<InstanceType<typeof Readability>['parse']>>
): ExtractedArticle {
  return {
    content: (parsed.content as string | undefined) ?? '',
    textContent: (parsed.textContent as string | undefined) ?? '',
    ...(parsed.title != null && { title: parsed.title }),
    ...(parsed.byline != null && { byline: parsed.byline }),
    ...(parsed.excerpt != null && { excerpt: parsed.excerpt }),
    ...(parsed.siteName != null && { siteName: parsed.siteName }),
  };
}

// Pre-Readability cleanup on a cloned document.
// Must strip tabs/breadcrumbs before Readability mangles role attributes.
// The original document is NOT yet prepared (prepareDocumentForMarkdown
// runs later in buildContentSource), so this clone starts from raw HTML.
function extractArticle(
  document: unknown,
  url: string,
  signal?: AbortSignal
): ExtractedArticle | null {
  if (!isReadabilityCompatible(document)) {
    logWarn('Document not compatible with Readability');
    return null;
  }

  try {
    if (!validateReaderability(document, url, signal)) {
      return null;
    }

    const parsed = invokeReadability(document, url, signal);
    if (!parsed) return null;

    return mapReadabilityResult(parsed);
  } catch (error: unknown) {
    logError(
      'Failed to extract article with Readability',
      error instanceof Error ? error : undefined
    );
    return null;
  }
}

function isValidInput(html: string, url: string): boolean {
  if (typeof html !== 'string' || html.length === 0) {
    logWarn('extractContent called with invalid HTML input');
    return false;
  }
  if (typeof url !== 'string' || url.length === 0) {
    logWarn('extractContent called with invalid URL');
    return false;
  }
  return true;
}

function applyBaseUri(document: Document, url: string): void {
  try {
    Object.defineProperty(document, 'baseURI', { value: url, writable: true });
  } catch (error: unknown) {
    logInfo('Failed to set baseURI (non-critical)', {
      url: url.substring(0, 100),
      error: getErrorMessage(error),
    });
  }
}

function createEmptyExtractionContext(): ExtractionContext {
  const { document } = parseHTML('<html></html>');
  return { article: null, metadata: {}, document };
}

function extractEarlyMetadataIfNeeded(
  html: string,
  url: string
): ExtractedMetadata | null {
  const maxSize = config.constants.maxHtmlSize;
  if (maxSize <= 0) return null;

  if (
    html.length <= maxSize &&
    (isAsciiOnly(html) || getUtf8ByteLength(html) <= maxSize)
  ) {
    return null;
  }

  return stageTracker.run(url, 'extract:early-metadata', () =>
    extractMetadataFromHead(html, url)
  );
}

function parseExtractionDocument(
  html: string,
  url: string,
  inputTruncated?: boolean
): { document: Document; truncated: boolean } {
  const { html: limitedHtml, truncated } = truncateHtml(html, inputTruncated);
  const { document } = stageTracker.run(url, 'extract:parse', () =>
    parseHTML(limitedHtml)
  );
  return { document, truncated };
}

function extractMergedMetadata(
  html: string,
  url: string,
  document: Document
): ExtractedMetadata {
  const earlyMetadata = extractEarlyMetadataIfNeeded(html, url);
  const lateMetadata = stageTracker.run(url, 'extract:metadata', () =>
    extractMetadata(document, url)
  );
  return mergeMetadata(earlyMetadata, lateMetadata);
}

function extractArticleIfRequested(
  document: Document,
  url: string,
  options: {
    extractArticle?: boolean;
    signal?: AbortSignal | undefined;
  }
): ExtractedArticle | null {
  if (!options.extractArticle) return null;
  return stageTracker.run(url, 'extract:article', () =>
    extractArticle(document, url, options.signal)
  );
}

function extractContentContext(
  html: string,
  url: string,
  options: {
    extractArticle?: boolean;
    signal?: AbortSignal | undefined;
    inputTruncated?: boolean | undefined;
  }
): ExtractionContext {
  if (!isValidInput(html, url)) {
    return createEmptyExtractionContext();
  }

  try {
    throwIfAborted(options.signal, url, 'extract:begin');

    const { document, truncated } = parseExtractionDocument(
      html,
      url,
      options.inputTruncated
    );
    throwIfAborted(options.signal, url, 'extract:parsed');

    applyBaseUri(document, url);

    const metadata = extractMergedMetadata(html, url, document);
    throwIfAborted(options.signal, url, 'extract:metadata');

    const article = extractArticleIfRequested(document, url, options);

    throwIfAborted(options.signal, url, 'extract:article');

    return {
      article,
      metadata,
      document,
      ...(truncated ? { truncated: true } : {}),
    };
  } catch (error: unknown) {
    if (error instanceof FetchError) throw error;

    throwIfAborted(options.signal, url, 'extract:error');

    logError(
      'Failed to extract content',
      error instanceof Error ? error : undefined
    );

    return createEmptyExtractionContext();
  }
}

export function extractContent(
  html: string,
  url: string,
  options: { extractArticle?: boolean; signal?: AbortSignal } = {
    extractArticle: true,
  }
): ExtractionResult {
  const result = extractContentContext(html, url, options);
  return { article: result.article, metadata: result.metadata };
}

function resolveRelativeHref(
  href: string,
  baseUrl: string,
  origin: string
): string {
  const trimmedHref = href.trim();
  if (!trimmedHref || /[\t\n\f\r ]/.test(trimmedHref)) return href;
  if (isAbsoluteOrSpecialUrl(trimmedHref)) return trimmedHref;

  const resolved = URL.parse(trimmedHref, baseUrl);
  if (resolved) return resolved.href;
  if (trimmedHref.startsWith('/')) return `${origin}${trimmedHref}`;
  return trimmedHref;
}

function findBalancedCloseParen(text: string, start: number): number {
  let depth = 1;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === '(') {
      depth++;
    } else if (ch === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function findInlineLink(
  markdown: string,
  start: number
): {
  prefixStart: number;
  closeParen: number;
  prefix: string;
  href: string;
} | null {
  let searchFrom = start;

  while (searchFrom < markdown.length) {
    const openBracket = markdown.indexOf('[', searchFrom);
    if (openBracket === -1) return null;

    const closeBracket = markdown.indexOf(']', openBracket + 1);
    if (closeBracket === -1) return null;

    if (markdown[closeBracket + 1] !== '(') {
      searchFrom = closeBracket + 1;
      continue;
    }

    const closeParen = findBalancedCloseParen(markdown, closeBracket + 2);
    if (closeParen === -1) return null;

    const prefixStart =
      openBracket > 0 && markdown[openBracket - 1] === '!'
        ? openBracket - 1
        : openBracket;
    const prefix = markdown.slice(prefixStart, closeBracket + 1);
    const href = markdown.slice(closeBracket + 2, closeParen);

    return { prefixStart, closeParen, prefix, href };
  }

  return null;
}

function isAbsoluteOrSpecialUrl(href: string): boolean {
  const trimmedHref = href.trim();
  if (!trimmedHref) return false;
  if (trimmedHref.startsWith('#')) return true;
  return URL.canParse(trimmedHref);
}

function resolveRelativeUrlsInSegment(
  markdown: string,
  baseUrl: string,
  origin: string
): string {
  let cursor = 0;
  const parts: string[] = [];

  while (cursor < markdown.length) {
    const link = findInlineLink(markdown, cursor);
    if (!link) {
      parts.push(markdown.slice(cursor));
      break;
    }

    parts.push(markdown.slice(cursor, link.prefixStart));
    parts.push(
      `${link.prefix}(${resolveRelativeHref(link.href, baseUrl, origin)})`
    );

    cursor = link.closeParen + 1;
  }

  return parts.join('');
}

function resolveRelativeUrls(
  markdown: string,
  baseUrl: string,
  signal?: AbortSignal
): string {
  const parsedBase = URL.parse(baseUrl);
  if (!parsedBase) return markdown;
  const { origin } = parsedBase;

  if (!markdown) return markdown;

  return processFencedContent(markdown, (text) => {
    throwIfAborted(signal, baseUrl, 'markdown:resolve-urls');
    return resolveRelativeUrlsInSegment(text, baseUrl, origin);
  });
}

function translateHtmlToMarkdown(params: {
  html: string;
  url: string;
  signal?: AbortSignal | undefined;
  document?: Document | undefined;
  skipNoiseRemoval?: boolean | undefined;
}): string {
  const { html, url, signal, document, skipNoiseRemoval } = params;

  throwIfAborted(signal, url, 'markdown:begin');

  const cleanedHtml = skipNoiseRemoval
    ? html
    : stageTracker.run(url, 'markdown:noise', () =>
        removeNoiseFromHtml(html, document, url, signal)
      );

  throwIfAborted(signal, url, 'markdown:cleaned');

  const content = stageTracker.run(url, 'markdown:translate', () =>
    translateHtmlFragmentToMarkdown(cleanedHtml)
  );

  throwIfAborted(signal, url, 'markdown:translated');

  const cleaned = cleanupMarkdownArtifacts(
    content,
    signal
      ? { preserveEmptyHeadings: true, signal, url }
      : { preserveEmptyHeadings: true, url }
  );
  return url ? resolveRelativeUrls(cleaned, url, signal) : cleaned;
}

function appendMetadataFooter(
  content: string,
  metadata: MetadataBlock | undefined,
  url: string
): string {
  const footer = buildMetadataFooter(metadata, url);
  if (!content.trim() && footer) {
    const note =
      '> **Note:** This page contains no readable content. It may require JavaScript to render.\n\n';
    return `${note}${footer}`;
  }

  return footer ? `${content}\n\n${footer}` : content;
}

export function htmlToMarkdown(
  html: string,
  metadata?: MetadataBlock,
  options?: {
    url?: string;
    signal?: AbortSignal | undefined;
    document?: Document | undefined;
    skipNoiseRemoval?: boolean | undefined;
  }
): string {
  const url = options?.url ?? metadata?.url ?? '';
  if (!html) return buildMetadataFooter(metadata, url);

  try {
    const content = translateHtmlToMarkdown({
      html,
      url,
      signal: options?.signal,
      document: options?.document,
      skipNoiseRemoval: options?.skipNoiseRemoval,
    });

    return appendMetadataFooter(content, metadata, url);
  } catch (error: unknown) {
    if (error instanceof FetchError) throw error;

    logError(
      'Failed to convert HTML to markdown',
      error instanceof Error ? error : undefined
    );
    throw new FetchError('Failed to convert HTML to markdown', url, 500, {
      reason: 'markdown_convert_failed',
    });
  }
}

const HTML_DOCUMENT_START = /^\s*<(?:!doctype|html|head|body)\b/i;
const STRUCTURAL_HTML_TAGS =
  /<(?:html|head|body|div|p|span|section|article|main|nav|footer|header)\b/i;

function shouldPreserveRawContent(url: string, content: string): boolean {
  if (isRawTextContentUrl(url)) {
    return !HTML_DOCUMENT_START.test(content.trim());
  }
  if (!isRawTextContent(content)) return false;
  return !STRUCTURAL_HTML_TAGS.test(content);
}

function buildRawMarkdownPayload(params: {
  rawContent: string;
  url: string;
  includeMetadata: boolean;
}): { content: string; title: string | undefined } {
  const title = extractTitleFromRawMarkdown(params.rawContent);
  let content = params.includeMetadata
    ? addSourceToMarkdown(params.rawContent, params.url)
    : params.rawContent;

  if (params.url) {
    content = resolveRelativeUrls(content, params.url);
  }

  return { content, title };
}

function tryTransformRawContent(params: {
  html: string;
  url: string;
  includeMetadata: boolean;
  inputTruncated?: boolean | undefined;
}): MarkdownTransformResult | null {
  if (!shouldPreserveRawContent(params.url, params.html)) return null;

  logDebug('Preserving raw markdown content', {
    url: params.url.substring(0, 80),
  });

  const { content, title } = buildRawMarkdownPayload({
    rawContent: params.html,
    url: params.url,
    includeMetadata: params.includeMetadata,
  });

  return {
    markdown: content,
    title,
    truncated: params.inputTruncated ?? false,
  };
}

const MIN_CONTENT_RATIO = 0.15;
const MIN_HTML_LENGTH_FOR_GATE = 100;

export function isExtractionSufficient(
  article: ExtractedArticle | null,
  originalHtmlOrDocument: string | Document
): boolean {
  if (!article) return false;

  const articleLength = article.textContent.length;
  const originalLength = getVisibleTextLength(originalHtmlOrDocument);

  if (originalLength < MIN_HTML_LENGTH_FOR_GATE) return true;
  return articleLength / originalLength >= MIN_CONTENT_RATIO;
}

const MIN_CONTENT_ROOT_LENGTH = 100;
const BINARY_SAMPLE_SIZE = 2000;

export function determineContentExtractionSource(
  article: ExtractedArticle | null
): article is ExtractedArticle {
  return article !== null;
}

export function createContentMetadataBlock(
  url: string,
  article: ExtractedArticle | null,
  extractedMeta: ExtractedMetadata,
  shouldExtractFromArticle: boolean,
  includeMetadata: boolean
): MetadataBlock | undefined {
  if (!includeMetadata) return undefined;

  const metadata: MetadataBlock = {
    type: 'metadata',
    url,
    fetchedAt: new Date().toISOString(),
  };

  if (shouldExtractFromArticle && article) {
    if (article.title !== undefined) {
      metadata.title = normalizeDocumentTitle(article.title, url);
    }
    if (article.byline !== undefined) metadata.author = article.byline;
  } else {
    if (extractedMeta.title !== undefined) metadata.title = extractedMeta.title;
    if (extractedMeta.description !== undefined)
      metadata.description = extractedMeta.description;
    if (extractedMeta.author !== undefined)
      metadata.author = extractedMeta.author;
  }

  return metadata;
}

interface ContentSource {
  readonly sourceHtml: string;
  readonly originalHtml: string;
  readonly title: string | undefined;
  readonly primaryHeading: string | undefined;
  readonly suppressSyntheticFavicon?: boolean;
  readonly favicon: string | undefined;
  readonly metadata: ReturnType<typeof createContentMetadataBlock>;
  readonly extractedMetadata: ExtractedMetadata;
  readonly document?: Document;
  readonly skipNoiseRemoval?: boolean;
  readonly truncated: boolean;
}

function prepareContentSourceDocument(
  document: Document,
  url: string,
  signal?: AbortSignal
): { document: Document; primaryHeading: string | undefined } {
  const initialPrimaryHeading =
    TransformHeuristics.findPrimaryHeading(document);

  prepareDocumentForMarkdown(document, url, signal);

  return {
    document,
    primaryHeading:
      TransformHeuristics.findPrimaryHeading(document) ?? initialPrimaryHeading,
  };
}

function resolveContentTitle(params: {
  primaryHeading: string | undefined;
  title: string | undefined;
  preferPrimaryHeading: boolean;
}): Pick<ContentSource, 'title' | 'suppressSyntheticFavicon'> {
  const resolvedTitle =
    (params.preferPrimaryHeading ? params.primaryHeading : undefined) ??
    params.title;

  return {
    title: resolvedTitle,
    suppressSyntheticFavicon:
      normalizeSyntheticTitleToken(resolvedTitle) ===
      normalizeSyntheticTitleToken(params.primaryHeading),
  };
}

const CONTENT_ROOT_SELECTORS = [
  'article',
  'main',
  '[role="main"]',
  '#content',
  '#main-content',
  '.content',
  '.main-content',
  '.post-content',
  '.article-content',
  '.entry-content',
  '[itemprop="articleBody"]',
  '[data-content]',
  '.post-body',
  '.article-body',
] as const;

const PRIMARY_HEADING_ROOT_SELECTORS = [
  ...CONTENT_ROOT_SELECTORS,
  '.markdown-body',
  '.entry-content',
  '[itemprop="text"]',
] as const;

function findContentRoot(document: Document): string | undefined {
  for (const selector of CONTENT_ROOT_SELECTORS) {
    const element = document.querySelector(selector);
    if (!element) continue;

    const innerHTML =
      typeof (element as HTMLElement).innerHTML === 'string'
        ? (element as HTMLElement).innerHTML
        : undefined;

    if (innerHTML && innerHTML.trim().length > MIN_CONTENT_ROOT_LENGTH)
      return innerHTML;
  }
  return undefined;
}

const PRIMARY_HEADING_SELECTORS_GLOBAL = ['[data-title="true"]', 'h1'] as const;
const PRIMARY_HEADING_SELECTORS_LOCAL = [
  '[data-title="true"]',
  'h1',
  'h2',
] as const;

function extractHeadingText(
  root: ParentNode,
  selectors: readonly string[]
): string | undefined {
  for (const selector of selectors) {
    const heading = root.querySelector(selector);
    if (!heading) continue;
    const text = heading.textContent.trim();
    if (text) return text;
  }
  return undefined;
}

function findPrimaryHeading(document: Document): string | undefined {
  const globalHeading = extractHeadingText(
    document,
    PRIMARY_HEADING_SELECTORS_GLOBAL
  );
  if (globalHeading) return globalHeading;

  for (const selector of PRIMARY_HEADING_ROOT_SELECTORS) {
    const root = document.querySelector(selector);
    if (!root) continue;

    const localHeading = extractHeadingText(
      root,
      PRIMARY_HEADING_SELECTORS_LOCAL
    );
    if (localHeading) return localHeading;
  }

  return undefined;
}

const TransformHeuristics = {
  findContentRoot,
  findPrimaryHeading,
  isGithubRepositoryRootUrl,
} as const;

type BaseContentSource = Pick<
  ContentSource,
  | 'favicon'
  | 'metadata'
  | 'extractedMetadata'
  | 'truncated'
  | 'primaryHeading'
  | 'originalHtml'
>;

function buildArticleSource(
  base: BaseContentSource,
  params: {
    evaluatedArticleDoc: Document;
    article: ExtractedArticle;
    extractedMeta: ExtractedMetadata;
    url: string;
    signal?: AbortSignal | undefined;
  }
): ContentSource {
  const { evaluatedArticleDoc, article, extractedMeta, url, signal } = params;
  prepareDocumentForMarkdown(evaluatedArticleDoc, url, signal);
  const articleTitle =
    article.title !== undefined
      ? normalizeDocumentTitle(article.title, url)
      : extractedMeta.title;
  const title = resolveContentTitle({
    primaryHeading: base.primaryHeading,
    title: articleTitle,
    preferPrimaryHeading:
      TransformHeuristics.isGithubRepositoryRootUrl(url) ||
      shouldPreferPrimaryHeadingTitle(base.primaryHeading, articleTitle),
  });

  return {
    ...base,
    sourceHtml: evaluatedArticleDoc.body.innerHTML,
    ...title,
    skipNoiseRemoval: true,
  };
}

function buildDocumentSource(
  base: BaseContentSource,
  params: {
    resolvedDocument: Document;
    html: string;
    extractedMeta: ExtractedMetadata;
  }
): ContentSource {
  const { resolvedDocument, html, extractedMeta } = params;
  const contentRoot = TransformHeuristics.findContentRoot(resolvedDocument);
  const title = resolveContentTitle({
    primaryHeading: base.primaryHeading,
    title: extractedMeta.title,
    preferPrimaryHeading: shouldPreferPrimaryHeadingTitle(
      base.primaryHeading,
      extractedMeta.title
    ),
  });

  return {
    ...base,
    sourceHtml:
      contentRoot ?? serializeDocumentForMarkdown(resolvedDocument, html),
    ...title,
    skipNoiseRemoval: true,
    document: resolvedDocument,
  };
}

function buildRawSource(
  base: BaseContentSource,
  params: { html: string; extractedMeta: ExtractedMetadata }
): ContentSource {
  return {
    ...base,
    sourceHtml: params.html,
    title: params.extractedMeta.title,
  };
}

function buildContentSource(params: {
  html: string;
  url: string;
  article: ExtractedArticle | null;
  extractedMeta: ExtractedMetadata;
  includeMetadata: boolean;
  evaluatedArticleDoc: Document | null;
  document?: Document;
  truncated: boolean;
  signal?: AbortSignal | undefined;
}): ContentSource {
  const {
    html,
    url,
    article,
    extractedMeta,
    includeMetadata,
    evaluatedArticleDoc,
    document,
    truncated,
    signal,
  } = params;

  const useArticleContent = evaluatedArticleDoc !== null;
  const metadata = createContentMetadataBlock(
    url,
    article,
    extractedMeta,
    useArticleContent,
    includeMetadata
  );
  const preparedDocument = document
    ? prepareContentSourceDocument(document, url, signal)
    : undefined;
  const primaryHeading = preparedDocument?.primaryHeading;

  const base: BaseContentSource = {
    favicon: extractedMeta.favicon,
    metadata,
    extractedMetadata: extractedMeta,
    truncated,
    primaryHeading,
    originalHtml: html,
  };

  if (evaluatedArticleDoc && article) {
    return buildArticleSource(base, {
      evaluatedArticleDoc,
      article,
      extractedMeta,
      url,
      signal,
    });
  }

  if (preparedDocument) {
    return buildDocumentSource(base, {
      resolvedDocument: preparedDocument.document,
      html,
      extractedMeta,
    });
  }

  return buildRawSource(base, { html, extractedMeta });
}

function resolveContentSource(params: {
  html: string;
  url: string;
  includeMetadata: boolean;
  signal?: AbortSignal | undefined;
  inputTruncated?: boolean | undefined;
}): ContentSource {
  const {
    article,
    metadata: extractedMeta,
    document,
    truncated,
  } = extractContentContext(params.html, params.url, {
    extractArticle: true,
    signal: params.signal,
    inputTruncated: params.inputTruncated,
  });

  const evaluatedArticleDoc = article
    ? evaluateArticleContent(article, document)
    : null;

  return buildContentSource({
    html: params.html,
    url: params.url,
    article,
    extractedMeta,
    includeMetadata: params.includeMetadata,
    evaluatedArticleDoc,
    document,
    truncated: truncated ?? false,
    signal: params.signal,
  });
}

interface MarkdownRenderContext {
  readonly context: ContentSource;
  readonly url: string;
  readonly signal: AbortSignal | undefined;
}

interface RenderedMarkdownStage {
  readonly markdown: string;
  readonly title: string | undefined;
  readonly truncated: boolean;
  readonly metadata: ExtractedMetadata;
}

function renderMarkdownStage({
  context,
  url,
  signal,
}: MarkdownRenderContext): string {
  return stageTracker.run(url, 'transform:markdown', () =>
    htmlToMarkdown(context.sourceHtml, context.metadata, {
      url,
      signal,
      document: context.document,
      skipNoiseRemoval: context.skipNoiseRemoval,
    })
  );
}

function postprocessMarkdownStage(
  { context, url, signal }: MarkdownRenderContext,
  markdown: string
): RenderedMarkdownStage {
  let content = maybeStripGithubPrimaryHeading(
    markdown,
    context.primaryHeading,
    url
  );
  content = maybePrependSyntheticTitle(content, context, url);
  content = supplementMarkdownFromNextFlight(content, context.originalHtml);
  content = cleanupMarkdownArtifacts(
    content,
    signal ? { signal, url } : { url }
  );

  return {
    markdown: content,
    title: context.title,
    truncated: context.truncated,
    metadata: context.extractedMetadata,
  };
}

function buildMarkdownFromContext(
  context: ContentSource,
  url: string,
  signal?: AbortSignal
): MarkdownTransformResult {
  const renderContext = { context, url, signal };
  const markdown = renderMarkdownStage(renderContext);
  return postprocessMarkdownStage(renderContext, markdown);
}

function resolveTransformContentResult(
  html: string,
  url: string,
  options: TransformOptions,
  signal?: AbortSignal
): MarkdownTransformResult {
  const rawResult = stageTracker.run(url, 'transform:raw', () =>
    tryTransformRawContent({
      html,
      url,
      includeMetadata: options.includeMetadata,
      inputTruncated: options.inputTruncated,
    })
  );
  if (rawResult) return rawResult;

  const context = stageTracker.run(url, 'transform:extract', () =>
    resolveContentSource({
      html,
      url,
      includeMetadata: options.includeMetadata,
      signal,
      inputTruncated: options.inputTruncated,
    })
  );

  return buildMarkdownFromContext(context, url, signal);
}

function completeTrackedTransform<T extends { truncated?: boolean }>(
  totalStage: TransformStageContext | null,
  result: T
): T {
  stageTracker.end(
    totalStage,
    result.truncated !== undefined ? { truncated: result.truncated } : undefined
  );
  return result;
}

const REPLACEMENT_CHAR = '\ufffd';
const BINARY_INDICATOR_THRESHOLD = 0.1;

function hasBinaryIndicators(content: string): boolean {
  if (!content) return false;

  if (content.includes('\x00')) return true;

  const sampleSize = Math.min(content.length, BINARY_SAMPLE_SIZE);
  let replacementCount = 0;
  let i = -1;

  while (
    (i = content.indexOf(REPLACEMENT_CHAR, i + 1)) !== -1 &&
    i < sampleSize
  ) {
    replacementCount++;
  }

  return replacementCount > sampleSize * BINARY_INDICATOR_THRESHOLD;
}

export function transformHtmlToMarkdownInProcess(
  html: string,
  url: string,
  options: TransformOptions
): MarkdownTransformResult {
  const signal = buildTransformSignal(options.signal);
  const totalStage = stageTracker.start(url, 'transform:total');

  try {
    throwIfAborted(signal, url, 'transform:begin');

    validateBinaryContent(html, url);
    return completeTrackedTransform(
      totalStage,
      resolveTransformContentResult(html, url, options, signal)
    );
  } catch (error) {
    stageTracker.end(totalStage);
    throw error;
  }
}

function validateBinaryContent(html: string, url: string): void {
  if (hasBinaryIndicators(html)) {
    throw new FetchError(
      'Content appears to be binary data (high replacement character ratio or null bytes)',
      url,
      415,
      { reason: 'binary_content_detected', stage: 'transform:validate' }
    );
  }
}

interface TransformPoolStats {
  queueDepth: number;
  activeWorkers: number;
  capacity: number;
}

export function getTransformPoolStats(): TransformPoolStats | null {
  return getWorkerPoolStats();
}

export async function shutdownTransformWorkerPool(): Promise<void> {
  await shutdownWorkerPool();
}

type TransformExecutionOptions = TransformOptions & { encoding?: string };

function transformInputInProcess(
  htmlOrBuffer: string | Uint8Array,
  url: string,
  options: TransformExecutionOptions
): MarkdownTransformResult {
  return transformHtmlToMarkdownInProcess(
    decodeInput(htmlOrBuffer, options.encoding),
    url,
    options
  );
}

function workerTransformOptions(options: TransformOptions): {
  includeMetadata: boolean;
  signal?: AbortSignal;
  inputTruncated?: boolean;
} {
  return {
    includeMetadata: options.includeMetadata,
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.inputTruncated
      ? { inputTruncated: options.inputTruncated }
      : {}),
  };
}

async function transformWithWorkerPool(
  htmlOrBuffer: string | Uint8Array,
  url: string,
  options: TransformExecutionOptions
): Promise<MarkdownTransformResult> {
  const pool = getOrCreateWorkerPool();
  if (pool.getCapacity() === 0) {
    return transformInputInProcess(htmlOrBuffer, url, options);
  }

  if (typeof htmlOrBuffer === 'string') {
    return pool.transform(htmlOrBuffer, url, workerTransformOptions(options));
  }
  return pool.transform(htmlOrBuffer, url, {
    ...workerTransformOptions(options),
    ...(options.encoding ? { encoding: options.encoding } : {}),
  });
}

function resolveWorkerFallback(
  error: unknown,
  htmlOrBuffer: string | Uint8Array,
  url: string,
  options: TransformExecutionOptions
): MarkdownTransformResult {
  const isQueueFull =
    error instanceof FetchError && error.details['reason'] === 'queue_full';

  if (isQueueFull) {
    logWarn('Transform worker queue full; falling back to in-process', {
      url: redactUrl(url),
    });

    return transformInputInProcess(htmlOrBuffer, url, options);
  }

  throwIfAborted(options.signal, url, 'transform:worker-fallback');

  if (error instanceof FetchError) throw error;

  if (!(error instanceof Error)) throw toError(error);

  const message = getErrorMessage(error);
  logWarn('Transform worker failed; falling back to in-process', {
    url: redactUrl(url),
    error: message,
  });

  return transformInputInProcess(htmlOrBuffer, url, options);
}

async function runWorkerTransformWithFallback(
  htmlOrBuffer: string | Uint8Array,
  url: string,
  options: TransformExecutionOptions
): Promise<MarkdownTransformResult> {
  return stageTracker.runAsync(url, 'transform:worker', async () => {
    try {
      return await transformWithWorkerPool(htmlOrBuffer, url, options);
    } catch (error: unknown) {
      return resolveWorkerFallback(error, htmlOrBuffer, url, options);
    }
  });
}

async function transformInputToMarkdown(
  htmlOrBuffer: string | Uint8Array,
  url: string,
  options: TransformExecutionOptions
): Promise<MarkdownTransformResult> {
  const totalStage = stageTracker.start(url, 'transform:total');

  try {
    throwIfAborted(options.signal, url, 'transform:begin');
    return completeTrackedTransform(
      totalStage,
      await runWorkerTransformWithFallback(htmlOrBuffer, url, options)
    );
  } catch (error) {
    stageTracker.end(totalStage);
    throw error;
  }
}

export async function transformHtmlToMarkdown(
  html: string,
  url: string,
  options: TransformOptions
): Promise<MarkdownTransformResult> {
  return transformInputToMarkdown(html, url, options);
}

export async function transformBufferToMarkdown(
  htmlBuffer: Uint8Array,
  url: string,
  options: TransformExecutionOptions
): Promise<MarkdownTransformResult> {
  return transformInputToMarkdown(htmlBuffer, url, options);
}

// ── ASCII code constants ────────────────────────────────────────────
const ASCII_MARKERS = {
  HASH: 35,
  ASTERISK: 42,
  PLUS: 43,
  DASH: 45,
  PERIOD: 46,
  DIGIT_0: 48,
  DIGIT_9: 57,
  EXCLAMATION: 33,
  QUESTION: 63,
  BRACKET_OPEN: 91,
} as const;

// ── Title heuristic thresholds ──────────────────────────────────────
const TITLE_MIN_WORDS = 2;
const TITLE_MAX_WORDS = 10;
const TITLE_MIN_CAPITALIZED = 2;
const TITLE_EXCLUSION_WORDS = new Set([
  'and',
  'or',
  'the',
  'of',
  'in',
  'for',
  'to',
  'a',
]);

// ── Processing limits ───────────────────────────────────────────────
const HAS_FOLLOWING_LOOKAHEAD = 10;
const PROPERTY_FIX_MAX_PASSES = 5;
const MAX_LINE_LENGTH = 80;

// ── TOC thresholds ──────────────────────────────────────────────────
const TOC_SCAN_LIMIT = 20;
const TOC_MAX_NON_EMPTY = 12;
const TOC_LINK_RATIO_THRESHOLD = 0.8;

// ── Docs-chrome scan depth ───────────────────────────────────────────
const CHROME_SCAN_LINE_LIMIT = 12;

// ── Fence pattern ───────────────────────────────────────────────────
const FENCE_PATTERN = /^\s*(`{3,}|~{3,})/;

// ── Regex collection ────────────────────────────────────────────────
const REGEX = {
  HEADING_MARKER: /^#{1,6}\s/m,
  HEADING_STRICT: /^#{1,6}\s+/m,
  EMPTY_HEADING_LINE: /^#{1,6}[ \t\u00A0]*$/,
  ANCHOR_ONLY_HEADING: /^#{1,6}\s+\[[^\]]+\]\(#[^)]+\)\s*$/,
  HEADING_TRAILING_PERMALINK:
    /^(#{1,6}\s+.+?)\s*\[(?:#|¶|§|¤|🔗)\]\(#[^)]+\)\s*$/gmu,
  FENCE_START: FENCE_PATTERN,
  LIST_MARKER: /^(?:[-*+])\s/m,
  TOC_LINK: /^- \[[^\]]+\]\(#[^)]+\)\s*$/,
  TOC_HEADING:
    /^(?:#{1,6}\s+)?(?:table of contents|contents|on this page)\s*$/i,
  COMBINED_LINE_REMOVALS:
    /^(?:\[Skip to (?:main )?(?:content|navigation)\]\(#[^)]*\)|\[Skip link\]\(#[^)]*\)|Was this page helpful\??|\[Back to top\]\(#[^)]*\)|\[\s*\]\(https?:\/\/[^)]*\))\s*$/gim,
  ZERO_WIDTH_ANCHOR: /\[(?:\s|\u200B)*\]\(#[^)]*\)[ \t]*/g,
  CONCATENATED_PROPS:
    /([a-z_][a-z0-9_]{0,30}\??:\s+)([\u0022\u201C][^\u0022\u201C\u201D]*[\u0022\u201D])([a-z_][a-z0-9_]{0,30}\??:)/g,
  DOUBLE_NEWLINE_REDUCER: /\n{3,}/g,
  HEADING_SPACING: /(^#{1,6}\s[^\n]*)\n([^\n])/gm,
  HEADING_CODE_BLOCK: /(^#{1,6}\s+\w+)```/gm,
  SPACING_LINK_FIX: /\]\(([^)]+)\)\[/g,
  SPACING_ADJ_COMBINED: /(?:\]\([^)]+\)|`[^`]+`)(?=[A-Za-z0-9])/g,
  SPACING_CODE_DASH: /(`[^`]+`)\s*\\-\s*/g,
  SPACING_ESCAPED_DASH: /(?<=[\w)\]`])\s*\\-\s*(?=[A-Za-z0-9([])/g,
  SPACING_ESCAPES: /\\([[\].])/g,
  SPACING_LIST_NUM_COMBINED:
    /^((?![-*+] |\d+\. |[ \t]).+)\n((?:[-*+]|\d+\.) )/gm,
  PUNCT_ONLY_LIST_ARTIFACT:
    /^(?:[-*+]|\d+\.)\s*(?:\\[-*+|/]|[-*+|/])(?:\s+(?:\\[-*+|/]|[-*+|/]))*\s*$/gm,
  NESTED_LIST_INDENT: /^( +)((?:[-*+])|\d+\.)\s/gm,
  TYPEDOC_COMMENT: /(`+)(?:(?!\1)[\s\S])*?\1|\s?\/\\?\*[\s\S]*?\\?\*\//g,
} as const;

// ── Heading keywords (config-driven) ────────────────────────────────
const HEADING_KEYWORDS = new Set(
  config.markdownCleanup.headingKeywords.map((value) =>
    value.toLocaleLowerCase(config.i18n.locale)
  )
);

// ── Prefix patterns ─────────────────────────────────────────────────
const SPECIAL_PREFIXES =
  /^(?:example|note|tip|warning|important|caution):\s+\S/i;
const REPL_PROMPT_LINE =
  /^(?:>>>|\.\.\.|In \[\d+\]:|Out\[\d+\]:|\.\.\.\\?>)\s*/;
const LEADING_DOCS_CHROME_PATTERNS = [
  /^Edit this page$/i,
  /^Toggle table of contents sidebar$/i,
  /^Toggle site navigation sidebar$/i,
  /^Toggle Light \/ Dark \/ Auto color theme$/i,
  /^Back to top$/i,
] as const;

// ── TypeDoc prefixes ────────────────────────────────────────────────
const TYPEDOC_PREFIXES = [
  'Defined in:',
  'Returns:',
  'Since:',
  'See also:',
] as const;

// ── TextPass pipeline type ──────────────────────────────────────────
interface TextPass {
  readonly stage: string;
  readonly enabled?: () => boolean;
  readonly transform: (text: string) => string;
}

interface CleanupOptions {
  preserveEmptyHeadings?: boolean;
  signal?: AbortSignal;
  url?: string;
}
function createAbortChecker(options?: CleanupOptions): (stage: string) => void {
  return (stage: string) => {
    throwIfAborted(options?.signal, options?.url ?? '', stage);
  };
}
function isBlank(line: string | undefined): boolean {
  return line === undefined || line.trim().length === 0;
}
function hasFollowingContent(lines: string[], startIndex: number): boolean {
  // Optimization: Bound lookahead to avoid checking too many lines in huge files
  for (
    let i = startIndex + 1;
    i < Math.min(lines.length, startIndex + HAS_FOLLOWING_LOOKAHEAD);
    i++
  ) {
    if (!isBlank(lines[i])) return true;
  }
  return false;
}
function findNextNonBlankLine(
  lines: string[],
  startIndex: number
): string | undefined {
  for (
    let i = startIndex + 1;
    i < Math.min(lines.length, startIndex + HAS_FOLLOWING_LOOKAHEAD);
    i++
  ) {
    const line = lines[i];
    if (!isBlank(line)) return line?.trim();
  }
  return undefined;
}
function stripAnchorOnlyHeading(line: string): string {
  return line.replace(/^(#{1,6})\s+\[([^\]]+)\]\(#[^)]+\)\s*$/, '$1 $2');
}
function isTitleCaseOrKeyword(trimmed: string): boolean {
  // Quick check for length to avoid regex on long strings
  if (trimmed.length > MAX_LINE_LENGTH) return false;

  // Single word optimization
  if (!trimmed.includes(' ')) {
    if (!/^[A-Z]/.test(trimmed)) return false;
    return HEADING_KEYWORDS.has(trimmed.toLocaleLowerCase(config.i18n.locale));
  }

  // Split limited number of words
  const words = trimmed.split(/\s+/);
  const len = words.length;
  if (len < TITLE_MIN_WORDS || len > TITLE_MAX_WORDS) return false;

  let capitalizedCount = 0;
  for (let i = 0; i < len; i++) {
    const w = words[i];
    if (!w) continue;
    const isCap = /^[A-Z][a-z]*$/.test(w);
    if (isCap) capitalizedCount++;
    else if (!TITLE_EXCLUSION_WORDS.has(w.toLowerCase())) return false;
  }

  return capitalizedCount >= TITLE_MIN_CAPITALIZED;
}
function getHeadingPrefix(trimmed: string): string | null {
  if (trimmed.length > MAX_LINE_LENGTH) return null;
  if (REPL_PROMPT_LINE.test(trimmed)) return null;

  // Fast path: Check common markdown markers first
  const firstChar = trimmed.charCodeAt(0);
  if (
    firstChar === ASCII_MARKERS.HASH ||
    firstChar === ASCII_MARKERS.DASH ||
    firstChar === ASCII_MARKERS.ASTERISK ||
    firstChar === ASCII_MARKERS.PLUS ||
    firstChar === ASCII_MARKERS.BRACKET_OPEN ||
    (firstChar >= ASCII_MARKERS.DIGIT_0 && firstChar <= ASCII_MARKERS.DIGIT_9)
  ) {
    if (
      REGEX.HEADING_MARKER.test(trimmed) ||
      REGEX.LIST_MARKER.test(trimmed) ||
      /^\d+\.\s/.test(trimmed) ||
      /^\[.*\]\(.*\)$/.test(trimmed)
    ) {
      return null;
    }
  }

  if (SPECIAL_PREFIXES.test(trimmed)) {
    return /^example:\s/i.test(trimmed) ? '### ' : '## ';
  }

  const lastChar = trimmed.charCodeAt(trimmed.length - 1);
  if (
    lastChar === ASCII_MARKERS.PERIOD ||
    lastChar === ASCII_MARKERS.EXCLAMATION ||
    lastChar === ASCII_MARKERS.QUESTION
  )
    return null;

  return isTitleCaseOrKeyword(trimmed) ? '## ' : null;
}
function getTocBlockStats(
  lines: string[],
  headingIndex: number
): { total: number; linkCount: number; nonLinkCount: number } {
  let total = 0;
  let linkCount = 0;
  let nonLinkCount = 0;
  const lookaheadMax = Math.min(lines.length, headingIndex + TOC_SCAN_LIMIT);

  for (let i = headingIndex + 1; i < lookaheadMax; i++) {
    const line = lines[i];
    if (!line) continue;
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (REGEX.HEADING_MARKER.test(trimmed)) break;

    total += 1;
    if (REGEX.TOC_LINK.test(trimmed)) linkCount += 1;
    else nonLinkCount += 1;

    if (total >= TOC_MAX_NON_EMPTY) break;
  }

  return { total, linkCount, nonLinkCount };
}
function skipTocLines(lines: string[], startIndex: number): number {
  for (let i = startIndex; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (!REGEX.TOC_LINK.test(trimmed)) return i;
  }
  return lines.length;
}
function isTypeDocArtifactLine(line: string): boolean {
  const trimmed = line.trim();
  for (const prefix of TYPEDOC_PREFIXES) {
    if (!trimmed.startsWith(prefix)) continue;
    const rest = trimmed.slice(prefix.length).trimStart();
    if (!rest.startsWith('**`')) return false;
    return rest.includes('`**');
  }
  return false;
}
function tryPromoteOrphan(
  lines: string[],
  i: number,
  trimmed: string
): string | null {
  const prevLine = lines[i - 1];
  const isOrphan = i === 0 || !prevLine || prevLine.trim().length === 0;
  if (!isOrphan) return null;

  const prefix = getHeadingPrefix(trimmed);
  if (!prefix) return null;

  const isSpecialPrefix = SPECIAL_PREFIXES.test(trimmed);
  if (!isSpecialPrefix && !hasFollowingContent(lines, i)) return null;
  if (!isSpecialPrefix) {
    const nextLine = findNextNonBlankLine(lines, i);
    if (nextLine && REGEX.HEADING_MARKER.test(nextLine)) return null;
  }

  return `${prefix}${trimmed}`;
}
function shouldSkipAsToc(
  lines: string[],
  i: number,
  trimmed: string,
  removeToc: boolean,
  options?: CleanupOptions
): number | null {
  if (!removeToc || !REGEX.TOC_HEADING.test(trimmed)) return null;

  const { total, linkCount, nonLinkCount } = getTocBlockStats(lines, i);
  if (total === 0 || nonLinkCount > 0) return null;

  const ratio = linkCount / total;
  if (ratio <= TOC_LINK_RATIO_THRESHOLD) return null;

  throwIfAborted(options?.signal, options?.url ?? '', 'markdown:cleanup:toc');
  return skipTocLines(lines, i + 1);
}
function normalizePreprocessLine(
  lines: string[],
  i: number,
  trimmed: string,
  line: string,
  options?: CleanupOptions
): string | null {
  if (REGEX.EMPTY_HEADING_LINE.test(trimmed)) return null;
  if (!REGEX.ANCHOR_ONLY_HEADING.test(trimmed)) return line;
  if (!hasFollowingContent(lines, i)) {
    return options?.preserveEmptyHeadings
      ? stripAnchorOnlyHeading(trimmed)
      : null;
  }
  return stripAnchorOnlyHeading(trimmed);
}
function maybeSkipTocBlock(
  lines: string[],
  i: number,
  trimmed: string,
  options?: CleanupOptions
): number | null {
  return shouldSkipAsToc(
    lines,
    i,
    trimmed,
    config.markdownCleanup.removeTocBlocks,
    options
  );
}
function maybePromoteOrphanHeading(
  lines: string[],
  i: number,
  trimmed: string,
  checkAbort: (stage: string) => void
): string | null {
  if (!config.markdownCleanup.promoteOrphanHeadings || trimmed.length === 0) {
    return null;
  }

  checkAbort('markdown:cleanup:promote');
  return tryPromoteOrphan(lines, i, trimmed);
}
function preprocessLines(lines: string[], options?: CleanupOptions): string {
  const checkAbort = createAbortChecker(options);
  const result: string[] = [];
  let skipUntil = -1;

  for (let i = 0; i < lines.length; i++) {
    if (i < skipUntil) continue;

    const currentLine = lines[i] ?? '';
    const trimmed = currentLine.trim();
    const normalizedLine = normalizePreprocessLine(
      lines,
      i,
      trimmed,
      currentLine,
      options
    );
    if (normalizedLine === null) continue;

    const tocSkip = maybeSkipTocBlock(lines, i, trimmed, options);
    if (tocSkip !== null) {
      skipUntil = tocSkip;
      continue;
    }

    const promotedLine = maybePromoteOrphanHeading(
      lines,
      i,
      trimmed,
      checkAbort
    );
    result.push(promotedLine ?? normalizedLine);
  }

  return result.join('\n');
}
function processTextBuffer(lines: string[], options?: CleanupOptions): string {
  if (lines.length === 0) return '';
  const text = preprocessLines(lines, options);
  return applyGlobalRegexes(text, options);
}
function removeTypeDocArtifacts(text: string): string {
  const filtered = text
    .split('\n')
    .filter((line) => !isTypeDocArtifactLine(line))
    .join('\n');
  return filtered.replace(REGEX.TYPEDOC_COMMENT, (match) =>
    match.startsWith('`') ? match : ''
  );
}
function removeSkipLinks(text: string): string {
  return text
    .replace(REGEX.ZERO_WIDTH_ANCHOR, '')
    .replace(REGEX.COMBINED_LINE_REMOVALS, '');
}
function normalizeInlineCodeTokens(text: string): string {
  return text.replace(/`([^`\n]+)`/g, (match: string, inner: string) => {
    const trimmed = inner.trim();
    if (!/[A-Za-z0-9]/.test(trimmed)) return match;

    const parts = /^(\s*)(.*?)(\s*)$/.exec(inner);
    if (!parts) return match;

    const normalized = collapseQualifiedIdentifierSpacing(parts[2] ?? '');
    if (trimmed === inner && normalized === inner) return match;
    return `${parts[1] ?? ''}\`${normalized}\`${parts[3] ?? ''}`;
  });
}

function applyUntilStable(
  text: string,
  pattern: RegExp,
  replacement: string,
  maxPasses = PROPERTY_FIX_MAX_PASSES
): string {
  let result = text;
  for (let i = 0; i < maxPasses; i++) {
    const next = result.replace(pattern, replacement);
    if (next === result) break;
    result = next;
  }
  return result;
}

function collapseQualifiedIdentifierSpacing(text: string): string {
  return applyUntilStable(
    text,
    /\b([A-Za-z_$][\w$]*)\.\s+(?=[A-Za-z_$<])/g,
    '$1.'
  );
}

function normalizeMarkdownLinkText(text: string): string {
  const normalized = collapseQualifiedIdentifierSpacing(
    text.replace(/\\`/g, '`').replace(/\\</g, '<').replace(/\\>/g, '>')
  );
  return normalized.replace(/</g, '\\<').replace(/>/g, '\\>');
}

function normalizeMarkdownLinkLabels(text: string): string {
  return text.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    (_match: string, linkText: string, url: string) =>
      `[${normalizeMarkdownLinkText(linkText)}](${url})`
  );
}

const INLINE_CODE_PAD_BEFORE = /(\S)[ \t]{2,}(?=`[^`\n]+`)/g;
const INLINE_CODE_PAD_AFTER = /(`[^`\n]+`)[ \t]{2,}(?=\S)/g;

function collapseInlineCodePadding(text: string): string {
  return text
    .replace(INLINE_CODE_PAD_BEFORE, '$1 ')
    .replace(INLINE_CODE_PAD_AFTER, '$1 ');
}

function escapeAngleBracketsInMarkdownTables(text: string): string {
  return text.replace(/^(?!\|\s*[-: ]+\|)(\|.*\|)\s*$/gm, (line: string) =>
    line
      .replace(/<\/([A-Za-z][A-Za-z0-9-]*)>/g, '\\</$1\\>')
      .replace(/<([A-Za-z][A-Za-z0-9-]*)>/g, '\\<$1\\>')
  );
}

function stripTrailingHeadingPermalinks(text: string): string {
  return text
    .replace(REGEX.HEADING_TRAILING_PERMALINK, '$1')
    .replace(/^(#{1,6})\s{2,}/gm, '$1 ')
    .replace(/^(#{1,6}\s+.*?)[ \t]+$/gm, '$1');
}

function getHeadingInfo(line: string): { level: number } | null {
  const match = /^(#{1,6})\s+/.exec(line.trim());
  if (!match) return null;
  return { level: match[1]?.length ?? 0 };
}

function findNextNonBlankIndex(lines: string[], startIndex: number): number {
  let idx = startIndex;
  while (idx < lines.length && isBlank(lines[idx])) {
    idx += 1;
  }
  return idx;
}

function removeEmptyHeadingSections(text: string): string {
  const lines = text.split('\n');
  const kept: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const heading = getHeadingInfo(line);
    if (!heading) {
      kept.push(line);
      continue;
    }

    const nextIndex = findNextNonBlankIndex(lines, i + 1);

    const nextLine = lines[nextIndex];
    if (nextLine === undefined) {
      kept.push(line);
      continue;
    }

    const nextHeading = getHeadingInfo(nextLine);
    if (nextHeading && nextHeading.level <= heading.level) {
      continue;
    }

    kept.push(line);
  }

  return kept.join('\n').replace(REGEX.DOUBLE_NEWLINE_REDUCER, '\n\n');
}

function normalizeMarkdownSpacing(text: string): string {
  let result = text
    .replace(REGEX.SPACING_LINK_FIX, ']($1) [')
    .replace(REGEX.SPACING_ADJ_COMBINED, '$& ')
    .replace(REGEX.SPACING_CODE_DASH, '$1 - ')
    .replace(REGEX.SPACING_ESCAPED_DASH, ' - ')
    .replace(REGEX.SPACING_ESCAPES, '$1')
    .replace(REGEX.SPACING_LIST_NUM_COMBINED, '$1\n\n$2')
    .replace(REGEX.PUNCT_ONLY_LIST_ARTIFACT, '')
    .replace(REGEX.DOUBLE_NEWLINE_REDUCER, '\n\n');

  // Fix missing spaces after sentence-ending punctuation followed by uppercase
  result = result.replace(/([.!?:;])([A-Z])/g, '$1 $2');

  // Trim whitespace around token-like inline code spans.
  result = normalizeInlineCodeTokens(result);
  result = collapseInlineCodePadding(result);

  result = normalizeMarkdownLinkLabels(result);
  result = escapeAngleBracketsInMarkdownTables(result);

  return normalizeNestedListIndentation(result);
}
function stripLeadingDocsChrome(text: string): string {
  const lines = text.split('\n');
  const cleaned = lines.map((line, index) => {
    if (index >= CHROME_SCAN_LINE_LIMIT) return line;
    const trimmed = line.trim();
    return LEADING_DOCS_CHROME_PATTERNS.some((pattern) => pattern.test(trimmed))
      ? ''
      : line;
  });
  return cleaned.join('\n').replace(REGEX.DOUBLE_NEWLINE_REDUCER, '\n\n');
}
function fixConcatenatedProperties(text: string): string {
  return applyUntilStable(text, REGEX.CONCATENATED_PROPS, '$1$2\n\n$3');
}
function applyGlobalRegexes(text: string, options?: CleanupOptions): string {
  const checkAbort = createAbortChecker(options);

  const passes: readonly TextPass[] = [
    {
      stage: 'markdown:cleanup:nbsp',
      transform: (t) => t.replace(/\u00A0/g, ' '),
    },
    {
      stage: 'markdown:cleanup:headings',
      transform: (t) =>
        t
          .replace(REGEX.HEADING_SPACING, '$1\n\n$2')
          .replace(REGEX.HEADING_CODE_BLOCK, '$1\n\n```'),
    },
    {
      stage: 'markdown:cleanup:typedoc',
      enabled: () => config.markdownCleanup.removeTypeDocComments,
      transform: removeTypeDocArtifacts,
    },
    {
      stage: 'markdown:cleanup:skip-links',
      enabled: () => config.markdownCleanup.removeSkipLinks,
      transform: removeSkipLinks,
    },
    {
      stage: 'markdown:cleanup:spacing',
      transform: normalizeMarkdownSpacing,
    },
    {
      stage: 'markdown:cleanup:properties',
      transform: fixConcatenatedProperties,
    },
    {
      stage: 'markdown:cleanup:permalinks',
      transform: stripTrailingHeadingPermalinks,
    },
  ];

  let result = text;
  for (const pass of passes) {
    if (pass.enabled !== undefined && !pass.enabled()) continue;
    checkAbort(pass.stage);
    result = pass.transform(result);
  }
  return result;
}
function normalizeNestedListIndentation(text: string): string {
  return text.replace(
    REGEX.NESTED_LIST_INDENT,
    (match: string, spaces: string, marker: string): string => {
      const count = spaces.length;
      if (count < 2 || count % 2 !== 0) return match;
      const normalized = ' '.repeat((count / 2) * 4);
      return `${normalized}${marker} `;
    }
  );
}

export function processFencedContent(
  content: string,
  processTextSegment: (text: string) => string
): string {
  // Normalize line endings to \n
  const normalizedContent = content.replace(/\r\n/g, '\n');
  const FENCE_BLOCK_REGEX =
    /^[ \t]*(`{3,}|~{3,})[^\n]*(?:\n[\s\S]*?)?(?:^[ \t]*\1[ \t]*$|$(?!\n))/gm;

  const parts: string[] = [];
  let lastIndex = 0;

  for (const match of normalizedContent.matchAll(FENCE_BLOCK_REGEX)) {
    const matchStart = match.index;
    if (matchStart > lastIndex) {
      parts.push(
        processTextSegment(normalizedContent.slice(lastIndex, matchStart))
      );
    }
    parts.push(match[0]);
    lastIndex = matchStart + match[0].length;
  }

  if (lastIndex < normalizedContent.length) {
    parts.push(processTextSegment(normalizedContent.slice(lastIndex)));
  }

  return parts.join('');
}

function stripLeadingBreadcrumbNoise(text: string): string {
  return text.replace(
    /^([^\n#>|`\-*+\d[\]()]{1,40})\n(\s*\n)?(?=#{1,2}\s)/,
    ''
  );
}

function stripCopyButtonText(text: string): string {
  return text.replace(/\[Copy\]\(#copy\)\s*/gi, '');
}

export function cleanupMarkdownArtifacts(
  content: string,
  options?: CleanupOptions
): string {
  if (!content) return '';

  throwIfAborted(options?.signal, options?.url ?? '', 'markdown:cleanup:begin');

  let result = stripCopyButtonText(
    processFencedContent(content, (text) =>
      processTextBuffer(text.split('\n'), options)
    ).trim()
  );

  if (!options?.preserveEmptyHeadings) {
    throwIfAborted(
      options?.signal,
      options?.url ?? '',
      'markdown:cleanup:empty-headings'
    );
    result = removeEmptyHeadingSections(result);
  }

  return stripLeadingBreadcrumbNoise(stripLeadingDocsChrome(result));
}
