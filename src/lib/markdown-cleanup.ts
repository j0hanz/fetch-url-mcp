import type { MetadataBlock } from '../transform/types.js';
import { config } from './config.js';
import { FetchError } from './errors.js';

// --- Constants & Regex ---

const MAX_LINE_LENGTH = 80;

const REGEX = {
  HEADING_MARKER: /^#{1,6}\s/m,
  HEADING_STRICT: /^#{1,6}\s+/m,
  EMPTY_HEADING_LINE: /^#{1,6}[ \t\u00A0]*$/,
  FENCE_START: /^\s*(`{3,}|~{3,})/,
  LIST_MARKER: /^(?:[-*+])\s/m,
  TOC_LINK: /^- \[[^\]]+\]\(#[^)]+\)\s*$/,
  TOC_HEADING: /^(?:#{1,6}\s+)?(?:table of contents|contents)\s*$/i,
  HTML_DOC_START: /^(<!doctype|<html)/i,
  COMBINED_LINE_REMOVALS:
    /^(?:\[Skip to (?:main )?(?:content|navigation)\]\(#[^)]*\)|\[Skip link\]\(#[^)]*\)|Was this page helpful\??)\s*$/gim,
  ZERO_WIDTH_ANCHOR: /\[(?:\s|\u200B)*\]\(#[^)]*\)[ \t]*/g,
  CONCATENATED_PROPS:
    /([a-z_][a-z0-9_]{0,30}\??:\s+)([\u0022\u201C][^\u0022\u201C\u201D]*[\u0022\u201D])([a-z_][a-z0-9_]{0,30}\??:)/g,
  DOUBLE_NEWLINE_REDUCER: /\n{3,}/g,
  SOURCE_KEY: /^source:\s/im,
  HEADING_SPACING: /(^#{1,6}\s[^\n]*)\n([^\n])/gm,
  HEADING_CODE_BLOCK: /(^#{1,6}\s+\w+)```/gm,
  SPACING_LINK_FIX: /\]\(([^)]+)\)\[/g,
  SPACING_ADJ_COMBINED: /(?:\]\([^)]+\)|`[^`]+`)(?=[A-Za-z0-9])/g,
  SPACING_CODE_DASH: /(`[^`]+`)\s*\\-\s*/g,
  SPACING_ESCAPES: /\\([[\].])/g,
  SPACING_LIST_NUM_COMBINED:
    /^((?![-*+] |\d+\. |[ \t]).+)\n((?:[-*+]|\d+\.) )/gm,
  NESTED_LIST_INDENT: /^( +)((?:[-*+])|\d+\.)\s/gm,
  TYPEDOC_COMMENT: /(`+)(?:(?!\1)[\s\S])*?\1|\s?\/\\?\*[\s\S]*?\\?\*\//g,
} as const;

const HEADING_KEYWORDS = new Set(
  config.markdownCleanup.headingKeywords.map((value) =>
    value.toLocaleLowerCase(config.i18n.locale)
  )
);

const SPECIAL_PREFIXES =
  /^(?:example|note|tip|warning|important|caution):\s+\S/i;

const TOC_SCAN_LIMIT = 20;
const TOC_MAX_NON_EMPTY = 12;
const TOC_LINK_RATIO_THRESHOLD = 0.8;
const TYPEDOC_PREFIXES = [
  'Defined in:',
  'Returns:',
  'Since:',
  'See also:',
] as const;

interface CleanupOptions {
  signal?: AbortSignal;
  url?: string;
}

function throwIfAborted(
  signal: AbortSignal | undefined,
  url: string,
  stage: string
): void {
  if (!signal?.aborted) return;
  throw new FetchError('Request was canceled', url, 499, {
    reason: 'aborted',
    stage,
  });
}

function createAbortChecker(options?: CleanupOptions): (stage: string) => void {
  const signal = options?.signal;
  const url = options?.url ?? '';
  return (stage: string): void => {
    throwIfAborted(signal, url, stage);
  };
}

// --- Helper Functions ---

function getLineEnding(content: string): '\n' | '\r\n' {
  return content.includes('\r\n') ? '\r\n' : '\n';
}

function isBlank(line: string | undefined): boolean {
  return line === undefined || line.trim().length === 0;
}

function hasFollowingContent(lines: string[], startIndex: number): boolean {
  // Optimization: Bound lookahead to avoid checking too many lines in huge files
  for (
    let i = startIndex + 1;
    i < Math.min(lines.length, startIndex + 50);
    i++
  ) {
    if (!isBlank(lines[i])) return true;
  }
  return false;
}

// Optimized Heuristics
function isTitleCaseOrKeyword(trimmed: string): boolean {
  // Quick check for length to avoid regex on long strings
  if (trimmed.length > MAX_LINE_LENGTH) return false;

  // Single word optimization
  if (!trimmed.includes(' ')) {
    if (!/^[A-Z]/.test(trimmed)) return false;
    return HEADING_KEYWORDS.has(trimmed.toLocaleLowerCase(config.i18n.locale));
  }

  // Split limited number of words
  const words = trimmed.split(/\s+/);
  const len = words.length;
  if (len < 2 || len > 6) return false;

  let capitalizedCount = 0;
  for (let i = 0; i < len; i++) {
    const w = words[i];
    if (!w) continue;
    const isCap = /^[A-Z][a-z]*$/.test(w);
    if (isCap) capitalizedCount++;
    else if (!/^(?:and|or|the|of|in|for|to|a)$/i.test(w)) return false;
  }

  return capitalizedCount >= 2;
}

function getHeadingPrefix(trimmed: string): string | null {
  if (trimmed.length > MAX_LINE_LENGTH) return null;

  // Fast path: Check common markdown markers first
  const firstChar = trimmed.charCodeAt(0);
  // # (35), - (45), * (42), + (43), digit (48-57), [ (91)
  if (
    firstChar === 35 ||
    firstChar === 45 ||
    firstChar === 42 ||
    firstChar === 43 ||
    firstChar === 91 ||
    (firstChar >= 48 && firstChar <= 57)
  ) {
    if (
      REGEX.HEADING_MARKER.test(trimmed) ||
      REGEX.LIST_MARKER.test(trimmed) ||
      /^\d+\.\s/.test(trimmed) ||
      /^\[.*\]\(.*\)$/.test(trimmed)
    ) {
      return null;
    }
  }

  if (SPECIAL_PREFIXES.test(trimmed)) {
    return /^example:\s/i.test(trimmed) ? '### ' : '## ';
  }

  const lastChar = trimmed.charCodeAt(trimmed.length - 1);
  // . (46), ! (33), ? (63)
  if (lastChar === 46 || lastChar === 33 || lastChar === 63) return null;

  return isTitleCaseOrKeyword(trimmed) ? '## ' : null;
}

// Optimized TOC detection
function getTocBlockStats(
  lines: string[],
  headingIndex: number
): { total: number; linkCount: number; nonLinkCount: number } {
  let total = 0;
  let linkCount = 0;
  let nonLinkCount = 0;
  const lookaheadMax = Math.min(lines.length, headingIndex + TOC_SCAN_LIMIT);

  for (let i = headingIndex + 1; i < lookaheadMax; i++) {
    const line = lines[i];
    if (!line) continue;
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (REGEX.HEADING_MARKER.test(trimmed)) break;

    total += 1;
    if (REGEX.TOC_LINK.test(trimmed)) linkCount += 1;
    else nonLinkCount += 1;

    if (total >= TOC_MAX_NON_EMPTY) break;
  }

  return { total, linkCount, nonLinkCount };
}

function skipTocLines(lines: string[], startIndex: number): number {
  for (let i = startIndex; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (!REGEX.TOC_LINK.test(trimmed)) return i;
  }
  return lines.length;
}

function isTypeDocArtifactLine(line: string): boolean {
  const trimmed = line.trim();
  for (const prefix of TYPEDOC_PREFIXES) {
    if (!trimmed.startsWith(prefix)) continue;
    const rest = trimmed.slice(prefix.length).trimStart();
    if (!rest.startsWith('**`')) return false;
    return rest.includes('`**');
  }
  return false;
}

// --- Main Processing Logic ---

function tryPromoteOrphan(
  lines: string[],
  i: number,
  trimmed: string
): string | null {
  const prevLine = lines[i - 1];
  const isOrphan = i === 0 || !prevLine || prevLine.trim().length === 0;
  if (!isOrphan) return null;

  const prefix = getHeadingPrefix(trimmed);
  if (!prefix) return null;

  const isSpecialPrefix = SPECIAL_PREFIXES.test(trimmed);
  if (!isSpecialPrefix && !hasFollowingContent(lines, i)) return null;

  return `${prefix}${trimmed}`;
}

function shouldSkipAsToc(
  lines: string[],
  i: number,
  trimmed: string,
  removeToc: boolean,
  options?: CleanupOptions
): number | null {
  if (!removeToc || !REGEX.TOC_HEADING.test(trimmed)) return null;

  const { total, linkCount, nonLinkCount } = getTocBlockStats(lines, i);
  if (total === 0 || nonLinkCount > 0) return null;

  const ratio = linkCount / total;
  if (ratio <= TOC_LINK_RATIO_THRESHOLD) return null;

  throwIfAborted(options?.signal, options?.url ?? '', 'markdown:cleanup:toc');
  return skipTocLines(lines, i + 1);
}

function preprocessLines(lines: string[], options?: CleanupOptions): string {
  const processedLines: string[] = [];
  const len = lines.length;
  const promote = config.markdownCleanup.promoteOrphanHeadings;
  const removeToc = config.markdownCleanup.removeTocBlocks;
  const checkAbort = createAbortChecker(options);

  let skipUntil = -1;

  for (let i = 0; i < len; i++) {
    if (i < skipUntil) continue;

    let line = lines[i];
    if (line === undefined) continue;

    const trimmed = line.trim();
    if (REGEX.EMPTY_HEADING_LINE.test(trimmed)) continue;

    const tocSkip = shouldSkipAsToc(lines, i, trimmed, removeToc, options);
    if (tocSkip !== null) {
      skipUntil = tocSkip;
      continue;
    }

    if (promote && trimmed.length > 0) {
      checkAbort('markdown:cleanup:promote');
      const promoted = tryPromoteOrphan(lines, i, trimmed);
      if (promoted) line = promoted;
    }

    processedLines.push(line);
  }
  return processedLines.join('\n');
}

// Process a block of non-fence lines
function processTextBuffer(lines: string[], options?: CleanupOptions): string {
  if (lines.length === 0) return '';
  const text = preprocessLines(lines, options);
  return applyGlobalRegexes(text, options);
}

function applyGlobalRegexes(text: string, options?: CleanupOptions): string {
  let result = text;
  const checkAbort = createAbortChecker(options);

  checkAbort('markdown:cleanup:headings');

  // fixAndSpaceHeadings
  result = result
    .replace(REGEX.HEADING_SPACING, '$1\n\n$2')
    .replace(REGEX.HEADING_CODE_BLOCK, '$1\n\n```');

  if (config.markdownCleanup.removeTypeDocComments) {
    checkAbort('markdown:cleanup:typedoc');
    result = result
      .split('\n')
      .filter((line) => !isTypeDocArtifactLine(line))
      .join('\n');
    result = result.replace(REGEX.TYPEDOC_COMMENT, (match) =>
      match.startsWith('`') ? match : ''
    );
  }
  if (config.markdownCleanup.removeSkipLinks) {
    checkAbort('markdown:cleanup:skip-links');
    result = result
      .replace(REGEX.ZERO_WIDTH_ANCHOR, '')
      .replace(REGEX.COMBINED_LINE_REMOVALS, '');
  }

  checkAbort('markdown:cleanup:spacing');

  // normalizeSpacing
  result = result
    .replace(REGEX.SPACING_LINK_FIX, ']($1)\n\n[')
    .replace(REGEX.SPACING_ADJ_COMBINED, '$& ')
    .replace(REGEX.SPACING_CODE_DASH, '$1 - ')
    .replace(REGEX.SPACING_ESCAPES, '$1')
    .replace(REGEX.SPACING_LIST_NUM_COMBINED, '$1\n\n$2')
    .replace(REGEX.DOUBLE_NEWLINE_REDUCER, '\n\n');

  result = normalizeNestedListIndentation(result);

  checkAbort('markdown:cleanup:properties');

  // fixProperties
  for (let k = 0; k < 3; k++) {
    const next = result.replace(REGEX.CONCATENATED_PROPS, '$1$2\n\n$3');
    if (next === result) break;
    result = next;
  }

  return result;
}

function normalizeNestedListIndentation(text: string): string {
  return text.replace(
    REGEX.NESTED_LIST_INDENT,
    (match: string, spaces: string, marker: string): string => {
      const count = spaces.length;
      if (count < 2 || count % 2 !== 0) return match;
      const normalized = ' '.repeat((count / 2) * 4);
      return `${normalized}${marker} `;
    }
  );
}

export function cleanupMarkdownArtifacts(
  content: string,
  options?: CleanupOptions
): string {
  if (!content) return '';

  const checkAbort = createAbortChecker(options);
  checkAbort('markdown:cleanup:begin');

  const len = content.length;
  let lastIndex = 0;
  let fenceMarker: string | null = null;
  const segments: string[] = [];
  let buffer: string[] = [];

  while (lastIndex < len) {
    let nextIndex = content.indexOf('\n', lastIndex);
    let line: string;

    if (nextIndex === -1) {
      line = content.slice(lastIndex);
      nextIndex = len;
    } else {
      if (nextIndex > lastIndex && content.charCodeAt(nextIndex - 1) === 13) {
        line = content.slice(lastIndex, nextIndex - 1);
      } else {
        line = content.slice(lastIndex, nextIndex);
      }
      nextIndex++; // Skip \n
    }

    const trimmed = line.trimStart();

    if (fenceMarker) {
      segments.push(line);
      if (
        trimmed.startsWith(fenceMarker) &&
        trimmed.slice(fenceMarker.length).trim() === ''
      ) {
        fenceMarker = null;
      }
    } else {
      const match = REGEX.FENCE_START.exec(line);
      const newMarker = match ? (match[1] ?? '```') : null;
      if (!newMarker) {
        buffer.push(line);
      } else {
        if (buffer.length > 0) {
          segments.push(processTextBuffer(buffer, options));
          buffer = [];
        }
        segments.push(line);
        fenceMarker = newMarker;
      }
    }

    lastIndex = nextIndex;
  }

  if (buffer.length > 0) {
    segments.push(processTextBuffer(buffer, options));
  }

  return segments.join('\n').trim();
}

// --- Frontmatter & Metadata Utilities ---

interface FrontmatterRange {
  start: number;
  end: number;
  linesStart: number;
  linesEnd: number;
  lineEnding: '\n' | '\r\n';
}

function detectFrontmatter(content: string): FrontmatterRange | null {
  const len = content.length;
  if (len < 4) return null;

  let lineEnding: '\n' | '\r\n' | null = null;
  let fenceLen = 0;

  if (content.startsWith('---\n')) {
    lineEnding = '\n';
    fenceLen = 4;
  } else if (content.startsWith('---\r\n')) {
    lineEnding = '\r\n';
    fenceLen = 5;
  }

  if (!lineEnding) return null;

  const fence = `---${lineEnding}`;
  const closeIndex = content.indexOf(fence, fenceLen);

  if (closeIndex === -1) return null;

  return {
    start: 0,
    end: closeIndex + fenceLen,
    linesStart: fenceLen,
    linesEnd: closeIndex,
    lineEnding,
  };
}

function parseFrontmatterEntry(
  line: string
): { key: string; value: string } | null {
  const trimmed = line.trim();
  const idx = trimmed.indexOf(':');
  if (!trimmed || idx <= 0) return null;

  return {
    key: trimmed.slice(0, idx).trim().toLowerCase(),
    value: trimmed.slice(idx + 1).trim(),
  };
}

function stripFrontmatterQuotes(val: string): string {
  const first = val.charAt(0);
  const last = val.charAt(val.length - 1);

  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return val.slice(1, -1).trim();
  }
  return val;
}

function scanFrontmatterForTitle(
  content: string,
  fm: FrontmatterRange
): string | undefined {
  const fmBody = content.slice(fm.linesStart, fm.linesEnd);
  let lastIdx = 0;
  while (lastIdx < fmBody.length) {
    let nextIdx = fmBody.indexOf(fm.lineEnding, lastIdx);
    if (nextIdx === -1) nextIdx = fmBody.length;

    const line = fmBody.slice(lastIdx, nextIdx);
    const entry = parseFrontmatterEntry(line);

    if (entry) {
      if (entry.key === 'title' || entry.key === 'name') {
        const cleaned = stripFrontmatterQuotes(entry.value);
        if (cleaned) return cleaned;
      }
    }
    lastIdx = nextIdx + fm.lineEnding.length;
  }
  return undefined;
}

function scanBodyForTitle(content: string): string | undefined {
  const len = content.length;
  let scanIndex = 0;
  const LIMIT = 5000;
  const maxScan = Math.min(len, LIMIT);

  while (scanIndex < maxScan) {
    let nextIndex = content.indexOf('\n', scanIndex);
    if (nextIndex === -1) nextIndex = len;

    let line = content.slice(scanIndex, nextIndex);
    if (line.endsWith('\r')) line = line.slice(0, -1);

    const trimmed = line.trim();
    if (trimmed) {
      if (REGEX.HEADING_STRICT.test(trimmed)) {
        return trimmed.replace(REGEX.HEADING_MARKER, '').trim() || undefined;
      }
      return undefined;
    }

    scanIndex = nextIndex + 1;
  }
  return undefined;
}

export function extractTitleFromRawMarkdown(
  content: string
): string | undefined {
  const fm = detectFrontmatter(content);
  if (fm) {
    const title = scanFrontmatterForTitle(content, fm);
    if (title) return title;
  }
  return scanBodyForTitle(content);
}

export function addSourceToMarkdown(content: string, url: string): string {
  const fm = detectFrontmatter(content);
  const useMarkdownFormat = config.transform.metadataFormat === 'markdown';

  if (useMarkdownFormat && !fm) {
    if (REGEX.SOURCE_KEY.test(content)) return content;
    const lineEnding = getLineEnding(content);
    const firstH1Match = REGEX.HEADING_MARKER.exec(content);

    if (firstH1Match) {
      const h1Index = firstH1Match.index;
      const lineEndIndex = content.indexOf(lineEnding, h1Index);
      const insertPos =
        lineEndIndex === -1 ? content.length : lineEndIndex + lineEnding.length;

      const injection = `${lineEnding}Source: ${url}${lineEnding}`;
      return content.slice(0, insertPos) + injection + content.slice(insertPos);
    }

    return `Source: ${url}${lineEnding}${lineEnding}${content}`;
  }

  if (!fm) {
    const lineEnding = getLineEnding(content);
    const escapedUrl = url.replace(/"/g, '\\"');
    return `---${lineEnding}source: "${escapedUrl}"${lineEnding}---${lineEnding}${lineEnding}${content}`;
  }

  const fmBody = content.slice(fm.linesStart, fm.linesEnd);
  if (REGEX.SOURCE_KEY.test(fmBody)) return content;

  const escapedUrl = url.replace(/"/g, '\\"');
  const injection = `source: "${escapedUrl}"${fm.lineEnding}`;

  return content.slice(0, fm.linesEnd) + injection + content.slice(fm.linesEnd);
}

function countCommonTags(content: string, limit: number): number {
  if (limit <= 0) return 0;

  const regex = /<(html|head|body|div|span|script|style|meta|link)\b/gi;

  let count = 0;
  while (regex.exec(content)) {
    count += 1;
    if (count > limit) break;
  }

  return count;
}

export function isRawTextContent(content: string): boolean {
  const trimmed = content.trim();
  if (REGEX.HTML_DOC_START.test(trimmed)) return false;

  if (detectFrontmatter(trimmed) !== null) return true;

  const tagCount = countCommonTags(content, 5);
  if (tagCount > 5) return false;

  return (
    REGEX.HEADING_MARKER.test(content) ||
    REGEX.LIST_MARKER.test(content) ||
    content.includes('```')
  );
}

function formatFetchedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;

  const formatter = new Intl.DateTimeFormat(config.i18n.locale, {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });

  return formatter.format(date);
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
    parts.push(`_${formatFetchedAt(metadata.fetchedAt)}_`);
  }

  if (parts.length > 0) lines.push(` ${parts.join(' | ')}`);
  if (metadata.description) lines.push(` <sub>${metadata.description}</sub>`);

  return lines.join('\n');
}
