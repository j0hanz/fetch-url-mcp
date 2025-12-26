import type { TocEntry } from '../../config/types.js';

import { stripMarkdownLinks } from '../../utils/content-cleaner.js';

function slugify(text: string): string {
  const cleanText = stripMarkdownLinks(text);

  return cleanText
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/--+/g, '-')
    .trim();
}

export function extractToc(markdown: string): TocEntry[] {
  const headingRegex = /^(#{1,6})\s+(.+)$/gm;
  const toc: TocEntry[] = [];

  for (const match of markdown.matchAll(headingRegex)) {
    const entry = buildTocEntry(match);
    if (entry) {
      toc.push(entry);
    }
  }

  return toc;
}

function buildTocEntry(match: RegExpExecArray): TocEntry | null {
  const hashMarks = match[1];
  const rawText = match[2];

  if (!hashMarks || !rawText) {
    return null;
  }

  const text = stripMarkdownLinks(rawText.trim());
  return {
    level: hashMarks.length,
    text,
    slug: slugify(rawText),
  };
}
