import {
  NodeHtmlMarkdown,
  type TranslatorConfig,
  type TranslatorConfigObject,
} from 'node-html-markdown';

import {
  detectLanguageFromCode,
  resolveLanguageFromAttributes,
} from '../lib/language-detection.js';
import { isLikeNode, isObject } from '../lib/type-guards.js';

// ---------------------------------------------------------------------------
// Shared constant
// ---------------------------------------------------------------------------

const CODE_BLOCK = {
  fence: '```',
  format: (code: string, language = ''): string =>
    `\`\`\`${language}\n${code}\n\`\`\``,
};

// ---------------------------------------------------------------------------
// DOM helpers (translator-only)
// ---------------------------------------------------------------------------

function getTagName(node: unknown): string {
  if (!isLikeNode(node)) return '';
  const raw = node.tagName;
  return typeof raw === 'string' ? raw.toUpperCase() : '';
}

function hasGetAttribute(
  value: unknown
): value is { getAttribute: (name: string) => string | null } {
  return (
    isObject(value) &&
    typeof (value as { getAttribute?: unknown }).getAttribute === 'function'
  );
}

function getNodeAttr(
  node: unknown
): ((name: string) => string | null) | undefined {
  if (!isLikeNode(node)) return undefined;
  return typeof node.getAttribute === 'function'
    ? node.getAttribute.bind(node)
    : undefined;
}

// ---------------------------------------------------------------------------
// Code translators
// ---------------------------------------------------------------------------

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

function isCodeBlock(
  parent: unknown
): parent is { tagName?: string; childNodes?: unknown[] } {
  const tagName = getTagName(parent);
  return tagName === 'PRE' || tagName === 'WRAPPED-PRE';
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

// ---------------------------------------------------------------------------
// Image translators
// ---------------------------------------------------------------------------

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

function buildImageTranslator(ctx: unknown): TranslatorConfig {
  if (!isObject(ctx)) return { content: '' };

  const { node } = ctx as { node?: unknown };
  const getAttribute = hasGetAttribute(node)
    ? node.getAttribute.bind(node)
    : undefined;

  const src = resolveImageSrc(getAttribute);

  const existingAlt = getAttribute?.('alt') ?? '';
  const alt = existingAlt.trim() || deriveAltFromImageUrl(src);

  const markdown = `![${alt}](${src})`;

  return { content: markdown };
}

// ---------------------------------------------------------------------------
// Pre / Mermaid translators
// ---------------------------------------------------------------------------

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
  const lower = className.toLowerCase();
  for (const [key, type] of GFM_ALERT_MAP) {
    if (lower.includes(key)) return type;
  }
  return undefined;
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

// ---------------------------------------------------------------------------
// Table / DL helpers
// ---------------------------------------------------------------------------

function hasComplexTableLayout(node: unknown): boolean {
  if (!isLikeNode(node)) return false;
  const innerHTML = typeof node.innerHTML === 'string' ? node.innerHTML : '';
  return /(?:colspan|rowspan)=["']?[2-9]/i.test(innerHTML);
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

// ---------------------------------------------------------------------------
// Translator registry + converter singleton
// ---------------------------------------------------------------------------

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

export function translateHtmlFragmentToMarkdown(html: string): string {
  return getMarkdownConverter().translate(html).trim();
}
