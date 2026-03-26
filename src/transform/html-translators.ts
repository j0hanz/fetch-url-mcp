import {
  NodeHtmlMarkdown,
  type TranslatorConfig,
  type TranslatorConfigObject,
} from 'node-html-markdown';

import { isLikeNode, isObject } from '../lib/utils.js';

import { WP_PHOTON_HOST_PATTERN } from './dom-prep.js';

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
  if (!isLikeNode(node)) return '';
  const raw = node.tagName;
  return typeof raw === 'string' ? raw.toUpperCase() : '';
}

function getNode(ctx: unknown): unknown {
  return isObject(ctx) ? (ctx as { node?: unknown }).node : undefined;
}

function getParent(ctx: unknown): unknown {
  return isObject(ctx) ? (ctx as { parent?: unknown }).parent : undefined;
}

function getNodeAttr(
  node: unknown
): ((name: string) => string | null) | undefined {
  if (!isLikeNode(node) || typeof node.getAttribute !== 'function')
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
    return (this._lower ??= this.code.toLowerCase());
  }

  get lines(): readonly string[] {
    return (this._lines ??= this.code.split(/\r?\n/));
  }

  get trimmedStart(): string {
    return (this._trimmedStart ??= this.code.trimStart());
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
    /^\s*\.\.\.\\?>\s+\S/m.test(trimmed)
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
    match: (ctx) => {
      if (HTML_TAGS.some((tag) => ctx.lower.includes(tag))) return false;

      const l = ctx.lower;
      const c = ctx.code;

      if (
        /^\s*(?:>>>|\.\.\.)\s/m.test(c) ||
        /<(?:QuerySet|[A-Z][A-Za-z0-9_]*:\s)|\bdatetime\.datetime\(|\bDoesNotExist:/.test(
          c
        ) ||
        /^\s*[A-Za-z_][\w.]*\s*=\s*[A-Z][\w.]*\(/m.test(c) ||
        /^\s*[A-Za-z_][\w.]*\.[A-Za-z_][\w]*\s*$/m.test(c) ||
        c.includes('None') ||
        c.includes('True') ||
        c.includes('False') ||
        l.includes('print(') ||
        l.includes('__name__') ||
        l.includes('self.') ||
        l.includes('elif ') ||
        /\b(?:def |elif |except |finally:|yield |lambda |raise |pass$)/m.test(l)
      ) {
        return true;
      }

      const hasJsSignals =
        /\b(?:const |let |var |function |require\(|=>|===|!==|console\.)/.test(
          l
        ) ||
        l.includes('{') ||
        l.includes("from '");
      return /\b(?:import|from|class)\b/.test(l) && !hasJsSignals;
    },
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

export function extractLanguageFromClassName(
  className: string
): string | undefined {
  if (!className) return undefined;

  // Split by whitespace and check for language indicators
  const tokens = className.match(/\S+/g);
  if (!tokens) return undefined;

  // Fast path: check for prefixes
  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (lower.startsWith('language-')) return token.slice(9);
    if (lower.startsWith('lang-')) return token.slice(5);
    if (lower.startsWith('highlight-')) return token.slice(10);
  }

  // Special handling for hljs which often appears with a separate language class
  if (tokens.includes('hljs')) {
    const langClass = tokens.find((t) => {
      const l = t.toLowerCase();
      return l !== 'hljs' && !l.startsWith('hljs-');
    });
    if (langClass) return langClass;
  }

  // Last resort: look for any known language prefix followed by a dash
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
