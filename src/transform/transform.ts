import { Buffer } from 'node:buffer';
import diagnosticsChannel from 'node:diagnostics_channel';
import { performance } from 'node:perf_hooks';

import { isProbablyReaderable, Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import {
  NodeHtmlMarkdown,
  type TranslatorConfig,
  type TranslatorConfigObject,
} from 'node-html-markdown';

import { config } from '../config.js';
import { removeNoiseFromHtml } from '../dom-noise-removal.js';
import { FetchError, getErrorMessage } from '../errors.js';
import { isRawTextContentUrl } from '../fetch.js';
import {
  detectLanguageFromCode,
  resolveLanguageFromAttributes,
} from '../language-detection.js';
import {
  addSourceToMarkdown,
  buildMetadataFooter,
  cleanupMarkdownArtifacts,
  extractTitleFromRawMarkdown,
  isRawTextContent,
} from '../markdown-cleanup.js';
import {
  getOperationId,
  getRequestId,
  logDebug,
  logError,
  logInfo,
  logWarn,
  redactUrl,
} from '../observability.js';
import { isLikeNode, isObject } from '../type-guards.js';
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

const utf8Decoder = new TextDecoder('utf-8');

function decodeInput(input: string | Uint8Array, encoding?: string): string {
  if (typeof input === 'string') return input;

  const normalizedEncoding = encoding?.trim().toLowerCase();
  if (
    !normalizedEncoding ||
    normalizedEncoding === 'utf-8' ||
    normalizedEncoding === 'utf8'
  ) {
    return utf8Decoder.decode(input);
  }

  try {
    return new TextDecoder(normalizedEncoding).decode(input);
  } catch {
    return utf8Decoder.decode(input);
  }
}

function getTagName(node: unknown): string {
  if (!isLikeNode(node)) return '';
  const raw = node.tagName;
  return typeof raw === 'string' ? raw.toUpperCase() : '';
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

function getAbortReason(signal: AbortSignal): unknown {
  const record = isObject(signal) ? (signal as Record<string, unknown>) : null;
  return record && 'reason' in record ? record['reason'] : undefined;
}

function isTimeoutAbortReason(reason: unknown): boolean {
  return reason instanceof Error && reason.name === 'TimeoutError';
}

function throwIfAborted(
  signal: AbortSignal | undefined,
  url: string,
  stage: string
): void {
  if (!signal?.aborted) return;

  const reason = getAbortReason(signal);
  if (isTimeoutAbortReason(reason)) {
    throw new FetchError('Request timeout', url, 504, {
      reason: 'timeout',
      stage,
    });
  }

  throw new FetchError('Request was canceled', url, 499, {
    reason: 'aborted',
    stage,
  });
}

function createAbortError(url: string, stage: string): FetchError {
  return new FetchError('Request was canceled', url, 499, {
    reason: 'aborted',
    stage,
  });
}

const abortPolicy = { throwIfAborted, createAbortError };

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
  const lastOpen = content.lastIndexOf('<');
  const lastClose = content.lastIndexOf('>');
  return lastOpen > lastClose ? content.substring(0, lastOpen) : content;
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

const HEAD_END_PATTERN = /<\/head\s*>|<body\b/i;
const MAX_HEAD_SCAN_LENGTH = 50_000;

function extractHeadSection(html: string): string | null {
  if (html.length <= MAX_HEAD_SCAN_LENGTH) {
    const match = HEAD_END_PATTERN.exec(html);
    return match ? html.substring(0, match.index) : null;
  }

  const searchText = html.substring(0, MAX_HEAD_SCAN_LENGTH);

  const match = HEAD_END_PATTERN.exec(searchText);
  if (!match) return null;

  return html.substring(0, match.index);
}

function extractMetadataFromHead(
  html: string,
  baseUrl?: string
): ExtractedMetadata | null {
  const headSection = extractHeadSection(html);
  if (!headSection) return null;

  try {
    const { document } = parseHTML(
      `<!DOCTYPE html><html>${headSection}</head><body></body></html>`
    );
    return extractMetadata(document, baseUrl);
  } catch {
    return null;
  }
}

function mergeMetadata(
  early: ExtractedMetadata | null,
  late: ExtractedMetadata
): ExtractedMetadata {
  if (!early) return late;

  const merged: ExtractedMetadata = {};
  const keys = [
    'title',
    'description',
    'author',
    'image',
    'publishedAt',
    'modifiedAt',
  ] as const;
  for (const key of keys) {
    const value = late[key] ?? early[key];
    if (value !== undefined) merged[key] = value;
  }

  return merged;
}

interface MetaContext {
  title: { og?: string; twitter?: string; standard?: string };
  description: { og?: string; twitter?: string; standard?: string };
  author?: string;
  image?: string;
  publishedAt?: string;
  modifiedAt?: string;
}

const META_PROPERTY_HANDLERS = new Map<
  string,
  (ctx: MetaContext, content: string) => void
>([
  [
    'og:title',
    (ctx, c) => {
      ctx.title.og = c;
    },
  ],
  [
    'og:description',
    (ctx, c) => {
      ctx.description.og = c;
    },
  ],
  [
    'og:image',
    (ctx, c) => {
      ctx.image = c;
    },
  ],
  [
    'article:published_time',
    (ctx, c) => {
      ctx.publishedAt = c;
    },
  ],
  [
    'article:modified_time',
    (ctx, c) => {
      ctx.modifiedAt = c;
    },
  ],
]);

const META_NAME_HANDLERS = new Map<
  string,
  (ctx: MetaContext, content: string) => void
>([
  [
    'twitter:title',
    (ctx, c) => {
      ctx.title.twitter = c;
    },
  ],
  [
    'twitter:description',
    (ctx, c) => {
      ctx.description.twitter = c;
    },
  ],
  [
    'description',
    (ctx, c) => {
      ctx.description.standard = c;
    },
  ],
  [
    'author',
    (ctx, c) => {
      ctx.author = c;
    },
  ],
]);

function processMetaTag(ctx: MetaContext, tag: Element): void {
  const content = tag.getAttribute('content')?.trim();
  if (!content) return;

  const property = tag.getAttribute('property');
  if (property) META_PROPERTY_HANDLERS.get(property)?.(ctx, content);

  const name = tag.getAttribute('name');
  if (name) META_NAME_HANDLERS.get(name)?.(ctx, content);
}

function buildMetaContext(document: Document): MetaContext {
  const ctx: MetaContext = { title: {}, description: {} };

  for (const tag of document.querySelectorAll('meta')) {
    processMetaTag(ctx, tag);
  }

  const titleEl = document.querySelector('title');
  if (!ctx.title.standard && titleEl?.textContent) {
    ctx.title.standard = titleEl.textContent.trim();
  }

  return ctx;
}

function resolveMetadataFromContext(ctx: MetaContext): ExtractedMetadata {
  const metadata: ExtractedMetadata = {};

  const resolvedTitle = ctx.title.og ?? ctx.title.twitter ?? ctx.title.standard;
  const resolvedDesc =
    ctx.description.og ?? ctx.description.twitter ?? ctx.description.standard;

  if (resolvedTitle) metadata.title = resolvedTitle;
  if (resolvedDesc) metadata.description = resolvedDesc;
  if (ctx.author) metadata.author = ctx.author;
  if (ctx.image) metadata.image = ctx.image;
  if (ctx.publishedAt) metadata.publishedAt = ctx.publishedAt;
  if (ctx.modifiedAt) metadata.modifiedAt = ctx.modifiedAt;

  return metadata;
}

function extractMetadata(
  document: Document,
  baseUrl?: string
): ExtractedMetadata {
  const ctx = buildMetaContext(document);
  const metadata = resolveMetadataFromContext(ctx);
  if (baseUrl) {
    const icon32 = document.querySelector<HTMLLinkElement>(
      'link[rel="icon"][sizes="32x32"]'
    );
    const href = icon32?.getAttribute('href');
    if (href) {
      const resolved = resolveFaviconUrl(href, baseUrl);
      if (resolved) metadata.favicon = resolved;
    }
  }

  return metadata;
}

function resolveFaviconUrl(href: string, baseUrl: string): string | undefined {
  const trimmed = href.trim();
  if (!trimmed) return undefined;
  if (trimmed.toLowerCase().startsWith('data:')) return undefined;

  try {
    const resolved = new URL(trimmed, baseUrl);
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
      return undefined;
    }
    return resolved.toString();
  } catch {
    return undefined;
  }
}

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
    const doc = document;

    // F1: Check abort before DOM text content extraction
    abortPolicy.throwIfAborted(signal, url, 'extract:article:textCheck');

    const rawText =
      doc.querySelector('body')?.textContent ??
      (doc.documentElement.textContent as string | null | undefined) ??
      '';
    const textLength = resolveCollapsedTextLengthUpTo(rawText, 401);

    if (textLength < 100) {
      logWarn(
        'Very minimal server-rendered content detected (< 100 chars). ' +
          'This might be a client-side rendered (SPA) application. ' +
          'Content extraction may be incomplete.',
        { textLength }
      );
    }

    // F1: Check abort before isProbablyReaderable (DOM traversal)
    abortPolicy.throwIfAborted(signal, url, 'extract:article:readabilityCheck');

    if (textLength >= 400 && !isProbablyReaderable(doc)) {
      return null;
    }

    // F1: Check abort before cloning document
    abortPolicy.throwIfAborted(signal, url, 'extract:article:clone');

    const readabilityDoc =
      typeof doc.cloneNode === 'function'
        ? (doc.cloneNode(true) as Document)
        : doc;

    // F1: Check abort before heavy Readability parse
    abortPolicy.throwIfAborted(signal, url, 'extract:article:parse');

    const reader = new Readability(readabilityDoc, {
      maxElemsToParse: 20_000,
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
    const { document } = parseHTML('<html></html>');
    return { article: null, metadata: {}, document };
  }

  try {
    abortPolicy.throwIfAborted(options.signal, url, 'extract:begin');

    // F2: Extract metadata from <head> BEFORE truncation to preserve it
    const earlyMetadata = willTruncate(html)
      ? stageTracker.run(url, 'extract:early-metadata', () =>
          extractMetadataFromHead(html, url)
        )
      : null;

    const { html: limitedHtml, truncated } = truncateHtml(
      html,
      options.inputTruncated
    );

    const { document } = stageTracker.run(url, 'extract:parse', () =>
      parseHTML(limitedHtml)
    );
    abortPolicy.throwIfAborted(options.signal, url, 'extract:parsed');

    applyBaseUri(document, url);

    const lateMetadata = stageTracker.run(url, 'extract:metadata', () =>
      extractMetadata(document, url)
    );
    abortPolicy.throwIfAborted(options.signal, url, 'extract:metadata');

    // Merge early (pre-truncation) with late (post-truncation) metadata
    const metadata = mergeMetadata(earlyMetadata, lateMetadata);

    const article = options.extractArticle
      ? stageTracker.run(url, 'extract:article', () =>
          extractArticle(document, url, options.signal)
        )
      : null;

    abortPolicy.throwIfAborted(options.signal, url, 'extract:article');

    return {
      article,
      metadata,
      document,
      ...(truncated ? { truncated: true } : {}),
    };
  } catch (error: unknown) {
    if (error instanceof FetchError) throw error;

    abortPolicy.throwIfAborted(options.signal, url, 'extract:error');

    logError('Failed to extract content', asError(error));

    const { document } = parseHTML('<html></html>');
    return { article: null, metadata: {}, document };
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

const CODE_BLOCK = {
  fence: '```',
  format: (code: string, language = ''): string =>
    `\`\`\`${language}\n${code}\n\`\`\``,
};

function buildInlineCode(content: string): string {
  const trimmed = content.trim();
  if (!trimmed) return '``';

  let maxBackticks = 0;
  let currentRun = 0;

  for (const char of trimmed) {
    if (char === '`') currentRun += 1;
    else {
      if (currentRun > maxBackticks) maxBackticks = currentRun;
      currentRun = 0;
    }
  }
  if (currentRun > maxBackticks) maxBackticks = currentRun;

  const delimiter = '`'.repeat(maxBackticks + 1);
  const padding = trimmed.startsWith('`') || trimmed.endsWith('`') ? ' ' : '';
  return `${delimiter}${padding}${trimmed}${padding}${delimiter}`;
}

function deriveAltFromImageUrl(src: string): string {
  if (!src) return '';

  try {
    const isAbsolute = URL.canParse(src);
    let parsed: URL | null = null;
    if (isAbsolute) {
      parsed = new URL(src);
    } else if (URL.canParse(src, 'http://localhost')) {
      parsed = new URL(src, 'http://localhost');
    }

    if (!parsed) return '';
    if (
      isAbsolute &&
      parsed.protocol !== 'http:' &&
      parsed.protocol !== 'https:'
    ) {
      return '';
    }

    const { pathname } = parsed;
    const segments = pathname.split('/');
    const filename = segments.pop() ?? '';
    if (!filename) return '';

    const dotIndex = filename.lastIndexOf('.');
    const name = dotIndex > 0 ? filename.slice(0, dotIndex) : filename;

    return name.replace(/[_-]+/g, ' ').trim();
  } catch {
    return '';
  }
}

function hasGetAttribute(
  value: unknown
): value is { getAttribute: (name: string) => string | null } {
  return (
    isObject(value) &&
    typeof (value as { getAttribute?: unknown }).getAttribute === 'function'
  );
}

function isCodeBlock(
  parent: unknown
): parent is { tagName?: string; childNodes?: unknown[] } {
  const tagName = getTagName(parent);
  return tagName === 'PRE' || tagName === 'WRAPPED-PRE';
}

function isAnchor(node: unknown): node is { tagName?: string } {
  return getTagName(node) === 'A';
}

function resolveAttributeLanguage(node: unknown): string | undefined {
  const getAttribute = hasGetAttribute(node)
    ? node.getAttribute.bind(node)
    : undefined;
  const className = getAttribute?.('class') ?? '';
  const dataLanguage = getAttribute?.('data-language') ?? '';
  return resolveLanguageFromAttributes(className, dataLanguage);
}

function findLanguageFromCodeChild(node: unknown): string | undefined {
  if (!isLikeNode(node)) return undefined;

  const childNodes = Array.from(node.childNodes ?? []);

  for (const child of childNodes) {
    if (!isLikeNode(child)) continue;

    const raw = child.rawTagName;
    const tagName = typeof raw === 'string' ? raw.toUpperCase() : '';

    if (tagName === 'CODE') return resolveAttributeLanguage(child);
  }

  return undefined;
}

function createCodeBlockPostprocessor(
  language: string | undefined
): (params: { content: string }) => string {
  return ({ content }: { content: string }) => {
    const trimmed = content.trim();
    if (!trimmed) return '';
    const resolvedLanguage = language ?? detectLanguageFromCode(trimmed) ?? '';
    return CODE_BLOCK.format(trimmed, resolvedLanguage);
  };
}

function buildInlineCodeTranslator(): TranslatorConfig {
  return {
    spaceIfRepeatingChar: true,
    noEscape: true,
    postprocess: ({ content }: { content: string }) => buildInlineCode(content),
  };
}

function buildCodeTranslator(ctx: unknown): TranslatorConfig {
  const inlineCodeTranslator = buildInlineCodeTranslator();
  if (!isObject(ctx)) return inlineCodeTranslator;
  const { parent } = ctx as { parent?: unknown };
  if (!isCodeBlock(parent)) return inlineCodeTranslator;

  return { noEscape: true, preserveWhitespace: true };
}

function extractFirstSrcsetUrl(srcset: string): string {
  const first = srcset.split(',')[0];
  if (!first) return '';
  return first.trim().split(/\s+/)[0] ?? '';
}

const LAZY_SRC_ATTRIBUTES = [
  'data-src',
  'data-lazy-src',
  'data-original',
  'data-srcset',
] as const;

function isDataUri(value: string): boolean {
  return value.startsWith('data:');
}

function extractNonDataSrcsetUrl(value: string): string | undefined {
  const url = extractFirstSrcsetUrl(value);
  return url && !isDataUri(url) ? url : undefined;
}

function resolveLazySrc(
  getAttribute: (name: string) => string | null
): string | undefined {
  for (const attr of LAZY_SRC_ATTRIBUTES) {
    const lazy = getAttribute(attr);
    if (!lazy || isDataUri(lazy)) continue;

    if (attr === 'data-srcset') {
      const url = extractNonDataSrcsetUrl(lazy);
      if (url) return url;
      continue;
    }

    return lazy;
  }
  return undefined;
}

function resolveImageSrc(
  getAttribute: ((name: string) => string | null) | undefined
): string {
  if (!getAttribute) return '';

  const srcRaw = getAttribute('src') ?? '';
  if (srcRaw && !isDataUri(srcRaw)) return srcRaw;

  // First check common lazy-loading attributes that may contain non-data URLs before falling back to the native srcset, as some sites use data URIs in lazy attributes while still providing valid URLs in srcset.
  const lazySrc = resolveLazySrc(getAttribute);
  if (lazySrc) return lazySrc;

  // If the src is a data URI or missing, check srcset for a valid URL. Some sites use srcset with data URIs in src and actual URLs in srcset for responsive images.
  const srcset = getAttribute('srcset');
  if (srcset) {
    const url = extractNonDataSrcsetUrl(srcset);
    if (url) return url;
  }

  // If the only available src is a data URI, we choose to omit it rather than include the raw data in the alt text or URL, as data URIs can be very long and are not useful in Markdown output.
  if (isDataUri(srcRaw)) return '[data URI removed]';

  return '';
}

function buildImageTranslator(ctx: unknown): TranslatorConfig {
  if (!isObject(ctx)) return { content: '' };

  const { node, parent } = ctx as { node?: unknown; parent?: unknown };
  const getAttribute = hasGetAttribute(node)
    ? node.getAttribute.bind(node)
    : undefined;

  const src = resolveImageSrc(getAttribute);

  const existingAlt = getAttribute?.('alt') ?? '';
  const alt = existingAlt.trim() || deriveAltFromImageUrl(src);

  const markdown = `![${alt}](${src})`;

  if (isAnchor(parent)) {
    return { content: markdown };
  }

  return { content: `\n\n${markdown}\n\n` };
}

const GFM_ALERT_MAP: ReadonlyMap<string, string> = new Map([
  ['note', 'NOTE'],
  ['info', 'NOTE'],
  ['tip', 'TIP'],
  ['hint', 'TIP'],
  ['warning', 'WARNING'],
  ['warn', 'WARNING'],
  ['caution', 'CAUTION'],
  ['danger', 'CAUTION'],
  ['important', 'IMPORTANT'],
]);

function resolveGfmAlertType(className: string): string | undefined {
  const lower = className.toLowerCase();
  for (const [key, type] of GFM_ALERT_MAP) {
    if (lower.includes(key)) return type;
  }
  return undefined;
}

function resolveDlNodeName(child: unknown): string {
  if (!isLikeNode(child)) return '';
  const raw = child.nodeName;
  return typeof raw === 'string' ? raw.toUpperCase() : '';
}

function resolveDlTextContent(child: unknown): string {
  if (!isLikeNode(child)) return '';
  const raw = child.textContent;
  return typeof raw === 'string' ? raw.trim() : '';
}

function buildDlChildFragment(child: unknown): string | null {
  const nodeName = resolveDlNodeName(child);
  if (nodeName === 'DT') return `**${resolveDlTextContent(child)}**\n`;
  if (nodeName === 'DD') return `: ${resolveDlTextContent(child)}\n`;
  return null;
}

function hasComplexTableLayout(node: unknown): boolean {
  if (!isLikeNode(node)) return false;
  const innerHTML = typeof node.innerHTML === 'string' ? node.innerHTML : '';
  return /(?:colspan|rowspan)=["']?[2-9]/i.test(innerHTML);
}

function buildPreTranslator(ctx: unknown): TranslatorConfig {
  if (!isObject(ctx)) return {};

  const { node } = ctx as { node?: unknown };
  const attributeLanguage =
    resolveAttributeLanguage(node) ?? findLanguageFromCodeChild(node);

  return {
    noEscape: true,
    preserveWhitespace: true,
    postprocess: createCodeBlockPostprocessor(attributeLanguage),
  };
}

function getNodeAttr(
  node: unknown
): ((name: string) => string | null) | undefined {
  if (!isLikeNode(node)) return undefined;
  return typeof node.getAttribute === 'function'
    ? node.getAttribute.bind(node)
    : undefined;
}

function buildDivTranslator(ctx: unknown): Record<string, unknown> {
  if (!isObject(ctx)) return {};
  const { node } = ctx as { node?: unknown };
  const getAttribute = getNodeAttr(node);
  if (!getAttribute) return {};

  const className = getAttribute('class') ?? '';
  if (className.includes('mermaid')) {
    return {
      noEscape: true,
      preserveWhitespace: true,
      postprocess: ({ content }: { content: string }) =>
        `\n\n\`\`\`mermaid\n${content.trim()}\n\`\`\`\n\n`,
    };
  }
  const isAdmonition =
    className.includes('admonition') ||
    className.includes('callout') ||
    className.includes('custom-block') ||
    getAttribute('role') === 'alert' ||
    /\b(note|tip|info|warning|danger|caution|important)\b/i.test(className);
  if (isAdmonition) {
    return {
      postprocess: ({ content }: { content: string }) => {
        const alertType = resolveGfmAlertType(className);
        const lines = content.trim().split('\n');
        const header = alertType ? `> [!${alertType}]\n` : '';
        return `\n\n${header}> ${lines.join('\n> ')}\n\n`;
      },
    };
  }

  if (!className.includes('type')) return {};

  return {
    postprocess: ({ content }: { content: string }) => {
      const lines = content.split('\n');
      const separated: string[] = [];

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? '';
        const nextLine = i < lines.length - 1 ? (lines[i + 1] ?? '') : '';

        separated.push(line);

        if (
          line.trim() &&
          nextLine.trim() &&
          line.includes(':') &&
          nextLine.includes(':') &&
          !line.startsWith(' ') &&
          !nextLine.startsWith(' ')
        ) {
          separated.push('');
        }
      }

      return separated.join('\n');
    },
  };
}

function buildSectionTranslator(ctx: unknown): Record<string, unknown> {
  if (isObject(ctx)) {
    const { node } = ctx as { node?: unknown };
    const getAttribute = getNodeAttr(node);
    if (getAttribute?.('class')?.includes('tsd-member')) {
      return {
        postprocess: ({ content }: { content: string }) =>
          `\n\n&nbsp;\n\n${content}\n\n`,
      };
    }
  }
  return {
    postprocess: ({ content }: { content: string }) => `\n\n${content}\n\n`,
  };
}

function buildSpanTranslator(ctx: unknown): Record<string, unknown> {
  if (!isObject(ctx)) return {};
  const { node } = ctx as { node?: unknown };
  const getAttribute = getNodeAttr(node);
  if (!getAttribute) return {};

  const dataAs = getAttribute('data-as') ?? '';
  if (dataAs === 'p') {
    return {
      postprocess: ({ content }: { content: string }) =>
        `\n\n${content.trim()}\n\n`,
    };
  }
  return {};
}

function buildMermaidPreTranslator(ctx: unknown): TranslatorConfig {
  if (!isObject(ctx)) return buildPreTranslator(ctx);
  const { node } = ctx as { node?: unknown };
  const getAttribute = getNodeAttr(node);
  if (!getAttribute) return buildPreTranslator(ctx);

  const className = getAttribute('class') ?? '';
  if (className.includes('mermaid')) {
    return {
      noEscape: true,
      preserveWhitespace: true,
      postprocess: ({ content }: { content: string }) =>
        `\n\n\`\`\`mermaid\n${content.trim()}\n\`\`\`\n\n`,
    };
  }

  return buildPreTranslator(ctx);
}

function createCustomTranslators(): TranslatorConfigObject {
  return {
    code: (ctx: unknown) => buildCodeTranslator(ctx),
    img: (ctx: unknown) => buildImageTranslator(ctx),
    table: (ctx: unknown) => {
      if (!isObject(ctx)) return {};
      const { node } = ctx as { node?: unknown };
      if (hasComplexTableLayout(node)) {
        return {
          postprocess: ({ content }: { content: string }) => {
            const trimmed = content.trim();
            if (!trimmed) return '';
            return `\n\n${trimmed}\n\n`;
          },
        };
      }
      return {};
    },
    dl: (ctx: unknown) => {
      if (!isObject(ctx)) return { content: '' };
      const { node } = ctx as { node?: unknown };
      if (!isLikeNode(node)) return { content: '' };

      const childNodes = Array.from(node.childNodes ?? []);

      let items = '';
      for (const child of childNodes) {
        const fragment = buildDlChildFragment(child);
        if (fragment !== null) items += fragment;
      }

      return { content: items ? `\n${items}\n` : '' };
    },
    div: buildDivTranslator,
    kbd: () => ({
      postprocess: ({ content }: { content: string }) => `\`${content}\``,
    }),
    mark: () => ({
      postprocess: ({ content }: { content: string }) => `==${content}==`,
    }),
    sub: () => ({
      postprocess: ({ content }: { content: string }) => `~${content}~`,
    }),
    sup: () => ({
      postprocess: ({ content }: { content: string }) => `^${content}^`,
    }),
    section: buildSectionTranslator,
    details: () => ({
      postprocess: ({ content }: { content: string }) => {
        const trimmed = content.trim();
        if (!trimmed) return '';
        return `\n\n${trimmed}\n\n`;
      },
    }),
    summary: () => ({
      postprocess: ({ content }: { content: string }) =>
        `${content.trim()}\n\n`,
    }),
    span: buildSpanTranslator,
    pre: buildMermaidPreTranslator,
  };
}

let markdownConverter: NodeHtmlMarkdown | null = null;

function getMarkdownConverter(): NodeHtmlMarkdown {
  markdownConverter ??= new NodeHtmlMarkdown(
    {
      codeFence: CODE_BLOCK.fence,
      codeBlockStyle: 'fenced',
      emDelimiter: '_',
      bulletMarker: '-',
      globalEscape: [/[\\`*_~]/gm, '\\$&'],
    },
    createCustomTranslators()
  );
  return markdownConverter;
}

function translateHtmlFragmentToMarkdown(html: string): string {
  return getMarkdownConverter().translate(html).trim();
}

function isWhitespaceChar(code: number): boolean {
  return code === 9 || code === 10 || code === 12 || code === 13 || code === 32;
}

function containsWhitespace(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    if (isWhitespaceChar(value.charCodeAt(i))) return true;
  }
  return false;
}

function resolveRelativeHref(
  href: string,
  baseUrl: string,
  origin: string
): string {
  const trimmedHref = href.trim();
  if (!trimmedHref || containsWhitespace(trimmedHref)) return href;
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

const FENCE_LINE_PATTERN = /^\s*(`{3,}|~{3,})/;

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

  let output = '';
  let buffer = '';
  let fenceMarker: string | null = null;

  const flushBuffer = (): void => {
    if (!buffer) return;
    output += resolveRelativeUrlsInSegment(buffer, baseUrl, origin);
    buffer = '';
  };

  const len = markdown.length;
  let lastIndex = 0;

  let lineCount = 0;
  while (lastIndex < len) {
    if (++lineCount % 500 === 0 && signal?.aborted) {
      throw new Error('Transform aborted during URL resolution');
    }
    let nextIndex = markdown.indexOf('\n', lastIndex);
    let line: string;
    let lineWithNewline: string;

    if (nextIndex === -1) {
      line = markdown.slice(lastIndex);
      lineWithNewline = line;
      nextIndex = len;
    } else {
      if (nextIndex > lastIndex && markdown.charCodeAt(nextIndex - 1) === 13) {
        line = markdown.slice(lastIndex, nextIndex - 1);
      } else {
        line = markdown.slice(lastIndex, nextIndex);
      }
      lineWithNewline = markdown.slice(lastIndex, nextIndex + 1);
      nextIndex++; // Skip \n
    }

    const trimmed = line.trimStart();

    if (fenceMarker) {
      output += lineWithNewline;
      if (
        trimmed.startsWith(fenceMarker) &&
        trimmed.slice(fenceMarker.length).trim() === ''
      ) {
        fenceMarker = null;
      }
    } else {
      const fenceMatch = FENCE_LINE_PATTERN.exec(line);
      if (fenceMatch?.[1]) {
        flushBuffer();
        output += lineWithNewline;
        fenceMarker = fenceMatch[1];
      } else {
        buffer += lineWithNewline;
      }
    }

    lastIndex = nextIndex;
  }

  flushBuffer();
  return output;
}

function translateHtmlToMarkdown(params: {
  html: string;
  url: string;
  signal?: AbortSignal | undefined;
  document?: Document | undefined;
  skipNoiseRemoval?: boolean | undefined;
}): string {
  const { html, url, signal, document, skipNoiseRemoval } = params;

  abortPolicy.throwIfAborted(signal, url, 'markdown:begin');

  const cleanedHtml = skipNoiseRemoval
    ? html
    : stageTracker.run(url, 'markdown:noise', () =>
        removeNoiseFromHtml(html, document, url, signal)
      );

  abortPolicy.throwIfAborted(signal, url, 'markdown:cleaned');

  const content = stageTracker.run(url, 'markdown:translate', () =>
    translateHtmlFragmentToMarkdown(cleanedHtml)
  );

  abortPolicy.throwIfAborted(signal, url, 'markdown:translated');

  const cleaned = cleanupMarkdownArtifacts(
    content,
    signal ? { signal, url } : { url }
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
const MIN_HEADING_RETENTION_RATIO = 0.3;
const MIN_CODE_BLOCK_RETENTION_RATIO = 0.15;

const MIN_LINE_LENGTH_FOR_TRUNCATION_CHECK = 20;
const MAX_TRUNCATED_LINE_RATIO = 0.95;

function needsDocumentWrapper(html: string): boolean {
  const trimmed = html.trim().toLowerCase();
  return (
    !trimmed.startsWith('<!doctype') &&
    !trimmed.startsWith('<html') &&
    !trimmed.startsWith('<body')
  );
}

function wrapHtmlFragment(html: string): string {
  return `<!DOCTYPE html><html><body>${html}</body></html>`;
}

function resolveHtmlDocument(htmlOrDocument: string | Document): Document {
  if (typeof htmlOrDocument !== 'string') return htmlOrDocument;

  const htmlToParse = needsDocumentWrapper(htmlOrDocument)
    ? wrapHtmlFragment(htmlOrDocument)
    : htmlOrDocument;

  try {
    return parseHTML(htmlToParse).document;
  } catch {
    // Don't crash on parse failures.
    return parseHTML('<!DOCTYPE html><html><body></body></html>').document;
  }
}

function countDomSelector(
  htmlOrDocument: string | Document,
  selector: string
): number {
  return resolveHtmlDocument(htmlOrDocument).querySelectorAll(selector).length;
}

function countTagsInString(html: string, regex: RegExp): number {
  let count = 0;
  while (regex.exec(html) !== null) {
    count++;
  }
  return count;
}

function countHeadingsDom(htmlOrDocument: string | Document): number {
  return countDomSelector(htmlOrDocument, 'h1,h2,h3,h4,h5,h6');
}

function countCodeBlocksDom(htmlOrDocument: string | Document): number {
  return countDomSelector(htmlOrDocument, 'pre');
}

function stripNonVisibleNodes(root: ParentNode): void {
  for (const el of root.querySelectorAll('script,style,noscript')) {
    el.remove();
  }
}

function resolveNodeText(node: Node): string {
  return node.textContent ?? '';
}

function getTextContentSkippingHidden(node: Node, parts: string[]): void {
  const { nodeType } = node;
  if (nodeType === 3) {
    const { textContent } = node;
    if (textContent) parts.push(textContent);
    return;
  }
  if (nodeType !== 1) return;

  const { tagName } = node as Element;
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
    stripNonVisibleNodes(doc.body);
    return resolveNodeText(doc.body).replace(/\s+/g, ' ').trim().length;
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
    if (article.title !== undefined) metadata.title = article.title;
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
  readonly title: string | undefined;
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

function findContentRoot(document: Document): string | undefined {
  for (const selector of CONTENT_ROOT_SELECTORS) {
    const element = document.querySelector(selector);
    if (!element) continue;

    const innerHTML =
      typeof (element as HTMLElement).innerHTML === 'string'
        ? (element as HTMLElement).innerHTML
        : undefined;

    if (innerHTML && innerHTML.trim().length > 100) return innerHTML;
  }
  return undefined;
}

function shouldUseArticleContent(
  article: ExtractedArticle,
  originalHtmlOrDocument: string | Document
): boolean {
  const articleLength = article.textContent.length;
  const originalLength = getVisibleTextLength(originalHtmlOrDocument);

  if (originalLength >= MIN_HTML_LENGTH_FOR_GATE) {
    const ratio = articleLength / originalLength;
    if (ratio < MIN_CONTENT_RATIO) return false;
  }

  const originalHeadings = countHeadingsDom(originalHtmlOrDocument);
  if (originalHeadings > 0) {
    // Optimization: Use regex on article content string instead of parsing it to DOM
    const articleHeadings = countTagsInString(article.content, /<h[1-6]\b/gi);
    const retentionRatio = articleHeadings / originalHeadings;

    if (retentionRatio < MIN_HEADING_RETENTION_RATIO) return false;
  }

  const originalCodeBlocks = countCodeBlocksDom(originalHtmlOrDocument);
  if (originalCodeBlocks > 0) {
    // Optimization: Use regex on article content string
    const articleCodeBlocks = countTagsInString(article.content, /<pre\b/gi);
    const codeRetentionRatio = articleCodeBlocks / originalCodeBlocks;

    if (codeRetentionRatio < MIN_CODE_BLOCK_RETENTION_RATIO) return false;
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
  skipNoiseRemoval?: boolean;
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
    skipNoiseRemoval,
    signal,
  } = params;

  const metadata = createContentMetadataBlock(
    url,
    article,
    extractedMeta,
    useArticleContent,
    includeMetadata
  );

  const base: Pick<
    ContentSource,
    'favicon' | 'metadata' | 'extractedMetadata' | 'truncated'
  > = {
    favicon: extractedMeta.favicon,
    metadata,
    extractedMetadata: extractedMeta,
    truncated,
  };

  if (useArticleContent && article) {
    const cleanedArticleHtml = skipNoiseRemoval
      ? article.content
      : removeNoiseFromHtml(article.content, undefined, url, signal);
    return {
      ...base,
      sourceHtml: cleanedArticleHtml,
      title: article.title,
      skipNoiseRemoval: true,
    };
  }

  if (document) {
    const cleanedHtml = skipNoiseRemoval
      ? html
      : removeNoiseFromHtml(html, document, url, signal);

    const contentRoot = findContentRoot(document);
    return {
      ...base,
      sourceHtml: contentRoot ?? cleanedHtml,
      title: extractedMeta.title,
      skipNoiseRemoval: true,
      document,
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
  skipNoiseRemoval?: boolean;
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
    ...(params.skipNoiseRemoval ? { skipNoiseRemoval: true } : {}),
    ...(params.signal ? { signal: params.signal } : {}),
  });
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
  if (context.title && !content.trim().startsWith('# ')) {
    const icon = context.favicon;
    let prefix = ' ';
    if (icon) {
      let alt = '';
      try {
        alt = new URL(url).hostname;
      } catch {
        /* skip */
      }
      prefix = ` ![${alt}](${icon}) `;
    }
    content = `#${prefix}${context.title}\n\n${content}`;
  }

  return {
    markdown: content,
    title: context.title,
    truncated: context.truncated,
    metadata: context.extractedMetadata,
  };
}

const REPLACEMENT_CHAR = '\ufffd';
const BINARY_INDICATOR_THRESHOLD = 0.1;

function hasBinaryIndicators(content: string): boolean {
  if (!content || content.length === 0) return false;

  if (content.includes('\x00')) return true;

  const sampleSize = Math.min(content.length, 2000);
  const sample = content.slice(0, sampleSize);
  let replacementCount = 0;

  for (const char of sample) {
    if (char === REPLACEMENT_CHAR) replacementCount++;
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
  let completed: MarkdownTransformResult | null = null;

  try {
    abortPolicy.throwIfAborted(signal, url, 'transform:begin');
    if (hasBinaryIndicators(html)) {
      throw new FetchError(
        'Content appears to be binary data (high replacement character ratio or null bytes)',
        url,
        415,
        { reason: 'binary_content_detected', stage: 'transform:validate' }
      );
    }

    const raw = stageTracker.run(url, 'transform:raw', () =>
      tryTransformRawContent({
        html,
        url,
        includeMetadata: options.includeMetadata,
        ...(options.inputTruncated ? { inputTruncated: true } : {}),
      })
    );
    if (raw) {
      completed = raw;
      return raw;
    }

    const context = stageTracker.run(url, 'transform:extract', () =>
      resolveContentSource({
        html,
        url,
        includeMetadata: options.includeMetadata,
        ...(signal ? { signal } : {}),
        ...(options.skipNoiseRemoval ? { skipNoiseRemoval: true } : {}),
        ...(options.inputTruncated ? { inputTruncated: true } : {}),
      })
    );

    const result = buildMarkdownFromContext(context, url, signal);
    completed = result;
    return result;
  } finally {
    endTotalTransformStage(totalStage, completed);
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

function endTotalTransformStage(
  context: TransformStageContext | null,
  result: MarkdownTransformResult | null
): void {
  if (!result) {
    stageTracker.end(context);
    return;
  }

  stageTracker.end(context, { truncated: result.truncated });
}

function buildWorkerTransformOptions(options: TransformOptions): {
  includeMetadata: boolean;
  signal?: AbortSignal;
  skipNoiseRemoval?: boolean;
  inputTruncated?: boolean;
} {
  return {
    includeMetadata: options.includeMetadata,
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.skipNoiseRemoval ? { skipNoiseRemoval: true } : {}),
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
    return pool.transform(
      htmlOrBuffer,
      url,
      buildWorkerTransformOptions(options)
    );
  }
  return pool.transform(htmlOrBuffer, url, {
    ...buildWorkerTransformOptions(options),
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

  abortPolicy.throwIfAborted(options.signal, url, 'transform:worker-fallback');

  if (error instanceof FetchError) throw error;

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
  let completed: MarkdownTransformResult | null = null;

  try {
    abortPolicy.throwIfAborted(options.signal, url, 'transform:begin');
    const result = await runWorkerTransformWithFallback(
      htmlOrBuffer,
      url,
      options
    );
    completed = result;
    return result;
  } finally {
    endTotalTransformStage(totalStage, completed);
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
