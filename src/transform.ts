import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import diagnosticsChannel from 'node:diagnostics_channel';
import { availableParallelism } from 'node:os';
import { performance } from 'node:perf_hooks';
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
import { z } from 'zod';

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
import type {
  ExtractedArticle,
  ExtractedMetadata,
  ExtractionResult,
  MarkdownTransformResult,
  MetadataBlock,
  TransformOptions,
  TransformStageContext,
  TransformStageEvent,
  TransformWorkerTransformMessage,
} from './transform-types.js';
import { isObject } from './type-guards.js';

function spreadSignal(
  signal: AbortSignal | undefined
): { signal: AbortSignal } | Record<string, never> {
  return signal ? { signal } : {};
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
      /* ignore */
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

function truncateHtml(html: string): { html: string; truncated: boolean } {
  const maxSize = config.constants.maxHtmlSize;

  if (html.length <= maxSize) {
    return { html, truncated: false };
  }

  let limit = maxSize;
  // Avoid splitting surrogate pairs.
  if (
    limit > 0 &&
    html.charCodeAt(limit - 1) >= 0xd800 &&
    html.charCodeAt(limit - 1) <= 0xdbff
  ) {
    limit--;
  }

  let content = html.substring(0, limit);

  // Avoid truncating inside tags.
  const lastOpen = content.lastIndexOf('<');
  const lastClose = content.lastIndexOf('>');

  if (lastOpen > lastClose) {
    content = content.substring(0, lastOpen);
  }

  logWarn('HTML content exceeds maximum size, truncating', {
    size: html.length,
    maxSize,
    truncatedSize: content.length,
  });
  return { html: content, truncated: true };
}

function willTruncate(html: string): boolean {
  return html.length > config.constants.maxHtmlSize;
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

    const reader = new Readability(readabilityDoc, { maxElemsToParse: 20_000 });
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

function validateRequiredString(value: unknown, message: string): boolean {
  if (typeof value === 'string' && value.length > 0) return true;
  logWarn(message);
  return false;
}

function isValidInput(html: string, url: string): boolean {
  return (
    validateRequiredString(
      html,
      'extractContent called with invalid HTML input'
    ) && validateRequiredString(url, 'extractContent called with invalid URL')
  );
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
  let maxBackticks = 0;
  let currentRun = 0;

  for (const char of content) {
    if (char === '`') currentRun += 1;
    else {
      if (currentRun > maxBackticks) maxBackticks = currentRun;
      currentRun = 0;
    }
  }
  if (currentRun > maxBackticks) maxBackticks = currentRun;

  const delimiter = '`'.repeat(maxBackticks + 1);
  const padding = content.startsWith('`') || content.endsWith('`') ? ' ' : '';
  return `${delimiter}${padding}${content}${padding}${delimiter}`;
}

function deriveAltFromImageUrl(src: string): string {
  if (!src) return '';

  try {
    const pathname = (() => {
      if (URL.canParse(src)) {
        const parsed = new URL(src);
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
          return parsed.pathname;
        }
        return '';
      }

      if (URL.canParse(src, 'http://localhost')) {
        return new URL(src, 'http://localhost').pathname;
      }

      const withoutQuery = src.split('?')[0] ?? '';
      return (withoutQuery.split('#')[0] ?? withoutQuery).trim();
    })();
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
    dl: (ctx: unknown) => {
      if (!isObject(ctx) || !isObject((ctx as { node?: unknown }).node))
        return { content: '' };
      const { node } = ctx as { node: { childNodes?: unknown[] } };
      const childNodes = Array.isArray(node.childNodes) ? node.childNodes : [];

      const items = childNodes
        .map((child: unknown) => {
          if (!isObject(child)) return '';

          const nodeName =
            typeof (child as { nodeName?: unknown }).nodeName === 'string'
              ? (child as { nodeName: string }).nodeName.toUpperCase()
              : '';

          const textContent =
            typeof (child as { textContent?: unknown }).textContent === 'string'
              ? (child as { textContent: string }).textContent.trim()
              : '';

          if (nodeName === 'DT') return `**${textContent}**`;
          if (nodeName === 'DD') return `: ${textContent}`;
          return '';
        })
        .filter(Boolean)
        .join('\n');

      return { content: items ? `\n${items}\n\n` : '' };
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
    pre: (ctx: unknown) => buildPreTranslator(ctx),
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
    },
    createCustomTranslators()
  );
  return markdownConverter;
}

function translateHtmlFragmentToMarkdown(html: string): string {
  return getMarkdownConverter().translate(html).trim();
}

function preprocessPropertySections(html: string): string {
  return html.replace(
    /<\/section>\s*(<section[^>]*class="[^"]*tsd-member[^"]*"[^>]*>)/g,
    '</section><p>&nbsp;</p>$1'
  );
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

  return cleanupMarkdownArtifacts(content);
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

function getVisibleTextLength(htmlOrDocument: string | Document): number {
  const doc = resolveHtmlDocument(htmlOrDocument);
  const root = doc.body;

  if (typeof htmlOrDocument === 'string') {
    stripNonVisibleNodes(root);
    const text = resolveNodeText(root);
    return text.replace(/\s+/g, ' ').trim().length;
  }

  const workRoot = root.cloneNode(true) as HTMLElement;
  stripNonVisibleNodes(workRoot);
  const text = resolveNodeText(workRoot);

  return text.replace(/\s+/g, ' ').trim().length;
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

function hasTruncatedSentences(text: string): boolean {
  const lines = text
    .split('\n')
    .filter(
      (line) => line.trim().length > MIN_LINE_LENGTH_FOR_TRUNCATION_CHECK
    );

  if (lines.length < 3) return false;

  const incompleteLines = lines.filter((line) => !/[.!?:;]$/.test(line.trim()));
  return incompleteLines.length / lines.length > MAX_TRUNCATED_LINE_RATIO;
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

  let articleDocument: Document | null = null;
  const getArticleDocument = (): Document => {
    if (articleDocument) return articleDocument;
    articleDocument = resolveHtmlDocument(article.content);
    return articleDocument;
  };

  if (originalLength >= MIN_HTML_LENGTH_FOR_GATE) {
    const ratio = articleLength / originalLength;
    if (ratio < MIN_CONTENT_RATIO) return false;
  }

  const originalHeadings = countHeadingsDom(originalHtmlOrDocument);
  if (originalHeadings > 0) {
    const articleHeadings = countHeadingsDom(getArticleDocument());
    const retentionRatio = articleHeadings / originalHeadings;

    if (retentionRatio < MIN_HEADING_RETENTION_RATIO) return false;
  }

  const originalCodeBlocks = countCodeBlocksDom(originalHtmlOrDocument);
  if (originalCodeBlocks > 0) {
    const articleCodeBlocks = countCodeBlocksDom(getArticleDocument());
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
    ...spreadSignal(params.signal),
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
  const content = stageTracker.run(url, 'transform:markdown', () =>
    htmlToMarkdown(context.sourceHtml, context.metadata, {
      url,
      ...spreadSignal(signal),
      ...(context.document ? { document: context.document } : {}),
      ...(context.skipNoiseRemoval ? { skipNoiseRemoval: true } : {}),
    })
  );

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
        ...spreadSignal(signal),
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

const workerMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('result'),
    id: z.string(),
    result: z.object({
      markdown: z.string(),
      title: z.string().optional(),
      truncated: z.boolean(),
    }),
  }),
  z.object({
    type: z.literal('error'),
    id: z.string(),
    error: z.object({
      name: z.string(),
      message: z.string(),
      url: z.string(),
      statusCode: z.number().optional(),
      details: z.record(z.string(), z.unknown()).optional(),
    }),
  }),
]);

type RunInContext = ReturnType<typeof AsyncLocalStorage.snapshot>;

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
  runInContext: RunInContext;
  resolve: (result: MarkdownTransformResult) => void;
  reject: (error: unknown) => void;
}

interface InflightTask {
  resolve: PendingTask['resolve'];
  reject: PendingTask['reject'];
  timer: NodeJS.Timeout;
  signal: AbortSignal | undefined;
  abortListener: (() => void) | undefined;
  workerIndex: number;
  runInContext: RunInContext;
}

interface WorkerSlot {
  worker: Worker;
  busy: boolean;
  currentTaskId: string | null;
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

const DEFAULT_TIMEOUT_MS = config.transform.timeoutMs;

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

  private closed = false;

  constructor(size: number, timeoutMs: number) {
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
      .map((slot) => slot?.worker.terminate())
      .filter((p): p is Promise<number> => p !== undefined);

    this.workers.fill(undefined);
    this.workers.length = 0;

    for (const id of Array.from(this.inflight.keys())) {
      const inflight = this.takeInflight(id);
      if (!inflight) continue;
      this.finalizeTask(inflight.runInContext, () => {
        inflight.reject(new Error(WorkerPool.CLOSED_MESSAGE));
      });
    }

    for (let i = this.queueHead; i < this.queue.length; i += 1) {
      const task = this.queue[i];
      if (!task) continue;
      this.clearAbortListener(task.signal, task.abortListener);
      this.finalizeTask(task.runInContext, () => {
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
    const runInContext = AsyncLocalStorage.snapshot();

    let abortListener: (() => void) | undefined;
    if (options.signal) {
      abortListener = () => {
        this.onAbortSignal(id, url, runInContext, reject);
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
      runInContext,
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
    runInContext: RunInContext,
    reject: (error: unknown) => void
  ): void {
    if (this.closed) {
      runInContext(() => {
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
        this.finalizeTask(task.runInContext, () => {
          task.reject(
            abortPolicy.createAbortError(url, 'transform:queued-abort')
          );
        });
      } else {
        runInContext(() => {
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
        slot.worker.postMessage({ type: 'cancel', id });
      } catch {
        /* ignore */
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
      /* ignore */
    }
  }

  private spawnWorker(workerIndex: number): WorkerSlot {
    const worker = new Worker(
      new URL('./workers/transform-worker.js', import.meta.url)
    );
    worker.unref();

    worker.on('message', (raw: unknown) => {
      this.onWorkerMessage(workerIndex, raw);
    });
    worker.on('error', (error: unknown) => {
      this.onWorkerBroken(
        workerIndex,
        `Transform worker error: ${getErrorMessage(error)}`
      );
    });
    worker.on('exit', (code: number) => {
      this.onWorkerBroken(
        workerIndex,
        `Transform worker exited (code ${code})`
      );
    });

    return { worker, busy: false, currentTaskId: null };
  }

  private onWorkerBroken(workerIndex: number, message: string): void {
    if (this.closed) return;

    const slot = this.workers[workerIndex];
    if (!slot) return;

    if (slot.busy && slot.currentTaskId) {
      this.failTask(slot.currentTaskId, new Error(message));
    }

    this.restartWorker(workerIndex, slot);
  }

  private restartWorker(workerIndex: number, slot?: WorkerSlot): void {
    if (this.closed) return;

    const target = slot ?? this.workers[workerIndex];
    if (target) void target.worker.terminate();

    this.workers[workerIndex] = this.spawnWorker(workerIndex);
    this.drainQueue();
  }

  private onWorkerMessage(workerIndex: number, raw: unknown): void {
    const parsed = workerMessageSchema.safeParse(raw);
    if (!parsed.success) return;

    const message = parsed.data;
    const inflight = this.takeInflight(message.id);
    if (!inflight) return;

    this.markIdle(workerIndex);

    if (message.type === 'result') {
      this.finalizeTask(inflight.runInContext, () => {
        inflight.resolve({
          markdown: message.result.markdown,
          truncated: message.result.truncated,
          title: message.result.title,
        });
      });
    } else {
      const err = message.error;
      if (err.name === 'FetchError') {
        this.finalizeTask(inflight.runInContext, () => {
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
        this.finalizeTask(inflight.runInContext, () => {
          inflight.reject(new Error(err.message));
        });
      }
    }

    this.drainQueue();
  }

  private takeInflight(id: string): InflightTask | null {
    const inflight = this.inflight.get(id);
    if (!inflight) return null;

    clearTimeout(inflight.timer);
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

    this.finalizeTask(inflight.runInContext, () => {
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
      this.finalizeTask(task.runInContext, () => {
        task.reject(new Error(WorkerPool.CLOSED_MESSAGE));
      });
      return;
    }

    if (task.signal?.aborted) {
      this.clearAbortListener(task.signal, task.abortListener);
      this.finalizeTask(task.runInContext, () => {
        task.reject(
          abortPolicy.createAbortError(task.url, 'transform:dispatch')
        );
      });
      return;
    }

    slot.busy = true;
    slot.currentTaskId = task.id;

    const timer = setTimeout(() => {
      try {
        slot.worker.postMessage({ type: 'cancel', id: task.id });
      } catch {
        /* ignore */
      }

      const inflight = this.takeInflight(task.id);
      if (!inflight) return;

      this.finalizeTask(inflight.runInContext, () => {
        inflight.reject(
          new FetchError('Request timeout', task.url, 504, {
            reason: 'timeout',
            stage: 'transform:worker-timeout',
          })
        );
      });

      this.restartWorker(workerIndex, slot);
    }, this.timeoutMs);
    timer.unref();

    this.inflight.set(task.id, {
      resolve: task.resolve,
      reject: task.reject,
      timer,
      signal: task.signal,
      abortListener: task.abortListener,
      workerIndex,
      runInContext: task.runInContext,
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
        message.htmlBuffer = task.htmlBuffer;
        message.encoding = task.encoding;
        const transferBuffer = task.htmlBuffer.buffer;
        if (
          typeof SharedArrayBuffer === 'undefined' ||
          !(transferBuffer instanceof SharedArrayBuffer)
        ) {
          transferList.push(transferBuffer as ArrayBuffer);
        }
      } else {
        message.html = task.html;
      }

      slot.worker.postMessage(message, transferList);
    } catch (error: unknown) {
      clearTimeout(timer);
      this.clearAbortListener(task.signal, task.abortListener);
      this.inflight.delete(task.id);
      this.markIdle(workerIndex);

      this.finalizeTask(task.runInContext, () => {
        task.reject(
          error instanceof Error
            ? error
            : new Error('Failed to dispatch transform worker message')
        );
      });
      this.restartWorker(workerIndex, slot);
    }
  }

  private finalizeTask(runInContext: RunInContext, fn: () => void): void {
    runInContext(fn);
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

function getOrCreateWorkerPool(): WorkerPool {
  const size = config.transform.maxWorkerScale === 0 ? 0 : POOL_MIN_WORKERS;
  workerPool ??= new WorkerPool(size, DEFAULT_TIMEOUT_MS);
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
    ...spreadSignal(options.signal),
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
    let html = '';
    if (typeof htmlOrBuffer === 'string') {
      html = htmlOrBuffer;
    } else {
      const decoder = new TextDecoder(options.encoding ?? 'utf-8');
      html = decoder.decode(htmlOrBuffer);
    }
    return transformHtmlToMarkdownInProcess(html, url, options);
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

  let html = '';
  if (typeof htmlOrBuffer === 'string') {
    html = htmlOrBuffer;
  } else {
    const decoder = new TextDecoder(options.encoding ?? 'utf-8');
    html = decoder.decode(htmlOrBuffer);
  }

  return transformHtmlToMarkdownInProcess(html, url, options);
}

export async function transformHtmlToMarkdown(
  html: string,
  url: string,
  options: TransformOptions
): Promise<MarkdownTransformResult> {
  const totalStage = stageTracker.start(url, 'transform:total');
  let completed: MarkdownTransformResult | null = null;

  try {
    abortPolicy.throwIfAborted(options.signal, url, 'transform:begin');

    const workerStage = stageTracker.start(url, 'transform:worker');
    try {
      const result = await transformWithWorkerPool(html, url, options);
      completed = result;
      return result;
    } catch (error: unknown) {
      const fallback = resolveWorkerFallback(error, html, url, options);
      completed = fallback;
      return fallback;
    } finally {
      stageTracker.end(workerStage);
    }
  } finally {
    if (completed)
      stageTracker.end(totalStage, { truncated: completed.truncated });
  }
}

export async function transformBufferToMarkdown(
  htmlBuffer: Uint8Array,
  url: string,
  options: TransformOptions & { encoding?: string }
): Promise<MarkdownTransformResult> {
  const totalStage = stageTracker.start(url, 'transform:total');
  let completed: MarkdownTransformResult | null = null;

  try {
    abortPolicy.throwIfAborted(options.signal, url, 'transform:begin');

    const workerStage = stageTracker.start(url, 'transform:worker');
    try {
      const result = await transformWithWorkerPool(htmlBuffer, url, options);
      completed = result;
      return result;
    } catch (error: unknown) {
      const fallback = resolveWorkerFallback(error, htmlBuffer, url, options);
      completed = fallback;
      return fallback;
    } finally {
      stageTracker.end(workerStage);
    }
  } finally {
    if (completed)
      stageTracker.end(totalStage, { truncated: completed.truncated });
  }
}
