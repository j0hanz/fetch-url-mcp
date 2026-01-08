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
import { isRecord } from '../utils/guards.js';

let turndownInstance: TurndownService | null = null;
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
function getTurndown(): TurndownService {
  turndownInstance ??= createTurndownInstance();
  return turndownInstance;
}
function isElement(node: unknown): node is HTMLElement {
  if (!isRecord(node)) return false;
  return 'getAttribute' in node && typeof node.getAttribute === 'function';
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
  return role ? NAVIGATION_ROLES.has(role) : false;
}

function matchesPromoIdOrClass(className: string, id: string): boolean {
  const combined = `${className} ${id}`.toLowerCase();
  return PROMO_PATTERN.test(combined);
}

function matchesHighZIsolate(className: string): boolean {
  return HIGH_Z_PATTERN.test(className) && ISOLATE_PATTERN.test(className);
}

function matchesFixedOrHighZIsolate(className: string): boolean {
  if (FIXED_PATTERN.test(className)) return true;
  return matchesHighZIsolate(className);
}

function addNoiseRule(instance: TurndownService): void {
  instance.addRule('removeNoise', {
    filter: (node) => isNoiseNode(node),
    replacement: () => '',
  });
}

function isNoiseNode(node: TurndownService.Node): boolean {
  if (!isElement(node)) return false;
  return isNoiseElement(node);
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
  if (isStructuralNoiseTag(metadata.tagName)) return true;
  if (metadata.isHidden) return true;
  if (hasNoiseRole(metadata.role)) return true;
  if (matchesFixedOrHighZIsolate(metadata.className)) return true;
  return matchesPromoIdOrClass(metadata.className, metadata.id);
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
  const { className, dataLanguage } = readCodeAttributes(codeNode);
  const attributeLanguage = resolveLanguageFromAttributes(
    className,
    dataLanguage
  );
  return attributeLanguage ?? detectLanguageFromCode(code) ?? '';
}

function readCodeAttributes(codeNode: HTMLElement): {
  className: string;
  dataLanguage: string;
} {
  return {
    className: codeNode.getAttribute('class') ?? '',
    dataLanguage: codeNode.getAttribute('data-language') ?? '',
  };
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

function appendFrontmatterField(
  lines: string[],
  key: string,
  value: string | undefined
): void {
  if (!value) return;
  lines.push(`${key}: ${escapeYamlValue(value)}`);
}

function createFrontmatter(metadata: MetadataBlock): string {
  const lines: string[] = [FRONTMATTER_DELIMITER];

  appendFrontmatterField(lines, 'title', metadata.title);
  appendFrontmatterField(lines, 'source', metadata.url);

  lines.push(FRONTMATTER_DELIMITER);
  return joinLines(lines);
}

export function htmlToMarkdown(html: string, metadata?: MetadataBlock): string {
  const frontmatter = buildFrontmatter(metadata);
  if (!html) return frontmatter;

  try {
    const content = getTurndown().turndown(html).trim();
    return frontmatter ? `${frontmatter}\n${content}` : content;
  } catch {
    return frontmatter;
  }
}

function buildFrontmatter(metadata?: MetadataBlock): string {
  if (!metadata) return '';
  return createFrontmatter(metadata);
}
