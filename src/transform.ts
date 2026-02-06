import { AsyncLocalStorage, AsyncResource } from 'node:async_hooks';
import { Buffer } from 'node:buffer';
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import diagnosticsChannel from 'node:diagnostics_channel';
import { availableParallelism } from 'node:os';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import {
  type Transferable as NodeTransferable,
  Worker,
} from 'node:worker_threads';

import { parseHTML } from 'linkedom';
import {
  NodeHtmlMarkdown,
  type TranslatorConfig,
  type TranslatorConfigObject,
} from 'node-html-markdown';

import { isProbablyReaderable, Readability } from '@mozilla/readability';

import { config } from './config.js';
import { removeNoiseFromHtml } from './dom-noise-removal.js';
import { FetchError, getErrorMessage } from './errors.js';
import { isRawTextContentUrl } from './fetch.js';
import {
  detectLanguageFromCode,
  resolveLanguageFromAttributes,
} from './language-detection.js';
import {
  addSourceToMarkdown,
  buildMetadataFooter,
  cleanupMarkdownArtifacts,
  extractTitleFromRawMarkdown,
  isRawTextContent,
} from './markdown-cleanup.js';
import {
  getOperationId,
  getRequestId,
  logDebug,
  logError,
  logInfo,
  logWarn,
  redactUrl,
} from './observability.js';
import { type CancellableTimeout, createUnrefTimeout } from './timer-utils.js';
import type {
  ExtractedArticle,
  ExtractedMetadata,
  ExtractionResult,
  MarkdownTransformResult,
  MetadataBlock,
  TransformOptions,
  TransformStageContext,
  TransformStageEvent,
  TransformWorkerCancelMessage,
  TransformWorkerOutgoingMessage,
  TransformWorkerTransformMessage,
} from './transform-types.js';
import { isObject } from './type-guards.js';

const utf8Decoder = new TextDecoder('utf-8');

function decodeUtf8Input(input: string | Uint8Array): string {
  return typeof input === 'string' ? input : utf8Decoder.decode(input);
}

function getTagName(node: unknown): string {
  if (!isObject(node)) return '';
  const raw = (node as { tagName?: unknown }).tagName;
  return typeof raw === 'string' ? raw.toUpperCase() : '';
}

interface ExtractionContext extends ExtractionResult {
  document: Document;
  truncated?: boolean;
}

export interface StageBudget {
  totalBudgetMs: number;
  elapsedMs: number;
}

function getAbortReason(signal: AbortSignal): unknown {
  const record = isObject(signal) ? (signal as Record<string, unknown>) : null;
  return record && 'reason' in record ? record.reason : undefined;
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
  private readonly channel = diagnosticsChannel.channel('superfetch.transform');

  start(
    url: string,
    stage: string,
    budget?: StageBudget
  ): TransformStageContext | null {
    if (!this.channel.hasSubscribers && !budget) return null;

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
    if (!this.channel.hasSubscribers && !budget) {
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
    const ctx = this.start(url, stage);
    try {
      return await fn();
    } finally {
      this.end(ctx);
    }
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

function truncateHtml(html: string): { html: string; truncated: boolean } {
  const maxSize = config.constants.maxHtmlSize;
  if (maxSize <= 0) return { html, truncated: false };

  // Fast path: V8 optimized byte length check (no allocation)
  const byteLength = Buffer.byteLength(html, 'utf8');
  if (byteLength <= maxSize) return { html, truncated: false };

  const htmlBuffer = Buffer.from(html, 'utf8');
  let content = trimUtf8Buffer(htmlBuffer, maxSize).toString('utf8');

  // Avoid truncating inside tags.
  const lastOpen = content.lastIndexOf('<');
  const lastClose = content.lastIndexOf('>');

  if (lastOpen > lastClose) {
    content = content.substring(0, lastOpen);
  }

  logWarn('HTML content exceeds maximum size, truncating', {
    size: byteLength,
    maxSize,
    truncatedSize: Buffer.byteLength(content, 'utf8'),
  });
  return { html: content, truncated: true };
}

function willTruncate(html: string): boolean {
  const maxSize = config.constants.maxHtmlSize;
  return maxSize > 0 && getUtf8ByteLength(html) > maxSize;
}

const HEAD_END_PATTERN = /<\/head\s*>|<body\b/i;
const MAX_HEAD_SCAN_LENGTH = 50_000;

function extractHeadSection(html: string): string | null {
  const searchLimit = Math.min(html.length, MAX_HEAD_SCAN_LENGTH);
  const searchText = html.substring(0, searchLimit);

  const match = HEAD_END_PATTERN.exec(searchText);
  if (!match) return null;

  return html.substring(0, match.index);
}

function extractMetadataFromHead(html: string): ExtractedMetadata | null {
  const headSection = extractHeadSection(html);
  if (!headSection) return null;

  try {
    const { document } = parseHTML(
      `<!DOCTYPE html><html>${headSection}</head><body></body></html>`
    );
    return extractMetadata(document);
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
  const title = late.title ?? early.title;
  const description = late.description ?? early.description;
  const author = late.author ?? early.author;
  const image = late.image ?? early.image;
  const publishedAt = late.publishedAt ?? early.publishedAt;
  const modifiedAt = late.modifiedAt ?? early.modifiedAt;

  if (title !== undefined) merged.title = title;
  if (description !== undefined) merged.description = description;
  if (author !== undefined) merged.author = author;
  if (image !== undefined) merged.image = image;
  if (publishedAt !== undefined) merged.publishedAt = publishedAt;
  if (modifiedAt !== undefined) merged.modifiedAt = modifiedAt;

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

function extractMetadata(document: Document): ExtractedMetadata {
  const ctx: MetaContext = { title: {}, description: {} };

  for (const tag of document.querySelectorAll('meta')) {
    const content = tag.getAttribute('content')?.trim();
    if (!content) continue;

    const property = tag.getAttribute('property');
    if (property) META_PROPERTY_HANDLERS.get(property)?.(ctx, content);

    const name = tag.getAttribute('name');
    if (name) META_NAME_HANDLERS.get(name)?.(ctx, content);
  }

  const titleEl = document.querySelector('title');
  if (!ctx.title.standard && titleEl?.textContent) {
    ctx.title.standard = titleEl.textContent.trim();
  }

  const resolvedTitle = ctx.title.og ?? ctx.title.twitter ?? ctx.title.standard;
  const resolvedDesc =
    ctx.description.og ?? ctx.description.twitter ?? ctx.description.standard;

  const metadata: ExtractedMetadata = {};
  if (resolvedTitle) metadata.title = resolvedTitle;
  if (resolvedDesc) metadata.description = resolvedDesc;
  if (ctx.author) metadata.author = ctx.author;
  if (ctx.image) metadata.image = ctx.image;
  if (ctx.publishedAt) metadata.publishedAt = ctx.publishedAt;
  if (ctx.modifiedAt) metadata.modifiedAt = ctx.modifiedAt;

  return metadata;
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
    const textLength = rawText.replace(/\s+/g, ' ').trim().length;

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

function extractContentContext(
  html: string,
  url: string,
  options: { extractArticle?: boolean; signal?: AbortSignal }
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
          extractMetadataFromHead(html)
        )
      : null;

    const { html: limitedHtml, truncated } = truncateHtml(html);

    const { document } = stageTracker.run(url, 'extract:parse', () =>
      parseHTML(limitedHtml)
    );
    abortPolicy.throwIfAborted(options.signal, url, 'extract:parsed');

    applyBaseUri(document, url);

    const lateMetadata = stageTracker.run(url, 'extract:metadata', () =>
      extractMetadata(document)
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

    logError(
      'Failed to extract content',
      error instanceof Error ? error : undefined
    );

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
  if (!isObject(node)) return undefined;

  const childNodes = Array.isArray(
    (node as { childNodes?: unknown }).childNodes
  )
    ? (node as { childNodes: unknown[] }).childNodes
    : [];

  for (const child of childNodes) {
    if (!isObject(child)) continue;

    const raw = (child as { rawTagName?: unknown }).rawTagName;
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
  if (!isObject(ctx)) return buildInlineCodeTranslator();
  const { parent } = ctx as { parent?: unknown };
  if (!isCodeBlock(parent)) return buildInlineCodeTranslator();

  return { noEscape: true, preserveWhitespace: true };
}

function buildImageTranslator(ctx: unknown): TranslatorConfig {
  if (!isObject(ctx)) return { content: '' };

  const { node, parent } = ctx as { node?: unknown; parent?: unknown };
  const getAttribute = hasGetAttribute(node)
    ? node.getAttribute.bind(node)
    : undefined;

  const srcRaw = getAttribute?.('src') ?? '';
  const src = srcRaw.startsWith('data:') ? '[data URI removed]' : srcRaw;

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
  if (!isObject(child)) return '';
  const raw = (child as { nodeName?: unknown }).nodeName;
  return typeof raw === 'string' ? raw.toUpperCase() : '';
}

function resolveDlTextContent(child: unknown): string {
  const raw = (child as { textContent?: unknown }).textContent;
  return typeof raw === 'string' ? raw.trim() : '';
}

function buildDlChildFragment(child: unknown): string | null {
  const nodeName = resolveDlNodeName(child);
  if (nodeName === 'DT') return `**${resolveDlTextContent(child)}**\n`;
  if (nodeName === 'DD') return `: ${resolveDlTextContent(child)}\n`;
  return null;
}

function hasComplexTableLayout(node: unknown): boolean {
  if (!isObject(node)) return false;
  const innerHTML =
    typeof (node as { innerHTML?: unknown }).innerHTML === 'string'
      ? (node as { innerHTML: string }).innerHTML
      : '';
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
      if (!isObject(ctx) || !isObject((ctx as { node?: unknown }).node))
        return { content: '' };
      const { node } = ctx as { node: { childNodes?: unknown[] } };
      const childNodes = Array.isArray(node.childNodes) ? node.childNodes : [];

      let items = '';
      for (const child of childNodes) {
        const fragment = buildDlChildFragment(child);
        if (fragment !== null) items += fragment;
      }

      return { content: items ? `\n${items}\n` : '' };
    },
    div: (ctx: unknown) => {
      if (!isObject(ctx) || !isObject((ctx as { node?: unknown }).node))
        return {};
      const { node } = ctx as { node: unknown };
      const getAttribute = hasGetAttribute(node)
        ? (
            node as { getAttribute: (n: string) => string | null }
          ).getAttribute.bind(node)
        : undefined;
      const className = getAttribute?.('class') ?? '';
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
        getAttribute?.('role') === 'alert' ||
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
    },
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
    section: () => ({
      postprocess: ({ content }: { content: string }) => `\n\n${content}\n\n`,
    }),
    details: () => ({
      postprocess: ({ content }: { content: string }) => {
        const trimmed = content.trim();
        if (!trimmed) return '';
        return `\n\n<details>\n${trimmed}\n</details>\n\n`;
      },
    }),
    summary: () => ({
      postprocess: ({ content }: { content: string }) =>
        `<summary>${content.trim()}</summary>\n\n`,
    }),
    span: (ctx: unknown) => {
      if (!isObject(ctx) || !isObject((ctx as { node?: unknown }).node))
        return {};
      const { node } = ctx as { node: unknown };
      const getAttribute = hasGetAttribute(node)
        ? (
            node as { getAttribute: (n: string) => string | null }
          ).getAttribute.bind(node)
        : undefined;
      const dataAs = getAttribute?.('data-as') ?? '';
      if (dataAs === 'p') {
        return {
          postprocess: ({ content }: { content: string }) =>
            `\n\n${content.trim()}\n\n`,
        };
      }
      return {};
    },
    pre: (ctx: unknown) => {
      if (!isObject(ctx) || !isObject((ctx as { node?: unknown }).node)) {
        return buildPreTranslator(ctx);
      }
      const { node } = ctx as { node: unknown };
      const getAttribute = hasGetAttribute(node)
        ? (
            node as { getAttribute: (n: string) => string | null }
          ).getAttribute.bind(node)
        : undefined;
      const className = getAttribute?.('class') ?? '';
      if (className.includes('mermaid')) {
        return {
          noEscape: true,
          preserveWhitespace: true,
          postprocess: ({ content }: { content: string }) =>
            `\n\n\`\`\`mermaid\n${content.trim()}\n\`\`\`\n\n`,
        };
      }

      return buildPreTranslator(ctx);
    },
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

function extractClassAttribute(openTag: string): string | null {
  const lower = openTag.toLowerCase();
  const classIndex = lower.indexOf('class');
  if (classIndex === -1) return null;

  let i = classIndex + 5;
  while (i < lower.length && isWhitespaceChar(lower.charCodeAt(i))) i += 1;
  if (lower[i] !== '=') return null;
  i += 1;
  while (i < lower.length && isWhitespaceChar(lower.charCodeAt(i))) i += 1;

  const quote = openTag[i];
  if (quote !== '"' && quote !== "'") return null;
  i += 1;
  const end = openTag.indexOf(quote, i);
  if (end === -1) return null;
  return openTag.slice(i, end);
}

function skipWhitespace(text: string, start: number): number {
  let index = start;
  while (index < text.length && isWhitespaceChar(text.charCodeAt(index))) {
    index += 1;
  }
  return index;
}

function isTsdMemberSectionTag(openTag: string): boolean {
  const classValue = extractClassAttribute(openTag);
  return classValue ? classValue.toLowerCase().includes('tsd-member') : false;
}

function findTsdMemberSectionStart(html: string, scan: number): number | null {
  if (scan >= html.length || !html.startsWith('<section', scan)) return null;

  const tagEnd = html.indexOf('>', scan);
  if (tagEnd === -1) return null;

  const openTag = html.slice(scan, tagEnd + 1);
  return isTsdMemberSectionTag(openTag) ? scan : null;
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

    const closeParen = markdown.indexOf(')', closeBracket + 2);
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

function preprocessPropertySections(html: string): string {
  const closeTag = '</section>';
  let cursor = 0;
  let output = '';

  for (
    let closeIndex = html.indexOf(closeTag, cursor);
    closeIndex !== -1;
    closeIndex = html.indexOf(closeTag, cursor)
  ) {
    const afterClose = closeIndex + closeTag.length;
    output += html.slice(cursor, afterClose);

    const scan = skipWhitespace(html, afterClose);
    const sectionStart = findTsdMemberSectionStart(html, scan);
    if (sectionStart !== null) {
      output += '<p>&nbsp;</p>';
      cursor = sectionStart;
      continue;
    }

    output += html.slice(afterClose, scan);
    cursor = scan;
  }

  output += html.slice(cursor);
  return output;
}

const ABSOLUTE_URL_PREFIXES = [
  'http://',
  'https://',
  'mailto:',
  'data:',
  '#',
  'tel:',
] as const;

function isAbsoluteOrSpecialUrl(href: string): boolean {
  return ABSOLUTE_URL_PREFIXES.some((p) => href.startsWith(p));
}

function resolveRelativeUrls(markdown: string, baseUrl: string): string {
  let origin: string;
  try {
    ({ origin } = new URL(baseUrl));
  } catch {
    return markdown;
  }

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
        removeNoiseFromHtml(html, document, url)
      );

  abortPolicy.throwIfAborted(signal, url, 'markdown:cleaned');

  const preprocessedHtml = stageTracker.run(url, 'markdown:preprocess', () =>
    preprocessPropertySections(cleanedHtml)
  );

  const content = stageTracker.run(url, 'markdown:translate', () =>
    translateHtmlFragmentToMarkdown(preprocessedHtml)
  );

  abortPolicy.throwIfAborted(signal, url, 'markdown:translated');

  const cleaned = cleanupMarkdownArtifacts(content);
  return url ? resolveRelativeUrls(cleaned, url) : cleaned;
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
  const content = params.includeMetadata
    ? addSourceToMarkdown(params.rawContent, params.url)
    : params.rawContent;

  return { content, title };
}

function tryTransformRawContent(params: {
  html: string;
  url: string;
  includeMetadata: boolean;
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

  return { markdown: content, title, truncated: false };
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
  readonly metadata: ReturnType<typeof createContentMetadataBlock>;
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
  } = params;

  const metadata = createContentMetadataBlock(
    url,
    article,
    extractedMeta,
    useArticleContent,
    includeMetadata
  );

  if (useArticleContent && article) {
    // Readability output can still be noisy (unless user requested skip).
    const cleanedArticleHtml = skipNoiseRemoval
      ? article.content
      : removeNoiseFromHtml(article.content, undefined, url);
    return {
      sourceHtml: cleanedArticleHtml,
      title: article.title,
      metadata,
      skipNoiseRemoval: true,
      truncated,
    };
  }

  if (document) {
    const cleanedHtml = skipNoiseRemoval
      ? html
      : removeNoiseFromHtml(html, document, url);

    const contentRoot = findContentRoot(document);
    if (contentRoot) {
      return {
        sourceHtml: contentRoot,
        title: extractedMeta.title,
        metadata,
        skipNoiseRemoval: true,
        document,
        truncated,
      };
    }

    return {
      sourceHtml: cleanedHtml,
      title: extractedMeta.title,
      metadata,
      skipNoiseRemoval: true,
      document,
      truncated,
    };
  }

  return {
    sourceHtml: html,
    title: extractedMeta.title,
    metadata,
    truncated,
  };
}

function resolveContentSource(params: {
  html: string;
  url: string;
  includeMetadata: boolean;
  signal?: AbortSignal;
  skipNoiseRemoval?: boolean;
}): ContentSource {
  const {
    article,
    metadata: extractedMeta,
    document,
    truncated,
  } = extractContentContext(params.html, params.url, {
    extractArticle: true,
    ...(params.signal ? { signal: params.signal } : {}),
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
    content = `# ${context.title}\n\n${content}`;
  }

  return {
    markdown: content,
    title: context.title,
    truncated: context.truncated,
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
      })
    );

    const result = buildMarkdownFromContext(context, url, signal);
    completed = result;
    return result;
  } finally {
    if (completed)
      stageTracker.end(totalStage, { truncated: completed.truncated });
  }
}

function isWorkerResponse(raw: unknown): raw is TransformWorkerOutgoingMessage {
  if (!raw || typeof raw !== 'object') return false;
  const t = (raw as Record<string, unknown>).type;
  return t === 'result' || t === 'error';
}

interface TaskContext {
  run: (fn: () => void) => void;
  destroy: () => void;
}

function createTaskContext(): TaskContext {
  const runWithStore = AsyncLocalStorage.snapshot();
  const resource = new AsyncResource('TransformWorkerTask', {
    requireManualDestroy: true,
  });

  return {
    run: (fn) => {
      resource.runInAsyncScope(runWithStore, null, fn);
    },
    destroy: () => {
      resource.emitDestroy();
    },
  };
}

interface PendingTask {
  id: string;
  html?: string;
  htmlBuffer?: Uint8Array;
  encoding?: string;
  url: string;
  includeMetadata: boolean;
  skipNoiseRemoval?: boolean;
  signal: AbortSignal | undefined;
  abortListener: (() => void) | undefined;
  context: TaskContext;
  resolve: (result: MarkdownTransformResult) => void;
  reject: (error: unknown) => void;
}

interface InflightTask {
  resolve: PendingTask['resolve'];
  reject: PendingTask['reject'];
  timeout: CancellableTimeout<null>;
  signal: AbortSignal | undefined;
  abortListener: (() => void) | undefined;
  workerIndex: number;
  context: TaskContext;
}

type TransformWorkerMessage =
  | TransformWorkerTransformMessage
  | TransformWorkerCancelMessage;

interface WorkerHost {
  kind: 'thread' | 'process';
  threadId?: number;
  pid?: number;
  postMessage: (
    message: TransformWorkerMessage,
    transferList?: NodeTransferable[]
  ) => void;
  terminate: () => Promise<void>;
  unref: () => void;
  onMessage: (handler: (raw: unknown) => void) => void;
  onError: (handler: (error: unknown) => void) => void;
  onExit: (
    handler: (code: number | null, signal: NodeJS.Signals | null) => void
  ) => void;
}

type WorkerSpawner = (workerIndex: number, name: string) => WorkerHost;

interface WorkerSlot {
  host: WorkerHost;
  busy: boolean;
  currentTaskId: string | null;
  name: string;
}

interface TransformWorkerPool {
  transform(
    html: string,
    url: string,
    options: {
      includeMetadata: boolean;
      signal?: AbortSignal;
      skipNoiseRemoval?: boolean;
    }
  ): Promise<MarkdownTransformResult>;
  close(): Promise<void>;
  getQueueDepth(): number;
  getActiveWorkers(): number;
  getCapacity(): number;
}

const POOL_MIN_WORKERS = Math.max(
  2,
  Math.min(4, Math.floor(availableParallelism() / 2))
);
const POOL_MAX_WORKERS = config.transform.maxWorkerScale;
const POOL_SCALE_THRESHOLD = 0.5;
const WORKER_NAME_PREFIX = 'superfetch-transform';

const DEFAULT_TIMEOUT_MS = config.transform.timeoutMs;
const TRANSFORM_CHILD_PATH = fileURLToPath(
  new URL('./workers/transform-child.js', import.meta.url)
);

function ensureTightBuffer(buffer: Uint8Array): Uint8Array {
  if (
    buffer.byteOffset === 0 &&
    buffer.byteLength === buffer.buffer.byteLength
  ) {
    return buffer;
  }

  return Buffer.from(buffer);
}

function createThreadWorkerHost(
  _workerIndex: number,
  name: string
): WorkerHost {
  const resourceLimits = config.transform.workerResourceLimits;
  const worker = new Worker(
    new URL('./workers/transform-worker.js', import.meta.url),
    {
      name,
      ...(resourceLimits ? { resourceLimits } : {}),
    }
  );

  return {
    kind: 'thread',
    threadId: worker.threadId,
    postMessage: (message, transferList) => {
      worker.postMessage(message, transferList);
    },
    terminate: async () => {
      await worker.terminate();
    },
    unref: () => {
      worker.unref();
    },
    onMessage: (handler) => {
      worker.on('message', handler);
    },
    onError: (handler) => {
      worker.on('error', handler);
      worker.on('messageerror', handler);
    },
    onExit: (handler) => {
      worker.on('exit', (code) => {
        handler(code, null);
      });
    },
  };
}

function createProcessWorkerHost(
  workerIndex: number,
  name: string
): WorkerHost {
  const child = fork(TRANSFORM_CHILD_PATH, [], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    serialization: 'advanced',
    env: {
      ...process.env,
      SUPERFETCH_WORKER_INDEX: String(workerIndex),
      SUPERFETCH_WORKER_NAME: name,
    },
  });

  if (child.pid === undefined) {
    throw new Error('Failed to fork process');
  }

  return {
    kind: 'process',
    pid: child.pid,
    postMessage: (message) => {
      if (!child.connected) {
        throw new Error('Transform worker IPC channel is closed');
      }
      child.send(message);
    },
    terminate: () =>
      new Promise((resolve) => {
        if (child.exitCode !== null || child.killed) {
          resolve();
          return;
        }
        child.once('exit', () => {
          resolve();
        });
        try {
          child.kill();
        } catch {
          resolve();
        }
      }),
    unref: () => {
      child.unref();
    },
    onMessage: (handler) => {
      child.on('message', handler);
    },
    onError: (handler) => {
      child.on('error', handler);
    },
    onExit: (handler) => {
      child.on('exit', (code, signal) => {
        handler(code, signal);
      });
    },
  };
}

class WorkerPool implements TransformWorkerPool {
  private static readonly CLOSED_MESSAGE = 'Transform worker pool closed';

  private readonly workers: (WorkerSlot | undefined)[] = [];
  private capacity: number;
  private readonly minCapacity = POOL_MIN_WORKERS;
  private readonly maxCapacity = POOL_MAX_WORKERS;

  private readonly queue: PendingTask[] = [];
  private queueHead = 0;
  private readonly inflight = new Map<string, InflightTask>();

  private readonly timeoutMs: number;
  private readonly queueMax: number;
  private readonly spawnWorkerImpl: WorkerSpawner;

  private closed = false;

  constructor(size: number, timeoutMs: number, spawnWorker: WorkerSpawner) {
    if (size === 0) {
      this.capacity = 0;
    } else {
      this.capacity = Math.max(
        this.minCapacity,
        Math.min(size, this.maxCapacity)
      );
    }
    this.timeoutMs = timeoutMs;
    this.queueMax = this.maxCapacity * 32;
    this.spawnWorkerImpl = spawnWorker;
  }

  async transform(
    html: string,
    url: string,
    options: {
      includeMetadata: boolean;
      signal?: AbortSignal;
      skipNoiseRemoval?: boolean;
    }
  ): Promise<MarkdownTransformResult>;
  async transform(
    htmlBuffer: Uint8Array,
    url: string,
    options: {
      includeMetadata: boolean;
      signal?: AbortSignal;
      skipNoiseRemoval?: boolean;
      encoding?: string;
    }
  ): Promise<MarkdownTransformResult>;
  async transform(
    htmlOrBuffer: string | Uint8Array,
    url: string,
    options: {
      includeMetadata: boolean;
      signal?: AbortSignal;
      skipNoiseRemoval?: boolean;
      encoding?: string;
    }
  ): Promise<MarkdownTransformResult> {
    this.ensureOpen();
    if (options.signal?.aborted)
      throw abortPolicy.createAbortError(url, 'transform:enqueue');

    if (this.getQueueDepth() >= this.queueMax) {
      throw new FetchError('Transform worker queue is full', url, 503, {
        reason: 'queue_full',
        stage: 'transform:enqueue',
      });
    }

    return new Promise<MarkdownTransformResult>((resolve, reject) => {
      const task = this.createPendingTask(
        htmlOrBuffer,
        url,
        options,
        resolve,
        reject
      );
      this.queue.push(task);
      this.drainQueue();
    });
  }

  getQueueDepth(): number {
    const depth = this.queue.length - this.queueHead;
    return depth > 0 ? depth : 0;
  }

  getActiveWorkers(): number {
    return this.workers.filter((s) => s?.busy).length;
  }

  getCapacity(): number {
    return this.capacity;
  }

  resize(size: number): void {
    const newCapacity = Math.max(
      this.minCapacity,
      Math.min(size, this.maxCapacity)
    );
    if (newCapacity === this.capacity) return;

    this.capacity = newCapacity;
    this.drainQueue();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    const terminations = this.workers
      .map((slot) => slot?.host.terminate())
      .filter((p): p is Promise<void> => p !== undefined);

    this.workers.fill(undefined);
    this.workers.length = 0;

    for (const id of Array.from(this.inflight.keys())) {
      const inflight = this.takeInflight(id);
      if (!inflight) continue;
      this.finalizeTask(inflight.context, () => {
        inflight.reject(new Error(WorkerPool.CLOSED_MESSAGE));
      });
    }

    for (let i = this.queueHead; i < this.queue.length; i += 1) {
      const task = this.queue[i];
      if (!task) continue;
      this.clearAbortListener(task.signal, task.abortListener);
      this.finalizeTask(task.context, () => {
        task.reject(new Error(WorkerPool.CLOSED_MESSAGE));
      });
    }
    this.queue.length = 0;
    this.queueHead = 0;

    await Promise.allSettled(terminations);
  }

  private ensureOpen(): void {
    if (this.closed) throw new Error(WorkerPool.CLOSED_MESSAGE);
  }

  private createPendingTask(
    htmlOrBuffer: string | Uint8Array,
    url: string,
    options: {
      includeMetadata: boolean;
      signal?: AbortSignal;
      skipNoiseRemoval?: boolean;
      encoding?: string;
    },
    resolve: (result: MarkdownTransformResult) => void,
    reject: (error: unknown) => void
  ): PendingTask {
    const id = randomUUID();

    // Preserve request context for resolve/reject even when callbacks fire
    // from worker thread events.
    const context = createTaskContext();

    let abortListener: (() => void) | undefined;
    if (options.signal) {
      abortListener = () => {
        this.onAbortSignal(id, url, context, reject);
      };
      options.signal.addEventListener('abort', abortListener, { once: true });
    }

    const task: PendingTask = {
      id,
      url,
      includeMetadata: options.includeMetadata,
      ...(options.skipNoiseRemoval ? { skipNoiseRemoval: true } : {}),
      signal: options.signal,
      abortListener,
      context,
      resolve,
      reject,
    };

    if (typeof htmlOrBuffer === 'string') {
      task.html = htmlOrBuffer;
    } else {
      task.htmlBuffer = htmlOrBuffer;
      if (options.encoding) {
        task.encoding = options.encoding;
      }
    }

    return task;
  }

  private onAbortSignal(
    id: string,
    url: string,
    context: TaskContext,
    reject: (error: unknown) => void
  ): void {
    if (this.closed) {
      this.finalizeTask(context, () => {
        reject(new Error(WorkerPool.CLOSED_MESSAGE));
      });
      return;
    }

    const inflight = this.inflight.get(id);
    if (inflight) {
      this.abortInflight(id, url, inflight.workerIndex);
      return;
    }

    const queuedIndex = this.findQueuedIndex(id);
    if (queuedIndex !== null) {
      const task = this.queue[queuedIndex];
      if (task) this.clearAbortListener(task.signal, task.abortListener);

      this.queue.splice(queuedIndex, 1);
      if (task) {
        this.finalizeTask(task.context, () => {
          task.reject(
            abortPolicy.createAbortError(url, 'transform:queued-abort')
          );
        });
      } else {
        this.finalizeTask(context, () => {
          reject(abortPolicy.createAbortError(url, 'transform:queued-abort'));
        });
      }
      this.maybeCompactQueue();
    }
  }

  private abortInflight(id: string, url: string, workerIndex: number): void {
    const slot = this.workers[workerIndex];
    if (slot) {
      try {
        slot.host.postMessage({ type: 'cancel', id });
      } catch {
        // Worker may be unavailable; failure is acceptable during abort
      }
    }
    this.failTask(
      id,
      abortPolicy.createAbortError(url, 'transform:signal-abort')
    );
    if (slot) this.restartWorker(workerIndex, slot);
  }

  private clearAbortListener(
    signal: AbortSignal | undefined,
    listener: (() => void) | undefined
  ): void {
    if (!signal || !listener) return;
    try {
      signal.removeEventListener('abort', listener);
    } catch {
      // Defensive: removeEventListener should not throw, but handle edge cases
    }
  }

  private spawnWorker(workerIndex: number): WorkerSlot {
    const name = `${WORKER_NAME_PREFIX}-${workerIndex + 1}`;
    const host = this.spawnWorkerImpl(workerIndex, name);
    host.unref();

    host.onMessage((raw: unknown) => {
      this.onWorkerMessage(workerIndex, raw);
    });
    host.onError((error: unknown) => {
      this.onWorkerBroken(
        workerIndex,
        `Transform worker error: ${getErrorMessage(error)}`
      );
    });
    host.onExit((code: number | null, signal: NodeJS.Signals | null) => {
      const suffix = signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`;
      this.onWorkerBroken(workerIndex, `Transform worker exited (${suffix})`);
    });

    return { host, busy: false, currentTaskId: null, name };
  }

  private onWorkerBroken(workerIndex: number, message: string): void {
    if (this.closed) return;

    const slot = this.workers[workerIndex];
    if (!slot) return;

    logWarn('Transform worker unavailable; restarting', {
      reason: message,
      workerIndex,
      workerKind: slot.host.kind,
      workerName: slot.name,
      ...(slot.host.kind === 'process'
        ? { pid: slot.host.pid }
        : { threadId: slot.host.threadId }),
    });

    if (slot.busy && slot.currentTaskId) {
      this.failTask(slot.currentTaskId, new Error(message));
    }

    this.restartWorker(workerIndex, slot);
  }

  private restartWorker(workerIndex: number, slot?: WorkerSlot): void {
    if (this.closed) return;

    const target = slot ?? this.workers[workerIndex];
    if (target) {
      target.host.terminate().catch(() => undefined);
    }

    this.workers[workerIndex] = this.spawnWorker(workerIndex);
    this.drainQueue();
  }

  private onWorkerMessage(workerIndex: number, raw: unknown): void {
    if (!isWorkerResponse(raw)) return;

    const message = raw;
    const inflight = this.takeInflight(message.id);
    if (!inflight) return;

    this.markIdle(workerIndex);

    if (message.type === 'result') {
      this.finalizeTask(inflight.context, () => {
        inflight.resolve({
          markdown: message.result.markdown,
          truncated: message.result.truncated,
          title: message.result.title,
        });
      });
    } else {
      const err = message.error;
      if (err.name === 'FetchError') {
        this.finalizeTask(inflight.context, () => {
          inflight.reject(
            new FetchError(
              err.message,
              err.url,
              err.statusCode,
              err.details ?? {}
            )
          );
        });
      } else {
        this.finalizeTask(inflight.context, () => {
          inflight.reject(new Error(err.message));
        });
      }
    }

    this.drainQueue();
  }

  private takeInflight(id: string): InflightTask | null {
    const inflight = this.inflight.get(id);
    if (!inflight) return null;

    inflight.timeout.cancel();
    this.clearAbortListener(inflight.signal, inflight.abortListener);
    this.inflight.delete(id);

    return inflight;
  }

  private markIdle(workerIndex: number): void {
    const slot = this.workers[workerIndex];
    if (!slot) return;
    slot.busy = false;
    slot.currentTaskId = null;
  }

  private failTask(id: string, error: unknown): void {
    const inflight = this.takeInflight(id);
    if (!inflight) return;

    this.finalizeTask(inflight.context, () => {
      inflight.reject(error);
    });
    this.markIdle(inflight.workerIndex);
  }

  private maybeScaleUp(): void {
    if (
      this.getQueueDepth() > this.capacity * POOL_SCALE_THRESHOLD &&
      this.capacity < this.maxCapacity
    ) {
      this.capacity += 1;
    }
  }

  private drainQueue(): void {
    if (this.closed || this.getQueueDepth() === 0) return;

    this.maybeScaleUp();

    for (let i = 0; i < this.workers.length; i += 1) {
      const slot = this.workers[i];
      if (slot && !slot.busy) {
        this.dispatchFromQueue(i, slot);
        if (this.getQueueDepth() === 0) return;
      }
    }

    if (this.workers.length < this.capacity && this.getQueueDepth() > 0) {
      const workerIndex = this.workers.length;
      const slot = this.spawnWorker(workerIndex);
      this.workers.push(slot);
      this.dispatchFromQueue(workerIndex, slot);

      if (this.workers.length < this.capacity && this.getQueueDepth() > 0) {
        setImmediate(() => {
          this.drainQueue();
        });
      }
    }
  }

  private takeNextQueuedTask(): PendingTask | null {
    while (this.queueHead < this.queue.length) {
      const task = this.queue[this.queueHead];
      this.queueHead += 1;

      if (task) {
        this.maybeCompactQueue();
        return task;
      }
    }

    this.maybeCompactQueue();
    return null;
  }

  private dispatchFromQueue(workerIndex: number, slot: WorkerSlot): void {
    const task = this.takeNextQueuedTask();
    if (!task) return;

    if (this.closed) {
      this.clearAbortListener(task.signal, task.abortListener);
      this.finalizeTask(task.context, () => {
        task.reject(new Error(WorkerPool.CLOSED_MESSAGE));
      });
      return;
    }

    if (task.signal?.aborted) {
      this.clearAbortListener(task.signal, task.abortListener);
      this.finalizeTask(task.context, () => {
        task.reject(
          abortPolicy.createAbortError(task.url, 'transform:dispatch')
        );
      });
      return;
    }

    slot.busy = true;
    slot.currentTaskId = task.id;

    const timeout = createUnrefTimeout(this.timeoutMs, null);
    void timeout.promise
      .then(() => {
        try {
          slot.host.postMessage({ type: 'cancel', id: task.id });
        } catch {
          // Worker may be unavailable; proceed with timeout handling
        }

        const inflight = this.takeInflight(task.id);
        if (!inflight) return;

        this.finalizeTask(inflight.context, () => {
          inflight.reject(
            new FetchError('Request timeout', task.url, 504, {
              reason: 'timeout',
              stage: 'transform:worker-timeout',
            })
          );
        });

        this.restartWorker(workerIndex, slot);
      })
      .catch((error: unknown) => {
        this.failTask(task.id, error);
      });

    this.inflight.set(task.id, {
      resolve: task.resolve,
      reject: task.reject,
      timeout,
      signal: task.signal,
      abortListener: task.abortListener,
      workerIndex,
      context: task.context,
    });

    try {
      const message: TransformWorkerTransformMessage = {
        type: 'transform',
        id: task.id,
        url: task.url,
        includeMetadata: task.includeMetadata,
        ...(task.skipNoiseRemoval ? { skipNoiseRemoval: true } : {}),
      };

      const transferList: NodeTransferable[] = [];

      if (task.htmlBuffer) {
        const htmlBuffer = ensureTightBuffer(task.htmlBuffer);
        message.htmlBuffer = htmlBuffer;
        message.encoding = task.encoding;
        // Data cloning is safer for fallback scenarios if the worker crashes.
        // const transferBuffer = htmlBuffer.buffer;
        // if (!utilTypes.isSharedArrayBuffer(transferBuffer)) {
        //   transferList.push(transferBuffer);
        // }
      } else {
        message.html = task.html;
      }

      slot.host.postMessage(message, transferList);
    } catch (error: unknown) {
      timeout.cancel();
      this.clearAbortListener(task.signal, task.abortListener);
      this.inflight.delete(task.id);
      this.markIdle(workerIndex);

      this.finalizeTask(task.context, () => {
        task.reject(
          error instanceof Error
            ? error
            : new Error('Failed to dispatch transform worker message')
        );
      });
      this.restartWorker(workerIndex, slot);
    }
  }

  private finalizeTask(context: TaskContext, fn: () => void): void {
    try {
      context.run(fn);
    } finally {
      context.destroy();
    }
  }

  private findQueuedIndex(id: string): number | null {
    for (let i = this.queueHead; i < this.queue.length; i += 1) {
      const task = this.queue[i];
      if (task?.id === id) return i;
    }
    return null;
  }

  private maybeCompactQueue(): void {
    if (this.queueHead === 0) return;

    if (
      this.queueHead >= this.queue.length ||
      (this.queueHead > 1024 && this.queueHead > this.queue.length / 2)
    ) {
      this.queue.splice(0, this.queueHead);
      this.queueHead = 0;
    }
  }
}

let workerPool: WorkerPool | null = null;

function resolveWorkerSpawner(): WorkerSpawner {
  return config.transform.workerMode === 'process'
    ? createProcessWorkerHost
    : createThreadWorkerHost;
}

function getOrCreateWorkerPool(): WorkerPool {
  const size = config.transform.maxWorkerScale === 0 ? 0 : POOL_MIN_WORKERS;
  workerPool ??= new WorkerPool(
    size,
    DEFAULT_TIMEOUT_MS,
    resolveWorkerSpawner()
  );
  return workerPool;
}

function getWorkerPoolStats(): {
  queueDepth: number;
  activeWorkers: number;
  capacity: number;
} | null {
  if (!workerPool) return null;
  return {
    queueDepth: workerPool.getQueueDepth(),
    activeWorkers: workerPool.getActiveWorkers(),
    capacity: workerPool.getCapacity(),
  };
}

async function shutdownWorkerPool(): Promise<void> {
  if (!workerPool) return;
  await workerPool.close();
  workerPool = null;
}

export interface TransformPoolStats {
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

function buildWorkerTransformOptions(options: TransformOptions): {
  includeMetadata: boolean;
  signal?: AbortSignal;
  skipNoiseRemoval?: boolean;
} {
  return {
    includeMetadata: options.includeMetadata,
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.skipNoiseRemoval ? { skipNoiseRemoval: true } : {}),
  };
}

async function transformWithWorkerPool(
  htmlOrBuffer: string | Uint8Array,
  url: string,
  options: TransformOptions & { encoding?: string }
): Promise<MarkdownTransformResult> {
  const pool = getOrCreateWorkerPool();
  if (pool.getCapacity() === 0) {
    return transformHtmlToMarkdownInProcess(
      decodeUtf8Input(htmlOrBuffer),
      url,
      options
    );
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
  options: TransformOptions & { encoding?: string }
): MarkdownTransformResult {
  if (error instanceof FetchError) throw error;
  abortPolicy.throwIfAborted(options.signal, url, 'transform:worker-fallback');

  return transformHtmlToMarkdownInProcess(
    decodeUtf8Input(htmlOrBuffer),
    url,
    options
  );
}

async function transformInputToMarkdown(
  htmlOrBuffer: string | Uint8Array,
  url: string,
  options: TransformOptions & { encoding?: string }
): Promise<MarkdownTransformResult> {
  const totalStage = stageTracker.start(url, 'transform:total');
  let completed: MarkdownTransformResult | null = null;

  try {
    abortPolicy.throwIfAborted(options.signal, url, 'transform:begin');

    const workerStage = stageTracker.start(url, 'transform:worker');
    try {
      const result = await transformWithWorkerPool(htmlOrBuffer, url, options);
      completed = result;
      return result;
    } catch (error: unknown) {
      const fallback = resolveWorkerFallback(error, htmlOrBuffer, url, options);
      completed = fallback;
      return fallback;
    } finally {
      stageTracker.end(workerStage);
    }
  } finally {
    if (completed) {
      stageTracker.end(totalStage, { truncated: completed.truncated });
    }
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
  options: TransformOptions & { encoding?: string }
): Promise<MarkdownTransformResult> {
  return transformInputToMarkdown(htmlBuffer, url, options);
}
