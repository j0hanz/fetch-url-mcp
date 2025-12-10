import TurndownService from 'turndown';
import type { ContentBlockUnion, MetadataBlock } from '../types/index.js';

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  emDelimiter: '_',
});

turndown.addRule('removeScripts', {
  filter: ['script', 'style', 'noscript'],
  replacement: () => '',
});

// Pre-compiled regex patterns for YAML value escaping (performance optimization)
const YAML_SPECIAL_CHARS = /[:[\]{}"\n\r'|>&*!?,#]/;
const YAML_NUMERIC = /^[\d.]+$/;
const YAML_RESERVED_WORDS = /^(true|false|null|yes|no|on|off)$/i;
const ESCAPE_BACKSLASH = /\\/g;
const ESCAPE_QUOTE = /"/g;
const ESCAPE_NEWLINE = /\n/g;
const ESCAPE_CARRIAGE = /\r/g;
const ESCAPE_TAB = /\t/g;

function escapeYamlValue(value: string): string {
  const needsQuoting =
    YAML_SPECIAL_CHARS.test(value) ||
    value.startsWith(' ') ||
    value.endsWith(' ') ||
    value === '' ||
    YAML_NUMERIC.test(value) ||
    YAML_RESERVED_WORDS.test(value);

  if (!needsQuoting) return value;

  const escaped = value
    .replace(ESCAPE_BACKSLASH, '\\\\')
    .replace(ESCAPE_QUOTE, '\\"')
    .replace(ESCAPE_NEWLINE, '\\n')
    .replace(ESCAPE_CARRIAGE, '\\r')
    .replace(ESCAPE_TAB, '\\t');

  return `"${escaped}"`;
}

function createFrontmatter(metadata: MetadataBlock): string {
  const lines = ['---'];

  if (metadata.title) lines.push(`title: ${escapeYamlValue(metadata.title)}`);
  if (metadata.description)
    lines.push(`description: ${escapeYamlValue(metadata.description)}`);
  if (metadata.author)
    lines.push(`author: ${escapeYamlValue(metadata.author)}`);
  if (metadata.url) lines.push(`url: ${escapeYamlValue(metadata.url)}`);
  if (metadata.fetchedAt)
    lines.push(`fetched_at: ${escapeYamlValue(metadata.fetchedAt)}`);

  lines.push('---');
  return lines.join('\n');
}

function tableToMarkdown(table: {
  headers?: string[];
  rows: string[][];
}): string {
  let markdown = '';

  if (table.headers && table.headers.length > 0) {
    markdown += '| ' + table.headers.join(' | ') + ' |\n';
    markdown += '| ' + table.headers.map(() => '---').join(' | ') + ' |\n';
  }

  for (const row of table.rows) {
    markdown += '| ' + row.join(' | ') + ' |\n';
  }

  return markdown.trim();
}

function blockToMarkdown(block: ContentBlockUnion): string {
  switch (block.type) {
    case 'metadata':
      return '';
    case 'heading':
      return '#'.repeat(block.level) + ' ' + block.text;
    case 'paragraph':
      return block.text;
    case 'list':
      return block.items
        .map((item, index) => (block.ordered ? `${index + 1}. ` : '- ') + item)
        .join('\n');
    case 'code':
      return '```' + (block.language || '') + '\n' + block.text + '\n```';
    case 'table':
      return tableToMarkdown(block);
    case 'image':
      return `![${block.alt || ''}](${block.src})`;
  }
}

export function htmlToMarkdown(html: string, metadata?: MetadataBlock): string {
  let markdown = '';

  if (metadata) {
    markdown += createFrontmatter(metadata);
    markdown += '\n\n';
  }

  markdown += turndown.turndown(html);
  return markdown;
}

export function blocksToMarkdown(
  blocks: ContentBlockUnion[],
  metadata?: MetadataBlock
): string {
  let markdown = '';

  if (metadata) {
    markdown += createFrontmatter(metadata);
    markdown += '\n\n';
  }

  for (const block of blocks) {
    markdown += blockToMarkdown(block);
    markdown += '\n\n';
  }

  return markdown.trim();
}
