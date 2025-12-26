import * as cheerio from 'cheerio';
import type { CheerioAPI } from 'cheerio';
import type { AnyNode, Element } from 'domhandler';

import { config } from '../config/index.js';
import type {
  BlockquoteBlock,
  CodeBlock,
  ContentBlockUnion,
  HeadingBlock,
  ImageBlock,
  ListBlock,
  ParagraphBlock,
  ParseableTagName,
  TableBlock,
} from '../config/types.js';

import {
  cleanCodeBlock,
  cleanHeading,
  cleanListItems,
  cleanParagraph,
  removeInlineTimestamps,
} from '../utils/content-cleaner.js';
import { truncateHtml } from '../utils/html-truncator.js';
import { sanitizeText } from '../utils/sanitizer.js';

import { logWarn } from './logger.js';

export function detectLanguageFromCode(code: string): string | undefined {
  // Common language patterns for code block detection
  const patterns: readonly [RegExp, string][] = [
    [
      /^\s*import\s+.*\s+from\s+['"]react['"]|<[A-Z][a-zA-Z]*[\s/>]|jsx\s*:|className=/m,
      'jsx',
    ],
    [
      /:\s*(string|number|boolean|void|any|unknown|never)\b|interface\s+\w+|type\s+\w+\s*=/m,
      'typescript',
    ],
    [/^\s*(fn|let\s+mut|impl|struct|enum|use\s+\w+::)/m, 'rust'],
    [
      /^\s*(export|const|let|var|function|class|async|await)\b|^\s*import\s+.*['"]]/m,
      'javascript',
    ],
    [/^\s*(def|class|import|from|if __name__|print\()/m, 'python'],
    [
      /^\s*(npm|yarn|pnpm|npx|brew|apt|pip|cargo|go )\s+(install|add|run|build|start)/m,
      'bash',
    ],
    [/^\s*[$#]\s+\w+|^\s*#!|^\s*(sudo|chmod|mkdir|cd|ls|cat|echo)\s+/m, 'bash'],
    [/^\s*[.#@]?[\w-]+\s*\{[^}]*\}|@media|@import|@keyframes/m, 'css'],
    [/^\s*<(!DOCTYPE|html|head|body|div|span|p|a|script|style)\b/im, 'html'],
    [/^\s*\{\s*"|^\s*\[\s*("|\d|true|false|null)/m, 'json'],
    [/^\s*[\w-]+:\s*.+$/m, 'yaml'],
    [/^\s*(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\s+/im, 'sql'],
    [/^\s*(func|package|import\s+")/m, 'go'],
  ];
  return patterns.find(([pattern]) => pattern.test(code))?.[1];
}
const CONTENT_SELECTOR =
  'h1, h2, h3, h4, h5, h6, p, ul, ol, pre, code:not(pre code), table, img, blockquote';
function parseHeading($: CheerioAPI, element: Element): HeadingBlock | null {
  const rawText = sanitizeText($(element).text());
  const text = cleanHeading(rawText);
  if (!text) return null;

  return {
    type: 'heading',
    level: parseInt(element.tagName.substring(1), 10),
    text,
  };
}
function parseParagraph(
  $: CheerioAPI,
  element: Element
): ParagraphBlock | null {
  let rawText = sanitizeText($(element).text());
  // Remove inline timestamps like "13 days ago" from paragraphs
  rawText = removeInlineTimestamps(rawText);
  const text = cleanParagraph(rawText);
  if (!text || text.length < config.extraction.minParagraphLength) return null;

  return { type: 'paragraph', text };
}
function parseList($: CheerioAPI, element: Element): ListBlock | null {
  const rawItems: string[] = [];
  $(element)
    .find('li')
    .each((_, li) => {
      const text = sanitizeText($(li).text());
      if (text) rawItems.push(text);
    });

  // Clean list items to remove noise
  const items = cleanListItems(rawItems);
  if (items.length === 0) return null;

  return {
    type: 'list',
    ordered: element.tagName.toLowerCase() === 'ol',
    items,
  };
}

function parseCode($: CheerioAPI, element: Element): CodeBlock | null {
  const rawText = $(element).text().trim();
  const text = cleanCodeBlock(rawText);
  if (!text) return null;

  // Try to get language from class attribute first
  const className = $(element).attr('class') ?? '';
  const dataLang = $(element).attr('data-language') ?? '';

  const languageMatch =
    /language-(\w+)/.exec(className) ??
    /lang-(\w+)/.exec(className) ??
    /highlight-(\w+)/.exec(className) ??
    /^(\w+)$/.exec(dataLang);

  const language = languageMatch?.[1] ?? detectLanguageFromCode(text);

  return {
    type: 'code',
    language,
    text,
  };
}

function parseTable($: CheerioAPI, element: Element): TableBlock | null {
  const headers: string[] = [];
  const rows: string[][] = [];
  const $table = $(element);

  $table.find('thead th, thead td').each((_, cell) => {
    headers.push(sanitizeText($(cell).text()));
  });

  if (headers.length === 0) {
    $table
      .find('tr')
      .first()
      .find('th, td')
      .each((_, cell) => {
        headers.push(sanitizeText($(cell).text()));
      });
  }

  const rowsSelector =
    headers.length > 0 ? 'tbody tr, tr:not(:first)' : 'tbody tr, tr';

  $table.find(rowsSelector).each((_, row) => {
    const cells: string[] = [];
    $(row)
      .find('td, th')
      .each((_, cell) => {
        cells.push(sanitizeText($(cell).text()));
      });
    if (cells.length > 0) rows.push(cells);
  });

  if (rows.length === 0) return null;

  return {
    type: 'table',
    headers: headers.length > 0 ? headers : undefined,
    rows,
  };
}

function parseImage($: CheerioAPI, element: Element): ImageBlock | null {
  const src = $(element).attr('src');
  if (!src) return null;

  return {
    type: 'image',
    src,
    alt: $(element).attr('alt') ?? undefined,
  };
}

function parseBlockquote(
  $: CheerioAPI,
  element: Element
): BlockquoteBlock | null {
  const rawText = sanitizeText($(element).text());
  const text = cleanParagraph(rawText);
  if (!text || text.length < config.extraction.minParagraphLength) return null;

  return { type: 'blockquote', text };
}

const ELEMENT_PARSERS = {
  h1: parseHeading,
  h2: parseHeading,
  h3: parseHeading,
  h4: parseHeading,
  h5: parseHeading,
  h6: parseHeading,
  p: parseParagraph,
  ul: parseList,
  ol: parseList,
  pre: parseCode,
  code: parseCode,
  table: parseTable,
  img: parseImage,
  blockquote: parseBlockquote,
} as const satisfies Record<
  string,
  ($: CheerioAPI, element: Element) => ContentBlockUnion | null
>;

function isParseableTag(tag: string): tag is ParseableTagName {
  return tag in ELEMENT_PARSERS;
}

function parseElement($: CheerioAPI, node: AnyNode): ContentBlockUnion | null {
  if (!('tagName' in node) || typeof node.tagName !== 'string') return null;

  const tagName = node.tagName.toLowerCase();
  if (!isParseableTag(tagName)) return null;
  return ELEMENT_PARSERS[tagName]($, node);
}

function filterBlocks(blocks: ContentBlockUnion[]): ContentBlockUnion[] {
  return blocks.filter(shouldIncludeBlock);
}

const TEXT_BLOCK_TYPES = new Set([
  'paragraph',
  'heading',
  'code',
  'blockquote',
]);

function isTextBlock(
  block: ContentBlockUnion
): block is ParagraphBlock | HeadingBlock | CodeBlock | BlockquoteBlock {
  return TEXT_BLOCK_TYPES.has(block.type);
}

function shouldIncludeBlock(block: ContentBlockUnion): boolean {
  if (isTextBlock(block)) {
    return block.text.length > 0;
  }
  if (block.type === 'list') {
    return block.items.length > 0;
  }
  return true;
}

function loadHtml(html: string): CheerioAPI | null {
  try {
    return cheerio.load(html);
  } catch (error) {
    logWarn('Failed to parse HTML', {
      error: error instanceof Error ? error.message : 'Unknown error',
      htmlLength: html.length,
    });
    return null;
  }
}

function removeNoiseElements($: CheerioAPI): void {
  $('script, style, noscript, iframe, svg').remove();
}

function collectBlocks($: CheerioAPI): ContentBlockUnion[] {
  const blocks: ContentBlockUnion[] = [];

  $('body')
    .find(CONTENT_SELECTOR)
    .each((_, element) => {
      const block = safeParseElement($, element);
      if (block) blocks.push(block);
    });

  return blocks;
}

function safeParseElement(
  $: CheerioAPI,
  element: AnyNode
): ContentBlockUnion | null {
  try {
    return parseElement($, element);
  } catch {
    return null;
  }
}

export function parseHtml(html: string): ContentBlockUnion[] {
  if (!html || typeof html !== 'string') return [];

  const processedHtml = truncateHtml(html);
  const $ = loadHtml(processedHtml);
  if (!$) return [];

  removeNoiseElements($);
  return filterBlocks(collectBlocks($));
}
