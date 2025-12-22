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
  let match: RegExpExecArray | null;

  while ((match = headingRegex.exec(markdown)) !== null) {
    const hashMarks = match[1];
    const rawText = match[2];

    if (!hashMarks || !rawText) continue;

    const text = stripMarkdownLinks(rawText.trim());
    toc.push({
      level: hashMarks.length,
      text,
      slug: slugify(rawText),
    });
  }

  return toc;
}
