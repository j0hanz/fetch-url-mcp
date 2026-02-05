import { config } from './config.js';
import type { MetadataBlock } from './transform-types.js';

const MAX_LINE_LENGTH = 80;

const REGEX = {
  HEADING_MARKER: /^#{1,6}\s/m,
  HEADING_STRICT: /^#{1,6}\s+/m,
  EMPTY_HEADING: /^#{1,6}[ \t\u00A0]*$\r?\n?/gm,

  FENCE_START: /^(\s*)(`{3,}|~{3,})/,

  LIST_MARKER: /^(?:[-*+])\s/m,
  TOC_LINK: /^- \[[^\]]+\]\(#[^)]+\)\s*$/,

  HTML_DOC_START: /^(<!doctype|<html)/i,
  COMMON_TAGS: /<(html|head|body|div|span|script|style|meta|link)\b/gi,
  ZERO_WIDTH_ANCHOR: /\[(?:\s|\u200B)*\]\(#[^)]*\)[ \t]*/g,
  SKIP_LINKS: /^\[Skip to (?:main )?(?:content|navigation)\]\(#[^)]*\)\s*$/gim,
  SKIP_LINK_SIMPLE: /^\[Skip link\]\(#[^)]*\)\s*$/gim,
  HELPFUL_PROMPT: /^Was this page helpful\??\s*$/gim,

  // Split `key: "value"next_key:` properties
  CONCATENATED_PROPS:
    /([a-z_][a-z0-9_]{0,30}\??:\s+)([\u0022\u201C][^\u0022\u201C\u201D]*[\u0022\u201D])([a-z_][a-z0-9_]{0,30}\??:)/g,

  DOUBLE_NEWLINE_REDUCER: /\n{3,}/g,
} as const;

const HEADING_KEYWORDS = new Set([
  'overview',
  'introduction',
  'summary',
  'conclusion',
  'prerequisites',
  'requirements',
  'installation',
  'configuration',
  'usage',
  'features',
  'limitations',
  'troubleshooting',
  'faq',
  'resources',
  'references',
  'changelog',
  'license',
  'acknowledgments',
  'appendix',
]);

const SPECIAL_PREFIXES =
  /^(?:example|note|tip|warning|important|caution):\s+\S/i;

interface Segment {
  content: string;
  isFence: boolean;
}

interface FrontmatterData {
  fence: string;
  lines: string[];
  endIndex: number;
  lineEnding: '\n' | '\r\n';
}

function splitByFences(content: string): Segment[] {
  const lines = content.split('\n');
  const segments: Segment[] = [];

  let currentBuffer: string[] = [];
  let inFence = false;
  let fenceMarker = '';

  const flush = (isFenceSegment: boolean): void => {
    if (currentBuffer.length > 0) {
      segments.push({
        content: currentBuffer.join('\n'),
        isFence: isFenceSegment,
      });
      currentBuffer = [];
    }
  };

  for (const line of lines) {
    const trimmed = line.trimStart();

    if (inFence) {
      const isClosure =
        trimmed.startsWith(fenceMarker) &&
        trimmed.slice(fenceMarker.length).trim() === '';

      currentBuffer.push(line);

      if (isClosure) {
        flush(true);
        inFence = false;
        fenceMarker = '';
      }
      continue;
    }

    const match = REGEX.FENCE_START.exec(line);
    if (match) {
      flush(false);
      inFence = true;
      fenceMarker = match[2] ?? '```';
      currentBuffer.push(line);
      continue;
    }

    currentBuffer.push(line);
  }

  flush(inFence); // Treat unclosed fence as a fence segment
  return segments;
}

const HeadingHeuristics = {
  isTooLong: (line: string) => line.length > MAX_LINE_LENGTH,
  hasExistingMarkup: (line: string) =>
    REGEX.HEADING_MARKER.test(line) ||
    REGEX.LIST_MARKER.test(line) ||
    /^\d+\.\s/.test(line) ||
    /[.!?]$/.test(line) ||
    /^\[.*\]\(.*\)$/.test(line),

  isSpecialPrefix: (line: string) => SPECIAL_PREFIXES.test(line),

  isTitleCaseOrKeyword: (trimmed: string) => {
    const words = trimmed.split(/\s+/);
    if (words.length === 1) {
      return (
        /^[A-Z]/.test(trimmed) && HEADING_KEYWORDS.has(trimmed.toLowerCase())
      );
    }
    if (words.length >= 2 && words.length <= 6) {
      return words.every(
        (w) =>
          /^[A-Z][a-z]*$/.test(w) || /^(?:and|or|the|of|in|for|to|a)$/i.test(w)
      );
    }
    return false;
  },
};

function getHeadingPrefix(trimmed: string): string | null {
  if (HeadingHeuristics.isTooLong(trimmed)) return null;
  if (HeadingHeuristics.hasExistingMarkup(trimmed)) return null;

  if (HeadingHeuristics.isSpecialPrefix(trimmed)) {
    return /^example:\s/i.test(trimmed) ? '### ' : '## ';
  }

  if (HeadingHeuristics.isTitleCaseOrKeyword(trimmed)) {
    return '## ';
  }

  return null;
}

function promoteOrphanHeadings(segmentText: string): string {
  if (!segmentText) return '';
  const lines = segmentText.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const trimmed = line.trim();
    if (!trimmed) continue;

    const prevLine = i > 0 ? (lines[i - 1] ?? '') : '';
    const isOrphan = i === 0 || prevLine.trim() === '';

    if (!isOrphan) continue;

    const prefix = getHeadingPrefix(trimmed);
    if (prefix) {
      lines[i] = `${prefix}${trimmed}`;
    }
  }

  return lines.join('\n');
}

function removeEmptyHeadings(text: string): string {
  return text.replace(REGEX.EMPTY_HEADING, '');
}

// Normalize spacing around headings (skip fences)
function fixAndSpaceHeadings(text: string): string {
  let current = text;

  current = current.replace(/(^#{1,6}\s[^\n]*)\n([^\n])/gm, '$1\n\n$2');

  current = current.replace(/(^#{1,6}\s+\w+)```/gm, '$1\n\n```');

  current = current.replace(/(^#{1,6}\s+\w*[A-Z])([A-Z][a-z])/gm, '$1\n\n$2');
  return current;
}

function removeSkipLinks(text: string): string {
  return text
    .replace(REGEX.ZERO_WIDTH_ANCHOR, '')
    .replace(REGEX.SKIP_LINKS, '')
    .replace(REGEX.SKIP_LINK_SIMPLE, '');
}

function removeToc(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let skipping = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const isToc = REGEX.TOC_LINK.test(line);
    const isEmpty = line.trim() === '';

    const prevIsToc =
      i > 0 &&
      (REGEX.TOC_LINK.test(lines[i - 1] ?? '') || lines[i - 1]?.trim() === '');
    const nextIsToc =
      i < lines.length - 1 &&
      (REGEX.TOC_LINK.test(lines[i + 1] ?? '') || lines[i + 1]?.trim() === '');

    if (isToc && (prevIsToc || nextIsToc)) {
      skipping = true;
      continue;
    }

    if (skipping) {
      if (isEmpty) skipping = false;
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}

function normalizeSpacing(text: string): string {
  return text
    .replace(/\]\(([^)]+)\)\[/g, ']($1)\n\n[') // Space between adjacent links
    .replace(REGEX.HELPFUL_PROMPT, '')
    .replace(/(`[^`]+`)\s*\\-\s*/g, '$1 - ') // Fix escaped hyphens after code
    .replace(/\\([[]])/g, '$1') // Unescape brackets
    .replace(/([^\n])\n([-*+] )/g, '$1\n\n$2') // Ensure lists start on new paragraph
    .replace(/(\S)\n(\d+\. )/g, '$1\n\n$2') // Ensure numbered lists start on new paragraph
    .replace(REGEX.DOUBLE_NEWLINE_REDUCER, '\n\n');
}

// Split concatenated properties (best-effort)
function fixProperties(text: string): string {
  let current = text;
  for (let i = 0; i < 3; i++) {
    const next = current.replace(REGEX.CONCATENATED_PROPS, '$1$2\n\n$3');
    if (next === current) break;
    current = next;
  }
  return current;
}

const CLEANUP_PIPELINE = [
  promoteOrphanHeadings,
  fixAndSpaceHeadings,
  removeEmptyHeadings,
  removeSkipLinks,
  removeToc,
  normalizeSpacing,
  fixProperties,
] as const;

const Frontmatter = {
  detect(content: string): FrontmatterData | null {
    const lineEnding = content.includes('\r\n') ? '\r\n' : '\n';
    if (!content.startsWith(`---${lineEnding}`)) return null;

    const endIndex = content.indexOf(`---${lineEnding}`, 3);
    if (endIndex === -1) return null;

    return {
      fence: `---${lineEnding}`,
      lines: content.slice(0, endIndex).split(lineEnding),
      endIndex: endIndex + `---${lineEnding}`.length,
      lineEnding,
    };
  },

  parseEntry(line: string): { key: string; value: string } | null {
    const trimmed = line.trim();
    const idx = trimmed.indexOf(':');
    if (!trimmed || idx <= 0) return null;

    return {
      key: trimmed.slice(0, idx).trim().toLowerCase(),
      value: trimmed.slice(idx + 1).trim(),
    };
  },

  stripQuotes(val: string): string {
    const first = val.charAt(0);
    const last = val.charAt(val.length - 1);
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return val.slice(1, -1).trim();
    }
    return val;
  },
};

export function cleanupMarkdownArtifacts(content: string): string {
  if (!content) return '';

  const segments = splitByFences(content);

  const processedSegments = segments.map((seg) => {
    if (seg.isFence) return seg.content;

    return CLEANUP_PIPELINE.reduce((text, step) => step(text), seg.content);
  });

  return processedSegments.join('\n').trim();
}

export function extractTitleFromRawMarkdown(
  content: string
): string | undefined {
  const fmTitle = extractTitleFromFrontmatter(content);
  if (fmTitle) return fmTitle;

  return extractTitleFromBody(content);
}

function extractTitleFromFrontmatter(content: string): string | undefined {
  const fm = Frontmatter.detect(content);
  if (!fm) return undefined;

  for (const line of fm.lines) {
    const entry = Frontmatter.parseEntry(line);
    if (entry && (entry.key === 'title' || entry.key === 'name')) {
      const cleaned = Frontmatter.stripQuotes(entry.value);
      if (cleaned) return cleaned;
    }
  }
  return undefined;
}

function extractTitleFromBody(content: string): string | undefined {
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const match = REGEX.HEADING_STRICT.exec(trimmed);
    if (match) {
      return trimmed.replace(REGEX.HEADING_MARKER, '').trim() || undefined;
    }

    return undefined; // First non-empty line decides
  }
  return undefined;
}

// Add source to frontmatter or body (based on config)
export function addSourceToMarkdown(content: string, url: string): string {
  const fm = Frontmatter.detect(content);
  const useMarkdownFormat = config.transform.metadataFormat === 'markdown';

  const injectBody = (): string => {
    const lineEnding = content.includes('\r\n') ? '\r\n' : '\n';
    const lines = content.split(lineEnding);

    const idx = lines.findIndex((l) => l.trim().length > 0);
    const targetLine = lines[idx] ?? '';
    if (idx !== -1 && REGEX.HEADING_MARKER.test(targetLine.trim())) {
      lines.splice(idx + 1, 0, '', `Source: ${url}`, '');
    } else {
      lines.unshift(`Source: ${url}`, '');
    }
    return lines.join(lineEnding);
  };

  if (useMarkdownFormat && !fm) {
    if (/^source:\s/im.test(content)) return content;
    return injectBody();
  }

  if (!fm) {
    const lineEnding = content.includes('\r\n') ? '\r\n' : '\n';
    return `---${lineEnding}source: "${url}"${lineEnding}---${lineEnding}${lineEnding}${content}`;
  }

  const fmBody = content.slice(fm.fence.length, fm.endIndex - fm.fence.length);
  if (/^source:\s/im.test(fmBody)) return content;

  const injection = `source: "${url}"${fm.lineEnding}`;
  const closeFenceIndex = content.indexOf(`---${fm.lineEnding}`, 3);

  return (
    content.slice(0, closeFenceIndex) +
    injection +
    content.slice(closeFenceIndex)
  );
}

export function isRawTextContent(content: string): boolean {
  const trimmed = content.trim();
  if (REGEX.HTML_DOC_START.test(trimmed)) return false;

  const hasFm = Frontmatter.detect(trimmed) !== null;
  const tagCount = Array.from(content.matchAll(REGEX.COMMON_TAGS)).length;

  if (hasFm) return true;
  if (tagCount > 2) return false;

  return (
    REGEX.HEADING_MARKER.test(content) ||
    REGEX.LIST_MARKER.test(content) ||
    content.includes('```')
  );
}

export function isLikelyHtmlContent(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed) return false;
  if (REGEX.HTML_DOC_START.test(trimmed)) return true;
  const tagCount = Array.from(content.matchAll(REGEX.COMMON_TAGS)).length;
  return tagCount > 2;
}

export function buildMetadataFooter(
  metadata?: MetadataBlock,
  fallbackUrl?: string
): string {
  if (!metadata) return '';

  const lines: string[] = ['---', ''];
  const url = metadata.url || fallbackUrl;
  const parts: string[] = [];

  if (metadata.title) parts.push(`_${metadata.title}_`);
  if (metadata.author) parts.push(`_${metadata.author}_`);
  if (url) parts.push(`[_Original Source_](${url})`);

  if (metadata.fetchedAt) {
    try {
      const date = new Date(metadata.fetchedAt);
      const str = `${String(date.getDate()).padStart(2, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${date.getFullYear()}`;
      parts.push(`_${str}_`);
    } catch {
      parts.push(`_${metadata.fetchedAt}_`);
    }
  }

  if (parts.length > 0) lines.push(` ${parts.join(' | ')}`);
  if (metadata.description) lines.push(` <sub>${metadata.description}</sub>`);

  return lines.join('\n');
}
