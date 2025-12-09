import * as cheerio from 'cheerio';
import type { CheerioAPI } from 'cheerio';
import type { AnyNode, Element } from 'domhandler';
import { sanitizeText } from '../utils/sanitizer.js';
import { config } from '../config/index.js';
import type {
  HeadingBlock,
  ParagraphBlock,
  ListBlock,
  CodeBlock,
  TableBlock,
  ImageBlock,
  ContentBlockUnion,
} from '../types/index.js';

function parseHeading($: CheerioAPI, element: Element): HeadingBlock | null {
  const text = sanitizeText($(element).text());
  if (!text) return null;

  return {
    type: 'heading',
    level: parseInt(element.tagName.substring(1), 10),
    text,
  };
}

function parseParagraph($: CheerioAPI, element: Element): ParagraphBlock | null {
  const text = sanitizeText($(element).text());
  if (!text || text.length < config.extraction.minParagraphLength) return null;

  return { type: 'paragraph', text };
}

function parseList($: CheerioAPI, element: Element): ListBlock | null {
  const items: string[] = [];
  $(element)
    .find('li')
    .each((_, li) => {
      const text = sanitizeText($(li).text());
      if (text) items.push(text);
    });

  if (items.length === 0) return null;

  return {
    type: 'list',
    ordered: element.tagName.toLowerCase() === 'ol',
    items,
  };
}

function parseCode($: CheerioAPI, element: Element): CodeBlock | null {
  const text = $(element).text().trim();
  if (!text) return null;

  const className = $(element).attr('class') || '';
  const languageMatch = className.match(/language-(\w+)/);

  return {
    type: 'code',
    language: languageMatch?.[1],
    text,
  };
}

function parseTable($: CheerioAPI, element: Element): TableBlock | null {
  const headers: string[] = [];
  const rows: string[][] = [];
  const $table = $(element);

  // Extract headers from thead or first row
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

  // Extract body rows
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
    alt: $(element).attr('alt') || undefined,
  };
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
} as const satisfies Record<
  string,
  ($: CheerioAPI, element: Element) => ContentBlockUnion | null
>;

type ParseableTagName = keyof typeof ELEMENT_PARSERS;

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
        return block.text.length > 0;
      case 'list':
        return block.items.length > 0;
      default:
        return true;
    }
  });
}

/**
 * Parses HTML content and extracts semantic blocks
 */
export function parseHtml(html: string): ContentBlockUnion[] {
  const $ = cheerio.load(html);
  const blocks: ContentBlockUnion[] = [];

  $('script, style, noscript, iframe, svg').remove();

  $('body')
    .find('h1, h2, h3, h4, h5, h6, p, ul, ol, pre, code, table, img')
    .each((_, element) => {
      const block = parseElement($, element);
      if (block) blocks.push(block);
    });

  return filterBlocks(blocks);
}
