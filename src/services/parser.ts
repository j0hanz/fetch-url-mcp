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
import { detectLanguage } from '../utils/language-detector.js';
import { sanitizeText } from '../utils/sanitizer.js';

import { logWarn } from './logger.js';

const MAX_HTML_SIZE = 10 * 1024 * 1024;

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
  const listItems = $(element).find('li').toArray();
  const rawItems: string[] = [];

  // Use for...of instead of .each() to avoid callback overhead
  for (const li of listItems) {
    const text = sanitizeText($(li).text());
    if (text) rawItems.push(text);
  }

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

  // Use detected language from class, or try to detect from content
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

  // Use toArray() + for...of instead of .each() callbacks
  const headerCells = $table.find('thead th, thead td').toArray();
  for (const cell of headerCells) {
    headers.push(sanitizeText($(cell).text()));
  }

  if (headers.length === 0) {
    const firstRowCells = $table.find('tr').first().find('th, td').toArray();
    for (const cell of firstRowCells) {
      headers.push(sanitizeText($(cell).text()));
    }
  }

  const rowsSelector =
    headers.length > 0 ? 'tbody tr, tr:not(:first)' : 'tbody tr, tr';
  const tableRows = $table.find(rowsSelector).toArray();

  for (const row of tableRows) {
    const rowCells = $(row).find('td, th').toArray();
    const cells: string[] = [];
    for (const cell of rowCells) {
      cells.push(sanitizeText($(cell).text()));
    }
    if (cells.length > 0) rows.push(cells);
  }

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

  let processedHtml = html;
  if (html.length > MAX_HTML_SIZE) {
    logWarn('HTML content exceeds maximum size, truncating at safe boundary', {
      size: html.length,
      maxSize: MAX_HTML_SIZE,
    });

    // Truncate at last complete tag boundary to avoid malformed HTML
    let safeLength = MAX_HTML_SIZE;
    while (safeLength > 0 && html[safeLength] !== '>') {
      safeLength--;
    }

    processedHtml = html.substring(0, safeLength + 1);

    // If we had to truncate too much, fall back to simple truncation
    if (processedHtml.length < MAX_HTML_SIZE * 0.5) {
      processedHtml = html.substring(0, MAX_HTML_SIZE);
    }
  }

  try {
    const $ = cheerio.load(processedHtml);
    const blocks: ContentBlockUnion[] = [];

    $('script, style, noscript, iframe, svg').remove();

    // Use toArray() + for...of instead of .each() to avoid callback overhead
    const elements = $('body')
      .find(
        'h1, h2, h3, h4, h5, h6, p, ul, ol, pre, code:not(pre code), table, img, blockquote'
      )
      .toArray();

    for (const element of elements) {
      try {
        const block = parseElement($, element);
        if (block) blocks.push(block);
      } catch {
        // Skip element errors
      }
    }

    return filterBlocks(blocks);
  } catch (error) {
    logWarn('Failed to parse HTML', {
      error: error instanceof Error ? error.message : 'Unknown error',
      htmlLength: html.length,
    });
    return [];
  }
}
