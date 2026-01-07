import TurndownService from 'turndown';

import {
  CODE_BLOCK,
  FRONTMATTER_DELIMITER,
  joinLines,
} from '../config/formatting.js';
import type { MetadataBlock } from '../config/types/content.js';

import {
  detectLanguageFromCode,
  resolveLanguageFromAttributes,
} from '../utils/code-language.js';

let turndownInstance: TurndownService | null = null;

function getTurndown(): TurndownService {
  if (turndownInstance) return turndownInstance;
  turndownInstance = createTurndownInstance();
  return turndownInstance;
}

function createTurndownInstance(): TurndownService {
  const instance = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    emDelimiter: '_',
    bulletListMarker: '-',
  });

  addNoiseRule(instance);
  addFencedCodeRule(instance);

  return instance;
}

function isElement(node: unknown): node is HTMLElement {
  return (
    node !== null &&
    typeof node === 'object' &&
    'getAttribute' in node &&
    typeof (node as HTMLElement).getAttribute === 'function'
  );
}

function addNoiseRule(instance: TurndownService): void {
  instance.addRule('removeNoise', {
    filter: [
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
    ],
    replacement: () => '',
  });

  instance.addRule('removeHiddenAndGraphics', {
    filter: (node) => {
      if (!isElement(node)) return false;
      const tagName = node.tagName.toLowerCase();
      if (tagName === 'svg' || tagName === 'canvas') return true;
      return (
        node.getAttribute('hidden') !== null ||
        node.getAttribute('aria-hidden') === 'true'
      );
    },
    replacement: () => '',
  });

  instance.addRule('removeNavigationByRole', {
    filter: (node) => {
      if (!isElement(node)) return false;
      const role = node.getAttribute('role');
      return (
        role === 'navigation' ||
        role === 'banner' ||
        role === 'complementary' ||
        role === 'contentinfo' ||
        role === 'tree' ||
        role === 'menubar' ||
        role === 'menu'
      );
    },
    replacement: () => '',
  });

  instance.addRule('removeFixedPositioned', {
    filter: (node) => {
      if (!isElement(node)) return false;
      const className = node.getAttribute('class') ?? '';
      return /\b(fixed|sticky)\b/.test(className);
    },
    replacement: () => '',
  });

  instance.addRule('removePromotionalContent', {
    filter: (node) => {
      if (!isElement(node)) return false;
      const className = node.getAttribute('class') ?? '';
      const id = node.getAttribute('id') ?? '';
      const combined = `${className} ${id}`.toLowerCase();
      return /banner|promo|announcement|cta|callout|advert|newsletter|subscribe|cookie|consent|popup|modal|overlay|toast/.test(
        combined
      );
    },
    replacement: () => '',
  });

  instance.addRule('removeHighZIndexOverlays', {
    filter: (node) => {
      if (!isElement(node)) return false;
      const className = node.getAttribute('class') ?? '';
      const hasHighZIndex = /\bz-(?:4[0-9]|50)\b/.test(className);
      const hasIsolate = /\bisolate\b/.test(className);
      return hasHighZIndex && hasIsolate;
    },
    replacement: () => '',
  });
}

function addFencedCodeRule(instance: TurndownService): void {
  instance.addRule('fencedCodeBlockWithLanguage', {
    filter: (node, options) => isFencedCodeBlock(node, options),
    replacement: (_content, node) => formatFencedCodeBlock(node),
  });
}

function isFencedCodeBlock(
  node: TurndownService.Node,
  options: TurndownService.Options
): boolean {
  if (options.codeBlockStyle !== 'fenced') return false;
  if (node.nodeName !== 'PRE') return false;
  const { firstChild } = node;
  if (!firstChild) return false;
  return firstChild.nodeName === 'CODE';
}

function formatFencedCodeBlock(node: TurndownService.Node): string {
  const codeNode = node.firstChild;
  if (!isElement(codeNode)) return '';

  const code = codeNode.textContent || '';
  const language = resolveCodeLanguage(codeNode, code);
  return CODE_BLOCK.format(code, language);
}

function resolveCodeLanguage(codeNode: HTMLElement, code: string): string {
  const className = codeNode.getAttribute('class') ?? '';
  const dataLang = codeNode.getAttribute('data-language') ?? '';
  const attributeLanguage = resolveLanguageFromAttributes(className, dataLang);
  return attributeLanguage ?? detectLanguageFromCode(code) ?? '';
}

const YAML_SPECIAL_CHARS = /[:[\]{}"\r\t'|>&*!?,#]|\n/;
const YAML_NUMERIC = /^[\d.]+$/;
const YAML_RESERVED_WORDS = /^(true|false|null|yes|no|on|off)$/i;

const ESCAPE_PATTERNS = {
  backslash: /\\/g,
  quote: /"/g,
  newline: /\n/g,
  tab: /\t/g,
} as const;

function needsYamlQuotes(value: string): boolean {
  const checks = [
    (input: string) => YAML_SPECIAL_CHARS.test(input),
    (input: string) => input.startsWith(' ') || input.endsWith(' '),
    (input: string) => input === '',
    (input: string) => YAML_NUMERIC.test(input),
    (input: string) => YAML_RESERVED_WORDS.test(input),
  ];

  return checks.some((check) => check(value));
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

function createFrontmatter(metadata: MetadataBlock): string {
  const lines: string[] = [FRONTMATTER_DELIMITER];

  if (metadata.title) {
    lines.push(`title: ${escapeYamlValue(metadata.title)}`);
  }
  if (metadata.url) {
    lines.push(`source: ${escapeYamlValue(metadata.url)}`);
  }

  lines.push(FRONTMATTER_DELIMITER);
  return joinLines(lines);
}

function convertHtmlToMarkdown(html: string): string {
  return getTurndown().turndown(html).trim();
}

function buildFrontmatterBlock(metadata?: MetadataBlock): string {
  return metadata ? createFrontmatter(metadata) : '';
}

export function htmlToMarkdown(html: string, metadata?: MetadataBlock): string {
  const frontmatter = buildFrontmatterBlock(metadata);

  if (!isValidHtmlInput(html)) {
    return frontmatter;
  }

  try {
    const content = convertHtmlToMarkdown(html);
    return frontmatter ? `${frontmatter}\n${content}` : content;
  } catch {
    return frontmatter;
  }
}

function isValidHtmlInput(html: string): boolean {
  return Boolean(html && typeof html === 'string');
}
