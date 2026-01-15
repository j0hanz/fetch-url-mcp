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
import { FetchError, getErrorMessage } from './errors.js';
import { isRawTextContentUrl } from './fetch.js';
import {
  getOperationId,
  getRequestId,
  logDebug,
  logError,
  logInfo,
  logWarn,
  redactUrl,
} from './observability.js';
import { isRecord } from './type-guards.js';

export interface MetadataBlock {
  type: 'metadata';
  title?: string;
  description?: string;
  author?: string;
  url: string;
  fetchedAt: string;
}

export interface ExtractedArticle {
  title?: string;
  byline?: string;
  content: string;
  textContent: string;
  excerpt?: string;
  siteName?: string;
}

export interface ExtractedMetadata {
  title?: string;
  description?: string;
  author?: string;
}

export interface ExtractionResult {
  article: ExtractedArticle | null;
  metadata: ExtractedMetadata;
}

export interface MarkdownTransformResult {
  markdown: string;
  title: string | undefined;
  truncated: boolean;
}

export interface TransformOptions {
  includeMetadata: boolean;
  signal?: AbortSignal;
}

function getAbortReason(signal: AbortSignal): unknown {
  if (!isRecord(signal)) return undefined;
  return 'reason' in signal ? signal.reason : undefined;
}

function getBodyInnerHtml(document: unknown): string | undefined {
  if (!isRecord(document)) return undefined;
  const { body } = document;
  if (!isRecord(body)) return undefined;
  const { innerHTML } = body;
  return typeof innerHTML === 'string' && innerHTML.length > 0
    ? innerHTML
    : undefined;
}

function getDocumentToString(document: unknown): (() => string) | undefined {
  if (!isRecord(document)) return undefined;
  if (typeof document.toString !== 'function') return undefined;
  return document.toString.bind(document);
}

function getDocumentElementOuterHtml(document: unknown): string | undefined {
  if (!isRecord(document)) return undefined;
  const { documentElement } = document;
  if (!isRecord(documentElement)) return undefined;
  const { outerHTML } = documentElement;
  return typeof outerHTML === 'string' && outerHTML.length > 0
    ? outerHTML
    : undefined;
}

const CODE_BLOCK = {
  fence: '```',
  format: (code: string, language = ''): string => {
    return `\`\`\`${language}\n${code}\n\`\`\``;
  },
};

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

export interface TransformStageContext {
  readonly stage: string;
  readonly startTime: number;
  readonly url: string;
}

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
  const result = fn();
  endTransformStage(context);
  return result;
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

type MetaSource = 'og' | 'twitter' | 'standard';
type MetaField = keyof ExtractedMetadata;

interface MetaCollectorState {
  title: Partial<Record<MetaSource, string>>;
  description: Partial<Record<MetaSource, string>>;
  author: Partial<Record<MetaSource, string>>;
}

function createMetaCollectorState(): MetaCollectorState {
  return {
    title: {},
    description: {},
    author: {},
  };
}

function resolveMetaField(
  state: MetaCollectorState,
  field: MetaField
): string | undefined {
  const sources = state[field];
  return sources.og ?? sources.twitter ?? sources.standard;
}

type ParsedMetaKey = 'title' | 'description' | 'author';

function parseOpenGraphKey(
  property: string | null
): Exclude<ParsedMetaKey, 'author'> | null {
  if (!property?.startsWith('og:')) return null;
  const key = property.replace('og:', '');
  return key === 'title' || key === 'description' ? key : null;
}

function parseTwitterKey(
  name: string | null
): Exclude<ParsedMetaKey, 'author'> | null {
  if (!name?.startsWith('twitter:')) return null;
  const key = name.replace('twitter:', '');
  return key === 'title' || key === 'description' ? key : null;
}

function parseStandardKey(name: string | null): ParsedMetaKey | null {
  if (name === 'description') return 'description';
  if (name === 'author') return 'author';
  return null;
}

function collectMetaTag(state: MetaCollectorState, tag: HTMLMetaElement): void {
  const content = tag.getAttribute('content')?.trim();
  if (!content) return;

  const ogKey = parseOpenGraphKey(tag.getAttribute('property'));
  if (ogKey) {
    state[ogKey].og = content;
    return;
  }

  const name = tag.getAttribute('name');
  const twitterKey = parseTwitterKey(name);
  if (twitterKey) {
    state[twitterKey].twitter = content;
    return;
  }

  const standardKey = parseStandardKey(name);
  if (standardKey) {
    state[standardKey].standard = content;
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
    const documentClone = document.cloneNode(true) as Document;
    const rawText =
      documentClone.body.textContent ||
      documentClone.documentElement.textContent;
    const textLength = rawText.replace(/\s+/g, ' ').trim().length;
    if (textLength >= 400 && !isProbablyReaderable(documentClone)) {
      return null;
    }
    const reader = new Readability(documentClone, { maxElemsToParse: 20_000 });
    return reader.parse();
  } catch (error: unknown) {
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
  options: { extractArticle?: boolean; signal?: AbortSignal } = {
    extractArticle: true,
  }
): ExtractionResult {
  const emptyResult = createEmptyExtractionResult();
  if (!isValidInput(html, url)) {
    return emptyResult;
  }

  return tryExtractContent(html, url, options);
}

function createEmptyExtractionResult(): ExtractionResult {
  return { article: null, metadata: {} };
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
): ExtractionResult {
  if (error instanceof FetchError) {
    throw error;
  }
  throwIfAborted(signal, url, 'extract:error');
  logError(
    'Failed to extract content',
    error instanceof Error ? error : undefined
  );
  return createEmptyExtractionResult();
}

function extractContentStages(
  html: string,
  url: string,
  options: { extractArticle?: boolean; signal?: AbortSignal }
): ExtractionResult {
  throwIfAborted(options.signal, url, 'extract:begin');
  const { document } = runTransformStage(url, 'extract:parse', () =>
    parseHTML(truncateHtml(html))
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
  };
}

function tryExtractContent(
  html: string,
  url: string,
  options: { extractArticle?: boolean; signal?: AbortSignal }
): ExtractionResult {
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
  } catch (error: unknown) {
    logInfo('Failed to set baseURI (non-critical)', {
      url: url.substring(0, 100),
      error: getErrorMessage(error),
    });
  }
}

function containsJsxTag(code: string): boolean {
  for (let index = 0; index < code.length - 1; index += 1) {
    if (code[index] !== '<') continue;
    const next = code[index + 1];
    if (!next) continue;
    if (next >= 'A' && next <= 'Z') return true;
  }
  return false;
}

function containsWord(source: string, word: string): boolean {
  let startIndex = source.indexOf(word);
  while (startIndex !== -1) {
    const before = startIndex === 0 ? '' : source[startIndex - 1];
    const afterIndex = startIndex + word.length;
    const after = afterIndex >= source.length ? '' : source[afterIndex];
    if (!isWordChar(before) && !isWordChar(after)) return true;
    startIndex = source.indexOf(word, startIndex + word.length);
  }
  return false;
}

function splitLines(content: string): string[] {
  return content.split('\n');
}

function extractLanguageFromClassName(className: string): string | undefined {
  const tokens = className.match(/\S+/g);
  if (!tokens) return undefined;
  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (lower.startsWith('language-')) return token.slice('language-'.length);
    if (lower.startsWith('lang-')) return token.slice('lang-'.length);
    if (lower.startsWith('highlight-')) {
      return token.slice('highlight-'.length);
    }
  }

  if (tokens.includes('hljs')) {
    const langClass = tokens.find(
      (t) => t !== 'hljs' && !t.startsWith('hljs-')
    );
    if (langClass) return langClass;
  }

  return undefined;
}

function resolveLanguageFromDataAttribute(
  dataLang: string
): string | undefined {
  const trimmed = dataLang.trim();
  if (!trimmed) return undefined;
  for (const char of trimmed) {
    if (!isWordChar(char)) return undefined;
  }
  return trimmed;
}

function isWordChar(char: string | undefined): boolean {
  if (!char) return false;
  const code = char.charCodeAt(0);
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    char === '_'
  );
}

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
];

const BASH_VERBS = ['install', 'add', 'run', 'build', 'start'];
const BASH_COMMANDS = ['sudo', 'chmod', 'mkdir', 'cd', 'ls', 'cat', 'echo'];

function detectBash(code: string): boolean {
  const lines = splitLines(code);
  for (const line of lines) {
    const trimmed = line.trimStart();
    if (!trimmed) continue;
    if (isBashIndicator(trimmed)) return true;
  }
  return false;
}

function startsWithCommand(line: string, commands: readonly string[]): boolean {
  return commands.some(
    (command) => line === command || line.startsWith(`${command} `)
  );
}

function isBashIndicator(line: string): boolean {
  return (
    isShebang(line) ||
    isPromptLine(line) ||
    startsWithCommand(line, BASH_COMMANDS) ||
    startsWithPackageManagerCommand(line)
  );
}

function isShebang(line: string): boolean {
  return line.startsWith('#!');
}

function isPromptLine(line: string): boolean {
  return line.startsWith('$ ') || line.startsWith('# ');
}

function startsWithPackageManagerCommand(line: string): boolean {
  return BASH_PACKAGE_MANAGERS.some((manager) => {
    if (!line.startsWith(`${manager} `)) return false;
    const rest = line.slice(manager.length + 1);
    return BASH_VERBS.some(
      (verb) => rest === verb || rest.startsWith(`${verb} `)
    );
  });
}

interface CodeDetector {
  language: string;
  detect: (code: string) => boolean;
}

const TYPE_HINTS = [
  'string',
  'number',
  'boolean',
  'void',
  'any',
  'unknown',
  'never',
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
const SQL_KEYWORDS = [
  'select',
  'insert',
  'update',
  'delete',
  'create',
  'alter',
  'drop',
];
const JS_WORD_REGEX =
  /\b(?:const|let|var|function|class|async|await|export|import)\b/;
const PYTHON_WORD_REGEX = /\b(?:def|class|import|from)\b/;
const RUST_WORD_REGEX = /\b(?:fn|impl|struct|enum)\b/;
const CSS_DIRECTIVE_REGEX = /@media|@import|@keyframes/;

const CODE_DETECTORS: readonly CodeDetector[] = [
  { language: 'jsx', detect: detectJsx },
  { language: 'typescript', detect: detectTypescript },
  { language: 'rust', detect: detectRust },
  { language: 'javascript', detect: detectJavascript },
  { language: 'python', detect: detectPython },
  { language: 'bash', detect: detectBash },
  { language: 'css', detect: detectCss },
  { language: 'html', detect: detectHtml },
  { language: 'json', detect: detectJson },
  { language: 'yaml', detect: detectYaml },
  { language: 'sql', detect: detectSql },
  { language: 'go', detect: detectGo },
];

function detectJsx(code: string): boolean {
  const lower = code.toLowerCase();
  if (lower.includes('classname=')) return true;
  if (lower.includes('jsx:')) return true;
  if (lower.includes("from 'react'") || lower.includes('from "react"')) {
    return true;
  }
  return containsJsxTag(code);
}

function detectTypescript(code: string): boolean {
  const lower = code.toLowerCase();
  if (containsWord(lower, 'interface')) return true;
  if (containsWord(lower, 'type')) return true;
  return TYPE_HINTS.some(
    (hint) => lower.includes(`: ${hint}`) || lower.includes(`:${hint}`)
  );
}

function detectRust(code: string): boolean {
  const lower = code.toLowerCase();
  return (
    RUST_WORD_REGEX.test(lower) ||
    lower.includes('let mut') ||
    (lower.includes('use ') && lower.includes('::'))
  );
}

function detectJavascript(code: string): boolean {
  const lower = code.toLowerCase();
  return JS_WORD_REGEX.test(lower);
}

function detectPython(code: string): boolean {
  const lower = code.toLowerCase();
  return (
    PYTHON_WORD_REGEX.test(lower) ||
    lower.includes('print(') ||
    lower.includes('__name__')
  );
}

function detectCss(code: string): boolean {
  const lower = code.toLowerCase();
  if (CSS_DIRECTIVE_REGEX.test(lower)) return true;

  const lines = splitLines(code);
  for (const line of lines) {
    const trimmed = line.trimStart();
    if (!trimmed) continue;
    if (isCssSelectorLine(trimmed) || isCssPropertyLine(trimmed)) return true;
  }
  return false;
}

function detectHtml(code: string): boolean {
  const lower = code.toLowerCase();
  return HTML_TAGS.some((tag) => lower.includes(tag));
}

function detectJson(code: string): boolean {
  const trimmed = code.trimStart();
  if (!trimmed) return false;
  return trimmed.startsWith('{') || trimmed.startsWith('[');
}

function detectYaml(code: string): boolean {
  const lines = splitLines(code);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const colonIndex = trimmed.indexOf(':');
    if (colonIndex <= 0) continue;
    const after = trimmed[colonIndex + 1];
    if (after === ' ' || after === '\t') return true;
  }
  return false;
}

function detectSql(code: string): boolean {
  const lower = code.toLowerCase();
  return SQL_KEYWORDS.some((keyword) => containsWord(lower, keyword));
}

function detectGo(code: string): boolean {
  const lower = code.toLowerCase();
  return (
    containsWord(lower, 'package') ||
    containsWord(lower, 'func') ||
    lower.includes('import "')
  );
}

function isCssSelectorLine(line: string): boolean {
  if (!line.startsWith('.') && !line.startsWith('#')) return false;
  return line.includes('{');
}

function isCssPropertyLine(line: string): boolean {
  return line.includes(':') && line.includes(';');
}

export function detectLanguageFromCode(code: string): string | undefined {
  for (const { language, detect } of CODE_DETECTORS) {
    if (detect(code)) return language;
  }
  return undefined;
}

export function resolveLanguageFromAttributes(
  className: string,
  dataLang: string
): string | undefined {
  const classMatch = extractLanguageFromClassName(className);
  return classMatch ?? resolveLanguageFromDataAttribute(dataLang);
}

function isElement(node: unknown): node is HTMLElement {
  return (
    isRecord(node) &&
    'getAttribute' in node &&
    typeof node.getAttribute === 'function'
  );
}

const STRUCTURAL_TAGS = new Set([
  'script',
  'style',
  'noscript',
  'iframe',
  'form',
  'button',
  'input',
  'select',
  'textarea',
]);

const ALWAYS_NOISE_TAGS = new Set(['nav', 'footer', 'aside']);

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
]);

const PROMO_TOKENS = new Set([
  'banner',
  'promo',
  'announcement',
  'cta',
  'callout',
  'advert',
  'ad',
  'ads',
  'sponsor',
  'newsletter',
  'subscribe',
  'cookie',
  'consent',
  'popup',
  'modal',
  'overlay',
  'toast',
  'share',
  'social',
  'related',
  'recommend',
  'comment',
  'breadcrumb',
  'pagination',
  'pager',
]);

const HEADER_NOISE_PATTERN =
  /\b(site-header|masthead|topbar|navbar|nav(?:bar)?|menu|header-nav)\b/i;
const FIXED_PATTERN = /\b(fixed|sticky)\b/;
const HIGH_Z_PATTERN = /\bz-(?:4\d|50)\b/;
const ISOLATE_PATTERN = /\bisolate\b/;

const HTML_DOCUMENT_MARKERS = /<\s*(?:!doctype|html|head|body)\b/i;
const NOISE_MARKERS = [
  '<script',
  '<style',
  '<noscript',
  '<iframe',
  '<nav',
  '<footer',
  '<aside',
  '<header',
  '<form',
  '<button',
  '<input',
  '<select',
  '<textarea',
  '<svg',
  '<canvas',
  ' aria-hidden="true"',
  " aria-hidden='true'",
  ' hidden',
  ' role="navigation"',
  " role='navigation'",
  ' role="banner"',
  " role='banner'",
  ' role="complementary"',
  " role='complementary'",
  ' role="contentinfo"',
  " role='contentinfo'",
  ' role="tree"',
  " role='tree'",
  ' role="menubar"',
  " role='menubar'",
  ' role="menu"',
  " role='menu'",
  ' banner',
  ' promo',
  ' announcement',
  ' cta',
  ' callout',
  ' advert',
  ' newsletter',
  ' subscribe',
  ' cookie',
  ' consent',
  ' popup',
  ' modal',
  ' overlay',
  ' toast',
  ' fixed',
  ' sticky',
  ' z-50',
  ' z-4',
  ' isolate',
];

function mayContainNoise(html: string): boolean {
  const haystack = html.toLowerCase();
  return NOISE_MARKERS.some((marker) => haystack.includes(marker));
}

function isFullDocumentHtml(html: string): boolean {
  return HTML_DOCUMENT_MARKERS.test(html);
}

function isStructuralNoiseTag(tagName: string): boolean {
  return (
    STRUCTURAL_TAGS.has(tagName) || tagName === 'svg' || tagName === 'canvas'
  );
}

function isElementHidden(element: HTMLElement): boolean {
  const style = element.getAttribute('style') ?? '';
  return (
    element.getAttribute('hidden') !== null ||
    element.getAttribute('aria-hidden') === 'true' ||
    /\bdisplay\s*:\s*none\b/i.test(style) ||
    /\bvisibility\s*:\s*hidden\b/i.test(style)
  );
}

function hasNoiseRole(role: string | null): boolean {
  return role !== null && NAVIGATION_ROLES.has(role);
}

function tokenizeIdentifierLikeText(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

function matchesPromoIdOrClass(className: string, id: string): boolean {
  const tokens = tokenizeIdentifierLikeText(`${className} ${id}`);
  return tokens.some((token) => PROMO_TOKENS.has(token));
}

function matchesHighZIsolate(className: string): boolean {
  return HIGH_Z_PATTERN.test(className) && ISOLATE_PATTERN.test(className);
}

function matchesFixedOrHighZIsolate(className: string): boolean {
  return FIXED_PATTERN.test(className) || matchesHighZIsolate(className);
}

interface ElementMetadata {
  tagName: string;
  className: string;
  id: string;
  role: string | null;
  isHidden: boolean;
}

function readElementMetadata(element: HTMLElement): ElementMetadata {
  return {
    tagName: element.tagName.toLowerCase(),
    className: element.getAttribute('class') ?? '',
    id: element.getAttribute('id') ?? '',
    role: element.getAttribute('role'),
    isHidden: isElementHidden(element),
  };
}

function isBoilerplateHeader({
  className,
  id,
  role,
}: ElementMetadata): boolean {
  if (hasNoiseRole(role)) return true;
  const combined = `${className} ${id}`.toLowerCase();
  return HEADER_NOISE_PATTERN.test(combined);
}

function isNoiseElement(node: HTMLElement): boolean {
  const metadata = readElementMetadata(node);
  return (
    isStructuralNoiseTag(metadata.tagName) ||
    ALWAYS_NOISE_TAGS.has(metadata.tagName) ||
    (metadata.tagName === 'header' && isBoilerplateHeader(metadata)) ||
    metadata.isHidden ||
    hasNoiseRole(metadata.role) ||
    matchesFixedOrHighZIsolate(metadata.className) ||
    matchesPromoIdOrClass(metadata.className, metadata.id)
  );
}

function stripNoiseNodes(document: Document): void {
  const nodes = document.querySelectorAll('*');

  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const node =
      typeof nodes.item === 'function' ? nodes.item(index) : nodes[index];
    if (!node) continue;
    if (isElement(node) && isNoiseElement(node)) {
      node.remove();
    }
  }
}

function removeNoiseFromHtml(html: string): string {
  const shouldParse = isFullDocumentHtml(html) || mayContainNoise(html);
  if (!shouldParse) return html;

  try {
    const { document } = parseHTML(html);

    stripNoiseNodes(document);

    const bodyInnerHtml = getBodyInnerHtml(document);
    if (bodyInnerHtml) return bodyInnerHtml;

    const docToString = getDocumentToString(document);
    if (docToString) return docToString();

    const documentElementOuterHtml = getDocumentElementOuterHtml(document);
    if (documentElementOuterHtml) return documentElementOuterHtml;

    return html;
  } catch {
    return html;
  }
}

function buildInlineCode(content: string): string {
  const runs = content.match(/`+/g);
  const longest = runs?.sort((a, b) => b.length - a.length)[0] ?? '';
  const delimiter = `\`${longest}`;
  const padding = delimiter.length > 1 ? ' ' : '';
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
  signal?: AbortSignal
): string {
  throwIfAborted(signal, url, 'markdown:begin');

  const cleanedHtml = runTransformStage(url, 'markdown:noise', () =>
    removeNoiseFromHtml(html)
  );

  throwIfAborted(signal, url, 'markdown:cleaned');

  const content = runTransformStage(url, 'markdown:translate', () =>
    getMarkdownConverter().translate(cleanedHtml).trim()
  );

  throwIfAborted(signal, url, 'markdown:translated');

  let finalMarkdown = cleanupMarkdownArtifacts(content);
  finalMarkdown = promoteOrphanHeadings(finalMarkdown);
  finalMarkdown = normalizeBlockSpacing(finalMarkdown);
  finalMarkdown = normalizeTableWhitespace(finalMarkdown);
  finalMarkdown = normalizeLineEndings(finalMarkdown);
  return finalMarkdown;
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
  options?: { url?: string; signal?: AbortSignal }
): string {
  const url = options?.url ?? metadata?.url ?? '';
  if (!html) return buildMetadataFooter(metadata, url);

  try {
    const content = translateHtmlToMarkdown(html, url, options?.signal);
    return appendMetadataFooter(content, metadata, url);
  } catch (error: unknown) {
    if (error instanceof FetchError) {
      throw error;
    }
    return buildMetadataFooter(metadata, url);
  }
}

function cleanupMarkdownArtifacts(content: string): string {
  let result = content;

  const fixOrphanHeadings = (text: string): string => {
    return text.replace(
      /^(.*?)(#{1,6})\s*(?:\r?\n){2}([A-Z][^\r\n]+?)(?:\r?\n)/gm,
      (match, prefix: unknown, hashes: unknown, heading: unknown) => {
        if (
          typeof prefix !== 'string' ||
          typeof hashes !== 'string' ||
          typeof heading !== 'string'
        ) {
          return match;
        }
        if (heading.length > 150) {
          return match;
        }
        const trimmedPrefix = prefix.trim();
        if (trimmedPrefix === '') {
          return `${hashes} ${heading}\n\n`;
        }
        return `${trimmedPrefix}\n\n${hashes} ${heading}\n\n`;
      }
    );
  };

  result = fixOrphanHeadings(result);
  result = result.replace(/^#{1,6}[ \t\u00A0]*$\r?\n?/gm, '');

  const zeroWidthAnchorLink = /\[(?:\s|\u200B)*\]\(#[^)]*\)\s*/g;

  result = result.replace(zeroWidthAnchorLink, '');
  result = result.replace(/\]\(([^)]+)\)\[/g, ']($1)\n\n[');
  result = result.replace(/^Was this page helpful\??\s*$/gim, '');
  result = result.replace(/(`[^`]+`)\s*\\-\s*/g, '$1 - ');
  result = result.replace(/\\([[]])/g, '$1');
  result = result.replace(/([^\n])\n([-*+] )/g, '$1\n\n$2');
  result = result.replace(/(\S)\n(\d+\. )/g, '$1\n\n$2');
  result = result.replace(/\n{3,}/g, '\n\n');

  return result.trim();
}

function normalizeBlockSpacing(markdown: string): string {
  return markdown
    .replace(/(\n#{1,6} .+)\n(?!\n)/g, '$1\n\n')
    .replace(/\n{3,}/g, '\n\n');
}

const HEADING_KEYWORDS = new Set([
  'overview',
  'introduction',
  'summary',
  'conclusion',
  'prerequisites',
  'requirements',
  'installation',
  'configuration',
  'usage',
  'features',
  'limitations',
  'troubleshooting',
  'faq',
  'resources',
  'references',
  'changelog',
  'license',
  'acknowledgments',
  'appendix',
]);

function isLikelyHeadingLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed || trimmed.length > 80) return false;
  if (/^#{1,6}\s/.test(trimmed)) return false;
  if (/^[-*+•]\s/.test(trimmed) || /^\d+\.\s/.test(trimmed)) return false;
  if (/[.!?]$/.test(trimmed)) return false;
  if (/^\[.*\]\(.*\)$/.test(trimmed)) return false;
  if (/^(?:example|note|tip|warning|important|caution):\s+\S/i.test(trimmed)) {
    return true;
  }
  const words = trimmed.split(/\s+/);
  if (words.length >= 2 && words.length <= 6) {
    const isTitleCase = words.every(
      (w) =>
        /^[A-Z][a-z]*$/.test(w) || /^(?:and|or|the|of|in|for|to|a)$/i.test(w)
    );
    if (isTitleCase) return true;
  }
  if (words.length === 1) {
    const lower = trimmed.toLowerCase();
    if (HEADING_KEYWORDS.has(lower) && /^[A-Z]/.test(trimmed)) {
      return true;
    }
  }

  return false;
}

function promoteOrphanHeadings(markdown: string): string {
  const lines = markdown.split('\n');
  const result: string[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const prevLine = i > 0 ? lines[i - 1] : '';
    const nextLine = i < lines.length - 1 ? lines[i + 1] : '';
    const isStandalone = prevLine?.trim() === '' && nextLine?.trim() === '';
    const isPrecededByBlank = prevLine?.trim() === '';

    if ((isStandalone || isPrecededByBlank) && isLikelyHeadingLine(line)) {
      const trimmed = line.trim();
      const isExample = /^example:\s/i.test(trimmed);
      const prefix = isExample ? '### ' : '## ';
      result.push(prefix + trimmed);
    } else {
      result.push(line);
    }
  }

  return result.join('\n');
}

function normalizeTableWhitespace(markdown: string): string {
  return markdown.replace(/\|([^|\n]+)\|/g, (_match, content: unknown) => {
    const trimmed = typeof content === 'string' ? content.trim() : '';
    return `| ${trimmed} |`;
  });
}

function normalizeLineEndings(markdown: string): string {
  return markdown.replace(/\r\n/g, '\n');
}

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
  const lines: string[] = [];

  if (metadata.title) lines.push(`> *${metadata.title}*`);
  if (metadata.description) lines.push(`> *${metadata.description}*`);
  if (metadata.author) lines.push(`> *${metadata.author}*`);

  const url = metadata.url || fallbackUrl;
  if (url || metadata.fetchedAt) {
    const parts: string[] = [];
    if (url) parts.push(`[Original Source](${url})`);
    if (metadata.fetchedAt) {
      const formattedDate = formatFetchedDate(metadata.fetchedAt);
      parts.push(`_${formattedDate}_`);
    }
    if (parts.length > 0) {
      lines.push(`> ${parts.join(' | ')}`);
    }
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

function countHeadings(html: string): number {
  if (!html) return 0;
  // Match opening heading tags <h1> through <h6>
  const headingPattern = /<h[1-6](?:\s[^>]*)?>([^<]*)<\/h[1-6]>/gi;
  const matches = html.match(headingPattern);
  return matches ? matches.length : 0;
}

function isHeadingStructurePreserved(
  article: ExtractedArticle | null,
  originalHtml: string
): boolean {
  if (!article) return false;

  const originalHeadingCount = countHeadings(originalHtml);
  const articleHeadingCount = countHeadings(article.content);

  // If original has no headings, structure is trivially preserved
  if (originalHeadingCount === 0) return true;

  // If article lost >50% of headings, structure is broken
  const retentionRatio = articleHeadingCount / originalHeadingCount;
  return retentionRatio >= MIN_HEADING_RETENTION_RATIO;
}

function stripHtmlTags(html: string): string {
  const parts: string[] = [];
  let inTag = false;

  for (const char of html) {
    if (char === '<') {
      inTag = true;
      continue;
    }
    if (char === '>') {
      inTag = false;
      continue;
    }
    if (!inTag) {
      parts.push(char);
    }
  }

  return parts.join('');
}

function estimateTextLength(html: string): number {
  return stripHtmlTags(html).replace(/\s+/g, ' ').trim().length;
}

export function isExtractionSufficient(
  article: ExtractedArticle | null,
  originalHtml: string
): boolean {
  if (!article) return false;

  const articleLength = article.textContent.length;
  const originalLength = estimateTextLength(originalHtml);

  if (originalLength < MIN_HTML_LENGTH_FOR_GATE) return true;

  return articleLength / originalLength >= MIN_CONTENT_RATIO;
}

export function determineContentExtractionSource(
  article: ExtractedArticle | null
): article is ExtractedArticle {
  return !!article;
}

function applyArticleMetadata(
  metadata: MetadataBlock,
  article: ExtractedArticle
): void {
  if (article.title !== undefined) metadata.title = article.title;
  if (article.byline !== undefined) metadata.author = article.byline;
}

function applyExtractedMetadata(
  metadata: MetadataBlock,
  extractedMeta: ExtractedMetadata
): void {
  if (extractedMeta.title !== undefined) metadata.title = extractedMeta.title;
  if (extractedMeta.description !== undefined) {
    metadata.description = extractedMeta.description;
  }
  if (extractedMeta.author !== undefined) {
    metadata.author = extractedMeta.author;
  }
}

export function createContentMetadataBlock(
  url: string,
  article: ExtractedArticle | null,
  extractedMeta: ExtractedMetadata,
  shouldExtractFromArticle: boolean,
  includeMetadata: boolean
): MetadataBlock | undefined {
  if (!includeMetadata) return undefined;
  const now = new Date().toISOString();
  const metadata: MetadataBlock = {
    type: 'metadata',
    url,
    fetchedAt: now,
  };

  if (shouldExtractFromArticle && article) {
    applyArticleMetadata(metadata, article);
    return metadata;
  }

  applyExtractedMetadata(metadata, extractedMeta);

  return metadata;
}

interface ContentSource {
  readonly sourceHtml: string;
  readonly title: string | undefined;
  readonly metadata: ReturnType<typeof createContentMetadataBlock>;
}

function buildContentSource({
  html,
  url,
  article,
  extractedMeta,
  includeMetadata,
  useArticleContent,
}: {
  html: string;
  url: string;
  article: ExtractedArticle | null;
  extractedMeta: ExtractedMetadata;
  includeMetadata: boolean;
  useArticleContent: boolean;
}): ContentSource {
  const metadata = createContentMetadataBlock(
    url,
    article,
    extractedMeta,
    useArticleContent,
    includeMetadata
  );

  return {
    sourceHtml: useArticleContent && article ? article.content : html,
    title: useArticleContent && article ? article.title : extractedMeta.title,
    metadata,
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
  html: string,
  url: string
): boolean {
  const shouldExtractFromArticle = determineContentExtractionSource(article);
  if (!shouldExtractFromArticle) return false;

  // Check content sufficiency (length-based quality gate)
  if (!isExtractionSufficient(article, html)) {
    logQualityGateFallback({
      url,
      articleLength: article.textContent.length,
    });
    return false;
  }

  // Check heading structure preservation
  if (!isHeadingStructurePreserved(article, html)) {
    logDebug(
      'Quality gate: Readability broke heading structure, using full HTML',
      {
        url: url.substring(0, 80),
        originalHeadings: countHeadings(html),
        articleHeadings: countHeadings(article.content),
      }
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
  const { article, metadata: extractedMeta } = extractContent(html, url, {
    extractArticle: true,
    ...(signal ? { signal } : {}),
  });

  const useArticleContent = article
    ? shouldUseArticleContent(article, html, url)
    : false;

  return buildContentSource({
    html,
    url,
    article,
    extractedMeta,
    includeMetadata,
    useArticleContent,
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
