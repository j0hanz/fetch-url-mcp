import TurndownService from 'turndown';
import type { MetadataBlock } from '../types/index.js';

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

// Pre-compiled regex patterns
const YAML_SPECIAL_CHARS = /[:[\]{}"\n\r'|>&*!?,#]/;
const YAML_NUMERIC = /^[\d.]+$/;
const YAML_RESERVED_WORDS = /^(true|false|null|yes|no|on|off)$/i;
const ESCAPE_BACKSLASH = /\\/g;
const ESCAPE_QUOTE = /"/g;
const ESCAPE_NEWLINE = /\n/g;
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
    .replace(ESCAPE_NEWLINE, '\\n')}"`;
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
  } catch {
    return metadata ? createFrontmatter(metadata) + '\n\n' : '';
  }

  if (metadata) {
    return createFrontmatter(metadata) + '\n\n' + content;
  }

  return content;
}
