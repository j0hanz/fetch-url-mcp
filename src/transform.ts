import { randomUUID } from 'node:crypto';
import diagnosticsChannel from 'node:diagnostics_channel';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { Worker } from 'node:worker_threads';

import { parseHTML } from 'linkedom';
import {
  NodeHtmlMarkdown,
  type TranslatorCollection,
  type TranslatorConfigObject,
} from 'node-html-markdown';

import { Readability } from '@mozilla/readability';

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
const FRONTMATTER_DELIMITER = '---';

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
    // Avoid crashing the publisher if a subscriber throws.
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

  const requestId = (getRequestId as unknown as () => string | undefined)();
  const operationId = (getOperationId as unknown as () => string | undefined)();

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

function isTimeoutReason(reason: unknown): boolean {
  return reason instanceof Error && reason.name === 'TimeoutError';
}

function throwIfAborted(
  signal: AbortSignal | undefined,
  url: string,
  stage: string
): void {
  if (!signal?.aborted) return;

  if (isTimeoutReason((signal as unknown as { reason: unknown }).reason)) {
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
    // Type assertion is safe here due to isReadabilityCompatible check
    const reader = new Readability(document);
    return reader.parse();
  } catch (error) {
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
  if (!isValidInput(html, url)) {
    return { article: null, metadata: {} };
  }

  return tryExtractContent(html, url, options);
}

function tryExtractContent(
  html: string,
  url: string,
  options: { extractArticle?: boolean; signal?: AbortSignal }
): ExtractionResult {
  try {
    throwIfAborted(options.signal, url, 'extract:begin');
    const parseStage = startTransformStage(url, 'extract:parse');
    const { document } = parseHTML(truncateHtml(html));
    endTransformStage(parseStage);

    throwIfAborted(options.signal, url, 'extract:parsed');

    applyBaseUri(document, url);

    const metadataStage = startTransformStage(url, 'extract:metadata');
    const metadata = extractMetadata(document);
    endTransformStage(metadataStage);

    throwIfAborted(options.signal, url, 'extract:metadata');

    let article: ExtractedArticle | null;
    if (options.extractArticle) {
      const articleStage = startTransformStage(url, 'extract:article');
      article = resolveArticleExtraction(document, options.extractArticle);
      endTransformStage(articleStage);
    } else {
      article = null;
    }

    throwIfAborted(options.signal, url, 'extract:article');
    return {
      article,
      metadata,
    };
  } catch (error) {
    if (error instanceof FetchError) {
      throw error;
    }
    throwIfAborted(options.signal, url, 'extract:error');
    logError(
      'Failed to extract content',
      error instanceof Error ? error : undefined
    );
    return { article: null, metadata: {} };
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
  } catch (error) {
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

const YAML_SPECIAL_CHARS = /[:[\]{}"\r\t'|>&*!?,#]|\n/;
const YAML_NUMERIC = /^[\d.]+$/;
const YAML_RESERVED_WORDS = /^(true|false|null|yes|no|on|off)$/i;

const ESCAPE_PATTERNS = {
  backslash: /\\/g,
  quote: /"/g,
  newline: /\n/g,
  tab: /\t/g,
};

const YAML_QUOTE_CHECKS: readonly ((input: string) => boolean)[] = [
  (input) => YAML_SPECIAL_CHARS.test(input),
  (input) => input.startsWith(' ') || input.endsWith(' '),
  (input) => input === '',
  (input) => YAML_NUMERIC.test(input),
  (input) => YAML_RESERVED_WORDS.test(input),
];

function needsYamlQuotes(value: string): boolean {
  return YAML_QUOTE_CHECKS.some((check) => check(value));
}

function escapeYamlValue(value: string): string {
  if (!needsYamlQuotes(value)) {
    return value;
  }

  const escaped = value
    .replace(ESCAPE_PATTERNS.backslash, '\\\\')
    .replace(ESCAPE_PATTERNS.quote, '\\"')
    .replace(ESCAPE_PATTERNS.newline, '\\n')
    .replace(ESCAPE_PATTERNS.tab, '\\t');

  return `"${escaped}"`;
}

function appendFrontmatterField(
  lines: string[],
  key: string,
  value: string | undefined
): void {
  if (!value) return;
  lines.push(`${key}: ${escapeYamlValue(value)}`);
}

function joinLines(lines: readonly string[]): string {
  return lines.join('\n');
}

function buildFrontmatter(metadata?: MetadataBlock): string {
  if (!metadata) return '';
  const lines: string[] = [FRONTMATTER_DELIMITER];

  appendFrontmatterField(lines, 'title', metadata.title);
  appendFrontmatterField(lines, 'source', metadata.url);
  appendFrontmatterField(lines, 'author', metadata.author);
  appendFrontmatterField(lines, 'description', metadata.description);
  appendFrontmatterField(lines, 'fetchedAt', metadata.fetchedAt);

  lines.push(FRONTMATTER_DELIMITER);
  return joinLines(lines);
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
  'nav',
  'footer',
  'aside',
  'header',
  'form',
  'button',
  'input',
  'select',
  'textarea',
]);
const NAVIGATION_ROLES = new Set([
  'navigation',
  'banner',
  'complementary',
  'contentinfo',
  'tree',
  'menubar',
  'menu',
]);
const PROMO_PATTERN =
  /banner|promo|announcement|cta|callout|advert|newsletter|subscribe|cookie|consent|popup|modal|overlay|toast/;
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
  return (
    element.getAttribute('hidden') !== null ||
    element.getAttribute('aria-hidden') === 'true'
  );
}

function hasNoiseRole(role: string | null): boolean {
  return role !== null && NAVIGATION_ROLES.has(role);
}

function matchesPromoIdOrClass(className: string, id: string): boolean {
  const combined = `${className} ${id}`.toLowerCase();
  return PROMO_PATTERN.test(combined);
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

function isNoiseElement(node: HTMLElement): boolean {
  const metadata = readElementMetadata(node);
  return (
    isStructuralNoiseTag(metadata.tagName) ||
    metadata.isHidden ||
    hasNoiseRole(metadata.role) ||
    matchesFixedOrHighZIsolate(metadata.className) ||
    matchesPromoIdOrClass(metadata.className, metadata.id)
  );
}

function removeNoiseFromHtml(html: string): string {
  const shouldParse = isFullDocumentHtml(html) || mayContainNoise(html);
  if (!shouldParse) return html;

  const shouldRemove = mayContainNoise(html);

  try {
    const { document } = parseHTML(html);

    if (shouldRemove) {
      const nodes = Array.from(document.querySelectorAll('*'));

      for (let index = nodes.length - 1; index >= 0; index -= 1) {
        const node = nodes[index];
        if (!node) continue;
        if (isElement(node) && isNoiseElement(node)) {
          node.remove();
        }
      }
    }

    const { body } = document as unknown as { body?: { innerHTML?: string } };
    if (body?.innerHTML) return body.innerHTML;

    if (
      typeof (document as unknown as { toString?: () => string }).toString ===
      'function'
    ) {
      return (document as unknown as { toString: () => string }).toString();
    }

    const { documentElement } = document as unknown as {
      documentElement?: { outerHTML?: string };
    };
    if (documentElement?.outerHTML) return documentElement.outerHTML;

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

function isCodeBlock(
  parent: unknown
): parent is { tagName?: string; childNodes?: unknown[] } {
  if (!isRecord(parent)) return false;
  const tagName =
    typeof parent.tagName === 'string' ? parent.tagName.toUpperCase() : '';
  return ['PRE', 'WRAPPED-PRE'].includes(tagName);
}

function createCodeTranslator(): TranslatorConfigObject {
  return {
    code: (ctx: unknown) => {
      if (!isRecord(ctx)) {
        return {
          spaceIfRepeatingChar: true,
          noEscape: true,
          postprocess: ({ content }: { content: string }) =>
            buildInlineCode(content),
        };
      }

      const { node, parent, visitor } = ctx;
      const getAttribute =
        isRecord(node) && typeof node.getAttribute === 'function'
          ? (node.getAttribute as (name: string) => string | null).bind(node)
          : undefined;

      if (!isCodeBlock(parent)) {
        return {
          spaceIfRepeatingChar: true,
          noEscape: true,
          postprocess: ({ content }: { content: string }) =>
            buildInlineCode(content),
        };
      }

      const className = getAttribute?.('class') ?? '';
      const dataLanguage = getAttribute?.('data-language') ?? '';
      const attributeLanguage = resolveLanguageFromAttributes(
        className,
        dataLanguage
      );

      const childTranslators = isRecord(visitor) ? visitor.instance : null;

      const codeBlockTranslators =
        isRecord(childTranslators) &&
        isRecord(
          (childTranslators as { codeBlockTranslators?: unknown })
            .codeBlockTranslators
        )
          ? (
              childTranslators as {
                codeBlockTranslators: TranslatorCollection;
              }
            ).codeBlockTranslators
          : null;

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
    },
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
    createCodeTranslator()
  );
}

function getMarkdownConverter(): NodeHtmlMarkdown {
  markdownInstance ??= createMarkdownInstance();
  return markdownInstance;
}

export function htmlToMarkdown(
  html: string,
  metadata?: MetadataBlock,
  options?: { url?: string; signal?: AbortSignal }
): string {
  const url = options?.url ?? metadata?.url ?? '';
  const frontmatter = buildFrontmatter(metadata);
  if (!html) return frontmatter;

  try {
    throwIfAborted(options?.signal, url, 'markdown:begin');

    const noiseStage = startTransformStage(url, 'markdown:noise');
    const cleanedHtml = removeNoiseFromHtml(html);
    endTransformStage(noiseStage);

    throwIfAborted(options?.signal, url, 'markdown:cleaned');

    const translateStage = startTransformStage(url, 'markdown:translate');
    const content = getMarkdownConverter().translate(cleanedHtml).trim();
    endTransformStage(translateStage);

    throwIfAborted(options?.signal, url, 'markdown:translated');
    return frontmatter ? `${frontmatter}\n${content}` : content;
  } catch (error) {
    if (error instanceof FetchError) {
      throw error;
    }
    return frontmatter;
  }
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

function extractTitleFromRawMarkdown(content: string): string | undefined {
  const frontmatter = findFrontmatterLines(content);
  if (!frontmatter) return undefined;

  const { lines, endIndex } = frontmatter;
  const entry = lines
    .slice(1, endIndex)
    .map((line) => parseFrontmatterEntry(line))
    .find((parsed) => parsed !== null && isTitleKey(parsed.key));
  if (!entry) return undefined;
  const value = stripOptionalQuotes(entry.value);
  return value || undefined;
}

function addSourceToMarkdown(content: string, url: string): string {
  const frontmatter = findFrontmatterLines(content);
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

function buildArticleContentSource({
  url,
  article,
  extractedMeta,
  includeMetadata,
}: {
  url: string;
  article: ExtractedArticle;
  extractedMeta: ExtractedMetadata;
  includeMetadata: boolean;
}): ContentSource {
  const metadata = createContentMetadataBlock(
    url,
    article,
    extractedMeta,
    true,
    includeMetadata
  );

  return {
    sourceHtml: article.content,
    title: article.title,
    metadata,
  };
}

function buildFullHtmlContentSource({
  html,
  url,
  article,
  extractedMeta,
  includeMetadata,
}: {
  html: string;
  url: string;
  article: ExtractedArticle | null;
  extractedMeta: ExtractedMetadata;
  includeMetadata: boolean;
}): ContentSource {
  const metadata = createContentMetadataBlock(
    url,
    article,
    extractedMeta,
    false,
    includeMetadata
  );

  return {
    sourceHtml: html,
    title: extractedMeta.title,
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

function tryBuildExtractedArticleContentSource({
  html,
  url,
  article,
  extractedMeta,
  includeMetadata,
}: {
  html: string;
  url: string;
  article: ExtractedArticle | null;
  extractedMeta: ExtractedMetadata;
  includeMetadata: boolean;
}): ContentSource | null {
  if (!article) return null;

  const shouldExtractFromArticle = determineContentExtractionSource(article);
  if (shouldExtractFromArticle && isExtractionSufficient(article, html)) {
    return buildArticleContentSource({
      url,
      article,
      extractedMeta,
      includeMetadata,
    });
  }

  if (shouldExtractFromArticle) {
    logQualityGateFallback({
      url,
      articleLength: article.textContent.length,
    });
  }

  return null;
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

  const extracted = tryBuildExtractedArticleContentSource({
    html,
    url,
    article,
    extractedMeta,
    includeMetadata,
  });
  if (extracted) return extracted;

  return buildFullHtmlContentSource({
    html,
    url,
    article,
    extractedMeta,
    includeMetadata,
  });
}

export function transformHtmlToMarkdownInProcess(
  html: string,
  url: string,
  options: TransformOptions
): MarkdownTransformResult {
  const totalStage = startTransformStage(url, 'transform:total');
  let success = false;

  try {
    throwIfAborted(options.signal, url, 'transform:begin');

    const rawStage = startTransformStage(url, 'transform:raw');
    const raw = tryTransformRawContent({
      html,
      url,
      includeMetadata: options.includeMetadata,
    });
    endTransformStage(rawStage);
    if (raw) {
      success = true;
      return raw;
    }

    const extractStage = startTransformStage(url, 'transform:extract');
    const context = resolveContentSource({
      html,
      url,
      includeMetadata: options.includeMetadata,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    endTransformStage(extractStage);

    const markdownStage = startTransformStage(url, 'transform:markdown');
    const content = htmlToMarkdown(context.sourceHtml, context.metadata, {
      url,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    endTransformStage(markdownStage);

    success = true;
    return {
      markdown: content,
      title: context.title,
      truncated: false,
    };
  } finally {
    if (success) {
      endTransformStage(totalStage, { truncated: false });
    }
  }
}

interface WorkerResultMessage {
  type: 'result';
  id: string;
  result: MarkdownTransformResult;
}

interface WorkerErrorMessage {
  type: 'error';
  id: string;
  error: {
    name: string;
    message: string;
    url: string;
    statusCode?: number;
    details?: Record<string, unknown>;
  };
}

type WorkerMessage = WorkerResultMessage | WorkerErrorMessage;

interface PendingTask {
  id: string;
  html: string;
  url: string;
  includeMetadata: boolean;
  signal: AbortSignal | undefined;
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

  // Leave 1 core for the event loop; cap to avoid runaway memory.
  return Math.min(16, Math.max(1, parallelism - 1));
}

const DEFAULT_TIMEOUT_MS = 30000;

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

    // Workers must not keep the process alive by themselves.
    worker.unref();

    const slot: WorkerSlot = {
      worker,
      busy: false,
      currentTaskId: null,
    };

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

    return slot;
  }

  private onWorkerBroken(workerIndex: number, message: string): void {
    if (this.closed) return;

    const slot = this.workers[workerIndex];
    if (!slot) return;

    if (slot.busy && slot.currentTaskId) {
      this.failTask(slot.currentTaskId, new Error(message));
    }

    void slot.worker.terminate();
    this.workers[workerIndex] = this.spawnWorker(workerIndex);
    this.drainQueue();
  }

  private onWorkerMessage(workerIndex: number, raw: unknown): void {
    if (
      !raw ||
      typeof raw !== 'object' ||
      !('type' in raw) ||
      !('id' in raw) ||
      typeof (raw as { id: unknown }).id !== 'string' ||
      typeof (raw as { type: unknown }).type !== 'string'
    ) {
      return;
    }

    const message = raw as WorkerMessage;
    const inflight = this.inflight.get(message.id);
    if (!inflight) return;

    clearTimeout(inflight.timer);
    if (inflight.signal && inflight.abortListener) {
      inflight.signal.removeEventListener('abort', inflight.abortListener);
    }
    this.inflight.delete(message.id);

    const slot = this.workers[workerIndex];
    if (slot) {
      slot.busy = false;
      slot.currentTaskId = null;
    }

    if (message.type === 'result') {
      inflight.resolve(message.result);
    } else {
      const { error } = message;
      if (error.name === 'FetchError') {
        inflight.reject(
          new FetchError(
            error.message,
            error.url,
            error.statusCode,
            error.details ?? {}
          )
        );
      } else {
        inflight.reject(new Error(error.message));
      }
    }

    this.drainQueue();
  }

  private failTask(id: string, error: unknown): void {
    const inflight = this.inflight.get(id);
    if (!inflight) return;

    clearTimeout(inflight.timer);
    if (inflight.signal && inflight.abortListener) {
      inflight.signal.removeEventListener('abort', inflight.abortListener);
    }
    this.inflight.delete(id);
    inflight.reject(error);

    const slot = this.workers[inflight.workerIndex];
    if (slot) {
      slot.busy = false;
      slot.currentTaskId = null;
    }
  }

  async transform(
    html: string,
    url: string,
    options: { includeMetadata: boolean; signal?: AbortSignal }
  ): Promise<MarkdownTransformResult> {
    if (this.closed) {
      throw new Error('Transform worker pool closed');
    }

    if (this.queue.length >= this.queueMax) {
      throw new Error('Transform worker queue is full');
    }

    return new Promise<MarkdownTransformResult>((resolve, reject) => {
      this.queue.push({
        id: randomUUID(),
        html,
        url,
        includeMetadata: options.includeMetadata,
        signal: options.signal,
        resolve,
        reject,
      });

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
    if (task.signal?.aborted) {
      task.reject(
        new FetchError('Request was canceled', task.url, 499, {
          reason: 'aborted',
          stage: 'transform:dispatch',
        })
      );
      return;
    }

    slot.busy = true;
    slot.currentTaskId = task.id;

    const timer = setTimeout(() => {
      try {
        slot.worker.postMessage({ type: 'cancel', id: task.id });
      } catch {
        // ignore
      }

      const inflight = this.inflight.get(task.id);
      if (!inflight) return;

      clearTimeout(inflight.timer);
      if (inflight.signal && inflight.abortListener) {
        inflight.signal.removeEventListener('abort', inflight.abortListener);
      }
      this.inflight.delete(task.id);

      inflight.reject(
        new FetchError('Request timeout', task.url, 504, {
          reason: 'timeout',
          stage: 'transform:worker-timeout',
        })
      );

      if (!this.closed) {
        void slot.worker.terminate();
        this.workers[workerIndex] = this.spawnWorker(workerIndex);
        this.drainQueue();
      }
    }, this.timeoutMs).unref();

    let abortListener: (() => void) | undefined;
    if (task.signal) {
      abortListener = () => {
        try {
          slot.worker.postMessage({ type: 'cancel', id: task.id });
        } catch {
          // ignore
        }
      };
      task.signal.addEventListener('abort', abortListener, { once: true });
    }

    this.inflight.set(task.id, {
      resolve: task.resolve,
      reject: task.reject,
      timer,
      signal: task.signal,
      abortListener,
      workerIndex,
    });

    slot.worker.postMessage({
      type: 'transform',
      id: task.id,
      html: task.html,
      url: task.url,
      includeMetadata: task.includeMetadata,
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    const terminations = this.workers.map((slot) => slot.worker.terminate());
    this.workers.length = 0;

    for (const [id, inflight] of this.inflight.entries()) {
      clearTimeout(inflight.timer);
      if (inflight.signal && inflight.abortListener) {
        inflight.signal.removeEventListener('abort', inflight.abortListener);
      }
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

export async function transformHtmlToMarkdown(
  html: string,
  url: string,
  options: TransformOptions
): Promise<MarkdownTransformResult> {
  const totalStage = startTransformStage(url, 'transform:total');
  let success = false;

  try {
    throwIfAborted(options.signal, url, 'transform:begin');

    const workerStage = startTransformStage(url, 'transform:worker');
    try {
      const poolRef = getOrCreateTransformWorkerPool();
      const result = await poolRef.transform(html, url, {
        includeMetadata: options.includeMetadata,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      success = true;
      return result;
    } catch (error: unknown) {
      if (error instanceof FetchError) {
        throw error;
      }

      // Stability-first: if worker infrastructure fails, fall back to in-process.
      throwIfAborted(options.signal, url, 'transform:worker-fallback');
      const fallback = transformHtmlToMarkdownInProcess(html, url, options);
      success = true;
      return fallback;
    } finally {
      endTransformStage(workerStage);
    }
  } finally {
    if (success) {
      endTransformStage(totalStage, { truncated: false });
    }
  }
}
