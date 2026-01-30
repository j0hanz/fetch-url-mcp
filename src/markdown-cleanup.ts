import { config } from './config.js';
import type { MetadataBlock } from './transform-types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Fence state helpers
// ─────────────────────────────────────────────────────────────────────────────

function isFenceStart(line: string): boolean {
  const trimmed = line.trimStart();
  return trimmed.startsWith('```') || trimmed.startsWith('~~~');
}

function extractFenceMarker(line: string): string {
  const trimmed = line.trimStart();
  const match = /^(`{3,}|~{3,})/.exec(trimmed);
  return match?.[1] ?? '```';
}

function isFenceEnd(line: string, marker: string): boolean {
  const trimmed = line.trimStart();
  return (
    trimmed.startsWith(marker) && trimmed.slice(marker.length).trim() === ''
  );
}

interface FenceState {
  inFence: boolean;
  marker: string;
}

function initialFenceState(): FenceState {
  return { inFence: false, marker: '' };
}

function advanceFenceState(line: string, state: FenceState): void {
  if (!state.inFence && isFenceStart(line)) {
    state.inFence = true;
    state.marker = extractFenceMarker(line);
    return;
  }
  if (state.inFence && isFenceEnd(line, state.marker)) {
    state.inFence = false;
    state.marker = '';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Segment utilities
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Split markdown into segments where each segment is either fully inside
 * a fenced block (including the fence lines), or fully outside.
 */
function splitByFences(
  content: string
): { content: string; inFence: boolean }[] {
  const lines = content.split('\n');
  const segments: { content: string; inFence: boolean }[] = [];
  const state = initialFenceState();

  let current: string[] = [];
  let currentIsFence = false;

  for (const line of lines) {
    // Transition into fence: flush outside segment first.
    if (!state.inFence && isFenceStart(line)) {
      if (current.length > 0) {
        segments.push({ content: current.join('\n'), inFence: currentIsFence });
        current = [];
      }
      currentIsFence = true;
      current.push(line);
      advanceFenceState(line, state);
      continue;
    }

    current.push(line);
    const wasInFence = state.inFence;
    advanceFenceState(line, state);

    // Transition out of fence: flush fence segment.
    if (wasInFence && !state.inFence) {
      segments.push({ content: current.join('\n'), inFence: true });
      current = [];
      currentIsFence = false;
    }
  }

  if (current.length > 0) {
    segments.push({ content: current.join('\n'), inFence: currentIsFence });
  }

  return segments;
}

// ─────────────────────────────────────────────────────────────────────────────
// Cleanup rules (OUTSIDE fences only)
// ─────────────────────────────────────────────────────────────────────────────

function removeEmptyHeadings(text: string): string {
  return text.replace(/^#{1,6}[ \t\u00A0]*$\r?\n?/gm, '');
}

function fixOrphanHeadings(text: string): string {
  // Pattern: hashes on their own line, blank line, then a "heading-like" line.
  return text.replace(
    /^(.*?)(#{1,6})\s*(?:\r?\n){2}([A-Z][^\r\n]+?)(?:\r?\n)/gm,
    (_match: string, prefix: string, hashes: string, heading: string) => {
      if (heading.length > 150) return _match;

      const trimmedPrefix = prefix.trim();
      if (trimmedPrefix === '') {
        return `${hashes} ${heading}\n\n`;
      }
      return `${trimmedPrefix}\n\n${hashes} ${heading}\n\n`;
    }
  );
}

function removeSkipLinksAndEmptyAnchors(text: string): string {
  const zeroWidthAnchorLink = /\[(?:\s|\u200B)*\]\(#[^)]*\)\s*/g;
  return text
    .replace(zeroWidthAnchorLink, '')
    .replace(/^\[Skip to (?:main )?content\]\(#[^)]*\)\s*$/gim, '')
    .replace(/^\[Skip to (?:main )?navigation\]\(#[^)]*\)\s*$/gim, '')
    .replace(/^\[Skip link\]\(#[^)]*\)\s*$/gim, '');
}

function ensureBlankLineAfterHeadings(text: string): string {
  // Heading followed immediately by a fence marker
  text = text.replace(/(^#{1,6}\s+\w+)```/gm, '$1\n\n```');

  // Heuristic: Some converters jam words together after a heading
  text = text.replace(/(^#{1,6}\s+\w*[A-Z])([A-Z][a-z])/gm, '$1\n\n$2');

  // Any heading line should be followed by a blank line before body
  return text.replace(/(^#{1,6}\s[^\n]*)\n([^\n])/gm, '$1\n\n$2');
}

/**
 * Remove markdown TOC blocks of the form:
 * - [Title](#anchor)
 * outside fenced code blocks.
 */
function removeTocBlocks(text: string): string {
  const tocLine = /^- \[[^\]]+\]\(#[^)]+\)\s*$/;
  const lines = text.split('\n');
  const out: string[] = [];

  let skipping = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const prev = i > 0 ? (lines[i - 1] ?? '') : '';
    const next = i < lines.length - 1 ? (lines[i + 1] ?? '') : '';

    if (tocLine.test(line)) {
      const prevIsToc = tocLine.test(prev) || prev.trim() === '';
      const nextIsToc = tocLine.test(next) || next.trim() === '';
      if (prevIsToc || nextIsToc) {
        skipping = true;
        continue;
      }
    }

    if (skipping) {
      if (line.trim() === '') {
        skipping = false;
      }
      continue;
    }

    out.push(line);
  }

  return out.join('\n');
}

function tidyLinksAndEscapes(text: string): string {
  return text
    .replace(/\]\(([^)]+)\)\[/g, ']($1)\n\n[')
    .replace(/^Was this page helpful\??\s*$/gim, '')
    .replace(/(`[^`]+`)\s*\\-\s*/g, '$1 - ')
    .replace(/\\([[]])/g, '$1');
}

function normalizeListsAndSpacing(text: string): string {
  // Ensure blank line before list starts (bullet/ordered)
  text = text.replace(/([^\n])\n([-*+] )/g, '$1\n\n$2');
  text = text.replace(/(\S)\n(\d+\. )/g, '$1\n\n$2');

  // Collapse excessive blank lines
  return text.replace(/\n{3,}/g, '\n\n');
}

function fixConcatenatedProperties(text: string): string {
  const quotedValuePattern =
    /([a-z_][a-z0-9_]{0,30}\??:\s+)([\u0022\u201C][^\u0022\u201C\u201D]*[\u0022\u201D])([a-z_][a-z0-9_]{0,30}\??:)/g;
  let result = text;
  let iterations = 0;
  const maxIterations = 3;

  while (iterations < maxIterations) {
    const before = result;
    result = result.replace(quotedValuePattern, '$1$2\n\n$3');

    if (result === before) {
      break;
    }
    iterations++;
  }

  return result;
}

const CLEANUP_STEPS: readonly ((text: string) => string)[] = [
  fixOrphanHeadings,
  removeEmptyHeadings,
  removeSkipLinksAndEmptyAnchors,
  ensureBlankLineAfterHeadings,
  removeTocBlocks,
  tidyLinksAndEscapes,
  normalizeListsAndSpacing,
  fixConcatenatedProperties,
];

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

function getLastLine(text: string): string {
  const index = text.lastIndexOf('\n');
  return index === -1 ? text : text.slice(index + 1);
}

export function cleanupMarkdownArtifacts(content: string): string {
  if (!content) return '';

  const segments = splitByFences(content);
  return segments
    .map((seg, index) => {
      if (seg.inFence) return seg.content;
      const prevSeg = segments[index - 1];
      const prevLineContext = prevSeg ? getLastLine(prevSeg.content) : '';
      const lines = seg.content.split('\n');
      const promotedLines: string[] = [];
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i] ?? '';
        const prevLine = i > 0 ? (lines[i - 1] ?? '') : prevLineContext;
        promotedLines.push(processNonFencedLine(line, prevLine));
      }
      const promoted = promotedLines.join('\n');
      return CLEANUP_STEPS.reduce((text, step) => step(text), promoted);
    })
    .join('\n')
    .trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// Raw markdown handling + metadata footer
// ─────────────────────────────────────────────────────────────────────────────

const HEADING_PATTERN = /^#{1,6}\s/m;
const LIST_PATTERN = /^(?:[-*+])\s/m;
const HTML_DOCUMENT_PATTERN = /^(<!doctype|<html)/i;

function containsMarkdownHeading(content: string): boolean {
  return HEADING_PATTERN.test(content);
}

function containsMarkdownList(content: string): boolean {
  return LIST_PATTERN.test(content);
}

function containsFencedCodeBlock(content: string): boolean {
  const first = content.indexOf('```');
  if (first === -1) return false;
  return content.includes('```', first + 3);
}

function looksLikeMarkdown(content: string): boolean {
  return (
    containsMarkdownHeading(content) ||
    containsMarkdownList(content) ||
    containsFencedCodeBlock(content)
  );
}

function detectLineEnding(content: string): '\n' | '\r\n' {
  return content.includes('\r\n') ? '\r\n' : '\n';
}

const FRONTMATTER_DELIMITER = '---';

function findFrontmatterLines(content: string): {
  lineEnding: '\n' | '\r\n';
  lines: string[];
  endIndex: number;
} | null {
  const lineEnding = detectLineEnding(content);
  const lines = content.split(lineEnding);
  if (lines[0] !== FRONTMATTER_DELIMITER) return null;
  const endIndex = lines.indexOf(FRONTMATTER_DELIMITER, 1);
  if (endIndex === -1) return null;
  return { lineEnding, lines, endIndex };
}

function stripOptionalQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 2) return trimmed;
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function parseFrontmatterEntry(
  line: string
): { key: string; value: string } | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const separatorIndex = trimmed.indexOf(':');
  if (separatorIndex <= 0) return null;
  const key = trimmed.slice(0, separatorIndex).trim().toLowerCase();
  const value = trimmed.slice(separatorIndex + 1);
  return { key, value };
}

function isTitleKey(key: string): boolean {
  return key === 'title' || key === 'name';
}

function extractTitleFromHeading(content: string): string | undefined {
  const lineEnding = detectLineEnding(content);
  const lines = content.split(lineEnding);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let index = 0;
    while (index < trimmed.length && trimmed[index] === '#') {
      index += 1;
    }

    if (index === 0 || index > 6) return undefined;
    const nextChar = trimmed[index];
    if (nextChar !== ' ' && nextChar !== '\t') return undefined;

    const heading = trimmed.slice(index).trim();
    return heading.length > 0 ? heading : undefined;
  }

  return undefined;
}

export function extractTitleFromRawMarkdown(
  content: string
): string | undefined {
  const frontmatter = findFrontmatterLines(content);
  if (!frontmatter) {
    return extractTitleFromHeading(content);
  }

  const { lines, endIndex } = frontmatter;
  const entry = lines
    .slice(1, endIndex)
    .map((line) => parseFrontmatterEntry(line))
    .find((parsed) => parsed !== null && isTitleKey(parsed.key));
  if (!entry) return undefined;
  const value = stripOptionalQuotes(entry.value);
  return value || undefined;
}

function hasMarkdownSourceLine(content: string): boolean {
  const lineEnding = detectLineEnding(content);
  const lines = content.split(lineEnding);

  const limit = Math.min(lines.length, 50);
  for (let index = 0; index < limit; index += 1) {
    const line = lines[index];
    if (!line) continue;
    if (line.trimStart().toLowerCase().startsWith('source:')) {
      return true;
    }
  }
  return false;
}

function addSourceToMarkdownMarkdownFormat(
  content: string,
  url: string
): string {
  if (hasMarkdownSourceLine(content)) return content;
  const lineEnding = detectLineEnding(content);
  const lines = content.split(lineEnding);

  const firstNonEmptyIndex = lines.findIndex((line) => line.trim().length > 0);
  if (firstNonEmptyIndex !== -1) {
    const firstLine = lines[firstNonEmptyIndex];
    if (firstLine && /^#{1,6}\s+/.test(firstLine.trim())) {
      const insertAt = firstNonEmptyIndex + 1;
      const updated = [
        ...lines.slice(0, insertAt),
        '',
        `Source: ${url}`,
        '',
        ...lines.slice(insertAt),
      ];
      return updated.join(lineEnding);
    }
  }

  return [`Source: ${url}`, '', content].join(lineEnding);
}

export function addSourceToMarkdown(content: string, url: string): string {
  const frontmatter = findFrontmatterLines(content);
  if (config.transform.metadataFormat === 'markdown' && !frontmatter) {
    return addSourceToMarkdownMarkdownFormat(content, url);
  }

  if (!frontmatter) {
    return `---\nsource: "${url}"\n---\n\n${content}`;
  }

  const { lineEnding, lines, endIndex } = frontmatter;
  const bodyLines = lines.slice(1, endIndex);
  const hasSource = bodyLines.some((line) =>
    line.trimStart().toLowerCase().startsWith('source:')
  );
  if (hasSource) return content;

  const updatedLines = [
    lines[0],
    ...bodyLines,
    `source: "${url}"`,
    ...lines.slice(endIndex),
  ];

  return updatedLines.join(lineEnding);
}

function hasFrontmatter(trimmed: string): boolean {
  return trimmed.startsWith('---\n') || trimmed.startsWith('---\r\n');
}

function looksLikeHtmlDocument(trimmed: string): boolean {
  return HTML_DOCUMENT_PATTERN.test(trimmed);
}

function countCommonHtmlTags(content: string): number {
  const matches =
    content.match(/<(html|head|body|div|span|script|style|meta|link)\b/gi) ??
    [];
  return matches.length;
}

export function isRawTextContent(content: string): boolean {
  const trimmed = content.trim();
  const isHtmlDocument = looksLikeHtmlDocument(trimmed);
  const hasMarkdownFrontmatter = hasFrontmatter(trimmed);
  const hasTooManyHtmlTags = countCommonHtmlTags(content) > 2;
  const isMarkdown = looksLikeMarkdown(content);

  return (
    !isHtmlDocument &&
    (hasMarkdownFrontmatter || (!hasTooManyHtmlTags && isMarkdown))
  );
}

export function isLikelyHtmlContent(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed) return false;
  if (looksLikeHtmlDocument(trimmed)) return true;
  return countCommonHtmlTags(content) > 2;
}

function formatFetchedDate(isoString: string): string {
  try {
    const date = new Date(isoString);
    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const year = date.getFullYear();
    return `${day}-${month}-${year}`;
  } catch {
    return isoString;
  }
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
    const formattedDate = formatFetchedDate(metadata.fetchedAt);
    parts.push(`_${formattedDate}_`);
  }

  if (parts.length > 0) {
    lines.push(` ${parts.join(' | ')}`);
  }

  if (metadata.description) {
    lines.push(` <sub>${metadata.description}</sub>`);
  }

  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Heading Promotion (fence-aware)
// ─────────────────────────────────────────────────────────────────────────────

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

function isLikelyHeadingLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed || trimmed.length > 80) return false;
  if (/^#{1,6}\s/.test(trimmed)) return false;
  if (/^[-*+•]\s/.test(trimmed) || /^\d+\.\s/.test(trimmed)) return false;
  if (/[.!?]$/.test(trimmed)) return false;
  if (/^\[.*\]\(.*\)$/.test(trimmed)) return false;

  if (/^(?:example|note|tip|warning|important|caution):\s+\S/i.test(trimmed)) {
    return true;
  }

  const words = trimmed.split(/\s+/);
  if (words.length >= 2 && words.length <= 6) {
    const isTitleCase = words.every(
      (w) =>
        /^[A-Z][a-z]*$/.test(w) || /^(?:and|or|the|of|in|for|to|a)$/i.test(w)
    );
    if (isTitleCase) return true;
  }

  if (words.length === 1) {
    const lower = trimmed.toLowerCase();
    if (HEADING_KEYWORDS.has(lower) && /^[A-Z]/.test(trimmed)) return true;
  }

  return false;
}

function shouldPromoteToHeading(line: string, prevLine: string): boolean {
  const isPrecededByBlank = prevLine.trim() === '';
  if (!isPrecededByBlank) return false;
  return isLikelyHeadingLine(line);
}

function formatAsHeading(line: string): string {
  const trimmed = line.trim();
  const isExample = /^example:\s/i.test(trimmed);
  const prefix = isExample ? '### ' : '## ';
  return prefix + trimmed;
}

function processNonFencedLine(line: string, prevLine: string): string {
  if (shouldPromoteToHeading(line, prevLine)) {
    return formatAsHeading(line);
  }
  return line;
}

/**
 * Promote standalone lines that look like headings to proper markdown headings.
 * Fence-aware: never modifies content inside fenced code blocks.
 */
export function promoteOrphanHeadings(markdown: string): string {
  if (!markdown) return '';

  const lines = markdown.split('\n');
  const result: string[] = [];
  const state = initialFenceState();

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const prevLine = i > 0 ? (lines[i - 1] ?? '') : '';

    if (state.inFence || isFenceStart(line)) {
      result.push(line);
      advanceFenceState(line, state);
      continue;
    }

    result.push(processNonFencedLine(line, prevLine));
  }

  return result.join('\n');
}
