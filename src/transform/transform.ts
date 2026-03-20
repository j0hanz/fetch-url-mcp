import { Buffer } from 'node:buffer';
import diagnosticsChannel from 'node:diagnostics_channel';
import { performance } from 'node:perf_hooks';

import { isProbablyReaderable, Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';

import { extractLanguageFromClassName } from '../lib/code-lang.js';
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
  prepareDocumentForMarkdown,
  removeNoiseFromHtml,
  serializeDocumentForMarkdown,
} from '../lib/dom-prep.js';
import { isRawTextContentUrl } from '../lib/http.js';
import {
  cleanupMarkdownArtifacts,
  processFencedContent,
} from '../lib/md-cleanup.js';
import {
  addSourceToMarkdown,
  buildMetadataFooter,
  extractTitleFromRawMarkdown,
  isRawTextContent,
} from '../lib/md-metadata.js';
import { throwIfAborted } from '../lib/utils.js';
import { FetchError, getErrorMessage, toError } from '../lib/utils.js';
import { isObject } from '../lib/utils.js';

import { translateHtmlFragmentToMarkdown } from './html-translators.js';
import {
  extractMetadata,
  extractMetadataFromHead,
  mergeMetadata,
  normalizeDocumentTitle,
} from './metadata.js';
import { supplementMarkdownFromNextFlight } from './next-flight.js';
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
    const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
    return buf.toString('utf8');
  }
  try {
    return new TextDecoder(normalizedEncoding).decode(input);
  } catch {
    const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
    return buf.toString('utf8');
  }
}

function asError(value: unknown): Error | undefined {
  return value instanceof Error ? value : undefined;
}

interface ExtractionContext extends ExtractionResult {
  document: Document;
  truncated?: boolean;
}

interface StageBudget {
  totalBudgetMs: number;
  elapsedMs: number;
}

function isWhitespaceChar(code: number): boolean {
  return code === 9 || code === 10 || code === 12 || code === 13 || code === 32;
}

function buildTransformSignal(signal?: AbortSignal): AbortSignal | undefined {
  const { timeoutMs } = config.transform;
  if (timeoutMs <= 0) return signal;

  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
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

  run<T>(url: string, stage: string, fn: () => T, budget?: StageBudget): T {
    if (this.shouldSkipTracking(budget)) {
      return fn();
    }

    if (budget && budget.elapsedMs >= budget.totalBudgetMs) {
      throw new FetchError('Transform budget exhausted', url, 504, {
        reason: 'timeout',
        stage: `${stage}:budget_exhausted`,
        elapsedMs: budget.elapsedMs,
        totalBudgetMs: budget.totalBudgetMs,
      });
    }

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
    fn: () => Promise<T>
  ): Promise<T> {
    if (this.shouldSkipTracking()) {
      return fn();
    }

    const ctx = this.start(url, stage);
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
    } catch {
      // Intentionally swallow publish errors to prevent cascading failures
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

function getUtf8ByteLength(html: string): number {
  return Buffer.byteLength(html, 'utf8');
}

function trimUtf8Buffer(buffer: Buffer, maxBytes: number): Buffer {
  if (buffer.length <= maxBytes) return buffer;
  if (maxBytes <= 0) return buffer.subarray(0, 0);

  let end = maxBytes;
  let cursor = end - 1;

  while (cursor >= 0 && ((buffer[cursor] ?? 0) & 0xc0) === 0x80) {
    cursor -= 1;
  }

  if (cursor < 0) return buffer.subarray(0, maxBytes);

  const lead = buffer[cursor] ?? 0;
  let sequenceLength = 1;

  if (lead >= 0xc0 && lead < 0xe0) sequenceLength = 2;
  else if (lead >= 0xe0 && lead < 0xf0) sequenceLength = 3;
  else if (lead >= 0xf0 && lead < 0xf8) sequenceLength = 4;

  if (cursor + sequenceLength > end) {
    end = cursor;
  }

  return buffer.subarray(0, end);
}

function trimDanglingTagFragment(content: string): string {
  let result = content;

  // Trim dangling HTML entity (e.g. "&amp" cut before ";")
  const lastAmp = result.lastIndexOf('&');
  if (lastAmp !== -1 && lastAmp > result.length - 10) {
    const tail = result.slice(lastAmp + 1);
    if (!tail.includes(';') && /^[#a-zA-Z][a-zA-Z0-9]*$/.test(tail)) {
      result = result.substring(0, lastAmp);
    }
  }

  const lastOpen = result.lastIndexOf('<');
  const lastClose = result.lastIndexOf('>');
  if (lastOpen > lastClose) {
    if (lastOpen === result.length - 1) {
      return result.substring(0, lastOpen);
    }
    const code = result.codePointAt(lastOpen + 1);
    if (
      code !== undefined &&
      (code === 47 || // '/'
        code === 33 || // '!'
        code === 63 || // '?'
        (code >= 65 && code <= 90) || // A-Z
        (code >= 97 && code <= 122)) // a-z
    ) {
      return result.substring(0, lastOpen);
    }
  }
  return result;
}

function truncateHtml(
  html: string,
  inputTruncated = false
): { html: string; truncated: boolean } {
  const maxSize = config.constants.maxHtmlSize;
  if (maxSize <= 0) return { html, truncated: false };

  if (html.length <= maxSize) {
    const byteLength = getUtf8ByteLength(html);
    if (byteLength <= maxSize && !inputTruncated)
      return { html, truncated: false };
  }

  const sliced = html.slice(0, maxSize);
  if (getUtf8ByteLength(sliced) <= maxSize) {
    return { html: trimDanglingTagFragment(sliced), truncated: true };
  }

  const htmlBuffer = Buffer.from(sliced, 'utf8');
  const content = trimDanglingTagFragment(
    trimUtf8Buffer(htmlBuffer, maxSize).toString('utf8')
  );

  logWarn('HTML content exceeds maximum size, truncating', {
    size: getUtf8ByteLength(html),
    maxSize,
    truncatedSize: getUtf8ByteLength(content),
  });
  return { html: content, truncated: true };
}

function willTruncate(html: string): boolean {
  const maxSize = config.constants.maxHtmlSize;
  return (
    maxSize > 0 && (html.length > maxSize || getUtf8ByteLength(html) > maxSize)
  );
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

function extractArticle(
  document: unknown,
  url: string,
  signal?: AbortSignal
): ExtractedArticle | null {
  if (!isReadabilityCompatible(document)) {
    logWarn('Document not compatible with Readability');
    return null;
  }

  const checkAbort = (stage: string): void => {
    throwIfAborted(signal, url, stage);
  };

  try {
    const doc = document;

    checkAbort('extract:article:textCheck');

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

    checkAbort('extract:article:readabilityCheck');

    if (
      textLength >= MIN_READERABLE_TEXT_LENGTH &&
      !isProbablyReaderable(doc)
    ) {
      return null;
    }

    checkAbort('extract:article:clone');

    const readabilityDoc =
      typeof doc.cloneNode === 'function'
        ? (doc.cloneNode(true) as Document)
        : doc;

    preserveAlertElements(readabilityDoc);
    preserveCodeLanguageAttributes(readabilityDoc);

    for (const el of readabilityDoc.querySelectorAll(
      '[class*="breadcrumb"],[class*="pagination"]'
    )) {
      el.remove();
    }

    checkAbort('extract:article:parse');

    const reader = new Readability(readabilityDoc, {
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
    const parsed = reader.parse();
    if (!parsed) return null;

    return {
      content: parsed.content ?? '',
      textContent: parsed.textContent ?? '',
      ...(parsed.title != null && { title: parsed.title }),
      ...(parsed.byline != null && { byline: parsed.byline }),
      ...(parsed.excerpt != null && { excerpt: parsed.excerpt }),
      ...(parsed.siteName != null && { siteName: parsed.siteName }),
    };
  } catch (error: unknown) {
    logError('Failed to extract article with Readability', asError(error));
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
  if (!willTruncate(html)) return null;
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
    signal?: AbortSignal;
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
    signal?: AbortSignal;
    inputTruncated?: boolean;
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

    logError('Failed to extract content', asError(error));

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
  if (!trimmedHref) return href;
  for (let i = 0; i < trimmedHref.length; i += 1) {
    if (isWhitespaceChar(trimmedHref.charCodeAt(i))) return href;
  }
  if (isAbsoluteOrSpecialUrl(trimmedHref)) return trimmedHref;

  try {
    return new URL(trimmedHref, baseUrl).href;
  } catch {
    if (trimmedHref.startsWith('/')) return `${origin}${trimmedHref}`;
    return trimmedHref;
  }
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
  let output = '';

  while (cursor < markdown.length) {
    const link = findInlineLink(markdown, cursor);
    if (!link) {
      output += markdown.slice(cursor);
      break;
    }

    output += markdown.slice(cursor, link.prefixStart);
    output += `${link.prefix}(${resolveRelativeHref(
      link.href,
      baseUrl,
      origin
    )})`;

    cursor = link.closeParen + 1;
  }

  return output;
}

function resolveRelativeUrls(
  markdown: string,
  baseUrl: string,
  signal?: AbortSignal
): string {
  let origin: string;
  try {
    ({ origin } = new URL(baseUrl));
  } catch {
    return markdown;
  }

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
    signal?: AbortSignal;
    document?: Document;
    skipNoiseRemoval?: boolean;
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

    logError('Failed to convert HTML to markdown', asError(error));
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
  inputTruncated?: boolean;
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
interface RetentionRule {
  selector: string;
  minOriginal: number;
  ratio: number;
}

const RETENTION_RULES: readonly RetentionRule[] = [
  { selector: 'h1,h2,h3,h4,h5,h6', minOriginal: 1, ratio: 0.3 },
  { selector: 'pre', minOriginal: 1, ratio: 0.15 },
  { selector: 'table', minOriginal: 1, ratio: 0.5 },
  { selector: 'img', minOriginal: 4, ratio: 0.2 },
  {
    selector: 'button,[role="tab"],[role="tabpanel"],[aria-controls]',
    minOriginal: 6,
    ratio: 0.1,
  },
];

const MIN_HEADINGS_FOR_EMPTY_SECTION_GATE = 5;
const MAX_EMPTY_SECTION_RATIO = 0.05;

const MIN_LINE_LENGTH_FOR_TRUNCATION_CHECK = 20;
const MAX_TRUNCATED_LINE_RATIO = 0.95;

function resolveHtmlDocument(htmlOrDocument: string | Document): Document {
  if (typeof htmlOrDocument !== 'string') return htmlOrDocument;

  const trimmed = htmlOrDocument.trim().toLowerCase();
  const needsWrapper =
    !trimmed.startsWith('<!doctype') &&
    !trimmed.startsWith('<html') &&
    !trimmed.startsWith('<body');
  const htmlToParse = needsWrapper
    ? `<!DOCTYPE html><html><body>${htmlOrDocument}</body></html>`
    : htmlOrDocument;

  try {
    return parseHTML(htmlToParse).document;
  } catch {
    // Don't crash on parse failures.
    return parseHTML('<!DOCTYPE html><html><body></body></html>').document;
  }
}

function getTextContentSkippingHidden(node: Node, parts: string[]): void {
  const { nodeType } = node;
  if (nodeType === 3) {
    const { textContent } = node;
    if (textContent) parts.push(textContent);
    return;
  }
  if (nodeType !== 1) return;

  const element = node as Element;
  if (
    element.hasAttribute('hidden') ||
    element.getAttribute('aria-hidden') === 'true'
  ) {
    return;
  }

  const { tagName } = element;
  if (tagName === 'SCRIPT' || tagName === 'STYLE' || tagName === 'NOSCRIPT')
    return;

  const { childNodes } = node;
  const { length } = childNodes;
  for (let i = 0; i < length; i++) {
    const child = childNodes[i];
    if (child) {
      getTextContentSkippingHidden(child, parts);
    }
  }
}

function getVisibleTextLength(htmlOrDocument: string | Document): number {
  if (typeof htmlOrDocument === 'string') {
    const doc = resolveHtmlDocument(htmlOrDocument);
    for (const el of doc.body.querySelectorAll('script,style,noscript')) {
      el.remove();
    }
    return (doc.body.textContent || '').replace(/\s+/g, ' ').trim().length;
  }
  const parts: string[] = [];
  getTextContentSkippingHidden(htmlOrDocument.body, parts);
  return parts.join('').replace(/\s+/g, ' ').trim().length;
}

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

// Heuristic to detect if the content was truncated due to length limits by checking for incomplete sentences.
const SENTENCE_ENDING_CODES = new Set([46, 33, 63, 58, 59]);

function trimLineOffsets(
  text: string,
  lineStart: number,
  lineEnd: number
): { start: number; end: number } | null {
  let start = lineStart;
  while (start < lineEnd && isWhitespaceChar(text.charCodeAt(start))) start++;
  let end = lineEnd - 1;
  while (end >= start && isWhitespaceChar(text.charCodeAt(end))) end--;
  if (end < start) return null;
  const trimmedLen = end - start + 1;
  return trimmedLen > MIN_LINE_LENGTH_FOR_TRUNCATION_CHECK
    ? { start, end }
    : null;
}

function classifyLine(
  text: string,
  lineStart: number,
  lineEnd: number
): { counted: boolean; incomplete: boolean } {
  const lineLength = lineEnd - lineStart;
  if (lineLength <= MIN_LINE_LENGTH_FOR_TRUNCATION_CHECK)
    return { counted: false, incomplete: false };

  const trimmed = trimLineOffsets(text, lineStart, lineEnd);
  if (!trimmed) return { counted: false, incomplete: false };

  const lastChar = text.charCodeAt(trimmed.end);
  return { counted: true, incomplete: !SENTENCE_ENDING_CODES.has(lastChar) };
}

function hasTruncatedSentences(text: string): boolean {
  let lineStart = 0;
  let linesFound = 0;
  let incompleteFound = 0;
  const len = text.length;

  for (let i = 0; i <= len; i++) {
    const isEnd = i === len;
    const isNewline = !isEnd && text.charCodeAt(i) === 10;

    if (isNewline || isEnd) {
      const { counted, incomplete } = classifyLine(text, lineStart, i);
      if (counted) {
        linesFound++;
        if (incomplete) incompleteFound++;
      }
      lineStart = i + 1;
    }
  }

  if (linesFound < 3) return false;
  return incompleteFound / linesFound > MAX_TRUNCATED_LINE_RATIO;
}

const MIN_CONTENT_ROOT_LENGTH = 100;
const HEADING_SCAN_LIMIT = 12;
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

function normalizeSyntheticTitleToken(value: string | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function shouldPreferPrimaryHeadingTitle(
  primaryHeading: string | undefined,
  title: string | undefined
): boolean {
  const primary = normalizeSyntheticTitleToken(primaryHeading);
  if (!primary) return false;

  const normalizedTitle = normalizeSyntheticTitleToken(title);
  if (!normalizedTitle) return true;
  if (normalizedTitle === primary) return true;

  return normalizedTitle
    .split(/\s*(?:[-|:•·]|–|—)\s*/u)
    .some((part) => part === primary);
}

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

function findPrimaryHeading(document: Document): string | undefined {
  for (const headingSelector of ['[data-title="true"]', 'h1'] as const) {
    const heading = document.querySelector(headingSelector);
    if (!heading) continue;
    const text = heading.textContent.trim();
    if (text) return text;
  }

  for (const selector of PRIMARY_HEADING_ROOT_SELECTORS) {
    const root = document.querySelector(selector);
    if (!root) continue;

    for (const headingSelector of [
      '[data-title="true"]',
      'h1',
      'h2',
    ] as const) {
      const heading = root.querySelector(headingSelector);
      if (!heading) continue;
      const text = heading.textContent.trim();
      if (text) return text;
    }
  }

  return undefined;
}

function countMatchingElements(root: ParentNode, selector: string): number {
  return root.querySelectorAll(selector).length;
}

function getHeadingLevel(heading: Element): number | null {
  const match = /^H([1-6])$/.exec(heading.tagName);
  if (!match) return null;

  return Number.parseInt(match[1] ?? '', 10);
}

function hasSectionContent(heading: Element): boolean {
  const level = getHeadingLevel(heading);
  if (level === null) return false;

  let current = heading.nextElementSibling;
  while (current) {
    const currentLevel = getHeadingLevel(current);
    if (currentLevel !== null && currentLevel <= level) return false;

    const text = current.textContent.trim();
    if (text.length > 0) return true;
    if (current.querySelector('img,table,pre,code,ul,ol,figure,blockquote')) {
      return true;
    }

    current = current.nextElementSibling;
  }

  return false;
}

function countEmptyHeadingSections(root: ParentNode): number {
  let emptyCount = 0;
  const headings = root.querySelectorAll('h1,h2,h3,h4,h5,h6');

  for (const heading of headings) {
    if (!hasSectionContent(heading)) emptyCount += 1;
  }

  return emptyCount;
}

function isGithubRepositoryRootUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  const hostname = parsed.hostname.toLowerCase();
  if (hostname !== 'github.com' && hostname !== 'www.github.com') {
    return false;
  }

  return parsed.pathname.split('/').filter(Boolean).length === 2;
}

const TransformHeuristics = {
  findContentRoot,
  findPrimaryHeading,
  isGithubRepositoryRootUrl,
} as const;

function shouldUseArticleContent(
  article: ExtractedArticle,
  document: Document
): boolean {
  // Content ratio gate
  const originalLength = getVisibleTextLength(document);
  if (originalLength >= MIN_HTML_LENGTH_FOR_GATE) {
    if (article.textContent.length / originalLength < MIN_CONTENT_RATIO)
      return false;
  }

  const articleDoc = parseHTML(
    `<!DOCTYPE html><html><body>${article.content}</body></html>`
  ).document;

  // Retention checks
  const passesRetention = RETENTION_RULES.every(
    ({ selector, minOriginal, ratio }) => {
      const original = countMatchingElements(document, selector);
      if (original < minOriginal) return true;
      return countMatchingElements(articleDoc, selector) / original >= ratio;
    }
  );
  if (!passesRetention) return false;

  // Empty section ratio
  const articleHeadings = countMatchingElements(
    articleDoc,
    'h1,h2,h3,h4,h5,h6'
  );
  if (articleHeadings >= MIN_HEADINGS_FOR_EMPTY_SECTION_GATE) {
    if (
      countEmptyHeadingSections(articleDoc) / articleHeadings >
      MAX_EMPTY_SECTION_RATIO
    ) {
      return false;
    }
  }

  return !hasTruncatedSentences(article.textContent);
}

function buildContentSource(params: {
  html: string;
  url: string;
  article: ExtractedArticle | null;
  extractedMeta: ExtractedMetadata;
  includeMetadata: boolean;
  useArticleContent: boolean;
  document?: Document;
  truncated: boolean;
  signal?: AbortSignal;
}): ContentSource {
  const {
    html,
    url,
    article,
    extractedMeta,
    includeMetadata,
    useArticleContent,
    document,
    truncated,
    signal,
  } = params;

  const metadata = createContentMetadataBlock(
    url,
    article,
    extractedMeta,
    useArticleContent,
    includeMetadata
  );

  const preparedDocument = document;
  let primaryHeading = document
    ? TransformHeuristics.findPrimaryHeading(document)
    : undefined;
  if (preparedDocument) {
    prepareDocumentForMarkdown(preparedDocument, url, signal);
    primaryHeading =
      TransformHeuristics.findPrimaryHeading(preparedDocument) ??
      primaryHeading;
  }

  const base: Pick<
    ContentSource,
    | 'favicon'
    | 'metadata'
    | 'extractedMetadata'
    | 'truncated'
    | 'primaryHeading'
    | 'originalHtml'
  > = {
    favicon: extractedMeta.favicon,
    metadata,
    extractedMetadata: extractedMeta,
    truncated,
    primaryHeading,
    originalHtml: html,
  };

  if (useArticleContent && article) {
    const { document: articleDoc } = parseHTML(
      `<!DOCTYPE html><html><body>${article.content}</body></html>`
    );
    prepareDocumentForMarkdown(articleDoc, url, signal);
    const articleTitle =
      article.title !== undefined
        ? normalizeDocumentTitle(article.title, url)
        : extractedMeta.title;
    const preferPrimaryHeading =
      TransformHeuristics.isGithubRepositoryRootUrl(url) ||
      shouldPreferPrimaryHeadingTitle(base.primaryHeading, articleTitle);
    const resolvedTitle =
      (preferPrimaryHeading ? base.primaryHeading : undefined) ?? articleTitle;

    return {
      ...base,
      sourceHtml: articleDoc.body.innerHTML,
      title: resolvedTitle,
      suppressSyntheticFavicon:
        normalizeSyntheticTitleToken(resolvedTitle) ===
        normalizeSyntheticTitleToken(base.primaryHeading),
      skipNoiseRemoval: true,
    };
  }

  if (document) {
    const resolvedDocument = preparedDocument ?? document;
    const contentRoot = TransformHeuristics.findContentRoot(resolvedDocument);
    const preferPrimaryHeading = shouldPreferPrimaryHeadingTitle(
      base.primaryHeading,
      extractedMeta.title
    );
    const resolvedTitle =
      (preferPrimaryHeading ? base.primaryHeading : undefined) ??
      extractedMeta.title;

    return {
      ...base,
      sourceHtml:
        contentRoot ?? serializeDocumentForMarkdown(resolvedDocument, html),
      title: resolvedTitle,
      suppressSyntheticFavicon:
        normalizeSyntheticTitleToken(resolvedTitle) ===
        normalizeSyntheticTitleToken(base.primaryHeading),
      skipNoiseRemoval: true,
      document: resolvedDocument,
    };
  }

  return {
    ...base,
    sourceHtml: html,
    title: extractedMeta.title,
  };
}

function resolveContentSource(params: {
  html: string;
  url: string;
  includeMetadata: boolean;
  signal?: AbortSignal;
  inputTruncated?: boolean;
}): ContentSource {
  const {
    article,
    metadata: extractedMeta,
    document,
    truncated,
  } = extractContentContext(params.html, params.url, {
    extractArticle: true,
    ...(params.signal ? { signal: params.signal } : {}),
    ...(params.inputTruncated ? { inputTruncated: true } : {}),
  });

  const useArticleContent = article
    ? shouldUseArticleContent(article, document)
    : false;

  return buildContentSource({
    html: params.html,
    url: params.url,
    article,
    extractedMeta,
    includeMetadata: params.includeMetadata,
    useArticleContent,
    document,
    truncated: truncated ?? false,
    ...(params.signal ? { signal: params.signal } : {}),
  });
}

function maybeStripGithubPrimaryHeading(
  markdown: string,
  context: ContentSource,
  url: string
): string {
  if (
    context.primaryHeading === undefined ||
    !TransformHeuristics.isGithubRepositoryRootUrl(url)
  ) {
    return markdown;
  }
  return stripLeadingHeading(markdown, context.primaryHeading);
}

function buildSyntheticTitlePrefix(
  url: string,
  favicon?: string,
  suppressFavicon?: boolean
): string {
  if (!favicon || suppressFavicon) return ' ';

  let alt = '';
  try {
    alt = new URL(url).hostname;
  } catch {
    /* skip */
  }

  return ` ![${alt}](${favicon}) `;
}

function maybePrependSyntheticTitle(
  markdown: string,
  context: ContentSource,
  url: string
): string {
  if (!context.title || /^(#{1,6})\s/.test(markdown.trimStart())) {
    return markdown;
  }

  return `#${buildSyntheticTitlePrefix(
    url,
    context.favicon,
    context.suppressSyntheticFavicon
  )}${context.title}\n\n${markdown}`;
}

function buildMarkdownFromContext(
  context: ContentSource,
  url: string,
  signal?: AbortSignal
): MarkdownTransformResult {
  let content = stageTracker.run(url, 'transform:markdown', () =>
    htmlToMarkdown(context.sourceHtml, context.metadata, {
      url,
      ...(signal ? { signal } : {}),
      ...(context.document ? { document: context.document } : {}),
      ...(context.skipNoiseRemoval ? { skipNoiseRemoval: true } : {}),
    })
  );
  content = maybeStripGithubPrimaryHeading(content, context, url);
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

function normalizeHeadingText(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

function stripLeadingHeading(markdown: string, headingText: string): string {
  if (!markdown) return markdown;

  const lines = markdown.split('\n');
  const target = normalizeHeadingText(headingText);
  let nonEmptySeen = 0;

  for (
    let i = 0;
    i < lines.length && nonEmptySeen < HEADING_SCAN_LIMIT;
    i += 1
  ) {
    const trimmed = lines[i]?.trim() ?? '';
    if (!trimmed) continue;

    nonEmptySeen += 1;
    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(trimmed);
    if (!match) continue;

    const current = normalizeHeadingText(match[2] ?? '');
    if (current !== target) return markdown;

    lines.splice(i, 1);
    if ((lines[i] ?? '').trim() === '') {
      lines.splice(i, 1);
    }
    return lines.join('\n');
  }

  return markdown;
}

const REPLACEMENT_CHAR = '\ufffd';
const BINARY_INDICATOR_THRESHOLD = 0.1;

function hasBinaryIndicators(content: string): boolean {
  if (!content || content.length === 0) return false;

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

    const result =
      stageTracker.run(url, 'transform:raw', () =>
        tryTransformRawContent({
          html,
          url,
          includeMetadata: options.includeMetadata,
          ...(options.inputTruncated ? { inputTruncated: true } : {}),
        })
      ) ??
      ((): MarkdownTransformResult => {
        const context = stageTracker.run(url, 'transform:extract', () =>
          resolveContentSource({
            html,
            url,
            includeMetadata: options.includeMetadata,
            ...(signal ? { signal } : {}),
            ...(options.inputTruncated ? { inputTruncated: true } : {}),
          })
        );
        return buildMarkdownFromContext(context, url, signal);
      })();

    stageTracker.end(totalStage, { truncated: result.truncated });
    return result;
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
    ...(options.inputTruncated ? { inputTruncated: true } : {}),
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
  const workerStage = stageTracker.start(url, 'transform:worker');
  try {
    return await transformWithWorkerPool(htmlOrBuffer, url, options);
  } catch (error: unknown) {
    return resolveWorkerFallback(error, htmlOrBuffer, url, options);
  } finally {
    stageTracker.end(workerStage);
  }
}

async function transformInputToMarkdown(
  htmlOrBuffer: string | Uint8Array,
  url: string,
  options: TransformExecutionOptions
): Promise<MarkdownTransformResult> {
  const totalStage = stageTracker.start(url, 'transform:total');

  try {
    throwIfAborted(options.signal, url, 'transform:begin');
    const result = await runWorkerTransformWithFallback(
      htmlOrBuffer,
      url,
      options
    );
    stageTracker.end(totalStage, { truncated: result.truncated });
    return result;
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
