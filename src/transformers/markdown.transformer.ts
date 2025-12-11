import TurndownService from 'turndown';

import type { MetadataBlock } from '../config/types.js';

import { detectLanguage } from '../utils/language-detector.js';

// Patterns for standalone noise lines to remove from markdown
const NOISE_LINE_PATTERNS: RegExp[] = [
  // Timestamps - various formats
  /^\d+\s*(seconds?|minutes?|hours?|days?|weeks?|months?|years?)\s*ago$/i,
  /^(updated|modified|edited|created|published|posted)\s+\d+\s*(seconds?|minutes?|hours?|days?|weeks?|months?|years?)\s*ago$/i,
  /^(just now|recently|today|yesterday)$/i,
  /^(updated|modified|edited|created|published)\s*:?\s*$/i,
  /^last\s+updated\s*:?$/i,
  /^(last\s+)?(updated|modified|edited)\s*:?\s*\d/i,

  // Single letters or panel labels (from splitter examples, etc.)
  /^[A-Z]$/,
  /^Panel\s+[A-Z]$/i,
  /^[A-Z]\s*$/,

  // Button/action labels
  /^(share|copy|like|follow|subscribe|download|print|save|bookmark)$/i,
  /^(copy to clipboard|copied!?|copy code|copy link)$/i,
  /^(click to copy|expand|collapse|show more|show less|load more)$/i,
  /^(view more|read more|see more|see all|view all)$/i,
  /^(try it|run|execute|play|preview|demo|live demo)$/i,
  /^(edit|delete|remove|add|cancel|confirm|submit|reset|clear)$/i,

  // Navigation
  /^(next|previous|prev|back|forward|home|menu|close|open)$/i,
  /^(scroll to top|back to top|top)$/i,

  // Interactive prompts
  /^(drag|click|tap|swipe|hover)\s+(to|the|here)/i,
  /^(drag the|move the|resize the)/i,

  // Empty structural elements
  /^[•·→←↑↓►▼▲◄▶◀■□●○★☆✓✗✔✘×]+$/,
  /^[,;:\-–—]+$/,
  /^\[\d+\]$/,
  /^\(\d+\)$/,
];

/**
 * Check if a line is noise that should be removed
 */
function isNoiseLine(line: string): boolean {
  const trimmed = line.trim();

  // Empty lines are fine
  if (!trimmed) return false;

  // Don't filter lines inside code blocks, headings, or lists
  if (
    trimmed.startsWith('#') ||
    trimmed.startsWith('-') ||
    trimmed.startsWith('*') ||
    trimmed.startsWith('`') ||
    trimmed.startsWith('>') ||
    trimmed.startsWith('|')
  ) {
    return false;
  }

  // Check against noise patterns
  for (const pattern of NOISE_LINE_PATTERNS) {
    if (pattern.test(trimmed)) {
      return true;
    }
  }

  return false;
}

/**
 * Post-process markdown to remove noise lines
 */
function cleanMarkdownContent(markdown: string): string {
  // Split by lines but preserve code blocks
  const lines = markdown.split('\n');
  const cleanedLines: string[] = [];
  let inCodeBlock = false;

  for (const line of lines) {
    // Track code block boundaries
    if (line.trim().startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      cleanedLines.push(line);
      continue;
    }

    // Don't filter inside code blocks
    if (inCodeBlock) {
      cleanedLines.push(line);
      continue;
    }

    // Filter noise lines outside code blocks
    if (!isNoiseLine(line)) {
      cleanedLines.push(line);
    }
  }

  return cleanedLines.join('\n');
}

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  emDelimiter: '_',
  bulletListMarker: '-',
});

// Remove noise elements
turndown.addRule('removeNoise', {
  filter: ['script', 'style', 'noscript', 'nav', 'footer', 'aside', 'iframe'],
  replacement: () => '',
});

// Enhanced code block handling with language detection
turndown.addRule('fencedCodeBlockWithLanguage', {
  filter: (node, options) => {
    return (
      options.codeBlockStyle === 'fenced' &&
      node.nodeName === 'PRE' &&
      node.firstChild !== null &&
      node.firstChild.nodeName === 'CODE'
    );
  },
  replacement: (_content, node) => {
    const codeNode = node.firstChild as HTMLElement;
    const code = codeNode.textContent || '';

    // Try to get language from class
    const className = codeNode.getAttribute('class') ?? '';
    const dataLang = codeNode.getAttribute('data-language') ?? '';

    const languageMatch =
      /language-(\w+)/.exec(className) ??
      /lang-(\w+)/.exec(className) ??
      /highlight-(\w+)/.exec(className) ??
      /^(\w+)$/.exec(dataLang);

    // Use detected language from class, or try to detect from content
    const language = languageMatch?.[1] ?? detectLanguage(code) ?? '';

    return `\n\n\`\`\`${language}\n${code.replace(/\n$/, '')}\n\`\`\`\n\n`;
  },
});

// Pre-compiled regex patterns
const YAML_SPECIAL_CHARS = /[:[\]{}"\n\r\t'|>&*!?,#]/;
const YAML_NUMERIC = /^[\d.]+$/;
const YAML_RESERVED_WORDS = /^(true|false|null|yes|no|on|off)$/i;
const ESCAPE_BACKSLASH = /\\/g;
const ESCAPE_QUOTE = /"/g;
const ESCAPE_NEWLINE = /\n/g;
const ESCAPE_TAB = /\t/g;
const MULTIPLE_NEWLINES = /\n{3,}/g;

function escapeYamlValue(value: string): string {
  const needsQuoting =
    YAML_SPECIAL_CHARS.test(value) ||
    value.startsWith(' ') ||
    value.endsWith(' ') ||
    value === '' ||
    YAML_NUMERIC.test(value) ||
    YAML_RESERVED_WORDS.test(value);

  if (!needsQuoting) return value;

  return `"${value
    .replace(ESCAPE_BACKSLASH, '\\\\')
    .replace(ESCAPE_QUOTE, '\\"')
    .replace(ESCAPE_NEWLINE, '\\n')
    .replace(ESCAPE_TAB, '\\t')}"`;
}

function createFrontmatter(metadata: MetadataBlock): string {
  const lines = ['---'];
  if (metadata.title) lines.push(`title: ${escapeYamlValue(metadata.title)}`);
  if (metadata.url) lines.push(`source: ${escapeYamlValue(metadata.url)}`);
  lines.push('---');
  return lines.join('\n');
}

export function htmlToMarkdown(html: string, metadata?: MetadataBlock): string {
  if (!html || typeof html !== 'string') {
    return metadata ? createFrontmatter(metadata) + '\n\n' : '';
  }

  let content = '';
  try {
    content = turndown.turndown(html);
    content = content.replace(MULTIPLE_NEWLINES, '\n\n').trim();
    // Clean up noise lines from the markdown
    content = cleanMarkdownContent(content);
    // Final cleanup of multiple newlines after removing noise
    content = content.replace(MULTIPLE_NEWLINES, '\n\n').trim();
  } catch {
    return metadata ? createFrontmatter(metadata) + '\n\n' : '';
  }

  if (metadata) {
    return createFrontmatter(metadata) + '\n\n' + content;
  }

  return content;
}
