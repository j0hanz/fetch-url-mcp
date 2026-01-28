/**
 * Markdown cleanup utilities for post-processing converted content.
 *
 * Goals:
 * - Never mutate fenced code blocks (``` / ~~~) content.
 * - Keep rules localized and readable.
 * - Avoid multi-pass regexes that accidentally hit code blocks.
 */

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

/**
 * Apply a transformation function only to non-fenced content.
 */
function mapOutsideFences(
  content: string,
  transform: (outside: string) => string
): string {
  const segments = splitByFences(content);
  return segments
    .map((seg) => (seg.inFence ? seg.content : transform(seg.content)))
    .join('\n');
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

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Clean up common markdown artifacts and formatting issues.
 * IMPORTANT: All rules are applied ONLY outside fenced code blocks.
 */
export function cleanupMarkdownArtifacts(content: string): string {
  if (!content) return '';

  const cleaned = mapOutsideFences(content, (outside) => {
    let text = outside;

    text = fixOrphanHeadings(text);
    text = removeEmptyHeadings(text);
    text = removeSkipLinksAndEmptyAnchors(text);
    text = ensureBlankLineAfterHeadings(text);
    text = removeTocBlocks(text);
    text = tidyLinksAndEscapes(text);
    text = normalizeListsAndSpacing(text);

    return text;
  });

  return cleaned.trim();
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
