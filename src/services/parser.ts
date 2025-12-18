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
import { detectLanguage } from '../utils/language-detector.js';
import { sanitizeText } from '../utils/sanitizer.js';

import { logWarn } from './logger.js';

// Cache selector for performance
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

  // Direct .each() iteration - no array allocation overhead
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

  // Check multiple possible class patterns for language
  const languageMatch =
    /language-(\w+)/.exec(className) ??
    /lang-(\w+)/.exec(className) ??
    /highlight-(\w+)/.exec(className) ??
    /^(\w+)$/.exec(dataLang);

  // Use detected language from class, or detect from content using utility
  const language = languageMatch?.[1] ?? detectLanguage(text);

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

  // Direct .each() iteration - no array allocation
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
  return blocks.filter((block) => {
    switch (block.type) {
      case 'paragraph':
      case 'heading':
      case 'code':
      case 'blockquote':
        return block.text.length > 0;
      case 'list':
        return block.items.length > 0;
      default:
        return true;
    }
  });
}

export function parseHtml(html: string): ContentBlockUnion[] {
  if (!html || typeof html !== 'string') return [];

  const processedHtml = truncateHtml(html);

  try {
    const $ = cheerio.load(processedHtml);
    const blocks: ContentBlockUnion[] = [];

    $('script, style, noscript, iframe, svg').remove();

    // Direct .each() iteration - no array allocation overhead
    $('body')
      .find(CONTENT_SELECTOR)
      .each((_, element) => {
        try {
          const block = parseElement($, element);
          if (block) blocks.push(block);
        } catch {
          // Ignore individual element parsing errors
        }
      });

    return filterBlocks(blocks);
  } catch (error) {
    logWarn('Failed to parse HTML', {
      error: error instanceof Error ? error.message : 'Unknown error',
      htmlLength: html.length,
    });
    return [];
  }
}
