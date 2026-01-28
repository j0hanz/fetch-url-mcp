import { randomUUID } from 'node:crypto';
import diagnosticsChannel from 'node:diagnostics_channel';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { Worker } from 'node:worker_threads';

import { parseHTML } from 'linkedom';
import {
  NodeHtmlMarkdown,
  type TranslatorCollection,
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
  cleanupMarkdownArtifacts,
  promoteOrphanHeadings,
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
} from './transform-types.js';
import { isRecord } from './type-guards.js';

// Re-export language detection for backward compatibility
export {
  detectLanguageFromCode,
  resolveLanguageFromAttributes,
} from './language-detection.js';

// Re-export markdown cleanup for backward compatibility
export {
  cleanupMarkdownArtifacts,
  promoteOrphanHeadings,
} from './markdown-cleanup.js';

// Re-export DOM noise removal for backward compatibility
export { removeNoiseFromHtml } from './dom-noise-removal.js';

// Re-export types for backward compatibility
export type {
  MetadataBlock,
  ExtractedArticle,
  ExtractedMetadata,
  ExtractionResult,
  MarkdownTransformResult,
  TransformOptions,
  TransformStageEvent,
  TransformStageContext,
} from './transform-types.js';

interface ExtractionContext extends ExtractionResult {
  document?: Document;
}

function getAbortReason(signal: AbortSignal): unknown {
  if (!isRecord(signal)) return undefined;
  return 'reason' in signal ? signal.reason : undefined;
}

// DOM accessor helpers moved to ./dom-noise-removal.ts

const CODE_BLOCK = {
  fence: '```',
  format: (code: string, language = ''): string => {
    return `\`\`\`${language}\n${code}\n\`\`\``;
  },
};

const transformChannel = diagnosticsChannel.channel('superfetch.transform');

function publishTransformEvent(event: TransformStageEvent): void {
  if (!transformChannel.hasSubscribers) return;
  try {
    transformChannel.publish(event);
  } catch {
    /* empty */
  }
}

export function startTransformStage(
  url: string,
  stage: string
): TransformStageContext | null {
  if (!transformChannel.hasSubscribers) return null;

  return {
    stage,
    startTime: performance.now(),
    url: redactUrl(url),
  };
}

export function endTransformStage(
  context: TransformStageContext | null,
  options?: { truncated?: boolean }
): void {
  if (!context) return;

  const requestId = getRequestId();
  const operationId = getOperationId();

  const event: TransformStageEvent = {
    v: 1,
    type: 'stage',
    stage: context.stage,
    durationMs: performance.now() - context.startTime,
    url: context.url,
    ...(requestId ? { requestId } : {}),
    ...(operationId ? { operationId } : {}),
    ...(options?.truncated !== undefined
      ? { truncated: options.truncated }
      : {}),
  };

  publishTransformEvent(event);
}

function runTransformStage<T>(url: string, stage: string, fn: () => T): T {
  const context = startTransformStage(url, stage);
  try {
    return fn();
  } finally {
    // Emit duration even if the stage throws; callers decide how to handle the error.
    endTransformStage(context);
  }
}

function isTimeoutReason(reason: unknown): boolean {
  return reason instanceof Error && reason.name === 'TimeoutError';
}

function throwIfAborted(
  signal: AbortSignal | undefined,
  url: string,
  stage: string
): void {
  if (!signal) return;
  const { aborted } = signal;
  if (!aborted) return;

  const reason = getAbortReason(signal);
  if (isTimeoutReason(reason)) {
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

function truncateHtml(html: string): string {
  const maxSize = config.constants.maxHtmlSize;

  if (html.length <= maxSize) {
    return html;
  }

  logWarn('HTML content exceeds maximum size, truncating', {
    size: html.length,
    maxSize,
  });

  return html.substring(0, maxSize);
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
  const ctx: MetaContext = {
    title: {},
    description: {},
  };

  for (const tag of document.querySelectorAll('meta')) {
    const content = tag.getAttribute('content')?.trim();
    if (!content) continue;

    const property = tag.getAttribute('property');
    if (property) {
      META_PROPERTY_HANDLERS.get(property)?.(ctx, content);
    }

    const name = tag.getAttribute('name');
    if (name) {
      META_NAME_HANDLERS.get(name)?.(ctx, content);
    }
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

  try {
    const doc = document;
    const rawText =
      doc.querySelector('body')?.textContent ?? doc.documentElement.textContent;
    const textLength = rawText.replace(/\s+/g, ' ').trim().length;
    if (textLength >= 400 && !isProbablyReaderable(doc)) {
      return null;
    }
    const reader = new Readability(doc, { maxElemsToParse: 20_000 });
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

export function extractContent(
  html: string,
  url: string,
  options: { extractArticle?: boolean; signal?: AbortSignal } = {
    extractArticle: true,
  }
): ExtractionResult {
  const result = extractContentWithDocument(html, url, options);
  return { article: result.article, metadata: result.metadata };
}

function extractContentWithDocument(
  html: string,
  url: string,
  options: { extractArticle?: boolean; signal?: AbortSignal }
): ExtractionContext {
  if (!isValidInput(html, url)) {
    return { article: null, metadata: {} };
  }

  return tryExtractContent(html, url, options);
}

function extractArticleWithStage(
  document: Document,
  url: string,
  shouldExtract: boolean | undefined
): ExtractedArticle | null {
  if (!shouldExtract) return null;
  return runTransformStage(url, 'extract:article', () =>
    resolveArticleExtraction(document, shouldExtract)
  );
}

function handleExtractionFailure(
  error: unknown,
  url: string,
  signal: AbortSignal | undefined
): ExtractionContext {
  if (error instanceof FetchError) {
    throw error;
  }
  throwIfAborted(signal, url, 'extract:error');
  logError(
    'Failed to extract content',
    error instanceof Error ? error : undefined
  );
  return { article: null, metadata: {} };
}

function extractContentStages(
  html: string,
  url: string,
  options: { extractArticle?: boolean; signal?: AbortSignal }
): ExtractionContext {
  throwIfAborted(options.signal, url, 'extract:begin');
  const truncatedHtml = truncateHtml(html);
  const { document } = runTransformStage(url, 'extract:parse', () =>
    parseHTML(truncatedHtml)
  );
  throwIfAborted(options.signal, url, 'extract:parsed');
  applyBaseUri(document, url);
  const metadata = runTransformStage(url, 'extract:metadata', () =>
    extractMetadata(document)
  );
  throwIfAborted(options.signal, url, 'extract:metadata');
  const article = extractArticleWithStage(
    document,
    url,
    options.extractArticle
  );
  throwIfAborted(options.signal, url, 'extract:article');
  return {
    article,
    metadata,
    ...(truncatedHtml.length === html.length ? { document } : {}),
  };
}

function tryExtractContent(
  html: string,
  url: string,
  options: { extractArticle?: boolean; signal?: AbortSignal }
): ExtractionContext {
  try {
    return extractContentStages(html, url, options);
  } catch (error: unknown) {
    return handleExtractionFailure(error, url, options.signal);
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
  if (typeof value === 'string' && value.length > 0) return true;
  logWarn(message);
  return false;
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
  } catch (error: unknown) {
    logInfo('Failed to set baseURI (non-critical)', {
      url: url.substring(0, 100),
      error: getErrorMessage(error),
    });
  }
}

// DOM noise removal functions moved to ./dom-noise-removal.ts

function buildInlineCode(content: string): string {
  const runs = content.match(/`+/g);
  let longest = '';
  if (runs) {
    for (const run of runs) {
      if (run.length > longest.length) {
        longest = run;
      }
    }
  }

  // Use a fence longer than any run of backticks in the content.
  const delimiter = `\`${longest}`;

  // Only pad when needed to avoid altering code spans unnecessarily.
  // CommonMark recommends padding when the code starts/ends with a backtick.
  const padding = content.startsWith('`') || content.endsWith('`') ? ' ' : '';

  return `${delimiter}${padding}${content}${padding}${delimiter}`;
}

function deriveAltFromImageUrl(src: string): string {
  if (!src) return '';

  try {
    const pathname = src.startsWith('http')
      ? new URL(src).pathname
      : (src.split('?')[0] ?? '');

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

function isCodeBlock(
  parent: unknown
): parent is { tagName?: string; childNodes?: unknown[] } {
  if (!isRecord(parent)) return false;
  const tagName =
    typeof parent.tagName === 'string' ? parent.tagName.toUpperCase() : '';
  return ['PRE', 'WRAPPED-PRE'].includes(tagName);
}

function hasGetAttribute(
  value: unknown
): value is { getAttribute: (name: string) => string | null } {
  return isRecord(value) && typeof value.getAttribute === 'function';
}

function hasCodeBlockTranslators(
  value: unknown
): value is { codeBlockTranslators: TranslatorCollection } {
  return isRecord(value) && isRecord(value.codeBlockTranslators);
}

function buildInlineCodeTranslator(): TranslatorConfig {
  return {
    spaceIfRepeatingChar: true,
    noEscape: true,
    postprocess: ({ content }: { content: string }) => buildInlineCode(content),
  };
}

function resolveAttributeLanguage(node: unknown): string | undefined {
  const getAttribute = hasGetAttribute(node)
    ? node.getAttribute.bind(node)
    : undefined;
  const className = getAttribute?.('class') ?? '';
  const dataLanguage = getAttribute?.('data-language') ?? '';
  return resolveLanguageFromAttributes(className, dataLanguage);
}

function resolveCodeBlockTranslators(
  visitor: unknown
): TranslatorCollection | null {
  const childTranslators = isRecord(visitor) ? visitor.instance : null;
  return hasCodeBlockTranslators(childTranslators)
    ? childTranslators.codeBlockTranslators
    : null;
}

function buildCodeBlockTranslator(
  attributeLanguage: string | undefined,
  codeBlockTranslators: TranslatorCollection | null
): TranslatorConfig {
  return {
    noEscape: true,
    preserveWhitespace: true,
    ...(codeBlockTranslators
      ? { childTranslators: codeBlockTranslators }
      : null),
    postprocess: ({ content }: { content: string }) => {
      const language =
        attributeLanguage ?? detectLanguageFromCode(content) ?? '';
      return CODE_BLOCK.format(content, language);
    },
  };
}

function buildCodeTranslator(ctx: unknown): TranslatorConfig {
  if (!isRecord(ctx)) return buildInlineCodeTranslator();

  const { node, parent, visitor } = ctx;
  if (!isCodeBlock(parent)) return buildInlineCodeTranslator();

  const attributeLanguage = resolveAttributeLanguage(node);
  const codeBlockTranslators = resolveCodeBlockTranslators(visitor);
  return buildCodeBlockTranslator(attributeLanguage, codeBlockTranslators);
}

function buildImageTranslator(ctx: unknown): TranslatorConfig {
  if (!isRecord(ctx)) return { content: '' };

  const { node } = ctx;
  const getAttribute = hasGetAttribute(node)
    ? node.getAttribute.bind(node)
    : undefined;

  const src = getAttribute?.('src') ?? '';
  const existingAlt = getAttribute?.('alt') ?? '';

  const alt = existingAlt.trim() || deriveAltFromImageUrl(src);

  return {
    content: `![${alt}](${src})`,
  };
}

/**
 * Check if a <pre> element has a direct <code> child.
 * If so, let the code translator handle it.
 */
function preHasCodeChild(node: unknown): boolean {
  if (!isRecord(node)) return false;
  const { childNodes } = node;
  if (!Array.isArray(childNodes)) return false;

  for (const child of childNodes) {
    if (!isRecord(child)) continue;
    const nodeName =
      typeof child.nodeName === 'string' ? child.nodeName.toUpperCase() : '';
    if (nodeName === 'CODE') return true;
  }
  return false;
}

/**
 * Build translator for <pre> elements without <code> children.
 * Wraps content in fenced code block with language detection.
 */
function buildPreTranslator(ctx: unknown): TranslatorConfig {
  if (!isRecord(ctx)) return {};

  const { node } = ctx;

  // If <pre> has <code> child, let default handling work
  if (preHasCodeChild(node)) {
    return {};
  }

  // For bare <pre>, wrap in code fence
  const attributeLanguage = resolveAttributeLanguage(node);

  return {
    noEscape: true,
    preserveWhitespace: true,
    postprocess: ({ content }: { content: string }) => {
      const trimmed = content.trim();
      if (!trimmed) return '';
      const language =
        attributeLanguage ?? detectLanguageFromCode(trimmed) ?? '';
      return CODE_BLOCK.format(trimmed, language);
    },
  };
}

function createCustomTranslators(): TranslatorConfigObject {
  return {
    code: (ctx: unknown) => buildCodeTranslator(ctx),
    img: (ctx: unknown) => buildImageTranslator(ctx),
    dl: (ctx: unknown) => {
      if (!isRecord(ctx) || !isRecord(ctx.node)) {
        return { content: '' };
      }
      const node = ctx.node as { childNodes?: unknown[] };
      const childNodes = Array.isArray(node.childNodes) ? node.childNodes : [];

      const items = childNodes
        .map((child: unknown) => {
          if (!isRecord(child)) return '';

          const nodeName =
            typeof child.nodeName === 'string'
              ? child.nodeName.toUpperCase()
              : '';
          const textContent =
            typeof child.textContent === 'string'
              ? child.textContent.trim()
              : '';

          if (nodeName === 'DT') return `**${textContent}**`;
          if (nodeName === 'DD') return `: ${textContent}`;
          return '';
        })
        .filter(Boolean)
        .join('\n');

      return { content: items ? `\n${items}\n\n` : '' };
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
    // Fix #6: Handle <pre> without <code> - wrap in fenced code block
    pre: (ctx: unknown) => buildPreTranslator(ctx),
  };
}

let markdownInstance: NodeHtmlMarkdown | null = null;

function createMarkdownInstance(): NodeHtmlMarkdown {
  return new NodeHtmlMarkdown(
    {
      codeFence: CODE_BLOCK.fence,
      codeBlockStyle: 'fenced',
      emDelimiter: '_',
      bulletMarker: '-',
    },
    createCustomTranslators()
  );
}

function getMarkdownConverter(): NodeHtmlMarkdown {
  markdownInstance ??= createMarkdownInstance();
  return markdownInstance;
}

function translateHtmlToMarkdown(
  html: string,
  url: string,
  signal?: AbortSignal,
  document?: Document
): string {
  throwIfAborted(signal, url, 'markdown:begin');

  const cleanedHtml = runTransformStage(url, 'markdown:noise', () =>
    removeNoiseFromHtml(html, document, url)
  );

  throwIfAborted(signal, url, 'markdown:cleaned');

  const content = runTransformStage(url, 'markdown:translate', () =>
    getMarkdownConverter().translate(cleanedHtml).trim()
  );

  throwIfAborted(signal, url, 'markdown:translated');

  const cleaned = cleanupMarkdownArtifacts(content);
  return promoteOrphanHeadings(cleaned);
}

function appendMetadataFooter(
  content: string,
  metadata: MetadataBlock | undefined,
  url: string
): string {
  const footer = buildMetadataFooter(metadata, url);
  return footer ? `${content}\n\n${footer}` : content;
}

export function htmlToMarkdown(
  html: string,
  metadata?: MetadataBlock,
  options?: { url?: string; signal?: AbortSignal; document?: Document }
): string {
  const url = options?.url ?? metadata?.url ?? '';
  if (!html) return buildMetadataFooter(metadata, url);

  try {
    const content = translateHtmlToMarkdown(
      html,
      url,
      options?.signal,
      options?.document
    );
    return appendMetadataFooter(content, metadata, url);
  } catch (error: unknown) {
    if (error instanceof FetchError) {
      throw error;
    }

    logError(
      'Failed to convert HTML to markdown',
      error instanceof Error ? error : undefined
    );

    return buildMetadataFooter(metadata, url);
  }
}

// Markdown cleanup functions moved to ./markdown-cleanup.ts

function formatFetchedDate(isoString: string): string {
  try {
    const date = new Date(isoString);
    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const year = date.getFullYear();
    return `${day}-${month}-${year}`;
  } catch {
    return isoString;
  }
}

function buildMetadataFooter(
  metadata?: MetadataBlock,
  fallbackUrl?: string
): string {
  if (!metadata) return '';
  const lines: string[] = ['---', ''];

  const url = metadata.url || fallbackUrl;
  const parts: string[] = [];

  if (metadata.title) parts.push(`_${metadata.title}_`);

  if (metadata.author) parts.push(`_${metadata.author}_`);

  if (url) parts.push(`[_Original Source_](${url})`);

  if (metadata.fetchedAt) {
    const formattedDate = formatFetchedDate(metadata.fetchedAt);
    parts.push(`_${formattedDate}_`);
  }

  if (parts.length > 0) {
    lines.push(` ${parts.join(' | ')}`);
  }

  if (metadata.description) {
    lines.push(` <sub>${metadata.description}</sub>`);
  }

  return lines.join('\n');
}

const HEADING_PATTERN = /^#{1,6}\s/m;
const LIST_PATTERN = /^(?:[-*+])\s/m;
const HTML_DOCUMENT_PATTERN = /^(<!doctype|<html)/i;

function containsMarkdownHeading(content: string): boolean {
  return HEADING_PATTERN.test(content);
}

function containsMarkdownList(content: string): boolean {
  return LIST_PATTERN.test(content);
}

function containsFencedCodeBlock(content: string): boolean {
  const first = content.indexOf('```');
  if (first === -1) return false;
  return content.includes('```', first + 3);
}

function looksLikeMarkdown(content: string): boolean {
  return (
    containsMarkdownHeading(content) ||
    containsMarkdownList(content) ||
    containsFencedCodeBlock(content)
  );
}

function detectLineEnding(content: string): '\n' | '\r\n' {
  return content.includes('\r\n') ? '\r\n' : '\n';
}

const FRONTMATTER_DELIMITER = '---';

function findFrontmatterLines(content: string): {
  lineEnding: '\n' | '\r\n';
  lines: string[];
  endIndex: number;
} | null {
  const lineEnding = detectLineEnding(content);
  const lines = content.split(lineEnding);
  if (lines[0] !== FRONTMATTER_DELIMITER) return null;
  const endIndex = lines.indexOf(FRONTMATTER_DELIMITER, 1);
  if (endIndex === -1) return null;
  return { lineEnding, lines, endIndex };
}

function stripOptionalQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 2) return trimmed;
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function parseFrontmatterEntry(
  line: string
): { key: string; value: string } | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const separatorIndex = trimmed.indexOf(':');
  if (separatorIndex <= 0) return null;
  const key = trimmed.slice(0, separatorIndex).trim().toLowerCase();
  const value = trimmed.slice(separatorIndex + 1);
  return { key, value };
}

function isTitleKey(key: string): boolean {
  return key === 'title' || key === 'name';
}

function extractTitleFromHeading(content: string): string | undefined {
  const lineEnding = detectLineEnding(content);
  const lines = content.split(lineEnding);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let index = 0;
    while (index < trimmed.length && trimmed[index] === '#') {
      index += 1;
    }

    if (index === 0 || index > 6) return undefined;
    const nextChar = trimmed[index];
    if (nextChar !== ' ' && nextChar !== '\t') return undefined;

    const heading = trimmed.slice(index).trim();
    return heading.length > 0 ? heading : undefined;
  }

  return undefined;
}

function extractTitleFromRawMarkdown(content: string): string | undefined {
  const frontmatter = findFrontmatterLines(content);
  if (!frontmatter) {
    return extractTitleFromHeading(content);
  }

  const { lines, endIndex } = frontmatter;
  const entry = lines
    .slice(1, endIndex)
    .map((line) => parseFrontmatterEntry(line))
    .find((parsed) => parsed !== null && isTitleKey(parsed.key));
  if (!entry) return undefined;
  const value = stripOptionalQuotes(entry.value);
  return value || undefined;
}

function hasMarkdownSourceLine(content: string): boolean {
  const lineEnding = detectLineEnding(content);
  const lines = content.split(lineEnding);

  const limit = Math.min(lines.length, 50);
  for (let index = 0; index < limit; index += 1) {
    const line = lines[index];
    if (!line) continue;
    if (line.trimStart().toLowerCase().startsWith('source:')) {
      return true;
    }
  }
  return false;
}

function addSourceToMarkdownMarkdownFormat(
  content: string,
  url: string
): string {
  if (hasMarkdownSourceLine(content)) return content;
  const lineEnding = detectLineEnding(content);
  const lines = content.split(lineEnding);

  const firstNonEmptyIndex = lines.findIndex((line) => line.trim().length > 0);
  if (firstNonEmptyIndex !== -1) {
    const firstLine = lines[firstNonEmptyIndex];
    if (firstLine && /^#{1,6}\s+/.test(firstLine.trim())) {
      const insertAt = firstNonEmptyIndex + 1;
      const updated = [
        ...lines.slice(0, insertAt),
        '',
        `Source: ${url}`,
        '',
        ...lines.slice(insertAt),
      ];
      return updated.join(lineEnding);
    }
  }

  return [`Source: ${url}`, '', content].join(lineEnding);
}

function addSourceToMarkdown(content: string, url: string): string {
  const frontmatter = findFrontmatterLines(content);
  if (config.transform.metadataFormat === 'markdown' && !frontmatter) {
    return addSourceToMarkdownMarkdownFormat(content, url);
  }

  if (!frontmatter) {
    return `---\nsource: "${url}"\n---\n\n${content}`;
  }

  const { lineEnding, lines, endIndex } = frontmatter;
  const bodyLines = lines.slice(1, endIndex);
  const hasSource = bodyLines.some((line) =>
    line.trimStart().toLowerCase().startsWith('source:')
  );
  if (hasSource) return content;

  const updatedLines = [
    lines[0],
    ...bodyLines,
    `source: "${url}"`,
    ...lines.slice(endIndex),
  ];

  return updatedLines.join(lineEnding);
}

function hasFrontmatter(trimmed: string): boolean {
  return trimmed.startsWith('---\n') || trimmed.startsWith('---\r\n');
}

function looksLikeHtmlDocument(trimmed: string): boolean {
  return HTML_DOCUMENT_PATTERN.test(trimmed);
}

function countCommonHtmlTags(content: string): number {
  const matches =
    content.match(/<(html|head|body|div|span|script|style|meta|link)\b/gi) ??
    [];
  return matches.length;
}

function isRawTextContent(content: string): boolean {
  const trimmed = content.trim();
  const isHtmlDocument = looksLikeHtmlDocument(trimmed);
  const hasMarkdownFrontmatter = hasFrontmatter(trimmed);
  const hasTooManyHtmlTags = countCommonHtmlTags(content) > 2;
  const isMarkdown = looksLikeMarkdown(content);

  return (
    !isHtmlDocument &&
    (hasMarkdownFrontmatter || (!hasTooManyHtmlTags && isMarkdown))
  );
}

function isLikelyHtmlContent(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed) return false;
  if (looksLikeHtmlDocument(trimmed)) return true;
  return countCommonHtmlTags(content) > 2;
}

function shouldPreserveRawContent(url: string, content: string): boolean {
  if (isRawTextContentUrl(url)) {
    return !isLikelyHtmlContent(content);
  }
  return isRawTextContent(content);
}

function buildRawMarkdownPayload({
  rawContent,
  url,
  includeMetadata,
}: {
  rawContent: string;
  url: string;
  includeMetadata: boolean;
}): { content: string; title: string | undefined } {
  const title = extractTitleFromRawMarkdown(rawContent);
  const content = includeMetadata
    ? addSourceToMarkdown(rawContent, url)
    : rawContent;

  return { content, title };
}

function tryTransformRawContent({
  html,
  url,
  includeMetadata,
}: {
  html: string;
  url: string;
  includeMetadata: boolean;
}): MarkdownTransformResult | null {
  if (!shouldPreserveRawContent(url, html)) {
    return null;
  }

  logDebug('Preserving raw markdown content', { url: url.substring(0, 80) });
  const { content, title } = buildRawMarkdownPayload({
    rawContent: html,
    url,
    includeMetadata,
  });
  return {
    markdown: content,
    title,
    truncated: false,
  };
}

const MIN_CONTENT_RATIO = 0.3;
const MIN_HTML_LENGTH_FOR_GATE = 100;
const MIN_HEADING_RETENTION_RATIO = 0.7;

/**
 * Count headings using DOM querySelectorAll.
 * Handles nested content like <h2><span>Text</span></h2> correctly.
 */
function countHeadingsDom(htmlOrDocument: string | Document): number {
  if (typeof htmlOrDocument === 'string') {
    // Wrap fragments in document structure for proper parsing
    const htmlToParse = needsDocumentWrapper(htmlOrDocument)
      ? wrapHtmlFragment(htmlOrDocument)
      : htmlOrDocument;

    const { document: doc } = parseHTML(htmlToParse);
    return doc.querySelectorAll('h1,h2,h3,h4,h5,h6').length;
  }

  return htmlOrDocument.querySelectorAll('h1,h2,h3,h4,h5,h6').length;
}

/**
 * Check if HTML string needs document wrapper for proper parsing.
 * Fragments without doctype/html/body tags need wrapping.
 */
function needsDocumentWrapper(html: string): boolean {
  const trimmed = html.trim().toLowerCase();
  return (
    !trimmed.startsWith('<!doctype') &&
    !trimmed.startsWith('<html') &&
    !trimmed.startsWith('<body')
  );
}

/**
 * Wrap HTML fragment in minimal document structure for proper parsing.
 */
function wrapHtmlFragment(html: string): string {
  return `<!DOCTYPE html><html><body>${html}</body></html>`;
}

/**
 * Get visible text length from HTML, excluding script/style/noscript content.
 * Fixes the bug where stripHtmlTagsForLength() counted JS/CSS as visible text.
 */
function getVisibleTextLength(htmlOrDocument: string | Document): number {
  // For string input, parse the HTML
  if (typeof htmlOrDocument === 'string') {
    // Wrap fragments in document structure for proper parsing
    const htmlToParse = needsDocumentWrapper(htmlOrDocument)
      ? wrapHtmlFragment(htmlOrDocument)
      : htmlOrDocument;

    const { document: doc } = parseHTML(htmlToParse);

    // Remove non-visible content that inflates text length
    for (const el of doc.querySelectorAll('script,style,noscript')) {
      el.remove();
    }

    // Get text content from body or documentElement
    // Note: linkedom may return null for body on HTML fragments despite types
    const body = doc.body as HTMLElement | null;
    const docElement = doc.documentElement as HTMLElement | null;
    const text = body?.textContent ?? docElement?.textContent ?? '';

    return text.replace(/\s+/g, ' ').trim().length;
  }

  // For Document input, clone to avoid mutation
  const workDoc = htmlOrDocument.cloneNode(true) as Document;

  // Remove non-visible content that inflates text length
  for (const el of workDoc.querySelectorAll('script,style,noscript')) {
    el.remove();
  }

  // Get text content from body or documentElement
  // Note: linkedom may return null for body on HTML fragments despite types
  const body = workDoc.body as HTMLElement | null;
  const docElement = workDoc.documentElement as HTMLElement | null;
  const text = body?.textContent ?? docElement?.textContent ?? '';

  return text.replace(/\s+/g, ' ').trim().length;
}

export function isExtractionSufficient(
  article: ExtractedArticle | null,
  originalHtmlOrDocument: string | Document
): boolean {
  if (!article) return false;

  const articleLength = article.textContent.length;
  // Use DOM-based visible text length to exclude script/style content
  const originalLength = getVisibleTextLength(originalHtmlOrDocument);

  if (originalLength < MIN_HTML_LENGTH_FOR_GATE) return true;

  return articleLength / originalLength >= MIN_CONTENT_RATIO;
}

const MIN_LINE_LENGTH_FOR_TRUNCATION_CHECK = 20;
const MAX_TRUNCATED_LINE_RATIO = 0.5;

/**
 * Detect if extracted text has many truncated/incomplete sentences.
 * Lines longer than 20 chars that don't end with sentence punctuation
 * are considered potentially truncated.
 */
function hasTruncatedSentences(text: string): boolean {
  const lines = text
    .split('\n')
    .filter(
      (line) => line.trim().length > MIN_LINE_LENGTH_FOR_TRUNCATION_CHECK
    );
  if (lines.length < 3) return false;

  const incompleteLines = lines.filter((line) => {
    const trimmed = line.trim();
    return !/[.!?:;]$/.test(trimmed);
  });

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
    if (extractedMeta.description !== undefined) {
      metadata.description = extractedMeta.description;
    }
    if (extractedMeta.author !== undefined) {
      metadata.author = extractedMeta.author;
    }
  }

  return metadata;
}

interface ContentSource {
  readonly sourceHtml: string;
  readonly title: string | undefined;
  readonly metadata: ReturnType<typeof createContentMetadataBlock>;
  readonly document?: Document;
}

/**
 * Content root selectors in priority order.
 * These identify the main content area on a page.
 */
const CONTENT_ROOT_SELECTORS = [
  'main',
  'article',
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

/**
 * Find the main content root element in a document.
 * Returns the innerHTML if found, undefined otherwise.
 */
function findContentRoot(document: Document): string | undefined {
  for (const selector of CONTENT_ROOT_SELECTORS) {
    const element = document.querySelector(selector);
    if (!element) continue;

    // Check if element has meaningful content
    const innerHTML =
      typeof (element as HTMLElement).innerHTML === 'string'
        ? (element as HTMLElement).innerHTML
        : undefined;

    if (innerHTML && innerHTML.trim().length > 100) {
      return innerHTML;
    }
  }
  return undefined;
}

function buildContentSource({
  html,
  url,
  article,
  extractedMeta,
  includeMetadata,
  useArticleContent,
  document,
}: {
  html: string;
  url: string;
  article: ExtractedArticle | null;
  extractedMeta: ExtractedMetadata;
  includeMetadata: boolean;
  useArticleContent: boolean;
  document?: Document;
}): ContentSource {
  const metadata = createContentMetadataBlock(
    url,
    article,
    extractedMeta,
    useArticleContent,
    includeMetadata
  );

  // If using article content, return it directly
  if (useArticleContent && article) {
    return {
      sourceHtml: article.content,
      title: article.title,
      metadata,
    };
  }

  // Try content root fallback before using full HTML
  if (document) {
    const contentRoot = findContentRoot(document);
    if (contentRoot) {
      logDebug('Using content root fallback instead of full HTML', {
        url: url.substring(0, 80),
        contentLength: contentRoot.length,
      });
      return {
        sourceHtml: contentRoot,
        title: extractedMeta.title,
        metadata,
        document,
      };
    }
  }

  // Fall back to full HTML
  return {
    sourceHtml: html,
    title: extractedMeta.title,
    metadata,
    ...(document ? { document } : {}),
  };
}

function logQualityGateFallback({
  url,
  articleLength,
}: {
  url: string;
  articleLength: number;
}): void {
  logDebug(
    'Quality gate: Readability extraction below threshold, using full HTML',
    {
      url: url.substring(0, 80),
      articleLength,
    }
  );
}

function shouldUseArticleContent(
  article: ExtractedArticle,
  originalHtmlOrDocument: string | Document,
  url: string
): boolean {
  const articleLength = article.textContent.length;
  const originalLength = getVisibleTextLength(originalHtmlOrDocument);

  // If the document is tiny, don't gate too aggressively.
  if (originalLength >= MIN_HTML_LENGTH_FOR_GATE) {
    const ratio = articleLength / originalLength;
    if (ratio < MIN_CONTENT_RATIO) {
      logQualityGateFallback({ url, articleLength });
      return false;
    }
  }

  // Heading structure retention (compute counts once to avoid repeated DOM queries/parses).
  const originalHeadings = countHeadingsDom(originalHtmlOrDocument);
  if (originalHeadings > 0) {
    const articleHeadings = countHeadingsDom(article.content);
    const retentionRatio = articleHeadings / originalHeadings;

    if (retentionRatio < MIN_HEADING_RETENTION_RATIO) {
      logDebug(
        'Quality gate: Readability broke heading structure, using full HTML',
        {
          url: url.substring(0, 80),
          originalHeadings,
          articleHeadings,
        }
      );
      return false;
    }
  }

  // Layout extraction issue: truncated/fragmented lines.
  if (hasTruncatedSentences(article.textContent)) {
    logDebug(
      'Quality gate: Extracted text has many truncated sentences, using full HTML',
      { url: url.substring(0, 80) }
    );
    return false;
  }

  return true;
}

function resolveContentSource({
  html,
  url,
  includeMetadata,
  signal,
}: {
  html: string;
  url: string;
  includeMetadata: boolean;
  signal?: AbortSignal;
}): ContentSource {
  const {
    article,
    metadata: extractedMeta,
    document,
  } = extractContentWithDocument(html, url, {
    extractArticle: true,
    ...(signal ? { signal } : {}),
  });

  // Parse original HTML for quality gate checks if extraction didn't provide document
  const originalDocument = document ?? parseHTML(html).document;

  const useArticleContent = article
    ? shouldUseArticleContent(article, originalDocument, url)
    : false;

  return buildContentSource({
    html,
    url,
    article,
    extractedMeta,
    includeMetadata,
    useArticleContent,
    ...(document ? { document } : {}),
  });
}

function tryTransformRawStage(
  html: string,
  url: string,
  includeMetadata: boolean
): MarkdownTransformResult | null {
  return runTransformStage(url, 'transform:raw', () =>
    tryTransformRawContent({
      html,
      url,
      includeMetadata,
    })
  );
}

function resolveContentSourceStage(
  html: string,
  url: string,
  includeMetadata: boolean,
  signal?: AbortSignal
): ContentSource {
  return runTransformStage(url, 'transform:extract', () =>
    resolveContentSource({
      html,
      url,
      includeMetadata,
      ...(signal ? { signal } : {}),
    })
  );
}

function buildMarkdownFromContext(
  context: ContentSource,
  url: string,
  signal?: AbortSignal
): MarkdownTransformResult {
  const content = runTransformStage(url, 'transform:markdown', () =>
    htmlToMarkdown(context.sourceHtml, context.metadata, {
      url,
      ...(signal ? { signal } : {}),
      ...(context.document ? { document: context.document } : {}),
    })
  );
  return {
    markdown: content,
    title: context.title,
    truncated: false,
  };
}

function runTotalTransformStage<T>(url: string, fn: () => T): T {
  const totalStage = startTransformStage(url, 'transform:total');
  let success = false;

  try {
    const result = fn();
    success = true;
    return result;
  } finally {
    if (success) {
      endTransformStage(totalStage, { truncated: false });
    }
  }
}

async function runTotalTransformStageAsync<T>(
  url: string,
  fn: () => Promise<T>
): Promise<T> {
  const totalStage = startTransformStage(url, 'transform:total');
  let success = false;

  try {
    const result = await fn();
    success = true;
    return result;
  } finally {
    if (success) {
      endTransformStage(totalStage, { truncated: false });
    }
  }
}

export function transformHtmlToMarkdownInProcess(
  html: string,
  url: string,
  options: TransformOptions
): MarkdownTransformResult {
  return runTotalTransformStage(url, () => {
    throwIfAborted(options.signal, url, 'transform:begin');

    const raw = tryTransformRawStage(html, url, options.includeMetadata);
    if (raw) {
      return raw;
    }

    const context = resolveContentSourceStage(
      html,
      url,
      options.includeMetadata,
      options.signal
    );

    return buildMarkdownFromContext(context, url, options.signal);
  });
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

interface PendingTask {
  id: string;
  html: string;
  url: string;
  includeMetadata: boolean;
  signal: AbortSignal | undefined;
  abortListener: (() => void) | undefined;
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
    options: { includeMetadata: boolean; signal?: AbortSignal }
  ): Promise<MarkdownTransformResult>;
  close(): Promise<void>;
}

let pool: WorkerPool | null = null;

function resolveDefaultWorkerCount(): number {
  const parallelism =
    typeof os.availableParallelism === 'function'
      ? os.availableParallelism()
      : os.cpus().length;
  return Math.min(16, Math.max(1, parallelism - 1));
}

const DEFAULT_TIMEOUT_MS = config.transform.timeoutMs;

function getOrCreateTransformWorkerPool(): TransformWorkerPool {
  pool ??= new WorkerPool(resolveDefaultWorkerCount(), DEFAULT_TIMEOUT_MS);
  return pool;
}

export async function shutdownTransformWorkerPool(): Promise<void> {
  if (!pool) return;
  await pool.close();
  pool = null;
}

class WorkerPool implements TransformWorkerPool {
  private readonly workers: WorkerSlot[] = [];
  private readonly queue: PendingTask[] = [];
  private readonly inflight = new Map<string, InflightTask>();
  private readonly timeoutMs: number;
  private readonly queueMax: number;
  private closed = false;

  private ensureOpen(): void {
    if (this.closed) {
      throw new Error('Transform worker pool closed');
    }
  }

  private ensureNotAborted(
    signal: AbortSignal | undefined,
    url: string,
    stage: string
  ): void {
    if (!signal?.aborted) return;
    throw new FetchError('Request was canceled', url, 499, {
      reason: 'aborted',
      stage,
    });
  }

  private ensureQueueCapacity(url: string): void {
    if (this.queue.length < this.queueMax) return;
    throw new FetchError('Transform worker queue is full', url, 503, {
      reason: 'queue_full',
      stage: 'transform:enqueue',
    });
  }

  private clearAbortListener(
    signal: AbortSignal | undefined,
    listener: (() => void) | undefined
  ): void {
    if (!signal || !listener) return;
    try {
      signal.removeEventListener('abort', listener);
    } catch {
      /* empty */
    }
  }

  private markSlotIdle(workerIndex: number): void {
    const slot = this.workers[workerIndex];
    if (!slot) return;
    slot.busy = false;
    slot.currentTaskId = null;
  }

  private takeInflight(id: string): InflightTask | null {
    const inflight = this.inflight.get(id);
    if (!inflight) return null;

    clearTimeout(inflight.timer);
    this.clearAbortListener(inflight.signal, inflight.abortListener);
    this.inflight.delete(id);

    return inflight;
  }

  private cancelWorkerTask(slot: WorkerSlot | undefined, id: string): void {
    if (!slot) return;
    try {
      slot.worker.postMessage({ type: 'cancel', id });
    } catch {
      /* empty */
    }
  }

  private restartWorker(workerIndex: number, slot?: WorkerSlot): void {
    if (this.closed) return;
    const target = slot ?? this.workers[workerIndex];
    if (target) {
      void target.worker.terminate();
    }
    this.workers[workerIndex] = this.spawnWorker(workerIndex);
    this.drainQueue();
  }

  private rejectIfClosed(reject: (error: unknown) => void): boolean {
    if (!this.closed) return false;
    reject(new Error('Transform worker pool closed'));
    return true;
  }

  private abortInflightTask(
    id: string,
    url: string,
    workerIndex: number
  ): void {
    const slot = this.workers[workerIndex];
    this.cancelWorkerTask(slot, id);
    this.failTask(
      id,
      new FetchError('Request was canceled', url, 499, {
        reason: 'aborted',
        stage: 'transform:signal-abort',
      })
    );
    if (slot) {
      this.restartWorker(workerIndex, slot);
    }
  }

  private abortQueuedTask(
    id: string,
    url: string,
    reject: (error: unknown) => void
  ): void {
    const queuedIndex = this.queue.findIndex((task) => task.id === id);
    if (queuedIndex === -1) return;
    this.queue.splice(queuedIndex, 1);
    reject(
      new FetchError('Request was canceled', url, 499, {
        reason: 'aborted',
        stage: 'transform:queued-abort',
      })
    );
  }

  private createWorkerSlot(worker: Worker): WorkerSlot {
    return {
      worker,
      busy: false,
      currentTaskId: null,
    };
  }

  private registerWorkerHandlers(workerIndex: number, worker: Worker): void {
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
  }

  constructor(size: number, timeoutMs: number) {
    const safeSize = Math.max(1, size);
    this.timeoutMs = timeoutMs;
    this.queueMax = safeSize * 2;

    for (let index = 0; index < safeSize; index += 1) {
      this.workers.push(this.spawnWorker(index));
    }
  }

  private spawnWorker(workerIndex: number): WorkerSlot {
    const worker = new Worker(
      new URL('./workers/transform-worker.js', import.meta.url)
    );

    worker.unref();

    const slot = this.createWorkerSlot(worker);
    this.registerWorkerHandlers(workerIndex, worker);
    return slot;
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

  private resolveWorkerResult(
    inflight: InflightTask,
    result: { markdown: string; title?: string | undefined; truncated: boolean }
  ): void {
    inflight.resolve({
      markdown: result.markdown,
      truncated: result.truncated,
      title: result.title,
    });
  }

  private rejectWorkerError(
    inflight: InflightTask,
    error: {
      name: string;
      message: string;
      url: string;
      statusCode?: number | undefined;
      details?: Record<string, unknown> | undefined;
    }
  ): void {
    if (error.name === 'FetchError') {
      inflight.reject(
        new FetchError(
          error.message,
          error.url,
          error.statusCode,
          error.details ?? {}
        )
      );
      return;
    }
    inflight.reject(new Error(error.message));
  }

  private onWorkerMessage(workerIndex: number, raw: unknown): void {
    const parsed = workerMessageSchema.safeParse(raw);
    if (!parsed.success) return;

    const message = parsed.data;
    const inflight = this.takeInflight(message.id);
    if (!inflight) return;

    this.markSlotIdle(workerIndex);

    if (message.type === 'result') {
      this.resolveWorkerResult(inflight, message.result);
    } else {
      this.rejectWorkerError(inflight, message.error);
    }

    this.drainQueue();
  }

  private failTask(id: string, error: unknown): void {
    const inflight = this.takeInflight(id);
    if (!inflight) return;

    inflight.reject(error);
    this.markSlotIdle(inflight.workerIndex);
  }

  private handleAbortSignal(
    id: string,
    url: string,
    reject: (error: unknown) => void
  ): void {
    if (this.rejectIfClosed(reject)) return;

    const inflight = this.inflight.get(id);
    if (inflight) {
      this.abortInflightTask(id, url, inflight.workerIndex);
      return;
    }

    this.abortQueuedTask(id, url, reject);
  }

  private createPendingTask(
    html: string,
    url: string,
    options: { includeMetadata: boolean; signal?: AbortSignal },
    resolve: (result: MarkdownTransformResult) => void,
    reject: (error: unknown) => void
  ): PendingTask {
    const id = randomUUID();

    let abortListener: (() => void) | undefined;
    if (options.signal) {
      abortListener = () => {
        this.handleAbortSignal(id, url, reject);
      };
      options.signal.addEventListener('abort', abortListener, { once: true });
    }

    return {
      id,
      html,
      url,
      includeMetadata: options.includeMetadata,
      signal: options.signal,
      abortListener,
      resolve,
      reject,
    };
  }

  async transform(
    html: string,
    url: string,
    options: { includeMetadata: boolean; signal?: AbortSignal }
  ): Promise<MarkdownTransformResult> {
    this.ensureOpen();
    this.ensureNotAborted(options.signal, url, 'transform:enqueue');
    this.ensureQueueCapacity(url);

    return new Promise<MarkdownTransformResult>((resolve, reject) => {
      const task = this.createPendingTask(html, url, options, resolve, reject);
      this.queue.push(task);

      this.drainQueue();
    });
  }

  private drainQueue(): void {
    if (this.queue.length === 0) return;

    for (
      let workerIndex = 0;
      workerIndex < this.workers.length;
      workerIndex += 1
    ) {
      const slot = this.workers[workerIndex];
      if (!slot || slot.busy) continue;

      const task = this.queue.shift();
      if (!task) return;

      this.dispatch(workerIndex, slot, task);

      if (this.queue.length === 0) return;
    }
  }

  private dispatch(
    workerIndex: number,
    slot: WorkerSlot,
    task: PendingTask
  ): void {
    if (this.rejectIfAborted(task)) return;

    this.markSlotBusy(slot, task);
    const timer = this.startTaskTimer(workerIndex, slot, task);
    this.registerInflightTask(task, timer, workerIndex);

    try {
      this.sendTransformMessage(slot, task);
    } catch (error: unknown) {
      this.handleDispatchFailure(workerIndex, slot, task, timer, error);
    }
  }

  private rejectIfAborted(task: PendingTask): boolean {
    if (!task.signal?.aborted) return false;
    this.clearAbortListener(task.signal, task.abortListener);
    task.reject(
      new FetchError('Request was canceled', task.url, 499, {
        reason: 'aborted',
        stage: 'transform:dispatch',
      })
    );
    return true;
  }

  private markSlotBusy(slot: WorkerSlot, task: PendingTask): void {
    slot.busy = true;
    slot.currentTaskId = task.id;
  }

  private startTaskTimer(
    workerIndex: number,
    slot: WorkerSlot,
    task: PendingTask
  ): NodeJS.Timeout {
    const timer = setTimeout(() => {
      this.cancelWorkerTask(slot, task.id);
      const inflight = this.takeInflight(task.id);
      if (!inflight) return;

      inflight.reject(
        new FetchError('Request timeout', task.url, 504, {
          reason: 'timeout',
          stage: 'transform:worker-timeout',
        })
      );

      this.restartWorker(workerIndex, slot);
    }, this.timeoutMs);
    timer.unref();
    return timer;
  }

  private registerInflightTask(
    task: PendingTask,
    timer: NodeJS.Timeout,
    workerIndex: number
  ): void {
    this.inflight.set(task.id, {
      resolve: task.resolve,
      reject: task.reject,
      timer,
      signal: task.signal,
      abortListener: task.abortListener,
      workerIndex,
    });
  }

  private sendTransformMessage(slot: WorkerSlot, task: PendingTask): void {
    slot.worker.postMessage({
      type: 'transform',
      id: task.id,
      html: task.html,
      url: task.url,
      includeMetadata: task.includeMetadata,
    });
  }

  private handleDispatchFailure(
    workerIndex: number,
    slot: WorkerSlot,
    task: PendingTask,
    timer: NodeJS.Timeout,
    error: unknown
  ): void {
    clearTimeout(timer);
    this.clearAbortListener(task.signal, task.abortListener);
    this.inflight.delete(task.id);
    this.markSlotIdle(workerIndex);

    const message =
      error instanceof Error
        ? error
        : new Error('Failed to dispatch transform worker message');
    task.reject(message);

    this.restartWorker(workerIndex, slot);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    const terminations = this.workers.map((slot) => slot.worker.terminate());
    this.workers.length = 0;

    for (const [id, inflight] of this.inflight.entries()) {
      clearTimeout(inflight.timer);
      this.clearAbortListener(inflight.signal, inflight.abortListener);
      inflight.reject(new Error('Transform worker pool closed'));
      this.inflight.delete(id);
    }

    for (const task of this.queue) {
      task.reject(new Error('Transform worker pool closed'));
    }
    this.queue.length = 0;

    await Promise.allSettled(terminations);
  }
}

function buildWorkerTransformOptions(options: TransformOptions): {
  includeMetadata: boolean;
  signal?: AbortSignal;
} {
  return {
    includeMetadata: options.includeMetadata,
    ...(options.signal ? { signal: options.signal } : {}),
  };
}

async function transformWithWorkerPool(
  html: string,
  url: string,
  options: TransformOptions
): Promise<MarkdownTransformResult> {
  const poolRef = getOrCreateTransformWorkerPool();
  return poolRef.transform(html, url, buildWorkerTransformOptions(options));
}

function resolveWorkerFallback(
  error: unknown,
  html: string,
  url: string,
  options: TransformOptions
): MarkdownTransformResult {
  if (error instanceof FetchError) {
    throw error;
  }

  throwIfAborted(options.signal, url, 'transform:worker-fallback');
  return transformHtmlToMarkdownInProcess(html, url, options);
}

export async function transformHtmlToMarkdown(
  html: string,
  url: string,
  options: TransformOptions
): Promise<MarkdownTransformResult> {
  return runTotalTransformStageAsync(url, async () => {
    throwIfAborted(options.signal, url, 'transform:begin');

    const workerStage = startTransformStage(url, 'transform:worker');
    try {
      const result = await transformWithWorkerPool(html, url, options);
      return result;
    } catch (error: unknown) {
      const fallback = resolveWorkerFallback(error, html, url, options);
      return fallback;
    } finally {
      endTransformStage(workerStage);
    }
  });
}
