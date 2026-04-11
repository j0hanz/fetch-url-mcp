import diagnosticsChannel from 'node:diagnostics_channel';
import process from 'node:process';
import { isMainThread, parentPort } from 'node:worker_threads';

import { isProbablyReaderable, Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import {
  NodeHtmlMarkdown,
  type TranslatorConfig,
  type TranslatorConfigObject,
} from 'node-html-markdown';

import { config } from '../lib/config.js';
import {
  getOperationId,
  getRequestId,
  logDebug,
  logError,
  Loggers,
  logInfo,
  logWarn,
  redactUrl,
} from '../lib/core.js';
import {
  FetchError,
  getErrorMessage,
  SystemErrors,
  throwIfAborted,
  toError,
} from '../lib/error/index.js';
import { isRawTextContentUrl } from '../lib/net/http.js';
import {
  CharCode,
  composeAbortSignal,
  getUtf8ByteLength,
  isAsciiOnly,
  isHtmlNode,
  isObject,
  isWhitespaceChar,
  trimDanglingTagFragment,
  truncateToUtf8Boundary,
} from '../lib/utils.js';

import { type ExtractedMetadata } from '../schemas.js';
import {
  getWorkerPoolStats,
  shutdownWorkerPool,
  transformWithWorkerPool as transformWithWorkerPoolRuntime,
} from './worker-pool.js';

/*
 * Module map:
 * - Head-section parsing -> Public interface
 * - Frontmatter & Source Injection -> Title Policy
 * - Content evaluation heuristics
 * - DOM helpers (translator-only) -> Translator registry + converter singleton
 * - Worker message validation -> Worker thread message handling
 * Own HTML extraction, markdown translation, and transform worker coordination here. Keep transport, auth, and task routing logic elsewhere.
 */

/**
 * Shared types for the transform pipeline.
 * Extracted to avoid circular dependencies between transform modules.
 */

/**
 * Metadata block for attaching source information to markdown output.
 */
export interface MetadataBlock {
  type: 'metadata';
  title?: string;
  description?: string;
  author?: string;
  url: string;
  fetchedAt: string;
}

/**
 * Article extracted by Readability.
 */
export interface ExtractedArticle {
  title?: string;
  byline?: string;
  content: string;
  textContent: string;
  excerpt?: string;
  siteName?: string;
}

/**
 * Result of content extraction (article + metadata).
 */
export interface ExtractionResult {
  article: ExtractedArticle | null;
  metadata: ExtractedMetadata;
}

interface MarkdownPayload {
  markdown: string;
  title?: string | undefined;
  truncated: boolean;
  metadata?: ExtractedMetadata | undefined;
}

/**
 * Result of HTML to markdown transformation.
 */
export interface MarkdownTransformResult extends MarkdownPayload {
  title: string | undefined;
}

/**
 * Options for transform operations.
 */
export interface TransformOptions {
  includeMetadataFooter: boolean;
  signal?: AbortSignal;
  inputTruncated?: boolean;
}

/**
 * Telemetry event emitted during transform stages.
 */
export interface TransformStageEvent {
  v: 1;
  type: 'stage';
  stage: string;
  durationMs: number;
  url: string;
  requestId?: string;
  operationId?: string;
  truncated?: boolean;
}

/**
 * Context for tracking transform stage timing.
 */
export interface TransformStageContext {
  readonly stage: string;
  readonly startTime: number;
  readonly url: string;
  readonly budgetMs?: number;
  readonly totalBudgetMs?: number;
}

/**
 * Worker message types for transform workers.
 */
export interface TransformWorkerTransformMessage {
  type: 'transform';
  id: string;
  html?: string | undefined;
  htmlBuffer?: Uint8Array | undefined;
  encoding?: string | undefined;
  url: string;
  includeMetadataFooter: boolean;
  inputTruncated?: boolean | undefined;
}

export interface TransformWorkerCancelledMessage {
  type: 'cancelled';
  id: string;
}

export interface TransformWorkerResultMessage {
  type: 'result';
  id: string;
  result: MarkdownPayload;
}

export interface TransformWorkerErrorMessage {
  type: 'error';
  id: string;
  error: {
    name: string;
    message: string;
    url: string;
    statusCode?: number | undefined;
    details?: Record<string, unknown> | undefined;
  };
}

export type TransformWorkerOutgoingMessage =
  | TransformWorkerResultMessage
  | TransformWorkerErrorMessage
  | TransformWorkerCancelledMessage;

interface WorkerMessageHandlerOptions {
  sendMessage: (message: TransformWorkerOutgoingMessage) => void;
  runTransform: (
    html: string,
    url: string,
    options: TransformOptions
  ) => MarkdownTransformResult;
}

type IncomingMessageRecord = Record<string, unknown>;

function isTransformMessage(
  message: unknown
): message is TransformWorkerTransformMessage {
  if (!message || typeof message !== 'object') return false;

  const value = message as IncomingMessageRecord;
  const {
    id,
    url,
    html,
    htmlBuffer,
    encoding,
    includeMetadataFooter,
    inputTruncated,
  } = value;

  return (
    typeof id === 'string' &&
    typeof url === 'string' &&
    typeof includeMetadataFooter === 'boolean' &&
    (html === undefined || typeof html === 'string') &&
    (htmlBuffer === undefined || htmlBuffer instanceof Uint8Array) &&
    (encoding === undefined || typeof encoding === 'string') &&
    (inputTruncated === undefined || typeof inputTruncated === 'boolean')
  );
}

function decodeHtml(
  html: string | undefined,
  htmlBuffer: Uint8Array | undefined,
  encoding: string | undefined,
  decoder: TextDecoder
): string {
  if (!htmlBuffer) return html ?? '';

  if (!encoding || encoding === 'utf-8') {
    return decoder.decode(htmlBuffer);
  }

  try {
    const decoded = new TextDecoder(encoding).decode(htmlBuffer);
    return decoded;
  } catch {
    return decoder.decode(htmlBuffer);
  }
}

function createErrorMessage(
  id: string,
  url: string,
  error: unknown
): TransformWorkerOutgoingMessage {
  if (error instanceof FetchError) {
    return {
      type: 'error',
      id,
      error: {
        name: error.name,
        message: error.message,
        url: error.url,
        statusCode: error.statusCode,
        details: { ...error.details },
      },
    };
  }

  return {
    type: 'error',
    id,
    error: {
      name: error instanceof Error ? error.name : 'Error',
      message: getErrorMessage(error),
      url,
    },
  };
}

function createResultMessage(
  id: string,
  result: MarkdownTransformResult
): TransformWorkerOutgoingMessage {
  return {
    type: 'result',
    id,
    result: {
      markdown: result.markdown,
      ...(result.metadata ? { metadata: result.metadata } : {}),
      ...(result.title !== undefined ? { title: result.title } : {}),
      truncated: result.truncated,
    },
  };
}

function createValidationErrorMessage(
  id: string,
  url: string,
  message: string
): TransformWorkerOutgoingMessage {
  return {
    type: 'error',
    id,
    error: {
      name: 'ValidationError',
      message,
      url,
    },
  };
}

function handleCancelMessage(params: {
  id: string;
  controllersById: Map<string, AbortController>;
  sendMessage: (message: TransformWorkerOutgoingMessage) => void;
}): void {
  const controller = params.controllersById.get(params.id);
  if (controller) controller.abort(new Error('Canceled'));

  params.sendMessage({ type: 'cancelled', id: params.id });
}

function executeTransformMessage(params: {
  message: TransformWorkerTransformMessage;
  controllersById: Map<string, AbortController>;
  decoder: TextDecoder;
  runTransform: WorkerMessageHandlerOptions['runTransform'];
  sendMessage: WorkerMessageHandlerOptions['sendMessage'];
}): void {
  const { message, controllersById, decoder, runTransform, sendMessage } =
    params;
  const {
    id,
    url,
    html,
    htmlBuffer,
    encoding,
    includeMetadataFooter,
    inputTruncated,
  } = message;

  if (!id.trim()) {
    sendMessage(
      createValidationErrorMessage(
        id,
        url || '',
        'Missing transform message id'
      )
    );
    return;
  }

  if (!url.trim()) {
    sendMessage(createValidationErrorMessage(id, url, 'Missing transform URL'));
    return;
  }

  const controller = new AbortController();
  controllersById.set(id, controller);

  try {
    const content = decodeHtml(html, htmlBuffer, encoding, decoder);
    const result = runTransform(content, url, {
      includeMetadataFooter,
      signal: controller.signal,
      ...(inputTruncated ? { inputTruncated: true } : {}),
    });

    sendMessage(createResultMessage(id, result));
  } catch (error: unknown) {
    sendMessage(createErrorMessage(id, url, error));
  } finally {
    controllersById.delete(id);
  }
}

export function createTransformMessageHandler(
  options: WorkerMessageHandlerOptions
): (raw: unknown) => void {
  const { sendMessage, runTransform } = options;
  const controllersById = new Map<string, AbortController>();
  const decoder = new TextDecoder('utf-8');

  return (raw: unknown): void => {
    if (!raw || typeof raw !== 'object') return;

    const message = raw as IncomingMessageRecord;
    const messageType = message['type'];
    const messageId = message['id'];

    if (messageType === 'cancel') {
      if (typeof messageId !== 'string') return;
      handleCancelMessage({ id: messageId, controllersById, sendMessage });
      return;
    }

    if (messageType !== 'transform' || !isTransformMessage(message)) return;
    executeTransformMessage({
      message,
      controllersById,
      decoder,
      runTransform,
      sendMessage,
    });
  };
}

// ---------------------------------------------------------------------------
// Head-section parsing
// ---------------------------------------------------------------------------

const HEAD_END_PATTERN = /<\/head\s*>|<body\b/i;
const MAX_HEAD_SCAN_LENGTH = 50_000;

function extractHeadSection(html: string): string | null {
  const searchText =
    html.length <= MAX_HEAD_SCAN_LENGTH
      ? html
      : html.slice(0, MAX_HEAD_SCAN_LENGTH);

  const match = HEAD_END_PATTERN.exec(searchText);
  return match ? html.slice(0, match.index) : null;
}

// ---------------------------------------------------------------------------
// MetaContext & handlers
// ---------------------------------------------------------------------------

interface MetaContext {
  title: { og?: string; twitter?: string; standard?: string };
  description: { og?: string; twitter?: string; standard?: string };
  author?: string;
  image?: string;
  publishedAt?: string;
  modifiedAt?: string;
}

export function normalizeDocumentTitle(
  title: string,
  baseUrl?: string
): string {
  if (!baseUrl || !title.startsWith('GitHub - ')) return title;

  const parsed = URL.parse(baseUrl);
  if (!parsed) return title;

  const hostname = parsed.hostname.toLowerCase();
  if (hostname !== 'github.com' && hostname !== 'www.github.com') {
    return title;
  }

  const segments = parsed.pathname.split('/').filter(Boolean);
  if (segments.length !== 2) return title;

  const [owner, repo] = segments;
  if (!owner || !repo) return title;

  return `${owner}/${repo}`;
}

type MetaHandler = (ctx: MetaContext, content: string) => void;

const META_PROPERTY_HANDLERS = new Map<string, MetaHandler>([
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

const META_NAME_HANDLERS = new Map<string, MetaHandler>([
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

// ---------------------------------------------------------------------------
// Favicon resolution
// ---------------------------------------------------------------------------

/** Ordered by preference: exact 32×32, SVG, any generic icon, legacy shortcut. */
const FAVICON_SELECTORS = [
  'link[rel="icon"][sizes="32x32"]',
  'link[rel="icon"][type="image/svg+xml"]',
  'link[rel="icon"]',
  'link[rel="shortcut icon"]',
] as const;

function resolveFaviconUrl(href: string, baseUrl: string): string | undefined {
  const trimmed = href.trim();
  if (!trimmed || trimmed.toLowerCase().startsWith('data:')) return undefined;

  const resolved = URL.parse(trimmed, baseUrl);
  if (resolved?.protocol !== 'http:' && resolved?.protocol !== 'https:') {
    return undefined;
  }

  return resolved.toString();
}

function extractFavicon(
  document: Document,
  baseUrl: string
): string | undefined {
  for (const selector of FAVICON_SELECTORS) {
    for (const el of document.querySelectorAll<HTMLLinkElement>(selector)) {
      const href = el.getAttribute('href');
      if (href) {
        const resolved = resolveFaviconUrl(href, baseUrl);
        if (resolved) return resolved;
      }
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export function extractMetadata(
  document: Document,
  baseUrl?: string
): ExtractedMetadata {
  const ctx = buildMetaContext(document);
  const metadata = resolveMetadataFromContext(ctx);
  if (metadata.title) {
    metadata.title = normalizeDocumentTitle(metadata.title, baseUrl);
  }
  if (baseUrl) {
    const favicon = extractFavicon(document, baseUrl);
    if (favicon) metadata.favicon = favicon;
  }

  return metadata;
}

export function extractMetadataFromHead(
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

export function mergeMetadata(
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
    'favicon',
    'publishedAt',
    'modifiedAt',
  ] as const;
  for (const key of keys) {
    const value = late[key] ?? early[key];
    if (value !== undefined) merged[key] = value;
  }

  return merged;
}

const BODY_SCAN_LIMIT = 500;
const HTML_TAG_DENSITY_LIMIT = 5;

const HEADING_MARKER = /^#{1,6}\s/m;
const HEADING_STRICT = /^#{1,6}\s+/m;
const SOURCE_KEY = /^source:\s/im;
const HTML_DOC_START = /^(<!doctype|<html)/i;
const LIST_MARKER = /^(?:[-*+])\s/m;

function getLineEnding(content: string): '\n' | '\r\n' {
  return content.includes('\r\n') ? '\r\n' : '\n';
}

// region Frontmatter & Source Injection

interface FrontmatterRange {
  start: number;
  end: number;
  linesStart: number;
  linesEnd: number;
  lineEnding: '\n' | '\r\n';
}
interface FrontmatterResult {
  range: FrontmatterRange;
  entries: Map<string, string>;
}
function stripSurroundingQuotes(value: string): string {
  const first = value.charAt(0);
  const last = value.charAt(value.length - 1);
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return value.slice(1, -1).trim();
  }
  return value;
}

function parseFrontmatterEntries(
  body: string,
  lineEnding: string
): Map<string, string> {
  const entries = new Map<string, string>();
  let lastIdx = 0;
  while (lastIdx < body.length) {
    let nextIdx = body.indexOf(lineEnding, lastIdx);
    if (nextIdx === -1) nextIdx = body.length;

    const line = body.slice(lastIdx, nextIdx).trim();
    const colonIdx = line.indexOf(':');
    if (line && colonIdx > 0) {
      const key = line.slice(0, colonIdx).trim().toLowerCase();
      const value = stripSurroundingQuotes(line.slice(colonIdx + 1).trim());
      if (value) entries.set(key, value);
    }
    lastIdx = nextIdx + lineEnding.length;
  }
  return entries;
}

function parseFrontmatter(content: string): FrontmatterResult | null {
  const len = content.length;
  if (len < 4) return null;

  let lineEnding: '\n' | '\r\n' | null = null;
  let fenceLen = 0;

  if (content.startsWith('---\n')) {
    lineEnding = '\n';
    fenceLen = 4;
  } else if (content.startsWith('---\r\n')) {
    lineEnding = '\r\n';
    fenceLen = 5;
  }

  if (!lineEnding) return null;

  const fence = `---${lineEnding}`;
  const closeIndex = content.indexOf(fence, fenceLen);
  if (closeIndex === -1) return null;

  const range: FrontmatterRange = {
    start: 0,
    end: closeIndex + fenceLen,
    linesStart: fenceLen,
    linesEnd: closeIndex,
    lineEnding,
  };

  const entries = parseFrontmatterEntries(
    content.slice(range.linesStart, range.linesEnd),
    lineEnding
  );

  return { range, entries };
}
function scanBodyForTitle(content: string): string | undefined {
  const len = content.length;
  let scanIndex = 0;
  const maxScan = Math.min(len, BODY_SCAN_LIMIT);

  while (scanIndex < maxScan) {
    let nextIndex = content.indexOf('\n', scanIndex);
    if (nextIndex === -1) nextIndex = len;

    let line = content.slice(scanIndex, nextIndex);
    if (line.endsWith('\r')) line = line.slice(0, -1);

    const trimmed = line.trim();
    if (trimmed) {
      if (HEADING_STRICT.test(trimmed)) {
        return trimmed.replace(HEADING_MARKER, '').trim() || undefined;
      }
    }

    scanIndex = nextIndex + 1;
  }
  return undefined;
}
export function extractTitleFromRawMarkdown(
  content: string
): string | undefined {
  const fm = parseFrontmatter(content);
  if (fm) {
    const title = fm.entries.get('title') ?? fm.entries.get('name');
    if (title) return title;
  }
  return scanBodyForTitle(fm ? content.slice(fm.range.end) : content);
}
export function addSourceToMarkdown(content: string, url: string): string {
  const fm = parseFrontmatter(content);
  const useMarkdownFormat = config.transform.metadataFormat === 'markdown';

  if (useMarkdownFormat && !fm) {
    if (SOURCE_KEY.test(content)) return content;
    const lineEnding = getLineEnding(content);
    const firstH1Match = HEADING_MARKER.exec(content);

    if (firstH1Match) {
      const h1Index = firstH1Match.index;
      const lineEndIndex = content.indexOf(lineEnding, h1Index);
      const insertPos =
        lineEndIndex === -1 ? content.length : lineEndIndex + lineEnding.length;

      const injection = `${lineEnding}Source: ${url}${lineEnding}`;
      return content.slice(0, insertPos) + injection + content.slice(insertPos);
    }

    return `Source: ${url}${lineEnding}${lineEnding}${content}`;
  }

  if (!fm) {
    const lineEnding = getLineEnding(content);
    const escapedUrl = url.replace(/"/g, '\\"');
    return `---${lineEnding}source: "${escapedUrl}"${lineEnding}---${lineEnding}${lineEnding}${content}`;
  }

  const fmBody = content.slice(fm.range.linesStart, fm.range.linesEnd);
  if (SOURCE_KEY.test(fmBody)) return content;

  const escapedUrl = url.replace(/"/g, '\\"');
  const injection = `source: "${escapedUrl}"${fm.range.lineEnding}`;

  return (
    content.slice(0, fm.range.linesEnd) +
    injection +
    content.slice(fm.range.linesEnd)
  );
}

// endregion

// region Content Detection & Metadata Footer

function countCommonTags(content: string, limit: number): number {
  if (limit <= 0) return 0;

  const regex = /<(html|head|body|div|span|script|style|meta|link)\b/gi;

  let count = 0;
  while (regex.exec(content)) {
    count += 1;
    if (count > limit) break;
  }

  return count;
}
export function isRawTextContent(content: string): boolean {
  const trimmed = content.trim();
  if (HTML_DOC_START.test(trimmed)) return false;

  if (parseFrontmatter(trimmed) !== null) return true;

  const tagCount = countCommonTags(content, HTML_TAG_DENSITY_LIMIT);
  if (tagCount > HTML_TAG_DENSITY_LIMIT) return false;

  return (
    HEADING_MARKER.test(content) ||
    LIST_MARKER.test(content) ||
    content.includes('```')
  );
}
function formatFetchedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;

  const formatter = new Intl.DateTimeFormat(config.i18n.locale, {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });

  return formatter.format(date);
}
export function buildMetadataFooter(
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
    parts.push(`_${formatFetchedAt(metadata.fetchedAt)}_`);
  }

  if (parts.length > 0) lines.push(` ${parts.join(' | ')}`);
  if (metadata.description) lines.push(` ${metadata.description}`);

  return lines.join('\n');
}

// endregion

// region Title Policy

export interface SyntheticTitleContext {
  readonly title: string | undefined;
}

// eslint-disable-next-line sonarjs/slow-regex -- bounded title separator, no user input
const TITLE_PART_SEPARATOR = /\s*(?:[-|:•·]|–|—)\s*/u;
// eslint-disable-next-line sonarjs/slow-regex -- anchored heading pattern on short lines
const LEADING_HEADING_PATTERN = /^(#{1,6})\s+(.+?)\s*$/;
const HEADING_SCAN_LIMIT = 12;

export function normalizeSyntheticTitleToken(
  value: string | undefined
): string {
  return (value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

export function shouldPreferPrimaryHeadingTitle(
  primaryHeading: string | undefined,
  title: string | undefined
): boolean {
  const primary = normalizeSyntheticTitleToken(primaryHeading);
  if (!primary) return false;

  const normalizedTitle = normalizeSyntheticTitleToken(title);
  if (!normalizedTitle) return true;
  if (normalizedTitle === primary) return true;

  return normalizedTitle
    .split(TITLE_PART_SEPARATOR)
    .some((part) => part === primary);
}

export function isGithubRepositoryRootUrl(url: string): boolean {
  const parsed = URL.parse(url);
  if (!parsed) return false;

  const hostname = parsed.hostname.toLowerCase();
  if (hostname !== 'github.com' && hostname !== 'www.github.com') {
    return false;
  }

  return parsed.pathname.split('/').filter(Boolean).length === 2;
}

function stripLeadingHeading(markdown: string, headingText: string): string {
  if (!markdown) return markdown;

  const lines = markdown.split('\n');
  const target = normalizeSyntheticTitleToken(headingText);
  let nonEmptySeen = 0;

  for (
    let index = 0;
    index < lines.length && nonEmptySeen < HEADING_SCAN_LIMIT;
    index += 1
  ) {
    const trimmed = lines[index]?.trim() ?? '';
    if (!trimmed) continue;

    nonEmptySeen += 1;
    const match = LEADING_HEADING_PATTERN.exec(trimmed);
    if (!match) continue;

    const current = normalizeSyntheticTitleToken(match[2] ?? '');
    if (current !== target) return markdown;

    lines.splice(index, 1);
    if ((lines[index] ?? '').trim() === '') {
      lines.splice(index, 1);
    }
    return lines.join('\n');
  }

  return markdown;
}

export function maybeStripGithubPrimaryHeading(
  markdown: string,
  primaryHeading: string | undefined,
  url: string
): string {
  if (primaryHeading === undefined || !isGithubRepositoryRootUrl(url)) {
    return markdown;
  }

  return stripLeadingHeading(markdown, primaryHeading);
}

export function maybePrependSyntheticTitle(
  markdown: string,
  context: SyntheticTitleContext
): string {
  if (!context.title || /^#\s/.test(markdown.trimStart())) {
    return markdown;
  }

  return `# ${context.title}\n\n${markdown}`;
}

// endregion

// ── Thresholds ──────────────────────────────────────────────────────
const NOISE_SCAN_LIMIT = 50_000;
const MIN_BODY_CONTENT_LENGTH = 100;
const DIALOG_MIN_CHARS_FOR_PRESERVATION = 500;
const NAV_FOOTER_MIN_CHARS_FOR_PRESERVATION = 500;
const ABORT_CHECK_INTERVAL = 500;
const NODE_FILTER_SHOW_TEXT = 4;
const ASIDE_NAV_LINK_DENSITY_THRESHOLD = 0.5;
const ASIDE_NAV_MIN_LINKS = 10;
const INLINE_DEMO_INSTRUCTION_MAX_CHARS = 160;
const REDUNDANT_PREVIEW_SEGMENT_MAX_CHARS = 60;
const REDUNDANT_PREVIEW_MAX_SEGMENTS = 12;
const DENSITY_BASE_CHARS = 100;
const MAX_PERMALINK_TEXT_LENGTH = 2;
const MIN_LINES_FOR_TRUNCATION_CHECK = 3;

// ── Regex patterns ──────────────────────────────────────────────────
const HTML_DOCUMENT_MARKERS = /<\s*(?:!doctype|html|head|body)\b/i;
const HTML_FRAGMENT_MARKERS =
  /<\s*(?:article|main|section|div|nav|footer|header|aside|table|ul|ol)\b/i;
const NOISE_PATTERNS: readonly RegExp[] = [
  /<\s*(?:script|style|noscript|iframe|nav|footer|header|form|button|input|select|textarea|svg|canvas)\b/i,
  /[\s"']role\s*=\s*['"]?(?:navigation|banner|complementary|contentinfo|tree|menubar|menu)['"]?/i,
  /[\s"'](?:aria-hidden\s*=\s*['"]?true['"]?|hidden)/i,
  /[\s"'](?:banner|promo|announcement|cta|advert|newsletter|subscribe|cookie|consent|popup|modal|overlay|toast)\b/i,
  /[\s"'](?:fixed|sticky|z-50|z-4|breadcrumbs?|pagination)\b/i,
];
const HEADER_NOISE_PATTERN =
  /\b(site-header|masthead|topbar|navbar|nav(?:bar)?|menu|header-nav)\b/i;
const FIXED_OR_HIGH_Z_PATTERN = /\b(?:fixed|sticky|z-(?:4\d|50))\b/;
const HEADING_PERMALINK_TEXT_PATTERN = /^[#¶§¤🔗]$/u;
const HEADING_PERMALINK_CLASS_PATTERN =
  /\b(?:mark|permalink|hash-link|anchor(?:js)?-?link|header-?link|heading-anchor|deep-link)\b/i;
const HIDDEN_STYLE_REGEX =
  /\b(?:display\s*:\s*none|visibility\s*:\s*hidden)\b/i;
const DISPLAY_NONE_REGEX = /display\s*:\s*none/i;
const DISPLAY_NONE_STRIP_REGEX = /display\s*:\s*none\s*;?/gi;
const UTM_PARAM_REGEX = /[?&]utm_(?:source|medium|campaign)=/i;
/** Sentinel regex that intentionally never matches; used for empty token sets. */
const NO_MATCH_REGEX = /a^/i;

// ── URL prefixes to skip during resolution ──────────────────────────
const SKIP_URL_PREFIXES = [
  '#',
  'javascript:',
  'mailto:',
  'tel:',
  'data:',
  'blob:',
];

// ── Tag / role sets ─────────────────────────────────────────────────
const BASE_STRUCTURAL_TAGS = new Set([
  'script',
  'style',
  'noscript',
  'iframe',
  'template',
  'form',
  'button',
  'input',
  'select',
  'textarea',
]);
const ALWAYS_NOISE_TAGS = new Set(['nav', 'footer']);
const NAVIGATION_ROLES = new Set([
  'navigation',
  'banner',
  'complementary',
  'contentinfo',
  'tree',
  'menubar',
  'menu',
  'dialog',
  'alertdialog',
  'search',
]);
const INTERACTIVE_CONTENT_ROLES = new Set([
  'tabpanel',
  'tab',
  'tablist',
  'dialog',
  'alertdialog',
  'menu',
  'menuitem',
  'option',
  'listbox',
  'combobox',
  'tooltip',
  'alert',
]);

// ── Promo tokens ────────────────────────────────────────────────────
const PROMO_TOKENS_ALWAYS = [
  'banner',
  'promo',
  'announcement',
  'cta',
  'advert',
  'ads',
  'sponsor',
  'recommend',
  'breadcrumb',
  'breadcrumbs',
  'taglist',
  'twitter-tweet',
  'fb-post',
  'instagram-media',
  'social-embed',
  'author-bio',
  'byline',
  'sharedaddy',
  'sharing',
];
const PROMO_TOKENS_AGGRESSIVE = ['ad', 'related', 'comment'];
const PROMO_TOKENS_BY_CATEGORY: Record<string, string[]> = {
  'cookie-banners': ['cookie', 'consent', 'popup', 'modal', 'overlay', 'toast'],
  newsletters: ['newsletter', 'subscribe'],
  'social-share': ['share', 'social', 'share-button'],
  'author-blocks': ['author-bio', 'byline', 'author-info', 'writer-profile'],
  'related-content': [
    'related-post',
    'related-article',
    'more-stories',
    'recommended-posts',
  ],
};

// ── Noise selector configurations ───────────────────────────────────
const BASE_NOISE_SELECTORS = {
  navFooter:
    'nav,footer,header[class*="site"],header[class*="nav"],header[class*="menu"],[role="banner"],[role="navigation"],[class*="breadcrumb"]',
  cookieBanners: '[role="dialog"]',
  hidden:
    '[style*="display: none"],[style*="display:none"],[style*="visibility: hidden"],[style*="visibility:hidden"],[hidden],[aria-hidden="true"]',
};
const DOCS_CONTROL_SELECTORS = [
  '.content-icon-container',
  '.edit-this-page',
  '.toc-overlay-icon',
  '.theme-toggle-container',
  '.sidebar-toggle',
  '.sidebar-drawer',
  '.toc-drawer',
  '.mobile-header',
  '.overlay.sidebar-overlay',
  '.overlay.toc-overlay',
  '.baseline-indicator',
  '.back-to-top',
  '.backtotop',
  '.headerlink',
  '[title="Edit this page"]',
  '.article-footer',
  '.baseline-indicator',
  'baseline-indicator',
  'mdn-content-feedback',
  'interactive-example',
] as const;

// ── Types ───────────────────────────────────────────────────────────
type NoiseRemovalConfig = (typeof config)['noiseRemoval'];
interface PromoTokenMatchers {
  readonly base: RegExp;
  readonly aggressive: RegExp;
}
interface NoiseContext {
  readonly flags: {
    readonly navFooter: boolean;
    readonly cookieBanners: boolean;
  };
  readonly structuralTags: Set<string>;
  readonly promoMatchers: PromoTokenMatchers;
  readonly promoEnabled: boolean;
  readonly noiseSelector: string;
  readonly extraSelector: string | null;
  readonly candidateSelector: string;
}

let cachedContext: NoiseContext | undefined;
let lastContextKey: string | undefined;

function escapeRegexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function buildTokenRegex(tokens: Set<string>): RegExp {
  if (tokens.size === 0) return NO_MATCH_REGEX;
  const pattern = new RegExp(
    `(?:^|[^a-z0-9])(?:${[...tokens].map(escapeRegexLiteral).join('|')})(?:$|[^a-z0-9])`,
    'i'
  );
  return pattern;
}
function getPromoMatchers(
  currentConfig: NoiseRemovalConfig,
  enabledCategories: Set<string>
): PromoTokenMatchers {
  const baseTokens = new Set(PROMO_TOKENS_ALWAYS);
  const aggressiveTokens = new Set<string>();

  if (currentConfig.aggressiveMode) {
    for (const token of PROMO_TOKENS_AGGRESSIVE) aggressiveTokens.add(token);
  }

  for (const [category, tokens] of Object.entries(PROMO_TOKENS_BY_CATEGORY)) {
    if (enabledCategories.has(category)) {
      for (const token of tokens) baseTokens.add(token);
    }
  }

  for (const t of currentConfig.extraTokens) {
    const n = t.toLowerCase().trim();
    if (n) baseTokens.add(n);
  }

  return {
    base: buildTokenRegex(baseTokens),
    aggressive: buildTokenRegex(aggressiveTokens),
  };
}
function buildNoiseSelector(flags: NoiseContext['flags']): string {
  const selectors = [BASE_NOISE_SELECTORS.hidden];
  if (flags.navFooter) selectors.push(BASE_NOISE_SELECTORS.navFooter);
  if (flags.cookieBanners) selectors.push(BASE_NOISE_SELECTORS.cookieBanners);
  return selectors.join(',');
}

function buildCandidateSelector(structuralTags: Set<string>): string {
  return [
    ...structuralTags,
    ...ALWAYS_NOISE_TAGS,
    'aside',
    'header',
    '[class]',
    '[id]',
    '[role]',
    '[style]',
  ].join(',');
}

function getContext(): NoiseContext {
  const currentConfig = config.noiseRemoval;
  const contextKey = JSON.stringify({
    locale: config.i18n.locale,
    enabledCategories: currentConfig.enabledCategories,
    extraTokens: currentConfig.extraTokens,
    extraSelectors: currentConfig.extraSelectors,
    aggressiveMode: currentConfig.aggressiveMode,
    preserveSvgCanvas: currentConfig.preserveSvgCanvas,
  });
  if (cachedContext !== undefined && lastContextKey === contextKey)
    return cachedContext;

  const enabled = new Set(
    currentConfig.enabledCategories
      .map((c) => {
        const s = c.toLowerCase().trim();
        const { locale } = config.i18n;
        return locale ? s.toLocaleLowerCase(locale) : s;
      })
      .filter(Boolean)
  );

  const isEnabled = (cat: string): boolean => enabled.has(cat);
  const flags = {
    navFooter: isEnabled('nav-footer'),
    cookieBanners: isEnabled('cookie-banners'),
  };

  const structuralTags = new Set(BASE_STRUCTURAL_TAGS);
  if (!currentConfig.preserveSvgCanvas) {
    structuralTags.add('svg');
    structuralTags.add('canvas');
  }

  const promoMatchers = getPromoMatchers(currentConfig, enabled);
  const extraSelectors = currentConfig.extraSelectors
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const noiseSelector = buildNoiseSelector(flags);
  const extraSelector =
    extraSelectors.length > 0 ? extraSelectors.join(',') : null;
  const candidateSelector = buildCandidateSelector(structuralTags);

  cachedContext = {
    flags,
    structuralTags,
    promoMatchers,
    promoEnabled: Object.keys(PROMO_TOKENS_BY_CATEGORY).some((cat) =>
      enabled.has(cat)
    ),
    noiseSelector,
    extraSelector,
    candidateSelector,
  };
  lastContextKey = contextKey;
  return cachedContext;
}
function isInteractive(element: Element, role: string | null): boolean {
  if (role && INTERACTIVE_CONTENT_ROLES.has(role)) return true;
  const tag = element.tagName.toLowerCase();
  const ds = element.getAttribute('data-state');
  if ((ds === 'inactive' || ds === 'closed') && !BASE_STRUCTURAL_TAGS.has(tag))
    return true;
  const dataOrientation = element.getAttribute('data-orientation');
  if (dataOrientation === 'horizontal' || dataOrientation === 'vertical')
    return true;
  return (
    element.hasAttribute('data-accordion-item') ||
    element.hasAttribute('data-radix-collection-item')
  );
}
function isPrimaryContent(element: Element, checkDescendants = false): boolean {
  if (element.closest('article,main,[role="main"]')) return true;
  if (checkDescendants && element.querySelector('article,main,[role="main"]'))
    return true;
  return false;
}
function isLinkDenseNavigation(
  element: Element,
  checkContainedNav = false
): boolean {
  if (checkContainedNav && element.querySelector('nav')) return true;
  const links = element.querySelectorAll('a[href]');
  if (links.length < ASIDE_NAV_MIN_LINKS) return false;
  const textLen = (element.textContent || '').trim().length;
  if (textLen === 0) return true;
  return (
    links.length / (textLen / DENSITY_BASE_CHARS) >=
    ASIDE_NAV_LINK_DENSITY_THRESHOLD
  );
}
function shouldPreserveDialog(element: Element): boolean {
  if (isPrimaryContent(element)) return true;
  const textLen = (element.textContent || '').length;
  if (textLen > DIALOG_MIN_CHARS_FOR_PRESERVATION) return true;
  return element.querySelector('h1,h2,h3,h4,h5,h6') !== null;
}

function shouldPreserveNavFooter(element: Element): boolean {
  if (element.querySelector('article,main,section,[role="main"]')) return true;
  const textLen = (element.textContent || '').trim().length;
  if (textLen < NAV_FOOTER_MIN_CHARS_FOR_PRESERVATION) return false;
  return !isLinkDenseNavigation(element);
}

function shouldPreserveAside(element: Element): boolean {
  if (!isPrimaryContent(element)) return false;
  return !isLinkDenseNavigation(element, true);
}

function shouldPreserve(element: Element, tagName: string): boolean {
  const role = element.getAttribute('role');
  if (role === 'dialog' || role === 'alertdialog') {
    return shouldPreserveDialog(element);
  }

  if (tagName === 'nav' || tagName === 'footer') {
    return shouldPreserveNavFooter(element);
  }

  if (tagName === 'aside') {
    return shouldPreserveAside(element);
  }

  return false;
}
function removeNodes(nodes: ArrayLike<Element>): void {
  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = nodes[i];
    if (node?.parentNode && !shouldPreserve(node, node.tagName.toLowerCase())) {
      node.remove();
    }
  }
}

function isStructuralNoise(
  tagName: string,
  interactive: boolean,
  context: NoiseContext
): boolean {
  return context.structuralTags.has(tagName) && !interactive;
}

function isNavigationNoise(
  tagName: string,
  role: string | null,
  className: string,
  id: string,
  context: NoiseContext
): boolean {
  if (!context.flags.navFooter) return false;
  if (ALWAYS_NOISE_TAGS.has(tagName)) return true;
  if (
    tagName === 'header' &&
    ((role !== null && NAVIGATION_ROLES.has(role)) ||
      HEADER_NOISE_PATTERN.test(`${className} ${id}`))
  )
    return true;
  if (tagName === 'aside') return true;
  return (
    role !== null &&
    NAVIGATION_ROLES.has(role) &&
    (tagName !== 'aside' || role !== 'complementary')
  );
}

function isHiddenNoise(hidden: boolean, interactive: boolean): boolean {
  return hidden && !interactive;
}

function isPositionalNoise(className: string, element: Element): boolean {
  return (
    FIXED_OR_HIGH_Z_PATTERN.test(className) &&
    (element.textContent || '').trim().length <
      NAV_FOOTER_MIN_CHARS_FOR_PRESERVATION
  );
}

function isPromoNoise(
  className: string,
  id: string,
  element: Element,
  context: NoiseContext
): boolean {
  if (!context.promoEnabled) return false;
  const aggTest =
    context.promoMatchers.aggressive.test(className) ||
    context.promoMatchers.aggressive.test(id);
  if (aggTest && !isPrimaryContent(element)) return true;
  if (
    context.promoMatchers.base.test(className) ||
    context.promoMatchers.base.test(id)
  ) {
    if (!isPrimaryContent(element, true)) return true;
  }
  return false;
}

function isNoiseElement(element: Element, context: NoiseContext): boolean {
  const tagName = element.tagName.toLowerCase();
  const role = element.getAttribute('role');
  const className = element.getAttribute('class') ?? '';
  const id = element.getAttribute('id') ?? '';
  const interactive = isInteractive(element, role);
  const style = element.getAttribute('style');
  const hidden =
    element.hasAttribute('hidden') ||
    element.getAttribute('aria-hidden') === 'true' ||
    (style !== null && HIDDEN_STYLE_REGEX.test(style));

  return (
    isStructuralNoise(tagName, interactive, context) ||
    isNavigationNoise(tagName, role, className, id, context) ||
    isHiddenNoise(hidden, interactive) ||
    isPositionalNoise(className, element) ||
    isPromoNoise(className, id, element, context)
  );
}
function stripHeadingWrapperDivs(h: Element): void {
  const divs = h.querySelectorAll('div');
  for (let j = divs.length - 1; j >= 0; j--) {
    const d = divs[j];
    if (!d?.parentNode) continue;
    const cls = d.getAttribute('class') ?? '';
    const stl = d.getAttribute('style') ?? '';
    if (
      cls.includes('absolute') ||
      stl.includes('position') ||
      d.getAttribute('tabindex') === '-1'
    ) {
      d.remove();
    }
  }
}

function stripPermalinkAnchors(h: Element): void {
  const anchors = h.querySelectorAll('a');
  for (let j = anchors.length - 1; j >= 0; j--) {
    const a = anchors[j];
    if (!a?.parentNode) continue;
    if (isHeadingPermalinkAnchor(a)) a.remove();
  }
}

function stripZeroWidthSpaces(h: Element, document: Document): void {
  const walker = document.createTreeWalker(h, NODE_FILTER_SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    if (node.textContent?.includes('\u200B')) {
      node.textContent = node.textContent.replace(/\u200B/g, '');
    }
  }
}

function cleanHeadings(document: Document): void {
  const headings = document.querySelectorAll('h1,h2,h3,h4,h5,h6');
  for (const h of headings) {
    if (!h.parentNode) continue;
    stripHeadingWrapperDivs(h);
    stripPermalinkAnchors(h);
    stripZeroWidthSpaces(h, document);
  }
}

function getCollapsedHeadingAnchorText(anchor: Element): string {
  return (anchor.textContent || '').replace(/[\u200B\s]/g, '');
}

function isHeadingPermalinkAnchor(anchor: Element): boolean {
  const href = anchor.getAttribute('href') ?? '';
  if (!href.startsWith('#')) return false;

  const text = getCollapsedHeadingAnchorText(anchor);
  if (text.length === 0 || HEADING_PERMALINK_TEXT_PATTERN.test(text)) {
    return true;
  }

  const className = anchor.getAttribute('class') ?? '';
  if (
    HEADING_PERMALINK_CLASS_PATTERN.test(className) &&
    text.length <= MAX_PERMALINK_TEXT_LENGTH
  ) {
    return true;
  }

  const ariaHidden = anchor.getAttribute('aria-hidden');
  const tabindex = anchor.getAttribute('tabindex');
  return (
    (ariaHidden === 'true' || tabindex === '-1') &&
    text.length <= MAX_PERMALINK_TEXT_LENGTH
  );
}

function hoistNestedRows(table: Element): void {
  const nestedRows = table.querySelectorAll('td tr, th tr');
  for (let i = nestedRows.length - 1; i >= 0; i--) {
    const nestedRow = nestedRows[i];
    if (nestedRow?.closest('table') != table) continue;
    const parentRow = nestedRow.parentElement?.closest('tr');
    if (parentRow && parentRow !== nestedRow) {
      parentRow.after(nestedRow);
    }
  }
}
function removeNoiseCandidates(
  candidates: NodeListOf<Element>,
  context: ReturnType<typeof getContext>,
  signal?: AbortSignal
): void {
  for (let i = candidates.length - 1; i >= 0; i--) {
    if (i % ABORT_CHECK_INTERVAL === 0 && signal?.aborted) {
      throw Error('Noise removal aborted');
    }
    const node = candidates[i];
    if (!node?.parentNode) continue;

    if (shouldPreserve(node, node.tagName.toLowerCase())) continue;
    if (isNoiseElement(node, context)) {
      node.remove();
    }
  }
}
function stripNoise(document: Document, signal?: AbortSignal): void {
  const context = getContext();

  if (config.noiseRemoval.debug) {
    logDebug(
      'Noise removal audit enabled',
      {
        categories: [...(context.flags.navFooter ? ['nav-footer'] : [])],
      },
      Loggers.LOG_TRANSFORM
    );
  }

  // Structural Removal
  removeNodes(document.querySelectorAll(context.noiseSelector));

  // Extra selectors (evaluated after base removal so DOM state is updated)
  if (context.extraSelector) {
    removeNodes(document.querySelectorAll(context.extraSelector));
  }

  // Candidates (conditional removal)
  removeNoiseCandidates(
    document.querySelectorAll(context.candidateSelector),
    context,
    signal
  );
}
function parseSrcsetEntries(
  srcset: string
): { url: string; descriptor: string }[] {
  return srcset.split(',').map((entry) => {
    const parts = entry.trim().split(/\s+/);
    return { url: parts[0] ?? '', descriptor: parts.slice(1).join(' ') };
  });
}

function processUrlElement(
  el: Element,
  attr: string,
  base: URL,
  isSrcset: boolean
): void {
  if (!el.parentNode) return;
  if (isSrcset) {
    const val = el.getAttribute(attr);
    if (val) {
      const newVal = parseSrcsetEntries(val)
        .map((entry) => {
          if (!entry.url) return entry.descriptor;
          const resolved = URL.parse(entry.url, base)?.href ?? entry.url;
          return entry.descriptor
            ? `${resolved} ${entry.descriptor}`
            : resolved;
        })
        .join(', ');
      el.setAttribute(attr, newVal);
    }
    return;
  }

  const val = el.getAttribute(attr);
  if (
    val &&
    !SKIP_URL_PREFIXES.some((p) => val.trim().toLowerCase().startsWith(p))
  ) {
    const resolved = URL.parse(val, base);
    if (resolved) el.setAttribute(attr, resolved.href);
  }
}

// Rewrite WordPress Photon CDN image URLs to point to the original host, since srcset URLs are often preserved with the updated domain while src is not.
// This ensures images are correctly resolved when the page is migrated to a new domain but still references the old domain in img src attributes.
export const WP_PHOTON_HOST_PATTERN = /^i\d\.wp\.com$/;

function rewritePhotonSrc(document: Document, pageHost: string): void {
  for (const img of document.querySelectorAll('img[src]')) {
    const src = img.getAttribute('src');
    if (!src) continue;
    const parsed = URL.parse(src);
    if (!parsed || !WP_PHOTON_HOST_PATTERN.test(parsed.hostname)) continue;
    if (img.getAttribute('srcset')) continue;
    const segments = parsed.pathname.split('/').filter(Boolean);
    if (segments.length < 2) continue;
    const originHost = segments[0];
    if (!originHost?.includes('.')) continue;
    const resourcePath = `/${segments.slice(1).join('/')}`;
    const rewritten = `https://${pageHost}${resourcePath}`;
    img.setAttribute('src', rewritten);
  }
}

// For images with src URLs pointing to a different domain than the page, check if their srcset contains a same-domain URL and prefer that for the src attribute.
// This can help preserve image loading when migrating content that references an old domain, as srcset entries are often left unchanged while src attributes are updated or removed.
function preferSameDomainSrc(document: Document, base: URL): void {
  const pageHost = base.hostname;
  for (const img of document.querySelectorAll('img[src][srcset]')) {
    const src = img.getAttribute('src');
    if (!src) continue;
    const srcParsed = URL.parse(src);
    if (!srcParsed || srcParsed.hostname === pageHost) continue;

    const srcset = img.getAttribute('srcset') ?? '';
    for (const entry of parseSrcsetEntries(srcset)) {
      if (!entry.url) continue;
      const parsed = URL.parse(entry.url);
      if (parsed?.hostname === pageHost) {
        img.setAttribute('src', entry.url);
        break;
      }
    }
  }
}

function getNoscriptImages(noscript: Element): Element[] {
  const imgs = Array.from(noscript.querySelectorAll('img'));
  if (imgs.length > 0) return imgs;

  const html = noscript.innerHTML || noscript.textContent || '';
  if (!/<img\b/i.test(html)) return [];

  const { document: fragDoc } = parseHTML(`<body>${html}</body>`);
  return Array.from(fragDoc.querySelectorAll('img'));
}

export function extractNoscriptImages(document: Document): void {
  for (const noscript of document.querySelectorAll('noscript')) {
    // linkedom may parse noscript children as DOM or raw text — handle both.
    const imgs = getNoscriptImages(noscript);
    if (imgs.length === 0) continue;

    // Skip when the previous sibling is (or contains) an <img> — the
    // lazy-loaded placeholder is already in the DOM and the translators
    // handle data-src / placeholder detection.
    const prev = noscript.previousElementSibling;
    if (prev?.tagName === 'IMG' || prev?.querySelector('img')) continue;

    for (const img of imgs) {
      // Skip tracking pixels (commonly 1×1 images placed in noscript by
      // analytics providers).
      if (
        img.getAttribute('width') === '1' ||
        img.getAttribute('height') === '1'
      )
        continue;
      noscript.before(img.cloneNode(true));
    }
  }
}

function resolveUrls(document: Document, baseUrlStr: string): void {
  const base = URL.parse(baseUrlStr);
  if (!base) return;

  rewritePhotonSrc(document, base.hostname);
  preferSameDomainSrc(document, base);

  const elements = document.querySelectorAll('a[href],img[src],source[srcset]');
  for (const el of elements) {
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') processUrlElement(el, 'href', base, false);
    else if (tag === 'img') processUrlElement(el, 'src', base, false);
    else if (tag === 'source') processUrlElement(el, 'srcset', base, true);
  }
}
function getValidContentHtml(element: Element | null): string | null {
  if (!element) return null;
  const html = element.innerHTML.trim();
  return html.length > MIN_BODY_CONTENT_LENGTH ? html : null;
}

export function resolveDocumentBody(document: Document): Element {
  const { body } = document;
  if (getValidContentHtml(body)) return body;

  const { children } = document.documentElement;
  for (const child of children) {
    if (child.tagName === 'BODY' && getValidContentHtml(child)) {
      return child;
    }
  }

  return body;
}

export function serializeDocumentForMarkdown(
  document: Document,
  fallback: string
): string {
  const body = resolveDocumentBody(document);
  const bodyHtml = getValidContentHtml(body);
  if (bodyHtml) return bodyHtml;

  const outerHtml = document.documentElement.outerHTML.trim();
  if (outerHtml.length > MIN_BODY_CONTENT_LENGTH) return outerHtml;

  return fallback;
}
function isFullDocumentHtml(html: string): boolean {
  return HTML_DOCUMENT_MARKERS.test(html);
}
function mayContainNoise(html: string): boolean {
  const sample =
    html.length <= NOISE_SCAN_LIMIT
      ? html
      : `${html.substring(0, NOISE_SCAN_LIMIT)}\n${html.substring(html.length - NOISE_SCAN_LIMIT)}`;
  return NOISE_PATTERNS.some((re) => re.test(sample));
}
function surfaceHiddenTabPanels(document: Document): void {
  const panels = document.querySelectorAll(
    '[data-slot="tabContent"], [role="tabpanel"]'
  );
  for (const panel of panels) {
    const style = panel.getAttribute('style') ?? '';
    if (DISPLAY_NONE_REGEX.test(style)) {
      panel.setAttribute(
        'style',
        style.replace(DISPLAY_NONE_STRIP_REGEX, '').trim()
      );
    }
    panel.removeAttribute('hidden');
  }
}

function stripTabTriggers(document: Document): void {
  const tabs = document.querySelectorAll('[role="tab"]');
  for (let i = tabs.length - 1; i >= 0; i--) {
    const tab = tabs[i];
    if (!tab) continue;
    const isSelected =
      tab.getAttribute('aria-selected') === 'true' ||
      tab.getAttribute('data-state') === 'active' ||
      tab.hasAttribute('data-selected');
    if (!isSelected) {
      tab.remove();
    }
  }
}

/** Surface hidden tab panels, then strip unselected tab triggers. */
export function normalizeTabContent(document: Document): void {
  surfaceHiddenTabPanels(document);
  stripTabTriggers(document);
}

function convertBlockToSpan(block: Element, document: Document): void {
  if (!block.parentNode) return;
  const span = document.createElement('span');
  span.appendChild(document.createTextNode(' '));
  while (block.firstChild) {
    span.appendChild(block.firstChild);
  }
  span.appendChild(document.createTextNode(' '));
  for (const attr of Array.from(block.attributes)) {
    span.setAttribute(attr.name, attr.value);
  }
  block.replaceWith(span);
}

function normalizeTableCellTextNodes(cell: Element, document: Document): void {
  const walker = document.createTreeWalker(cell, NODE_FILTER_SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    if (node.nodeValue) {
      node.nodeValue = node.nodeValue.replace(/\r?\n/g, ' ');
      if (node.nodeValue.includes('|')) {
        node.nodeValue = node.nodeValue.replace(/\|/g, '\\|');
      }
    }
  }
}

function normalizeTableCells(document: Document): void {
  const cells = document.querySelectorAll('td, th');
  for (const cell of cells) {
    const brs = cell.querySelectorAll('br');
    for (const br of brs) {
      br.replaceWith(' ');
    }

    const blocks = Array.from(
      cell.querySelectorAll('div, p, ul, li, h1, h2, h3, h4, h5, h6')
    );
    for (const block of blocks) {
      convertBlockToSpan(block, document);
    }

    normalizeTableCellTextNodes(cell, document);
  }
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function hasDirectPreDescendant(element: Element): boolean {
  return (
    element.tagName === 'PRE' ||
    Array.from(element.children).some(
      (child) => child.tagName === 'PRE' || child.querySelector('pre') !== null
    )
  );
}

function collectLeafTextSegments(element: Element): string[] {
  const seen = new Set<string>();
  const segments: string[] = [];
  const candidates = element.querySelectorAll('p,li,div,span');

  for (const candidate of candidates) {
    if (
      candidate.children.length > 0 ||
      candidate.querySelector('pre,code,table,ul,ol,blockquote,figure') !== null
    ) {
      continue;
    }

    const text = normalizeWhitespace(candidate.textContent || '');
    if (
      text.length === 0 ||
      text.length > REDUNDANT_PREVIEW_SEGMENT_MAX_CHARS ||
      seen.has(text)
    ) {
      continue;
    }

    seen.add(text);
    segments.push(text);
  }

  if (segments.length > 0) return segments;

  const fallback = normalizeWhitespace(element.textContent || '');
  return fallback ? [fallback] : [];
}

function isHostnameLike(value: string): boolean {
  return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(value);
}

function hasPreviewMedia(element: Element): boolean {
  return element.querySelector('svg,canvas') !== null;
}

function hasInteractiveOrComplexContent(preview: Element): boolean {
  if (preview.tagName === 'FIGCAPTION') return true;
  return (
    preview.querySelector(
      'a[href],button,input,select,textarea,form,video,audio,iframe,table,ul,ol,blockquote'
    ) !== null
  );
}

function hasValidTextSegments(segments: string[]): boolean {
  return (
    segments.length > 0 &&
    segments.length <= REDUNDANT_PREVIEW_MAX_SEGMENTS &&
    segments.every(
      (segment) => segment.length <= REDUNDANT_PREVIEW_SEGMENT_MAX_CHARS
    )
  );
}

function isRedundantCodePreview(
  preview: Element,
  codeContainer: Element
): boolean {
  if (hasInteractiveOrComplexContent(preview)) return false;

  const segments = collectLeafTextSegments(preview);
  if (!hasValidTextSegments(segments)) return false;

  const codeText = normalizeWhitespace(codeContainer.textContent || '');
  if (!codeText) return false;

  const matchingSegments = segments.filter((segment) =>
    codeText.includes(segment)
  );
  if (matchingSegments.length === segments.length) return true;

  return (
    (hasPreviewMedia(preview) || segments.some(isHostnameLike)) &&
    matchingSegments.length > 0
  );
}

function pruneFigurePreviewPanes(document: Document): void {
  for (const figure of document.querySelectorAll('figure')) {
    const directChildren = Array.from(figure.children);
    const codeChild = directChildren.find((child) =>
      hasDirectPreDescendant(child)
    );
    if (!codeChild) continue;

    for (const child of directChildren) {
      if (child === codeChild || child.tagName === 'FIGCAPTION') continue;
      if (isRedundantCodePreview(child, codeChild)) child.remove();
    }
  }
}

function isDemoInstructionBlock(element: Element): boolean {
  if (
    element.querySelector(
      'a[href],pre,code,table,ul,ol,blockquote,figure,h1,h2,h3,h4,h5,h6'
    ) !== null
  ) {
    return false;
  }

  const text = normalizeWhitespace(element.textContent || '');
  if (
    text.length === 0 ||
    text.length > INLINE_DEMO_INSTRUCTION_MAX_CHARS ||
    /[.!?]$/.test(text)
  ) {
    return false;
  }

  return collectLeafTextSegments(element).length <= 3;
}

function pruneDemoInstructionBlocks(document: Document): void {
  for (const container of document.querySelectorAll('div,section,article')) {
    const children = Array.from(container.children);
    const figureIndex = children.findIndex(
      (child) =>
        child.tagName === 'FIGURE' && child.querySelector('pre') !== null
    );
    if (figureIndex <= 0) continue;

    for (let i = 0; i < figureIndex; i++) {
      const child = children[i];
      if (child && isDemoInstructionBlock(child)) child.remove();
    }
  }
}

function normalizeHighlightedCodeLines(document: Document): void {
  for (const code of document.querySelectorAll('pre > code')) {
    const directChildren = Array.from(code.children);
    if (directChildren.length < 2) continue;

    const directSpans = directChildren.filter(
      (child) => child.tagName === 'SPAN'
    );
    if (directSpans.length !== directChildren.length) continue;

    const hasLineClass = directSpans.some((child) =>
      (child.getAttribute('class') ?? '').split(/\s+/).includes('line')
    );
    const hasNewlineNode = Array.from(code.childNodes).some(
      (node) => node.nodeType === 3 && /[\r\n]/.test(node.textContent ?? '')
    );

    if (hasNewlineNode || !hasLineClass) continue;

    for (let i = 0; i < directSpans.length - 1; i++) {
      const current = directSpans[i];
      const next = current?.nextSibling;
      if (next?.nodeType === 3 && (next.textContent ?? '').startsWith('\n')) {
        continue;
      }
      current?.after(document.createTextNode('\n'));
    }
  }
}

const COPY_BUTTON_SELECTOR =
  'button,a[href="#copy"],a[href="#"],span[class*="copy"]';
const COPY_BUTTON_TEXT_PATTERN = /^copy(?: code)?$/i;

function stripCodeBlockCopyButtons(document: Document): void {
  for (const pre of document.querySelectorAll('pre')) {
    const candidates = pre.querySelectorAll(COPY_BUTTON_SELECTOR);
    for (let i = candidates.length - 1; i >= 0; i--) {
      const el = candidates[i];
      if (!el) continue;
      const text = (el.textContent || '').trim();
      if (
        el.tagName === 'BUTTON' ||
        COPY_BUTTON_TEXT_PATTERN.test(text) ||
        (el.getAttribute('href') ?? '').includes('#copy')
      ) {
        el.remove();
      }
    }
  }
}

function cleanCodeExamples(document: Document): void {
  stripCodeBlockCopyButtons(document);
  pruneFigurePreviewPanes(document);
  pruneDemoInstructionBlocks(document);
  normalizeHighlightedCodeLines(document);
}

function stripPromoLinks(document: Document): void {
  const links = document.querySelectorAll('a[href]');
  for (let i = links.length - 1; i >= 0; i--) {
    const link = links[i];
    if (!link) continue;
    const href = link.getAttribute('href');
    if (href && UTM_PARAM_REGEX.test(href)) {
      link.remove();
    }
  }
}

function separateAdjacentInlineElements(document: Document): void {
  const badges = document.querySelectorAll(
    'span.chakra-badge, [data-scope="badge"], [class*="badge"], [data-slot="label"], [slot="label"]'
  );
  for (const badge of badges) {
    const next = badge.nextSibling;
    if (next?.nodeType === 1) {
      badge.after(document.createTextNode(' '));
    }
  }
}

const CODE_EDITOR_LANG_REGEX = /\blanguage-(\S+)/;

// Some documentation sites render code examples as highlighted, aria-hidden blocks with a textarea containing the raw code for accessibility.
// Surface the textarea content and remove the redundant highlighted block to produce cleaner markdown output.
export function surfaceCodeEditorContent(document: Document): void {
  for (const pre of document.querySelectorAll('pre[aria-hidden="true"]')) {
    const codeChild = pre.querySelector('code');
    if (!codeChild) continue;

    const container = pre.parentElement;
    if (!container) continue;

    const textarea = container.querySelector('textarea');
    if (!textarea) continue;

    // Extract language from the highlighted code element
    const langMatch = CODE_EDITOR_LANG_REGEX.exec(
      codeChild.getAttribute('class') ?? ''
    );
    const lang = langMatch?.[1] ?? '';

    // Build a clean pre>code block from the textarea plain text
    const newPre = document.createElement('pre');
    const newCode = document.createElement('code');
    if (lang) newCode.setAttribute('class', `language-${lang}`);
    newCode.textContent = textarea.textContent || '';
    newPre.appendChild(newCode);
    container.insertBefore(newPre, pre);
    pre.remove();
    textarea.remove();
  }
}

export function stripDocsControls(document: Document): void {
  removeNodes(document.querySelectorAll(DOCS_CONTROL_SELECTORS.join(',')));
}

export function stripScreenReaderText(document: Document): void {
  const selectors = [
    '.sr-only',
    '.screen-reader-text',
    '.visually-hidden',
    '[class*="sr-only"]',
    '[class*="visually-hidden"]',
    '.cdk-visually-hidden',
    '.vh',
    '.hidden-visually',
  ];
  removeNodes(document.querySelectorAll(selectors.join(',')));
}

function stripAriaLiveInstructions(document: Document): void {
  for (const el of document.querySelectorAll('[aria-live]')) {
    const text = (el.textContent || '').trim();
    if (text.length > 0 && text.length <= INLINE_DEMO_INSTRUCTION_MAX_CHARS) {
      el.remove();
    }
  }
}

export function runDocsControlPass(document: Document): void {
  normalizeTabContent(document);
  surfaceCodeEditorContent(document);
  cleanHeadings(document);
  stripDocsControls(document);
  stripAriaLiveInstructions(document);
  stripPromoLinks(document);
  separateAdjacentInlineElements(document);
}

const PHRASING_PARENTS = new Set([
  'P',
  'LI',
  'TD',
  'TH',
  'DD',
  'SPAN',
  'LABEL',
  'FIGCAPTION',
  'BLOCKQUOTE',
]);

function unwrapInlineButtons(document: Document): void {
  for (const btn of document.querySelectorAll('button')) {
    const parent = btn.parentElement;
    if (!parent || !PHRASING_PARENTS.has(parent.tagName)) continue;
    btn.replaceWith(...Array.from(btn.childNodes));
  }
}

function runStructuralNoisePass(
  document: Document,
  signal?: AbortSignal
): void {
  unwrapInlineButtons(document);
  stripNoise(document, signal);
}

function runCodeExamplePass(document: Document): void {
  cleanCodeExamples(document);
}

function unwrapOrphanedTableCells(document: Document): void {
  for (const cell of document.querySelectorAll('td, th')) {
    if (!cell.closest('table')) {
      cell.replaceWith(...Array.from(cell.childNodes));
    }
  }
}

function runTableNormalizationPass(document: Document): void {
  unwrapOrphanedTableCells(document);
  normalizeTableCells(document);
  normalizeTableStructure(document);
}

function runUrlResolutionPass(document: Document, baseUrl?: string): void {
  if (baseUrl) resolveUrls(document, baseUrl);
}

// Called on both raw documents (pre-article path) and article fragments
// (post-Readability). Some passes (stripTabTriggers, etc.) are no-ops
// on Readability output since tabs are already stripped or absent.
export function prepareDocumentForMarkdown(
  document: Document,
  baseUrl?: string,
  signal?: AbortSignal
): void {
  extractNoscriptImages(document);
  runDocsControlPass(document);
  runStructuralNoisePass(document, signal);
  runCodeExamplePass(document);
  runTableNormalizationPass(document);
  runUrlResolutionPass(document, baseUrl);
}

// Some sites put tbody/thead/tfoot inside td/th, which breaks markdown tables.
function normalizeTableStructure(document: Document): void {
  for (const table of document.querySelectorAll('table')) {
    const theadCells = table.querySelectorAll('thead td');
    for (const td of theadCells) {
      const th = document.createElement('th');
      th.innerHTML = td.innerHTML;
      for (const attr of Array.from(td.attributes)) {
        th.setAttribute(attr.name, attr.value);
      }
      td.replaceWith(th);
    }
    for (const cell of table.querySelectorAll('th, td')) {
      for (const tag of ['tbody', 'thead', 'tfoot'] as const) {
        let nested = cell.querySelector(tag);
        while (nested) {
          table.appendChild(nested);
          nested = cell.querySelector(tag);
        }
      }
    }

    hoistNestedRows(table);
  }
}

export function removeNoiseFromHtml(
  html: string,
  document?: Document,
  baseUrl?: string,
  signal?: AbortSignal
): string {
  const shouldParse =
    isFullDocumentHtml(html) ||
    mayContainNoise(html) ||
    HTML_FRAGMENT_MARKERS.test(html);
  if (!shouldParse) return html;

  try {
    const doc = document ?? parseHTML(html).document;
    prepareDocumentForMarkdown(doc, baseUrl, signal);
    return serializeDocumentForMarkdown(doc, html);
  } catch {
    return html;
  }
}

// ── Content evaluation heuristics ───────────────────────────────────

const MIN_CONTENT_RATIO = 0.15;
const MIN_HTML_LENGTH_FOR_GATE = 100;

interface RetentionRule {
  selector: string;
  pattern: RegExp;
  minThreshold: number;
  ratio: number;
}

const RETENTION_RULES: readonly RetentionRule[] = [
  {
    selector: 'h1,h2,h3,h4,h5,h6',
    pattern: /<h[1-6]\b/gi,
    minThreshold: 1,
    ratio: 0.3,
  },
  { selector: 'pre', pattern: /<pre\b/gi, minThreshold: 1, ratio: 0.15 },
  { selector: 'table', pattern: /<table\b/gi, minThreshold: 1, ratio: 0.5 },
  { selector: 'img', pattern: /<img\b/gi, minThreshold: 4, ratio: 0.2 },
];

const MIN_HEADINGS_FOR_EMPTY_SECTION_GATE = 5;
const MAX_EMPTY_SECTION_RATIO = 0.15;

const MIN_LINE_LENGTH_FOR_TRUNCATION_CHECK = 20;
const MAX_TRUNCATED_LINE_RATIO = 0.95;

function resolveHtmlDocument(htmlOrDocument: string | Document): Document {
  if (typeof htmlOrDocument !== 'string') return htmlOrDocument;

  const needsWrapper = !/^\s*<(?:!doctype|html|body)\b/i.test(htmlOrDocument);
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

  for (const child of node.childNodes) {
    getTextContentSkippingHidden(child, parts);
  }
}

export function getVisibleTextLength(
  htmlOrDocument: string | Document
): number {
  if (typeof htmlOrDocument === 'string') {
    const doc = resolveHtmlDocument(htmlOrDocument);
    const body = resolveDocumentBody(doc);
    for (const el of body.querySelectorAll('script,style,noscript')) {
      el.remove();
    }
    return (body.textContent || '').replace(/\s+/g, ' ').trim().length;
  }
  const body = resolveDocumentBody(htmlOrDocument);
  const parts: string[] = [];
  getTextContentSkippingHidden(body, parts);
  return parts.join('').replace(/\s+/g, ' ').trim().length;
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
    // Skip headings that are explicitly hidden or for screen readers
    const cls = heading.getAttribute('class') ?? '';
    if (
      cls.includes('screen-reader-text') ||
      cls.includes('sr-only') ||
      cls.includes('visually-hidden')
    ) {
      continue;
    }
    if (!hasSectionContent(heading)) emptyCount += 1;
  }

  return emptyCount;
}

// Heuristic to detect if the content was truncated due to length limits by checking for incomplete sentences.
const SENTENCE_ENDING_CODES = new Set<number>([
  CharCode.PERIOD,
  CharCode.EXCLAMATION,
  CharCode.QUESTION,
  CharCode.COLON,
  CharCode.SEMICOLON,
  CharCode.DOUBLE_QUOTE,
  CharCode.SINGLE_QUOTE,
  CharCode.RIGHT_PAREN,
  CharCode.RIGHT_BRACKET,
  CharCode.BACKTICK,
]);

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
    const isNewline = !isEnd && text.charCodeAt(i) === CharCode.LF;

    if (isNewline || isEnd) {
      const { counted, incomplete } = classifyLine(text, lineStart, i);
      if (counted) {
        linesFound++;
        if (incomplete) incompleteFound++;
      }
      lineStart = i + 1;
    }
  }

  if (linesFound < MIN_LINES_FOR_TRUNCATION_CHECK) return false;
  return incompleteFound / linesFound > MAX_TRUNCATED_LINE_RATIO;
}

function passesContentRatioGate(
  articleTextLength: number,
  document: Document
): boolean {
  const originalLength = getVisibleTextLength(document);
  return (
    originalLength < MIN_HTML_LENGTH_FOR_GATE ||
    articleTextLength / originalLength >= MIN_CONTENT_RATIO
  );
}

const DATA_IMG_PATTERN = /<img\b[^>]*\bsrc\s*=\s*["']?data:/gi;

function countRealImages(htmlOrDoc: string | Document): number {
  if (typeof htmlOrDoc === 'string') {
    const total = htmlOrDoc.match(/<img\b/gi)?.length ?? 0;
    const dataImages = htmlOrDoc.match(DATA_IMG_PATTERN)?.length ?? 0;
    return total - dataImages;
  }
  let count = 0;
  for (const img of htmlOrDoc.querySelectorAll('img')) {
    const src = img.getAttribute('src') ?? '';
    if (!src.startsWith('data:')) count++;
  }
  return count;
}

function passesRetentionRulesFromHtml(
  originalDoc: Document,
  articleHtml: string
): boolean {
  return RETENTION_RULES.every(({ selector, pattern, minThreshold, ratio }) => {
    // Exclude lazy-loaded placeholder images (data: URI src) from the
    // original count so they don't inflate the denominator and cause
    // false retention failures.
    const original =
      selector === 'img'
        ? countRealImages(originalDoc)
        : countMatchingElements(originalDoc, selector);
    if (original < minThreshold) return true;
    // For images, also exclude data: URIs from the article count to
    // align with the denominator's real-image filtering.
    const articleCount =
      selector === 'img'
        ? countRealImages(articleHtml)
        : [...articleHtml.matchAll(pattern)].length;
    return articleCount / original >= ratio;
  });
}

function passesEmptySectionRatio(articleDoc: Document): boolean {
  const headings = Array.from(
    articleDoc.querySelectorAll('h1,h2,h3,h4,h5,h6')
  ).filter((h) => {
    const cls = h.getAttribute('class') ?? '';
    return (
      !cls.includes('screen-reader-text') &&
      !cls.includes('sr-only') &&
      !cls.includes('visually-hidden')
    );
  });
  const headingCount = headings.length;
  return (
    headingCount < MIN_HEADINGS_FOR_EMPTY_SECTION_GATE ||
    countEmptyHeadingSections(articleDoc) / headingCount <=
      MAX_EMPTY_SECTION_RATIO
  );
}

export function evaluateArticleContent(
  article: ExtractedArticle,
  document: Document
): Document | null {
  if (!passesContentRatioGate(article.textContent.length, document)) {
    logDebug('FAILED passesContentRatioGate', undefined, Loggers.LOG_TRANSFORM);
    return null;
  }

  if (!passesRetentionRulesFromHtml(document, article.content)) {
    logDebug(
      'FAILED passesRetentionRulesFromHtml',
      undefined,
      Loggers.LOG_TRANSFORM
    );
    return null;
  }

  if (hasTruncatedSentences(article.textContent)) {
    logDebug('FAILED hasTruncatedSentences', undefined, Loggers.LOG_TRANSFORM);
    return null;
  }

  const articleDoc = parseHTML(
    `<!DOCTYPE html><html><body>${article.content}</body></html>`
  ).document;

  if (!passesEmptySectionRatio(articleDoc)) {
    const headings = articleDoc.querySelectorAll('h1,h2,h3,h4,h5,h6');
    logDebug(
      `FAILED passesEmptySectionRatio: ${headings.length} headings`,
      undefined,
      Loggers.LOG_TRANSFORM
    );
    for (const h of headings) {
      logDebug(
        `H: ${h.textContent} ${String(hasSectionContent(h))}`,
        undefined,
        Loggers.LOG_TRANSFORM
      );
    }
    return null;
  }

  return articleDoc;
}

// ---------------------------------------------------------------------------
// Shared constant
// ---------------------------------------------------------------------------

const CODE_BLOCK = {
  fence: '```',
  format: (code: string, language = ''): string =>
    `\`\`\`${language}\n${code}\n\`\`\``,
};

const MERMAID_POSTPROCESS = ({ content }: { content: string }): string =>
  `\n\n\`\`\`mermaid\n${content.trim()}\n\`\`\`\n\n`;

const MERMAID_TRANSLATOR_CONFIG: TranslatorConfig = {
  noEscape: true,
  preserveWhitespace: true,
  postprocess: MERMAID_POSTPROCESS,
};

// ---------------------------------------------------------------------------
// DOM helpers (translator-only)
// ---------------------------------------------------------------------------

function getTagName(node: unknown): string {
  if (!isHtmlNode(node)) return '';
  const raw = node.tagName;
  return typeof raw === 'string' ? raw.toUpperCase() : '';
}

function getNode(ctx: unknown): unknown {
  return isObject(ctx) ? ctx['node'] : undefined;
}

function getParent(ctx: unknown): unknown {
  return isObject(ctx) ? ctx['parent'] : undefined;
}

function getNodeAttr(
  node: unknown
): ((name: string) => string | null) | undefined {
  if (!isHtmlNode(node) || typeof node.getAttribute !== 'function')
    return undefined;
  return node.getAttribute.bind(node);
}

// ---------------------------------------------------------------------------
// Code translators
// ---------------------------------------------------------------------------

class DetectionContext {
  private _lower?: string;
  private _lines?: readonly string[];
  private _trimmedStart?: string;

  constructor(readonly code: string) {}

  get lower(): string {
    this._lower ??= this.code.toLowerCase();
    return this._lower;
  }

  get lines(): readonly string[] {
    this._lines ??= this.code.split(/\r?\n/);
    return this._lines;
  }

  get trimmedStart(): string {
    this._trimmedStart ??= this.code.trimStart();
    return this._trimmedStart;
  }
}
const BASH_COMMANDS = new Set([
  'sudo',
  'chmod',
  'mkdir',
  'cd',
  'ls',
  'cat',
  'echo',
]);
const BASH_PACKAGE_MANAGERS = [
  'npm',
  'yarn',
  'pnpm',
  'npx',
  'brew',
  'apt',
  'pip',
  'cargo',
  'go',
] as const;
const TYPESCRIPT_HINTS = [
  ': string',
  ':string',
  ': number',
  ':number',
  ': boolean',
  ':boolean',
  ': void',
  ':void',
  ': any',
  ':any',
  ': unknown',
  ':unknown',
  ': never',
  ':never',
];
const HTML_TAGS = [
  '<!doctype',
  '<html',
  '<head',
  '<body',
  '<div',
  '<span',
  '<p',
  '<a',
  '<script',
  '<style',
];
function isBashLine(line: string): boolean {
  const trimmed = line.trimStart();
  if (!trimmed) return false;

  if (
    trimmed.startsWith('#!') ||
    trimmed.startsWith('$ ') ||
    /^\.\.\.\\?> \s+\S/.test(trimmed)
  ) {
    return true;
  }

  const spaceIdx = trimmed.indexOf(' ');
  const firstWord = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);

  if (BASH_COMMANDS.has(firstWord)) return true;

  return (
    spaceIdx !== -1 &&
    BASH_PACKAGE_MANAGERS.includes(
      firstWord as (typeof BASH_PACKAGE_MANAGERS)[number]
    )
  );
}
function detectBashIndicators(lines: readonly string[]): boolean {
  return lines.some(isBashLine);
}
function detectCssStructure(lines: readonly string[]): boolean {
  for (const line of lines) {
    const trimmed = line.trimStart();
    if (!trimmed || trimmed.startsWith('# ') || trimmed.startsWith('//')) {
      continue;
    }

    if (/^[.#][A-Za-z_-][\w-]*\s*\{/.test(trimmed)) return true;

    if (
      trimmed.includes(';') &&
      /^\s*[a-z][\w-]*\s*:/.test(trimmed) &&
      !trimmed.includes('(')
    ) {
      return true;
    }
  }
  return false;
}
function detectYamlStructure(lines: readonly string[]): boolean {
  for (const line of lines) {
    const trimmed = line.trim();
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx > 0) {
      const after = trimmed[colonIdx + 1];
      if (after === ' ' || after === '\t') return true;
    }
  }
  return false;
}
type Matcher = (ctx: DetectionContext) => boolean;
interface LanguageDef {
  lang: string;
  weight: number;
  match: Matcher;
}

function matchPythonKeywords(l: string): boolean {
  return (
    l.includes('print(') ||
    l.includes('__name__') ||
    l.includes('self.') ||
    l.includes('elif ') ||
    /\b(?:def |elif |except |finally:|yield |lambda |raise |pass$)/m.test(l)
  );
}

function matchPythonRegex(c: string): boolean {
  return (
    // eslint-disable-next-line sonarjs/slow-regex -- Python REPL prefix, bounded input
    /^\s*(?:>>>|\.\.\.)\s/m.test(c) ||
    /<(?:QuerySet|[A-Z]\w*:\s)|\bdatetime\.datetime\(|\bDoesNotExist:/.test(
      c
    ) ||
    // eslint-disable-next-line sonarjs/slow-regex -- Python assignment pattern, bounded input
    /^\s*[A-Za-z_][\w.]*\s*=\s*[A-Z][\w.]*\(/m.test(c) ||
    // eslint-disable-next-line sonarjs/slow-regex -- Python dotted expression, bounded input
    /^\s*[A-Za-z_][\w.]*\.[A-Za-z_]\w*\s*$/m.test(c)
  );
}

function matchPython(ctx: DetectionContext): boolean {
  if (HTML_TAGS.some((tag) => ctx.lower.includes(tag))) return false;

  const l = ctx.lower;
  const c = ctx.code;

  if (matchPythonRegex(c)) return true;
  if (c.includes('None') || c.includes('True') || c.includes('False'))
    return true;
  if (matchPythonKeywords(l)) return true;

  const hasJsSignals =
    /\b(?:const |let |var |function |require\(|=>|===|!==|console\.)/.test(l) ||
    l.includes('{') ||
    l.includes("from '");
  return /\b(?:import|from|class)\b/.test(l) && !hasJsSignals;
}

const LANGUAGES: LanguageDef[] = [
  {
    lang: 'rust',
    weight: 25,
    match: (ctx) =>
      ctx.lower.includes('let mut') ||
      /\b(?:fn|impl|struct|enum)\b/.test(ctx.lower) ||
      (ctx.lower.includes('use ') && ctx.lower.includes('::')),
  },
  {
    lang: 'go',
    weight: 22,
    match: (ctx) =>
      ctx.lower.includes('import "') || /\b(?:package|func)\b/.test(ctx.lower),
  },
  {
    lang: 'jsx',
    weight: 22,
    match: (ctx) => {
      const l = ctx.lower;
      if (
        l.includes('classname=') ||
        l.includes('jsx:') ||
        l.includes("from 'react'") ||
        l.includes('from "react"')
      ) {
        return true;
      }
      // eslint-disable-next-line sonarjs/regex-complexity -- JSX tag detection needs full attribute matching
      return /<\/?[A-Z][A-Za-z0-9]*(?:\s+[A-Za-z_:][\w:.-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|\{[^}]*\}))?)*\s*\/?>/m.test(
        ctx.code
      );
    },
  },
  {
    lang: 'typescript',
    weight: 20,
    match: (ctx) =>
      /\b(?:interface|type)\b/.test(ctx.lower) ||
      TYPESCRIPT_HINTS.some((hint) => ctx.lower.includes(hint)),
  },
  {
    lang: 'sql',
    weight: 20,
    match: (ctx) =>
      // eslint-disable-next-line sonarjs/slow-regex, sonarjs/regex-complexity -- SQL keyword detection on bounded code snippets
      /\b(?:select\s+(?:.+?\s+from|[\d*@])|insert\s+into|update\s+.+?\s+set|delete\s+from|create\s+(?:table|database|index|view|function|procedure|trigger|user|role)|alter\s+(?:table|database|index|view))\b/.test(
        ctx.lower
      ),
  },
  {
    lang: 'html',
    weight: 19,
    match: (ctx) => HTML_TAGS.some((tag) => ctx.lower.includes(tag)),
  },
  {
    lang: 'python',
    weight: 18,
    match: matchPython,
  },
  {
    lang: 'css',
    weight: 18,
    match: (ctx) =>
      /@media|@import|@keyframes|@theme\b|@utility\b|@layer\b|@apply\b|@variant\b|@custom-variant\b|@reference\b|@source\b/.test(
        ctx.lower
      ) || detectCssStructure(ctx.lines),
  },
  { lang: 'bash', weight: 15, match: (ctx) => detectBashIndicators(ctx.lines) },
  { lang: 'yaml', weight: 15, match: (ctx) => detectYamlStructure(ctx.lines) },
  {
    lang: 'javascript',
    weight: 15,
    match: (ctx) =>
      /\b(?:const|let|var|function|class|async|await|export|import)\b/.test(
        ctx.lower
      ),
  },
  {
    lang: 'json',
    weight: 10,
    match: (ctx) =>
      ctx.trimmedStart.startsWith('{') || ctx.trimmedStart.startsWith('['),
  },
];

const KNOWN_LANG_PREFIXES = new Set([
  'css',
  'javascript',
  'js',
  'typescript',
  'ts',
  'python',
  'py',
  'html',
  'xml',
  'sql',
  'bash',
  'sh',
  'yaml',
  'json',
  'ruby',
  'go',
  'rust',
  'java',
  'php',
  'c',
  'cpp',
  'swift',
  'kotlin',
  'scss',
  'sass',
  'less',
  'graphql',
  'markdown',
  'md',
]);

function extractLangFromPrefixes(tokens: string[]): string | undefined {
  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (lower.startsWith('language-')) return token.slice(9);
    if (lower.startsWith('lang-')) return token.slice(5);
    if (lower.startsWith('highlight-')) return token.slice(10);
  }
  return undefined;
}

function extractLangFromHljs(tokens: string[]): string | undefined {
  if (!tokens.includes('hljs')) return undefined;
  return tokens.find((t) => {
    const l = t.toLowerCase();
    return l !== 'hljs' && !l.startsWith('hljs-');
  });
}

export function extractLanguageFromClassName(
  className: string
): string | undefined {
  if (!className) return undefined;

  const tokens = className.match(/\S+/g);
  if (!tokens) return undefined;

  const prefixed = extractLangFromPrefixes(tokens);
  if (prefixed) return prefixed;

  const hljs = extractLangFromHljs(tokens);
  if (hljs) return hljs;

  for (const token of tokens) {
    const dashIdx = token.indexOf('-');
    if (dashIdx > 0) {
      const prefix = token.slice(0, dashIdx).toLowerCase();
      if (KNOWN_LANG_PREFIXES.has(prefix)) return prefix;
    }
  }

  return undefined;
}
function resolveLanguageFromDataAttribute(
  dataLang: string
): string | undefined {
  const trimmed = dataLang.trim();
  return /^\w+$/.test(trimmed) ? trimmed : undefined;
}
export function resolveLanguageFromAttributes(
  className: string,
  dataLang: string
): string | undefined {
  return (
    extractLanguageFromClassName(className) ??
    resolveLanguageFromDataAttribute(dataLang)
  );
}
export function detectLanguageFromCode(code: string): string | undefined {
  if (!code || !/\S/.test(code)) return undefined;

  const ctx = new DetectionContext(code);
  return LANGUAGES.find((def) => def.match(ctx))?.lang;
}

function buildInlineCode(content: string): string {
  const trimmed = content.trim();
  if (!trimmed) return '``';

  const matches = trimmed.match(/`+/g);
  const maxBackticks = matches ? Math.max(...matches.map((m) => m.length)) : 0;

  const delimiter = '`'.repeat(maxBackticks + 1);
  const padding = trimmed.startsWith('`') || trimmed.endsWith('`') ? ' ' : '';
  return `${delimiter}${padding}${trimmed}${padding}${delimiter}`;
}

function isCodeBlock(
  parent: unknown
): parent is { tagName?: string; childNodes?: unknown[] } {
  const tagName = getTagName(parent);
  return tagName === 'PRE' || tagName === 'WRAPPED-PRE';
}

function resolveAttributeLanguage(node: unknown): string | undefined {
  const getAttribute = getNodeAttr(node);
  const className = getAttribute?.('class') ?? '';
  const dataLanguage = getAttribute?.('data-language') ?? '';
  return resolveLanguageFromAttributes(className, dataLanguage);
}

function findLanguageFromCodeChild(node: unknown): string | undefined {
  if (!isHtmlNode(node)) return undefined;

  const childNodes = Array.from(node.childNodes ?? []);

  for (const child of childNodes) {
    if (!isHtmlNode(child)) continue;

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
  if (!isCodeBlock(getParent(ctx))) return inlineCodeTranslator;

  return { noEscape: true, preserveWhitespace: true };
}

// ---------------------------------------------------------------------------
// Image translators
// ---------------------------------------------------------------------------

function extractFirstSrcsetUrl(srcset: string): string {
  return srcset.split(',')[0]?.trim().split(/\s+/)[0] ?? '';
}

const LAZY_SRC_ATTRIBUTES = [
  'data-src',
  'data-lazy-src',
  'data-lazy',
  'data-original',
  'data-echo',
  'data-srcset',
] as const;

function isDataUri(value: string): boolean {
  return value.startsWith('data:');
}

const PLACEHOLDER_FILENAME_PATTERN =
  /(?:^|\/)(?:blank|spacer|placeholder|grey|gray|pixel|loading|lazy|transparent|empty|dummy)\.[a-z]{3,4}$/i;

function isPlaceholderSrc(value: string): boolean {
  if (isDataUri(value)) return true;
  const parsed = URL.parse(value) ?? URL.parse(value, 'http://localhost');
  if (!parsed) return false;
  return PLACEHOLDER_FILENAME_PATTERN.test(parsed.pathname);
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

// Some sites (notably WordPress with Photon CDN) use a CDN proxy URL in img src while keeping the original same-domain URL in srcset.
// Since the converter prefers srcset URLs for CDN-hosted images, we need to detect this pattern and extract the canonical URL from srcset to ensure images are correctly resolved, especially when migrating content to a new domain.
function isWpPhotonUrl(src: string): boolean {
  const parsed = URL.parse(src);
  return parsed !== null && WP_PHOTON_HOST_PATTERN.test(parsed.hostname);
}

function resolveImageSrc(
  getAttribute: ((name: string) => string | null) | undefined
): string {
  if (!getAttribute) return '';

  const srcRaw = getAttribute('src') ?? '';
  const srcsetUrl = extractNonDataSrcsetUrl(getAttribute('srcset') ?? '');

  // When src is a CDN proxy URL, prefer srcset which usually has the
  // canonical same-domain URL that survives domain migrations.
  if (srcRaw && isWpPhotonUrl(srcRaw) && srcsetUrl) return srcsetUrl;

  if (srcRaw && !isPlaceholderSrc(srcRaw)) return srcRaw;

  // First check common lazy-loading attributes that may contain non-data URLs before falling back to the native srcset, as some sites use data URIs in lazy attributes while still providing valid URLs in srcset.
  const lazySrc = resolveLazySrc(getAttribute);
  if (lazySrc) return lazySrc;

  // If the src is a data URI or missing, check srcset for a valid URL. Some sites use srcset with data URIs in src and actual URLs in srcset for responsive images.
  if (srcsetUrl) return srcsetUrl;

  return '';
}

function deriveAltFromImageUrl(src: string): string {
  if (!src) return '';

  const absoluteParsed = URL.parse(src);
  const parsed = absoluteParsed ?? URL.parse(src, 'http://localhost');

  if (!parsed) return '';
  if (
    absoluteParsed &&
    parsed.protocol !== 'http:' &&
    parsed.protocol !== 'https:'
  ) {
    return '';
  }

  const match = /\/([^/]+?)(?:\.[^/.]+)?$/.exec(parsed.pathname);
  if (!match?.[1]) return '';

  return match[1].replace(/[_-]+/g, ' ').trim();
}

function buildImageTranslator(ctx: unknown): TranslatorConfig {
  const getAttribute = getNodeAttr(getNode(ctx));

  const src = resolveImageSrc(getAttribute);
  const existingAlt = getAttribute?.('alt') ?? '';
  if (!src) {
    return { content: existingAlt.trim() };
  }

  const alt = existingAlt.trim() || deriveAltFromImageUrl(src);
  return { content: `![${alt}](${src})` };
}

// ---------------------------------------------------------------------------
// Pre / Mermaid translators
// ---------------------------------------------------------------------------

function buildPreTranslator(ctx: unknown): TranslatorConfig {
  const node = getNode(ctx);
  if (!node) return {};

  const attributeLanguage =
    resolveAttributeLanguage(node) ?? findLanguageFromCodeChild(node);

  return {
    noEscape: true,
    preserveWhitespace: true,
    postprocess: createCodeBlockPostprocessor(attributeLanguage),
  };
}

function buildMermaidPreTranslator(ctx: unknown): TranslatorConfig {
  const node = getNode(ctx);
  const getAttribute = getNodeAttr(node);

  const className = getAttribute?.('class') ?? '';
  if (className.includes('mermaid')) return MERMAID_TRANSLATOR_CONFIG;

  return buildPreTranslator(ctx);
}

// ---------------------------------------------------------------------------
// Block-level translators (div, section, span, table, dl, etc.)
// ---------------------------------------------------------------------------

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
  const tokens = className.toLowerCase().split(/\s+/);
  for (const token of tokens) {
    const mapped = GFM_ALERT_MAP.get(token);
    if (mapped) return mapped;
  }
  return undefined;
}

function buildAdmonitionConfig(
  className: string,
  alertType: string | undefined,
  getAttribute: (name: string) => string | null
): Record<string, unknown> | undefined {
  const isAdmonition =
    className.includes('admonition') ||
    className.includes('callout') ||
    className.includes('custom-block') ||
    getAttribute('role') === 'alert' ||
    alertType !== undefined;

  if (!isAdmonition) return undefined;

  return {
    postprocess: ({ content }: { content: string }) => {
      const lines = content.trim().split('\n');
      const header = alertType ? `> [!${alertType}]\n` : '';
      return `\n\n${header}> ${lines.join('\n> ')}\n\n`;
    },
  };
}

function buildTypeSpacingConfig(): Record<string, unknown> {
  return {
    postprocess: ({ content }: { content: string }) => {
      const lines = content.split('\n');
      const separated: string[] = [];

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? '';
        separated.push(line);

        const nextLine = lines[i + 1];
        if (
          nextLine !== undefined &&
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

function buildDivTranslator(
  ctx: unknown
): Record<string, unknown> | TranslatorConfig {
  const getAttribute = getNodeAttr(getNode(ctx));
  if (!getAttribute) return {};

  const className = getAttribute('class') ?? '';
  if (className.includes('mermaid')) return MERMAID_TRANSLATOR_CONFIG;

  const alertType = resolveGfmAlertType(className);
  const admonition = buildAdmonitionConfig(className, alertType, getAttribute);
  if (admonition) return admonition;

  if (!className.includes('type')) return {};
  return buildTypeSpacingConfig();
}

function buildSectionTranslator(ctx: unknown): Record<string, unknown> {
  const getAttribute = getNodeAttr(getNode(ctx));
  if (getAttribute?.('class')?.includes('tsd-member')) {
    return {
      postprocess: ({ content }: { content: string }) =>
        `\n\n&nbsp;\n\n${content}\n\n`,
    };
  }
  return {
    postprocess: ({ content }: { content: string }) => `\n\n${content}\n\n`,
  };
}

function buildSpanTranslator(ctx: unknown): Record<string, unknown> {
  const getAttribute = getNodeAttr(getNode(ctx));
  if (getAttribute?.('data-as') === 'p') {
    return {
      postprocess: ({ content }: { content: string }) =>
        `\n\n${content.trim()}\n\n`,
    };
  }
  return {};
}

// ---------------------------------------------------------------------------
// DL helpers
// ---------------------------------------------------------------------------

function normalizeDefinitionListContent(content: string): string {
  const lines = content
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return '';

  const normalized: string[] = [];

  for (const line of lines) {
    const isDefinition = line.startsWith(': ');
    const previous = normalized[normalized.length - 1];
    if (
      previous &&
      previous.length > 0 &&
      !previous.startsWith(': ') &&
      !isDefinition
    ) {
      normalized.push('');
    }
    normalized.push(line);
  }

  return normalized.join('\n');
}

// ---------------------------------------------------------------------------
// Simple tag translators
// ---------------------------------------------------------------------------

function buildDlTranslator(): Record<string, unknown> {
  return {
    postprocess: ({ content }: { content: string }) => {
      const normalized = normalizeDefinitionListContent(content);
      return normalized ? `\n\n${normalized}\n\n` : '';
    },
  };
}

function buildDtTranslator(): Record<string, unknown> {
  return {
    postprocess: ({ content }: { content: string }) => `${content.trim()}\n`,
  };
}

function buildDdTranslator(): Record<string, unknown> {
  return {
    postprocess: ({ content }: { content: string }) =>
      content.trim() ? `: ${content.trim()}\n` : '',
  };
}

function wrapTranslator(
  prefix: string,
  suffix: string
): () => Record<string, unknown> {
  return () => ({
    postprocess: ({ content }: { content: string }) =>
      `${prefix}${content}${suffix}`,
  });
}

function buildDetailsTranslator(): Record<string, unknown> {
  return {
    postprocess: ({ content }: { content: string }) => {
      const trimmed = content.trim();
      if (!trimmed) return '';
      return `\n\n${trimmed}\n\n`;
    },
  };
}

function buildSummaryTranslator(): Record<string, unknown> {
  return {
    postprocess: ({ content }: { content: string }) => `${content.trim()}\n\n`,
  };
}

// ---------------------------------------------------------------------------
// Translator registry + converter singleton
// ---------------------------------------------------------------------------

function createCustomTranslators(): TranslatorConfigObject {
  return {
    code: buildCodeTranslator,
    img: buildImageTranslator,
    dl: buildDlTranslator,
    dt: buildDtTranslator,
    dd: buildDdTranslator,
    div: buildDivTranslator,
    kbd: wrapTranslator('`', '`'),
    mark: wrapTranslator('==', '=='),
    sub: wrapTranslator('~', '~'),
    sup: wrapTranslator('^', '^'),
    section: buildSectionTranslator,
    details: buildDetailsTranslator,
    summary: buildSummaryTranslator,
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

export function translateHtmlFragmentToMarkdown(html: string): string {
  return getMarkdownConverter().translate(html).trim();
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

// ── List indentation normalization ───────────────────────────────────
const SOURCE_INDENT_STEP = 2;
const TARGET_INDENT_STEP = 4;

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
    // eslint-disable-next-line sonarjs/slow-regex -- anchored heading line pattern, bounded per-line
    /^(#{1,6}\s+.+?)\s*\[[#¶§¤🔗]\]\(#[^)]+\)\s*$/gmu,
  FENCE_START: FENCE_PATTERN,
  LIST_MARKER: /^(?:[-*+])\s/m,
  TOC_LINK: /^- \[[^\]]+\]\(#[^)]+\)\s*$/,
  TOC_HEADING:
    /^(?:#{1,6}\s+)?(?:table of contents|contents|on this page)\s*$/i,
  COMBINED_LINE_REMOVALS:
    // eslint-disable-next-line sonarjs/regex-complexity -- pattern matches multiple navigation/a11y skip-link variants
    /^(?:\[Skip to (?:main )?(?:content|navigation)\]\(#[^)]*\)|\[Skip link\]\(#[^)]*\)|Was this page helpful\??|\[Back to top\]\(#[^)]*\)|\[\s*\]\(https?:\/\/[^)]*\))\s*$/gim,
  ZERO_WIDTH_ANCHOR: /\[(?:\s|\u200B)*\]\(#[^)]*\)[ \t]*/g,
  // ReDoS-safe: {0,30} bounds identifier backtracking, negated char class
  // [^\u0022\u201C\u201D]* has no overlap with delimiters, and \s+ is anchored
  // between ':' and a quote. Multi-pass capped at PROPERTY_FIX_MAX_PASSES.
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

interface LineContext {
  readonly lines: string[];
  readonly index: number;
  readonly trimmed: string;
  readonly line: string;
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
function findNextNonBlank(
  lines: string[],
  startIndex: number,
  maxLookahead?: number
): number {
  const limit =
    maxLookahead !== undefined
      ? Math.min(lines.length, startIndex + maxLookahead)
      : lines.length;
  for (let i = startIndex; i < limit; i++) {
    if (!isBlank(lines[i])) return i;
  }
  return -1;
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
function isMarkdownStructuralLine(trimmed: string): boolean {
  const firstChar = trimmed.charCodeAt(0);
  if (
    firstChar !== ASCII_MARKERS.HASH &&
    firstChar !== ASCII_MARKERS.DASH &&
    firstChar !== ASCII_MARKERS.ASTERISK &&
    firstChar !== ASCII_MARKERS.PLUS &&
    firstChar !== ASCII_MARKERS.BRACKET_OPEN &&
    (firstChar < ASCII_MARKERS.DIGIT_0 || firstChar > ASCII_MARKERS.DIGIT_9)
  ) {
    return false;
  }
  return (
    REGEX.HEADING_MARKER.test(trimmed) ||
    REGEX.LIST_MARKER.test(trimmed) ||
    /^\d+\.\s/.test(trimmed) ||
    /^\[.*\]\(.*\)$/.test(trimmed)
  );
}
function isTerminalPunctuation(charCode: number): boolean {
  return (
    charCode === ASCII_MARKERS.PERIOD ||
    charCode === ASCII_MARKERS.EXCLAMATION ||
    charCode === ASCII_MARKERS.QUESTION
  );
}
function getHeadingPrefix(trimmed: string): string | null {
  if (trimmed.length > MAX_LINE_LENGTH) return null;
  if (REPL_PROMPT_LINE.test(trimmed)) return null;

  if (isMarkdownStructuralLine(trimmed)) return null;

  if (SPECIAL_PREFIXES.test(trimmed)) {
    return /^example:\s/i.test(trimmed) ? '### ' : '## ';
  }

  if (isTerminalPunctuation(trimmed.charCodeAt(trimmed.length - 1)))
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
function tryPromoteOrphan(ctx: LineContext): string | null {
  const prevLine = ctx.lines[ctx.index - 1];
  const isOrphan = ctx.index === 0 || !prevLine || prevLine.trim().length === 0;
  if (!isOrphan) return null;

  const prefix = getHeadingPrefix(ctx.trimmed);
  if (!prefix) return null;

  const isSpecialPrefix = SPECIAL_PREFIXES.test(ctx.trimmed);
  if (!isSpecialPrefix && !hasFollowingContent(ctx.lines, ctx.index))
    return null;
  if (!isSpecialPrefix) {
    const nextIdx = findNextNonBlank(
      ctx.lines,
      ctx.index + 1,
      HAS_FOLLOWING_LOOKAHEAD
    );
    const nextLine = nextIdx >= 0 ? ctx.lines[nextIdx]?.trim() : undefined;
    if (nextLine && REGEX.HEADING_MARKER.test(nextLine)) return null;
  }

  return `${prefix}${ctx.trimmed}`;
}
function shouldSkipAsToc(
  ctx: LineContext,
  removeToc: boolean,
  options?: CleanupOptions
): number | null {
  if (!removeToc || !REGEX.TOC_HEADING.test(ctx.trimmed)) return null;

  const { total, linkCount, nonLinkCount } = getTocBlockStats(
    ctx.lines,
    ctx.index
  );
  if (total === 0 || nonLinkCount > 0) return null;

  const ratio = linkCount / total;
  if (ratio <= TOC_LINK_RATIO_THRESHOLD) return null;

  throwIfAborted(options?.signal, options?.url ?? '', 'markdown:cleanup:toc');
  return skipTocLines(ctx.lines, ctx.index + 1);
}
function normalizePreprocessLine(
  ctx: LineContext,
  options?: CleanupOptions
): string | null {
  if (REGEX.EMPTY_HEADING_LINE.test(ctx.trimmed)) return null;
  if (!REGEX.ANCHOR_ONLY_HEADING.test(ctx.trimmed)) return ctx.line;
  if (!hasFollowingContent(ctx.lines, ctx.index)) {
    return options?.preserveEmptyHeadings
      ? stripAnchorOnlyHeading(ctx.trimmed)
      : null;
  }
  return stripAnchorOnlyHeading(ctx.trimmed);
}
function maybeSkipTocBlock(
  ctx: LineContext,
  options?: CleanupOptions
): number | null {
  return shouldSkipAsToc(ctx, config.markdownCleanup.removeTocBlocks, options);
}
function maybePromoteOrphanHeading(
  ctx: LineContext,
  checkAbort: (stage: string) => void
): string | null {
  if (
    !config.markdownCleanup.promoteOrphanHeadings ||
    ctx.trimmed.length === 0
  ) {
    return null;
  }

  checkAbort('markdown:cleanup:promote');
  return tryPromoteOrphan(ctx);
}
function preprocessLines(lines: string[], options?: CleanupOptions): string {
  const checkAbort = createAbortChecker(options);
  const result: string[] = [];
  let skipUntil = -1;

  for (let i = 0; i < lines.length; i++) {
    if (i < skipUntil) continue;

    const currentLine = lines[i] ?? '';
    const trimmed = currentLine.trim();
    const ctx: LineContext = { lines, index: i, trimmed, line: currentLine };

    const normalizedLine = normalizePreprocessLine(ctx, options);
    if (normalizedLine === null) continue;

    const tocSkip = maybeSkipTocBlock(ctx, options);
    if (tocSkip !== null) {
      skipUntil = tocSkip;
      continue;
    }

    const promotedLine = maybePromoteOrphanHeading(ctx, checkAbort);
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

    // eslint-disable-next-line sonarjs/slow-regex -- anchored start/end with lazy quantifier on bounded captured group
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
    // eslint-disable-next-line sonarjs/slow-regex -- markdown link pattern, negated character classes
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
  // eslint-disable-next-line sonarjs/slow-regex -- line-anchored table row match, no overlapping quantifiers
  return text.replace(/^(?!\|\s*[-: ]+\|)(\|.*\|)\s*$/gm, (line: string) =>
    line
      .replace(/<\/([A-Za-z][A-Za-z0-9-]*)>/g, '\\</$1\\>')
      .replace(/<([A-Za-z][A-Za-z0-9-]*)>/g, '\\<$1\\>')
  );
}

function stripTrailingHeadingPermalinks(text: string): string {
  return (
    text
      .replace(REGEX.HEADING_TRAILING_PERMALINK, '$1')
      .replace(/^(#{1,6})\s{2,}/gm, '$1 ')
      // eslint-disable-next-line sonarjs/slow-regex -- anchored heading line with lazy quantifier, bounded per-line
      .replace(/^(#{1,6}\s+.*?)[ \t]+$/gm, '$1')
  );
}

function getHeadingInfo(line: string): { level: number } | null {
  const match = /^(#{1,6})\s+/.exec(line.trim());
  if (!match) return null;
  return { level: match[1]?.length ?? 0 };
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

    const nextIndex = findNextNonBlank(lines, i + 1);

    const nextLine = nextIndex >= 0 ? lines[nextIndex] : undefined;
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
      if (count < SOURCE_INDENT_STEP || count % SOURCE_INDENT_STEP !== 0)
        return match;
      const normalized = ' '.repeat(
        (count / SOURCE_INDENT_STEP) * TARGET_INDENT_STEP
      );
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
    // eslint-disable-next-line sonarjs/slow-regex, sonarjs/regex-complexity -- fenced code block matching requires backreference and multiline anchors
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

export function finalizeMarkdownSections(
  content: string,
  options?: Pick<CleanupOptions, 'signal' | 'url'>
): string {
  if (!content) return '';
  throwIfAborted(
    options?.signal,
    options?.url ?? '',
    'markdown:cleanup:empty-headings'
  );
  return stripLeadingBreadcrumbNoise(
    stripLeadingDocsChrome(removeEmptyHeadingSections(content))
  );
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
    result = finalizeMarkdownSections(result, options);
  } else {
    result = stripLeadingBreadcrumbNoise(stripLeadingDocsChrome(result));
  }

  return result;
}

interface FlightApiRow {
  readonly attribute: string;
  readonly type: string;
  readonly description: string;
  readonly defaultValue: string;
}

interface FlightPayloadData {
  readonly installationCommands?: string[];
  readonly importCommands?: string[];
  readonly apiTables: Map<string, string>;
  readonly demoCodeBlocks: Map<string, string>;
  readonly mermaidDiagrams: Map<string, string>;
}

const NEXT_FLIGHT_PAYLOAD_RE =
  /self\.__next_f\.push\(\[1,"((?:\\.|[^"\\])*)"\]\)<\/script>/gs;
// eslint-disable-next-line sonarjs/slow-regex -- template literal assignment capture, bounded
const TEMPLATE_ASSIGNMENT_RE = /([A-Za-z_$][\w$]*)=`([\s\S]*?)`;/g;
const FLIGHT_INSTALL_RE =
  /commands:\{cli:"([^"]+)",npm:"([^"]+)",yarn:"([^"]+)",pnpm:"([^"]+)",bun:"([^"]+)"\}/;
const FLIGHT_IMPORT_RE = /commands:\{main:'([^']+)',individual:'([^']+)'\}/;
const FLIGHT_DEMO_RE =
  /title:"((?:\\.|[^"\\])*)",files:([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)/g;
const FLIGHT_API_RE =
  /children:"([^"]+)"\}\),`\\n`,\(0,e\.jsx\)\(o,\{data:\[([\s\S]*?)\]\}\)/g;
const FLIGHT_API_ROW_RE =
  /attribute:"((?:\\.|[^"\\])*)",type:"((?:\\.|[^"\\])*)",description:"((?:\\.|[^"\\])*)",default:"((?:\\.|[^"\\])*)"/g;
const FLIGHT_MERMAID_SECTION_RE =
  // eslint-disable-next-line sonarjs/regex-complexity -- complex JSX heading+mermaid structure match with bounded lookahead
  /_jsx\(Heading,\{\s*level:"[1-6]",\s*id:"[^"]+",\s*children:"((?:\\.|[^"\\])*)"\s*\}\)(?:(?!_jsx\(Heading,\{)[\s\S]){0,12000}?_jsx\(Mermaid,\{\s*chart:"((?:\\.|[^"\\])*)"\s*\}\)/g;

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function decodeJsonStringLiteral(value: string): string | undefined {
  const decoded: unknown = JSON.parse(`"${value}"`);
  return typeof decoded === 'string' ? decoded : undefined;
}

function decodeFlightStringValue(value: string): string {
  try {
    return decodeJsonStringLiteral(value) ?? decodeHtmlEntities(value);
  } catch {
    return decodeHtmlEntities(value);
  }
}

function decodeNextFlightPayloads(html: string): string[] {
  const payloads: string[] = [];

  for (const match of html.matchAll(NEXT_FLIGHT_PAYLOAD_RE)) {
    const rawPayload = match[1];
    if (!rawPayload) continue;

    try {
      const decodedPayload = decodeJsonStringLiteral(rawPayload);
      if (decodedPayload) payloads.push(decodedPayload);
    } catch {
      // Ignore malformed payload fragments and continue with the rest.
    }
  }

  return payloads;
}

const QUOTE_CHARS = new Set(['"', "'"]);
const OPEN_BRACKETS = new Set(['{', '[', '(']);
const CLOSE_BRACKETS = new Set(['}', ']', ')']);

interface CharScanState {
  escapeNext: boolean;
  inString: boolean;
}

/** Returns true if the char was consumed by escape/string tracking and should be skipped. */
function advanceScanState(state: CharScanState, char: string): boolean {
  if (state.escapeNext) {
    state.escapeNext = false;
    return true;
  }
  if (char === '\\') {
    state.escapeNext = true;
    return true;
  }
  if (QUOTE_CHARS.has(char)) state.inString = !state.inString;
  return false;
}

function updateNestLevel(
  char: string,
  inString: boolean,
  level: number
): number {
  if (inString) return level;
  if (OPEN_BRACKETS.has(char)) return level + 1;
  if (CLOSE_BRACKETS.has(char)) return level - 1;
  return level;
}

function splitAtTopLevelCommas(body: string): string[] {
  const segments: string[] = [];
  let current = '';
  const state: CharScanState = { escapeNext: false, inString: false };
  let nestLevel = 0;

  for (const char of body) {
    if (advanceScanState(state, char)) {
      current += char;
      continue;
    }
    nestLevel = updateNestLevel(char, state.inString, nestLevel);
    if (char === ',' && !state.inString && nestLevel === 0) {
      segments.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  if (current) segments.push(current);
  return segments;
}

function parseObjectEntries(body: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const part of splitAtTopLevelCommas(body)) {
    const entryMatch =
      // eslint-disable-next-line sonarjs/slow-regex -- object entry key:value extraction, bounded per comma-split segment
      /(?:"((?:\\.|[^"\\])*)"|([A-Za-z_$][\w$]*)):([A-Za-z_$][\w$]*)$/.exec(
        part.trim()
      );
    const key = entryMatch?.[1] ?? entryMatch?.[2];
    const value = entryMatch?.[3];
    if (key && value) entries.set(key, value);
  }
  return entries;
}

function findClosingBrace(text: string, start: number): number {
  const state: CharScanState = { escapeNext: false, inString: false };
  let depth = 1;

  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (char === undefined) break;
    if (advanceScanState(state, char)) continue;
    if (state.inString) continue;
    if (char === '{') depth++;
    else if (char === '}') depth--;
    if (depth === 0) return i;
  }
  return -1;
}

function classifyObjectBody(
  objectName: string,
  body: string,
  aliasMap: Map<string, string>,
  objectMaps: Map<string, Map<string, string>>
): void {
  const spreadMatch = /^\.\.\.([A-Za-z_$][\w$]*)$/.exec(body);
  if (spreadMatch?.[1]) {
    aliasMap.set(objectName, spreadMatch[1]);
    return;
  }

  const entries = parseObjectEntries(body);
  if (entries.size > 0) objectMaps.set(objectName, entries);
}

function parseFlightObjectRefs(text: string): {
  templateMap: Map<string, string>;
  aliasMap: Map<string, string>;
  objectMaps: Map<string, Map<string, string>>;
} {
  const templateMap = new Map<string, string>();
  const aliasMap = new Map<string, string>();
  const objectMaps = new Map<string, Map<string, string>>();

  for (const match of text.matchAll(TEMPLATE_ASSIGNMENT_RE)) {
    const name = match[1];
    const code = match[2];
    if (name && code) templateMap.set(name, decodeHtmlEntities(code));
  }

  // eslint-disable-next-line sonarjs/slow-regex -- identifier=brace pattern for object extraction, bounded
  const regex = /([A-Za-z_$][\w$]*)=\{/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const objectName = match[1];
    if (!objectName) continue;

    const end = findClosingBrace(text, regex.lastIndex);
    if (end === -1) continue;

    const body = text.substring(regex.lastIndex, end).trim();
    if (!body) continue;

    classifyObjectBody(objectName, body, aliasMap, objectMaps);
  }

  return { templateMap, aliasMap, objectMaps };
}

function resolveFlightCodeRef(
  name: string | undefined,
  refs: ReturnType<typeof parseFlightObjectRefs>,
  seen = new Set<string>()
): string | undefined {
  if (!name || seen.has(name)) return undefined;
  seen.add(name);

  const direct = refs.templateMap.get(name);
  if (direct) return direct;

  const alias = refs.aliasMap.get(name);
  if (alias) return resolveFlightCodeRef(alias, refs, seen);

  const objectMap = refs.objectMaps.get(name);
  if (!objectMap) return undefined;

  for (const ref of objectMap.values()) {
    const resolved = resolveFlightCodeRef(ref, refs, seen);
    if (resolved) return resolved;
  }

  return undefined;
}

function escapeMarkdownTableCell(value: string): string {
  const normalized = decodeHtmlEntities(value).replace(/\s+/g, ' ').trim();
  return (normalized || '-').replace(/\|/g, '\\|');
}

function buildMarkdownTable(rows: readonly FlightApiRow[]): string {
  if (rows.length === 0) return '';

  const lines = [
    '| Prop | Type | Description | Default |',
    '| ---- | ---- | ----------- | ------- |',
  ];

  for (const row of rows) {
    lines.push(
      `| ${escapeMarkdownTableCell(row.attribute)} | ${escapeMarkdownTableCell(row.type)} | ${escapeMarkdownTableCell(row.description)} | ${escapeMarkdownTableCell(row.defaultValue)} |`
    );
  }

  return lines.join('\n');
}

function buildCodeBlock(code: string): string {
  const trimmed = code.trim();
  if (!trimmed) return '';

  const language = detectLanguageFromCode(trimmed) ?? 'tsx';
  return `\`\`\`${language}\n${trimmed}\n\`\`\``;
}

function buildMermaidBlock(chart: string): string {
  const normalized = decodeFlightStringValue(chart).trim();
  if (!normalized) return '';

  return `\`\`\`mermaid\n${normalized}\n\`\`\``;
}

function normalizeSupplementHeadingText(value: string): string {
  return (
    value
      // eslint-disable-next-line sonarjs/slow-regex -- markdown link stripping on bounded heading text
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase()
  );
}

function getMarkdownHeadingInfo(
  line: string
): { level: number; title: string } | null {
  // eslint-disable-next-line sonarjs/slow-regex -- anchored heading with lazy quantifier, bounded per-line
  const match = /^(#{1,6})\s+(.+?)(?:\s+#*)?\s*$/.exec(line.trim());
  if (!match) return null;

  return {
    level: match[1]?.length ?? 0,
    title: normalizeSupplementHeadingText(match[2] ?? ''),
  };
}

function findMarkdownSection(
  lines: string[],
  title: string
): { start: number; end: number } | null {
  const target = normalizeSupplementHeadingText(title);

  const startIndex = lines.findIndex((line) => {
    const heading = getMarkdownHeadingInfo(line);
    return heading?.title === target;
  });

  if (startIndex === -1) return null;

  const startHeading = getMarkdownHeadingInfo(lines[startIndex] ?? '');
  if (!startHeading) return null;

  let end = lines.length;
  for (let j = startIndex + 1; j < lines.length; j += 1) {
    const nextHeading = getMarkdownHeadingInfo(lines[j] ?? '');
    if (nextHeading && nextHeading.level <= startHeading.level) {
      end = j;
      break;
    }
  }

  return { start: startIndex, end };
}

function getSectionBody(
  lines: string[],
  section: { start: number; end: number }
): string {
  return lines
    .slice(section.start + 1, section.end)
    .join('\n')
    .trim();
}

function updateMarkdownSection(
  lines: string[],
  title: string,
  strategy: (sectionBody: string) => string | null
): boolean {
  const section = findMarkdownSection(lines, title);
  if (!section) return false;

  const bodyText = getSectionBody(lines, section);
  const nextBody = strategy(bodyText);
  if (nextBody === null) return false;

  const replacement =
    nextBody.trim().length > 0
      ? ['', ...nextBody.trim().split('\n'), '']
      : [''];
  lines.splice(
    section.start + 1,
    section.end - section.start - 1,
    ...replacement
  );
  return true;
}

interface UpsertOptions {
  readonly exclusionPattern?: RegExp | string;
  readonly replacement?: boolean;
}

function upsertMarkdownSection(
  lines: string[],
  title: string,
  content: string,
  options?: UpsertOptions
): boolean {
  return updateMarkdownSection(lines, title, (bodyText) => {
    if (options?.replacement) return content;

    if (options?.exclusionPattern) {
      if (options.exclusionPattern instanceof RegExp) {
        if (options.exclusionPattern.test(bodyText)) return null;
      } else if (bodyText.includes(options.exclusionPattern)) {
        return null;
      }
    }

    return bodyText ? `${bodyText}\n\n${content.trim()}` : content.trim();
  });
}

function parseFlightApiRow(rowMatch: RegExpMatchArray): FlightApiRow | null {
  const attribute = rowMatch[1];
  const type = rowMatch[2];
  const description = rowMatch[3];
  const defaultValue = rowMatch[4];
  if (
    !attribute ||
    !type ||
    description === undefined ||
    defaultValue === undefined
  ) {
    return null;
  }
  return { attribute, type, description, defaultValue };
}

function extractFlightApiTables(text: string): Map<string, string> {
  const apiTables = new Map<string, string>();
  for (const match of text.matchAll(FLIGHT_API_RE)) {
    const title = match[1];
    const rawRows = match[2] ?? '';
    if (!title) continue;

    const rows: FlightApiRow[] = [];
    for (const rowMatch of rawRows.matchAll(FLIGHT_API_ROW_RE)) {
      const row = parseFlightApiRow(rowMatch);
      if (row) rows.push(row);
    }

    const table = buildMarkdownTable(rows);
    if (table) apiTables.set(title, table);
  }
  return apiTables;
}

function extractFlightMermaidDiagrams(text: string): Map<string, string> {
  const mermaidDiagrams = new Map<string, string>();
  for (const match of text.matchAll(FLIGHT_MERMAID_SECTION_RE)) {
    const title = match[1] ? decodeFlightStringValue(match[1]).trim() : '';
    const chart = match[2] ? buildMermaidBlock(match[2]) : '';
    if (title && chart) mermaidDiagrams.set(title, chart);
  }
  return mermaidDiagrams;
}

function extractFlightDemoBlocks(
  text: string,
  refs: ReturnType<typeof parseFlightObjectRefs>
): Map<string, string> {
  const demoCodeBlocks = new Map<string, string>();
  for (const match of text.matchAll(FLIGHT_DEMO_RE)) {
    const title = match[1];
    const objectName = match[2];
    const key = match[3];
    const ref = objectName
      ? refs.objectMaps.get(objectName)?.get(key ?? '')
      : undefined;
    const code = resolveFlightCodeRef(ref, refs);
    const codeBlock = code ? buildCodeBlock(code) : '';
    if (title && codeBlock) demoCodeBlocks.set(title, codeBlock);
  }
  return demoCodeBlocks;
}

function extractNextFlightSupplement(
  originalHtml: string
): FlightPayloadData | null {
  const payloads = decodeNextFlightPayloads(originalHtml);
  if (payloads.length === 0) return null;

  const text = payloads.join('\n');
  const refs = parseFlightObjectRefs(text);

  const installMatch = FLIGHT_INSTALL_RE.exec(text);
  const importMatch = FLIGHT_IMPORT_RE.exec(text);

  return {
    ...(installMatch ? { installationCommands: installMatch.slice(1) } : {}),
    ...(importMatch ? { importCommands: importMatch.slice(1) } : {}),
    apiTables: extractFlightApiTables(text),
    demoCodeBlocks: extractFlightDemoBlocks(text, refs),
    mermaidDiagrams: extractFlightMermaidDiagrams(text),
  };
}

export function supplementMarkdownFromNextFlight(
  markdown: string,
  originalHtml: string
): string {
  const payloadData = extractNextFlightSupplement(originalHtml);
  if (!payloadData) return markdown;

  const lines = markdown.split('\n');

  if (payloadData.installationCommands?.length) {
    upsertMarkdownSection(
      lines,
      'Installation',
      buildCodeBlock(payloadData.installationCommands.join('\n')),
      { exclusionPattern: /(npm|pnpm|yarn|bun|npx)\s+(install|add)/ }
    );
  }

  if (payloadData.importCommands?.length) {
    upsertMarkdownSection(
      lines,
      'Import',
      buildCodeBlock(payloadData.importCommands.join('\n\n')),
      { exclusionPattern: /import\s+\{/ }
    );
  }

  for (const [title, table] of payloadData.apiTables) {
    upsertMarkdownSection(lines, title, table, { replacement: true });
  }

  for (const [title, mermaidBlock] of payloadData.mermaidDiagrams) {
    upsertMarkdownSection(lines, title, mermaidBlock, {
      exclusionPattern: '```mermaid',
    });
  }

  for (const [title, codeBlock] of payloadData.demoCodeBlocks) {
    upsertMarkdownSection(lines, title, codeBlock, { exclusionPattern: '```' });
  }

  return lines.join('\n');
}

function decodeInput(input: string | Uint8Array, encoding?: string): string {
  if (typeof input === 'string') return input;

  const normalizedEncoding = encoding?.trim().toLowerCase();

  if (
    !normalizedEncoding ||
    normalizedEncoding === 'utf-8' ||
    normalizedEncoding === 'utf8'
  ) {
    const decoded = new TextDecoder('utf-8').decode(input);
    return decoded;
  }
  try {
    const decoded = new TextDecoder(normalizedEncoding, { fatal: true }).decode(
      input
    );
    return decoded;
  } catch {
    const decoded = new TextDecoder('utf-8').decode(input);
    return decoded;
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
        logWarn(
          'Transform stage exceeded warning threshold',
          {
            stage: context.stage,
            durationMs: Math.round(durationMs),
            thresholdMs: Math.round(warnThresholdMs),
            url: context.url,
          },
          Loggers.LOG_TRANSFORM
        );
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
      logDebug(
        'Diagnostic channel publish failed',
        {
          stage: event.stage,
          error: getErrorMessage(error),
        },
        Loggers.LOG_TRANSFORM
      );
    }
  }

  runTrackedSync<T extends { truncated?: boolean }>(
    url: string,
    signal: AbortSignal | undefined,
    fn: () => T
  ): T {
    const totalStage = this.start(url, 'transform:total');
    try {
      throwIfAborted(signal, url, 'transform:begin');
      const result = fn();
      this.end(
        totalStage,
        result.truncated !== undefined
          ? { truncated: result.truncated }
          : undefined
      );
      return result;
    } catch (error) {
      this.end(totalStage);
      throw error;
    }
  }

  async runTrackedAsync<T extends { truncated?: boolean }>(
    url: string,
    signal: AbortSignal | undefined,
    fn: () => Promise<T>
  ): Promise<T> {
    const totalStage = this.start(url, 'transform:total');
    try {
      throwIfAborted(signal, url, 'transform:begin');
      const result = await fn();
      this.end(
        totalStage,
        result.truncated !== undefined
          ? { truncated: result.truncated }
          : undefined
      );
      return result;
    } catch (error) {
      this.end(totalStage);
      throw error;
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
  const maxSize = config.constants.maxHtmlBytes;
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

  logWarn(
    'HTML content exceeds maximum size, truncating',
    {
      size: getUtf8ByteLength(html),
      maxSize,
      truncatedSize: getUtf8ByteLength(content),
    },
    Loggers.LOG_TRANSFORM
  );
  return { html: content, truncated: true };
}

const MIN_SPA_CONTENT_LENGTH = 100;
const MIN_READERABLE_TEXT_LENGTH = 400;
const MAX_READABILITY_ELEMENTS = 20_000;

function isReadabilityCompatible(doc: unknown): doc is Document {
  if (!isObject(doc)) return false;
  const { querySelectorAll, querySelector } = doc;
  return (
    'documentElement' in doc &&
    typeof querySelectorAll === 'function' &&
    typeof querySelector === 'function'
  );
}

function getNormalizedTextLengthUpTo(text: string, max: number): number {
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

function renameHeaderAttributesInAncestors(heading: Element): void {
  let p = heading.parentNode as Element | null;
  while (p && p.tagName !== 'BODY' && p.tagName !== 'HTML') {
    const cls = p.getAttribute('class');
    if (cls && /header/i.test(cls)) {
      p.setAttribute('class', cls.replace(/header/gi, 'hdr-preserved'));
    }
    const id = p.getAttribute('id');
    if (id && /header/i.test(id)) {
      p.setAttribute('id', id.replace(/header/gi, 'hdr-preserved'));
    }
    p = p.parentNode as Element | null;
  }
}

const UNWRAP_TAGS = new Set(['DIV', 'HEADER', 'SECTION']);

function unwrapStructuralWrappers(container: Element): void {
  for (const child of Array.from(container.children)) {
    if (!UNWRAP_TAGS.has(child.tagName)) continue;

    const cls = child.getAttribute('class') ?? '';
    if (cls.includes('mermaid')) continue;

    const frag = container.ownerDocument.createDocumentFragment();
    while (child.firstChild) {
      frag.appendChild(child.firstChild);
    }
    child.replaceWith(frag);
  }
}

function preserveHeadingLayouts(doc: Document): void {
  // Readability aggressively drops elements matching /header/i in their class/id.
  // Many technical docs use `<div class="layout__header">` to wrap their title and intro text,
  // causing the ENTIRE intro and H1 to be dropped.
  for (const heading of doc.querySelectorAll('h1, h2')) {
    renameHeaderAttributesInAncestors(heading);
  }

  // To prevent Readability from penalizing sibling document sections
  // (e.g. intro vs reference tables) and picking only one, we unwrap structural wrappers inside main boundaries.
  for (const main of doc.querySelectorAll('main, [role="main"], article')) {
    unwrapStructuralWrappers(main);
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
  preserveHeadingLayouts(readabilityDoc);
  preserveCodeLanguageAttributes(readabilityDoc);
  normalizeTabContent(readabilityDoc);
  surfaceCodeEditorContent(readabilityDoc);
  stripDocsControls(readabilityDoc);
  stripScreenReaderText(readabilityDoc);

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
  const textLength = getNormalizedTextLengthUpTo(
    rawText,
    MIN_READERABLE_TEXT_LENGTH + 1
  );

  if (textLength < MIN_SPA_CONTENT_LENGTH) {
    logWarn(
      'Very minimal server-rendered content detected (< 100 chars). ' +
        'This might be a client-side rendered (SPA) application. ' +
        'Content extraction may be incomplete.',
      { textLength },
      Loggers.LOG_TRANSFORM
    );
  }

  throwIfAborted(signal, url, 'extract:article:readabilityCheck');

  return textLength < MIN_READERABLE_TEXT_LENGTH || isProbablyReaderable(doc);
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
    logWarn(
      'Document not compatible with Readability',
      undefined,
      Loggers.LOG_TRANSFORM
    );
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
      error instanceof Error ? error : undefined,
      Loggers.LOG_TRANSFORM
    );
    return null;
  }
}

function isValidInput(html: string, url: string): boolean {
  if (typeof html !== 'string' || html.length === 0) {
    logWarn(
      'extractContent called with invalid HTML input',
      undefined,
      Loggers.LOG_TRANSFORM
    );
    return false;
  }
  if (typeof url !== 'string' || url.length === 0) {
    logWarn(
      'extractContent called with invalid URL',
      undefined,
      Loggers.LOG_TRANSFORM
    );
    return false;
  }
  return true;
}

function applyBaseUri(document: Document, url: string): void {
  try {
    Object.defineProperty(document, 'baseURI', { value: url, writable: true });
  } catch (error: unknown) {
    logInfo(
      'Failed to set baseURI (non-critical)',
      {
        url: url.substring(0, 100),
        error: getErrorMessage(error),
      },
      Loggers.LOG_TRANSFORM
    );
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
  const maxSize = config.constants.maxHtmlBytes;
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
      error instanceof Error ? error : undefined,
      Loggers.LOG_TRANSFORM
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
  let openBracket = markdown.indexOf('[', start);

  while (openBracket !== -1) {
    const closeBracket = markdown.indexOf(']', openBracket + 1);
    if (closeBracket === -1) return null;

    if (markdown[closeBracket + 1] !== '(') {
      openBracket = markdown.indexOf('[', closeBracket + 1);
      continue;
    }

    const closeParen = findBalancedCloseParen(markdown, closeBracket + 2);
    if (closeParen === -1) return null;

    const isImage = openBracket > 0 && markdown[openBracket - 1] === '!';
    const prefixStart = isImage ? openBracket - 1 : openBracket;

    return {
      prefixStart,
      closeParen,
      prefix: markdown.slice(prefixStart, closeBracket + 1),
      href: markdown.slice(closeBracket + 2, closeParen),
    };
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

function handleHtmlToMarkdownError(error: unknown, url: string): never {
  if (error instanceof FetchError) throw error;

  logError(
    'Failed to convert HTML to markdown',
    error instanceof Error ? error : undefined,
    Loggers.LOG_TRANSFORM
  );
  throw new FetchError('Failed to convert HTML to markdown', url, 500, {
    reason: 'markdown_convert_failed',
  });
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
    return handleHtmlToMarkdownError(error, url);
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
  includeMetadataFooter: boolean;
}): { content: string; title: string | undefined } {
  const title = extractTitleFromRawMarkdown(params.rawContent);
  let content = params.includeMetadataFooter
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
  includeMetadataFooter: boolean;
  inputTruncated?: boolean | undefined;
}): MarkdownTransformResult | null {
  if (!shouldPreserveRawContent(params.url, params.html)) return null;

  logDebug(
    'Preserving raw markdown content',
    {
      url: params.url.substring(0, 80),
    },
    Loggers.LOG_TRANSFORM
  );

  const { content, title } = buildRawMarkdownPayload({
    rawContent: params.html,
    url: params.url,
    includeMetadataFooter: params.includeMetadataFooter,
  });

  return {
    markdown: content,
    title,
    truncated: params.inputTruncated ?? false,
  };
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
  includeMetadataFooter: boolean
): MetadataBlock | undefined {
  if (!includeMetadataFooter) return undefined;

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
}): Pick<ContentSource, 'title'> {
  const resolvedTitle =
    (params.preferPrimaryHeading ? params.primaryHeading : undefined) ??
    params.title;

  return {
    title: resolvedTitle,
  };
}

function resolveSourceTitle(
  base: BaseContentSource,
  candidateTitle: string | undefined,
  url: string
): Pick<ContentSource, 'title'> {
  return resolveContentTitle({
    primaryHeading: base.primaryHeading,
    title: candidateTitle,
    preferPrimaryHeading:
      TransformHeuristics.isGithubRepositoryRootUrl(url) ||
      shouldPreferPrimaryHeadingTitle(base.primaryHeading, candidateTitle),
  });
}

const CONTENT_REGION_SELECTORS = [
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

const HEADING_REGION_EXTRA_SELECTORS = [
  '.markdown-body',
  '[itemprop="text"]',
] as const;

function findContentRoot(document: Document): string | undefined {
  for (const selector of CONTENT_REGION_SELECTORS) {
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

  for (const selector of [
    ...CONTENT_REGION_SELECTORS,
    ...HEADING_REGION_EXTRA_SELECTORS,
  ]) {
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
  const title = resolveSourceTitle(base, articleTitle, url);

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
    url: string;
  }
): ContentSource {
  const { resolvedDocument, html, extractedMeta, url } = params;
  const contentRoot = TransformHeuristics.findContentRoot(resolvedDocument);
  const title = resolveSourceTitle(base, extractedMeta.title, url);

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

interface BuildContentSourceInput {
  readonly html: string;
  readonly url: string;
  readonly article: ExtractedArticle | null;
  readonly extractedMeta: ExtractedMetadata;
  readonly includeMetadataFooter: boolean;
  readonly evaluatedArticleDoc: Document | null;
  readonly document?: Document;
  readonly truncated: boolean;
  readonly signal?: AbortSignal | undefined;
}

function resolveBaseContentSource(input: BuildContentSourceInput): {
  base: BaseContentSource;
  preparedDocument: ReturnType<typeof prepareContentSourceDocument> | undefined;
} {
  const {
    html,
    url,
    article,
    extractedMeta,
    includeMetadataFooter,
    evaluatedArticleDoc,
    document,
    truncated,
    signal,
  } = input;

  const metadata = createContentMetadataBlock(
    url,
    article,
    extractedMeta,
    evaluatedArticleDoc !== null,
    includeMetadataFooter
  );
  const preparedDocument = document
    ? prepareContentSourceDocument(document, url, signal)
    : undefined;

  const base: BaseContentSource = {
    favicon: extractedMeta.favicon,
    metadata,
    extractedMetadata: extractedMeta,
    truncated,
    primaryHeading: preparedDocument?.primaryHeading,
    originalHtml: html,
  };

  return { base, preparedDocument };
}

function buildContentSource(input: BuildContentSourceInput): ContentSource {
  const { base, preparedDocument } = resolveBaseContentSource(input);

  if (input.evaluatedArticleDoc && input.article) {
    return buildArticleSource(base, {
      evaluatedArticleDoc: input.evaluatedArticleDoc,
      article: input.article,
      extractedMeta: input.extractedMeta,
      url: input.url,
      signal: input.signal,
    });
  }

  if (preparedDocument) {
    return buildDocumentSource(base, {
      resolvedDocument: preparedDocument.document,
      html: input.html,
      extractedMeta: input.extractedMeta,
      url: input.url,
    });
  }

  return buildRawSource(base, {
    html: input.html,
    extractedMeta: input.extractedMeta,
  });
}

function resolveContentSource(params: {
  html: string;
  url: string;
  includeMetadataFooter: boolean;
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
    includeMetadataFooter: params.includeMetadataFooter,
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
  content = maybePrependSyntheticTitle(content, context);
  content = supplementMarkdownFromNextFlight(content, context.originalHtml);
  content = finalizeMarkdownSections(
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
      includeMetadataFooter: options.includeMetadataFooter,
      inputTruncated: options.inputTruncated,
    })
  );
  if (rawResult) return rawResult;

  const context = stageTracker.run(url, 'transform:extract', () =>
    resolveContentSource({
      html,
      url,
      includeMetadataFooter: options.includeMetadataFooter,
      signal,
      inputTruncated: options.inputTruncated,
    })
  );

  return buildMarkdownFromContext(context, url, signal);
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
  return stageTracker.runTrackedSync(url, signal, () => {
    validateBinaryContent(html, url);
    return resolveTransformContentResult(html, url, options, signal);
  });
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
  includeMetadataFooter: boolean;
  signal?: AbortSignal;
  inputTruncated?: boolean;
} {
  return {
    includeMetadataFooter: options.includeMetadataFooter,
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
  if (config.transform.maxWorkerScale === 0) {
    return transformInputInProcess(htmlOrBuffer, url, options);
  }
  return transformWithWorkerPoolRuntime(
    htmlOrBuffer,
    url,
    {
      ...workerTransformOptions(options),
      ...(options.encoding ? { encoding: options.encoding } : {}),
    },
    { workerPath: new URL(import.meta.url) }
  );
}

function resolveWorkerFallback(
  error: unknown,
  htmlOrBuffer: string | Uint8Array,
  url: string,
  options: TransformExecutionOptions
): MarkdownTransformResult {
  const poolStats = getWorkerPoolStats();
  const isQueueFull =
    error instanceof FetchError &&
    error.details['reason'] === SystemErrors.QUEUE_FULL;

  if (isQueueFull) {
    logWarn(
      'Transform worker queue full; falling back to in-process',
      {
        url: redactUrl(url),
        ...(poolStats ?? {}),
      },
      Loggers.LOG_TRANSFORM
    );

    return transformInputInProcess(htmlOrBuffer, url, options);
  }

  throwIfAborted(options.signal, url, 'transform:worker-fallback');

  if (error instanceof FetchError) throw error;

  if (!(error instanceof Error)) throw toError(error);

  const message = getErrorMessage(error);
  logWarn(
    'Transform worker failed; falling back to in-process',
    {
      url: redactUrl(url),
      error: message,
      ...(poolStats ?? {}),
    },
    Loggers.LOG_TRANSFORM
  );

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
  return stageTracker.runTrackedAsync(url, options.signal, () =>
    runWorkerTransformWithFallback(htmlOrBuffer, url, options)
  );
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

// Worker thread message handling

function bootstrapWorkerThread(): void {
  if (!isMainThread && parentPort) {
    const port = parentPort;
    const onMessage = createTransformMessageHandler({
      sendMessage: (message) => {
        port.postMessage(message);
      },
      runTransform: transformHtmlToMarkdownInProcess,
    });
    port.on('message', onMessage);
  } else if (process.send) {
    const send = process.send.bind(process);
    const onMessage = createTransformMessageHandler({
      sendMessage: (message) => {
        send(message);
      },
      runTransform: transformHtmlToMarkdownInProcess,
    });
    process.on('message', onMessage);
  }
}

bootstrapWorkerThread();
