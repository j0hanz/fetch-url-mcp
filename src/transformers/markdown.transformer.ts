import TurndownService from 'turndown';

import type { MetadataBlock } from '../config/types.js';

import { detectLanguageFromCode } from '../services/parser.js';

const NOISE_LINE_PATTERNS: readonly RegExp[] = [
  // Single letters or panel labels (common in code examples)
  /^[A-Z]$/,
  /^Panel\s+[A-Z]$/i,

  // Empty structural elements that survive HTML->Markdown conversion
  /^[•·→←↑↓►▼▲◄▶◀■□●○★☆✓✗✔✘×]+$/,
  /^[,;:\-–—]+$/,
  /^\[\d+\]$/,
  /^\(\d+\)$/,
] as const;

const MULTIPLE_NEWLINES = /\n{3,}/g;

function isNoiseLine(line: string): boolean {
  const trimmed = line.trim();

  if (!trimmed) return false;

  const markdownPrefixes = ['#', '-', '*', '`', '>', '|'];
  if (markdownPrefixes.some((prefix) => trimmed.startsWith(prefix))) {
    return false;
  }

  return NOISE_LINE_PATTERNS.some((pattern) => pattern.test(trimmed));
}

const CODE_FENCE = '```';

function cleanMarkdownContent(markdown: string): string {
  const lines = markdown.split('\n');
  const cleanedLines: string[] = [];
  let insideCodeBlock = false;

  for (const line of lines) {
    if (line.trim().startsWith(CODE_FENCE)) {
      insideCodeBlock = !insideCodeBlock;
      cleanedLines.push(line);
      continue;
    }

    if (insideCodeBlock) {
      cleanedLines.push(line);
      continue;
    }

    if (!isNoiseLine(line)) {
      cleanedLines.push(line);
    }
  }

  return cleanedLines.join('\n');
}

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

function addNoiseRule(instance: TurndownService): void {
  instance.addRule('removeNoise', {
    filter: ['script', 'style', 'noscript', 'nav', 'footer', 'aside', 'iframe'],
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
  const codeNode = node.firstChild as HTMLElement;
  const code = codeNode.textContent || '';
  const language = resolveCodeLanguage(codeNode, code);
  return `\n\n\`\`\`${language}\n${code.replace(/\n$/, '')}\n\`\`\`\n\n`;
}

function resolveCodeLanguage(codeNode: HTMLElement, code: string): string {
  const className = codeNode.getAttribute('class') ?? '';
  const dataLang = codeNode.getAttribute('data-language') ?? '';

  const languageMatch =
    /language-(\w+)/.exec(className) ??
    /lang-(\w+)/.exec(className) ??
    /highlight-(\w+)/.exec(className) ??
    /^(\w+)$/.exec(dataLang);

  return languageMatch?.[1] ?? detectLanguageFromCode(code) ?? '';
}

const YAML_SPECIAL_CHARS = /[:[\]{}"\n\r\t'|>&*!?,#]/;
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
  const lines = ['---'];

  if (metadata.title) {
    lines.push(`title: ${escapeYamlValue(metadata.title)}`);
  }
  if (metadata.url) {
    lines.push(`source: ${escapeYamlValue(metadata.url)}`);
  }

  lines.push('---');
  return lines.join('\n');
}

function convertHtmlToMarkdown(html: string): string {
  let content = getTurndown().turndown(html);
  content = content.replace(MULTIPLE_NEWLINES, '\n\n').trim();
  content = cleanMarkdownContent(content);
  content = content.replace(MULTIPLE_NEWLINES, '\n\n').trim();
  return content;
}

function buildFrontmatterBlock(metadata?: MetadataBlock): string {
  return metadata ? `${createFrontmatter(metadata)}\n\n` : '';
}

export function htmlToMarkdown(html: string, metadata?: MetadataBlock): string {
  const frontmatter = buildFrontmatterBlock(metadata);

  if (!isValidHtmlInput(html)) {
    return frontmatter;
  }

  try {
    const content = convertHtmlToMarkdown(html);
    return frontmatter ? `${frontmatter}${content}` : content;
  } catch {
    return frontmatter;
  }
}

function isValidHtmlInput(html: string): boolean {
  return Boolean(html && typeof html === 'string');
}
