import { config } from './core.js';
import { throwIfAborted } from './utils.js';

// ── ASCII code constants ────────────────────────────────────────────
const ASCII_MARKERS = {
  HASH: 35,
  ASTERISK: 42,
  PLUS: 43,
  DASH: 45,
  PERIOD: 46,
  DIGIT_0: 48,
  DIGIT_9: 57,
  EXCLAMATION: 33,
  QUESTION: 63,
  BRACKET_OPEN: 91,
} as const;

// ── Title heuristic thresholds ──────────────────────────────────────
const TITLE_MIN_WORDS = 2;
const TITLE_MAX_WORDS = 10;
const TITLE_MIN_CAPITALIZED = 2;
const TITLE_EXCLUSION_WORDS = new Set([
  'and',
  'or',
  'the',
  'of',
  'in',
  'for',
  'to',
  'a',
]);

// ── Processing limits ───────────────────────────────────────────────
const HAS_FOLLOWING_LOOKAHEAD = 10;
const PROPERTY_FIX_MAX_PASSES = 5;
const MAX_LINE_LENGTH = 80;

// ── TOC thresholds ──────────────────────────────────────────────────
const TOC_SCAN_LIMIT = 20;
const TOC_MAX_NON_EMPTY = 12;
const TOC_LINK_RATIO_THRESHOLD = 0.8;

// ── Docs-chrome scan depth ───────────────────────────────────────────
const CHROME_SCAN_LINE_LIMIT = 12;

// ── Fence pattern ───────────────────────────────────────────────────
const FENCE_PATTERN = /^\s*(`{3,}|~{3,})/;

// ── Regex collection ────────────────────────────────────────────────
const REGEX = {
  HEADING_MARKER: /^#{1,6}\s/m,
  HEADING_STRICT: /^#{1,6}\s+/m,
  EMPTY_HEADING_LINE: /^#{1,6}[ \t\u00A0]*$/,
  ANCHOR_ONLY_HEADING: /^#{1,6}\s+\[[^\]]+\]\(#[^)]+\)\s*$/,
  HEADING_TRAILING_PERMALINK:
    /^(#{1,6}\s+.+?)\s*\[(?:#|¶|§|¤|🔗)\]\(#[^)]+\)\s*$/gmu,
  FENCE_START: FENCE_PATTERN,
  LIST_MARKER: /^(?:[-*+])\s/m,
  TOC_LINK: /^- \[[^\]]+\]\(#[^)]+\)\s*$/,
  TOC_HEADING:
    /^(?:#{1,6}\s+)?(?:table of contents|contents|on this page)\s*$/i,
  COMBINED_LINE_REMOVALS:
    /^(?:\[Skip to (?:main )?(?:content|navigation)\]\(#[^)]*\)|\[Skip link\]\(#[^)]*\)|Was this page helpful\??|\[Back to top\]\(#[^)]*\)|\[\s*\]\(https?:\/\/[^)]*\))\s*$/gim,
  ZERO_WIDTH_ANCHOR: /\[(?:\s|\u200B)*\]\(#[^)]*\)[ \t]*/g,
  CONCATENATED_PROPS:
    /([a-z_][a-z0-9_]{0,30}\??:\s+)([\u0022\u201C][^\u0022\u201C\u201D]*[\u0022\u201D])([a-z_][a-z0-9_]{0,30}\??:)/g,
  DOUBLE_NEWLINE_REDUCER: /\n{3,}/g,
  HEADING_SPACING: /(^#{1,6}\s[^\n]*)\n([^\n])/gm,
  HEADING_CODE_BLOCK: /(^#{1,6}\s+\w+)```/gm,
  SPACING_LINK_FIX: /\]\(([^)]+)\)\[/g,
  SPACING_ADJ_COMBINED: /(?:\]\([^)]+\)|`[^`]+`)(?=[A-Za-z0-9])/g,
  SPACING_CODE_DASH: /(`[^`]+`)\s*\\-\s*/g,
  SPACING_ESCAPED_DASH: /(?<=[\w)\]`])\s*\\-\s*(?=[A-Za-z0-9([])/g,
  SPACING_ESCAPES: /\\([[\].])/g,
  SPACING_LIST_NUM_COMBINED:
    /^((?![-*+] |\d+\. |[ \t]).+)\n((?:[-*+]|\d+\.) )/gm,
  PUNCT_ONLY_LIST_ARTIFACT:
    /^(?:[-*+]|\d+\.)\s*(?:\\[-*+|/]|[-*+|/])(?:\s+(?:\\[-*+|/]|[-*+|/]))*\s*$/gm,
  NESTED_LIST_INDENT: /^( +)((?:[-*+])|\d+\.)\s/gm,
  TYPEDOC_COMMENT: /(`+)(?:(?!\1)[\s\S])*?\1|\s?\/\\?\*[\s\S]*?\\?\*\//g,
} as const;

// ── Heading keywords (config-driven) ────────────────────────────────
const HEADING_KEYWORDS = new Set(
  config.markdownCleanup.headingKeywords.map((value) =>
    value.toLocaleLowerCase(config.i18n.locale)
  )
);

// ── Prefix patterns ─────────────────────────────────────────────────
const SPECIAL_PREFIXES =
  /^(?:example|note|tip|warning|important|caution):\s+\S/i;
const REPL_PROMPT_LINE =
  /^(?:>>>|\.\.\.|In \[\d+\]:|Out\[\d+\]:|\.\.\.\\?>)\s*/;
const LEADING_DOCS_CHROME_PATTERNS = [
  /^Edit this page$/i,
  /^Toggle table of contents sidebar$/i,
  /^Toggle site navigation sidebar$/i,
  /^Toggle Light \/ Dark \/ Auto color theme$/i,
  /^Back to top$/i,
] as const;

// ── TypeDoc prefixes ────────────────────────────────────────────────
const TYPEDOC_PREFIXES = [
  'Defined in:',
  'Returns:',
  'Since:',
  'See also:',
] as const;

// ── TextPass pipeline type ──────────────────────────────────────────
interface TextPass {
  readonly stage: string;
  readonly enabled?: () => boolean;
  readonly transform: (text: string) => string;
}

interface CleanupOptions {
  preserveEmptyHeadings?: boolean;
  signal?: AbortSignal;
  url?: string;
}
function createAbortChecker(options?: CleanupOptions): (stage: string) => void {
  return (stage: string) => {
    throwIfAborted(options?.signal, options?.url ?? '', stage);
  };
}
function isBlank(line: string | undefined): boolean {
  return line === undefined || line.trim().length === 0;
}
function hasFollowingContent(lines: string[], startIndex: number): boolean {
  // Optimization: Bound lookahead to avoid checking too many lines in huge files
  for (
    let i = startIndex + 1;
    i < Math.min(lines.length, startIndex + HAS_FOLLOWING_LOOKAHEAD);
    i++
  ) {
    if (!isBlank(lines[i])) return true;
  }
  return false;
}
function findNextNonBlankLine(
  lines: string[],
  startIndex: number
): string | undefined {
  for (
    let i = startIndex + 1;
    i < Math.min(lines.length, startIndex + HAS_FOLLOWING_LOOKAHEAD);
    i++
  ) {
    const line = lines[i];
    if (!isBlank(line)) return line?.trim();
  }
  return undefined;
}
function stripAnchorOnlyHeading(line: string): string {
  return line.replace(/^(#{1,6})\s+\[([^\]]+)\]\(#[^)]+\)\s*$/, '$1 $2');
}
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
  if (len < TITLE_MIN_WORDS || len > TITLE_MAX_WORDS) return false;

  let capitalizedCount = 0;
  for (let i = 0; i < len; i++) {
    const w = words[i];
    if (!w) continue;
    const isCap = /^[A-Z][a-z]*$/.test(w);
    if (isCap) capitalizedCount++;
    else if (!TITLE_EXCLUSION_WORDS.has(w.toLowerCase())) return false;
  }

  return capitalizedCount >= TITLE_MIN_CAPITALIZED;
}
function getHeadingPrefix(trimmed: string): string | null {
  if (trimmed.length > MAX_LINE_LENGTH) return null;
  if (REPL_PROMPT_LINE.test(trimmed)) return null;

  // Fast path: Check common markdown markers first
  const firstChar = trimmed.charCodeAt(0);
  if (
    firstChar === ASCII_MARKERS.HASH ||
    firstChar === ASCII_MARKERS.DASH ||
    firstChar === ASCII_MARKERS.ASTERISK ||
    firstChar === ASCII_MARKERS.PLUS ||
    firstChar === ASCII_MARKERS.BRACKET_OPEN ||
    (firstChar >= ASCII_MARKERS.DIGIT_0 && firstChar <= ASCII_MARKERS.DIGIT_9)
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
  if (
    lastChar === ASCII_MARKERS.PERIOD ||
    lastChar === ASCII_MARKERS.EXCLAMATION ||
    lastChar === ASCII_MARKERS.QUESTION
  )
    return null;

  return isTitleCaseOrKeyword(trimmed) ? '## ' : null;
}
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
  if (!isSpecialPrefix) {
    const nextLine = findNextNonBlankLine(lines, i);
    if (nextLine && REGEX.HEADING_MARKER.test(nextLine)) return null;
  }

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
function normalizePreprocessLine(
  lines: string[],
  i: number,
  trimmed: string,
  line: string,
  options?: CleanupOptions
): string | null {
  if (REGEX.EMPTY_HEADING_LINE.test(trimmed)) return null;
  if (!REGEX.ANCHOR_ONLY_HEADING.test(trimmed)) return line;
  if (!hasFollowingContent(lines, i)) {
    return options?.preserveEmptyHeadings
      ? stripAnchorOnlyHeading(trimmed)
      : null;
  }
  return stripAnchorOnlyHeading(trimmed);
}
function maybeSkipTocBlock(
  lines: string[],
  i: number,
  trimmed: string,
  options?: CleanupOptions
): number | null {
  return shouldSkipAsToc(
    lines,
    i,
    trimmed,
    config.markdownCleanup.removeTocBlocks,
    options
  );
}
function maybePromoteOrphanHeading(
  lines: string[],
  i: number,
  trimmed: string,
  checkAbort: (stage: string) => void
): string | null {
  if (!config.markdownCleanup.promoteOrphanHeadings || trimmed.length === 0) {
    return null;
  }

  checkAbort('markdown:cleanup:promote');
  return tryPromoteOrphan(lines, i, trimmed);
}
function preprocessLines(lines: string[], options?: CleanupOptions): string {
  const checkAbort = createAbortChecker(options);
  const result: string[] = [];
  let skipUntil = -1;

  for (let i = 0; i < lines.length; i++) {
    if (i < skipUntil) continue;

    const currentLine = lines[i] ?? '';
    const trimmed = currentLine.trim();
    const normalizedLine = normalizePreprocessLine(
      lines,
      i,
      trimmed,
      currentLine,
      options
    );
    if (normalizedLine === null) continue;

    const tocSkip = maybeSkipTocBlock(lines, i, trimmed, options);
    if (tocSkip !== null) {
      skipUntil = tocSkip;
      continue;
    }

    const promotedLine = maybePromoteOrphanHeading(
      lines,
      i,
      trimmed,
      checkAbort
    );
    result.push(promotedLine ?? normalizedLine);
  }

  return result.join('\n');
}
function processTextBuffer(lines: string[], options?: CleanupOptions): string {
  if (lines.length === 0) return '';
  const text = preprocessLines(lines, options);
  return applyGlobalRegexes(text, options);
}
function removeTypeDocArtifacts(text: string): string {
  const filtered = text
    .split('\n')
    .filter((line) => !isTypeDocArtifactLine(line))
    .join('\n');
  return filtered.replace(REGEX.TYPEDOC_COMMENT, (match) =>
    match.startsWith('`') ? match : ''
  );
}
function removeSkipLinks(text: string): string {
  return text
    .replace(REGEX.ZERO_WIDTH_ANCHOR, '')
    .replace(REGEX.COMBINED_LINE_REMOVALS, '');
}
function normalizeInlineCodeTokens(text: string): string {
  return text.replace(/`([^`\n]+)`/g, (match: string, inner: string) => {
    const trimmed = inner.trim();
    if (!/[A-Za-z0-9]/.test(trimmed)) return match;

    const parts = /^(\s*)(.*?)(\s*)$/.exec(inner);
    if (!parts) return match;

    const normalized = collapseQualifiedIdentifierSpacing(parts[2] ?? '');
    if (trimmed === inner && normalized === inner) return match;
    return `${parts[1] ?? ''}\`${normalized}\`${parts[3] ?? ''}`;
  });
}

function applyUntilStable(
  text: string,
  pattern: RegExp,
  replacement: string,
  maxPasses = PROPERTY_FIX_MAX_PASSES
): string {
  let result = text;
  for (let i = 0; i < maxPasses; i++) {
    const next = result.replace(pattern, replacement);
    if (next === result) break;
    result = next;
  }
  return result;
}

function collapseQualifiedIdentifierSpacing(text: string): string {
  return applyUntilStable(
    text,
    /\b([A-Za-z_$][\w$]*)\.\s+(?=[A-Za-z_$<])/g,
    '$1.'
  );
}

function normalizeMarkdownLinkText(text: string): string {
  const normalized = collapseQualifiedIdentifierSpacing(
    text.replace(/\\`/g, '`').replace(/\\</g, '<').replace(/\\>/g, '>')
  );
  return normalized.replace(/</g, '\\<').replace(/>/g, '\\>');
}

function normalizeMarkdownLinkLabels(text: string): string {
  return text.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    (_match: string, linkText: string, url: string) =>
      `[${normalizeMarkdownLinkText(linkText)}](${url})`
  );
}

const INLINE_CODE_PAD_BEFORE = /(\S)[ \t]{2,}(?=`[^`\n]+`)/g;
const INLINE_CODE_PAD_AFTER = /(`[^`\n]+`)[ \t]{2,}(?=\S)/g;

function collapseInlineCodePadding(text: string): string {
  return text
    .replace(INLINE_CODE_PAD_BEFORE, '$1 ')
    .replace(INLINE_CODE_PAD_AFTER, '$1 ');
}

function escapeAngleBracketsInMarkdownTables(text: string): string {
  return text.replace(/^(?!\|\s*[-: ]+\|)(\|.*\|)\s*$/gm, (line: string) =>
    line
      .replace(/<\/([A-Za-z][A-Za-z0-9-]*)>/g, '\\</$1\\>')
      .replace(/<([A-Za-z][A-Za-z0-9-]*)>/g, '\\<$1\\>')
  );
}

function stripTrailingHeadingPermalinks(text: string): string {
  return text
    .replace(REGEX.HEADING_TRAILING_PERMALINK, '$1')
    .replace(/^(#{1,6})\s{2,}/gm, '$1 ')
    .replace(/^(#{1,6}\s+.*?)[ \t]+$/gm, '$1');
}

function getHeadingInfo(line: string): { level: number } | null {
  const match = /^(#{1,6})\s+/.exec(line.trim());
  if (!match) return null;
  return { level: match[1]?.length ?? 0 };
}

function findNextNonBlankIndex(lines: string[], startIndex: number): number {
  let idx = startIndex;
  while (idx < lines.length && isBlank(lines[idx])) {
    idx += 1;
  }
  return idx;
}

function removeEmptyHeadingSections(text: string): string {
  const lines = text.split('\n');
  const kept: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const heading = getHeadingInfo(line);
    if (!heading) {
      kept.push(line);
      continue;
    }

    const nextIndex = findNextNonBlankIndex(lines, i + 1);

    const nextLine = lines[nextIndex];
    if (nextLine === undefined) {
      kept.push(line);
      continue;
    }

    const nextHeading = getHeadingInfo(nextLine);
    if (nextHeading && nextHeading.level <= heading.level) {
      continue;
    }

    kept.push(line);
  }

  return kept.join('\n').replace(REGEX.DOUBLE_NEWLINE_REDUCER, '\n\n');
}

function normalizeMarkdownSpacing(text: string): string {
  let result = text
    .replace(REGEX.SPACING_LINK_FIX, ']($1) [')
    .replace(REGEX.SPACING_ADJ_COMBINED, '$& ')
    .replace(REGEX.SPACING_CODE_DASH, '$1 - ')
    .replace(REGEX.SPACING_ESCAPED_DASH, ' - ')
    .replace(REGEX.SPACING_ESCAPES, '$1')
    .replace(REGEX.SPACING_LIST_NUM_COMBINED, '$1\n\n$2')
    .replace(REGEX.PUNCT_ONLY_LIST_ARTIFACT, '')
    .replace(REGEX.DOUBLE_NEWLINE_REDUCER, '\n\n');

  // Fix missing spaces after sentence-ending punctuation followed by uppercase
  result = result.replace(/([.!?:;])([A-Z])/g, '$1 $2');

  // Trim whitespace around token-like inline code spans.
  result = normalizeInlineCodeTokens(result);
  result = collapseInlineCodePadding(result);

  result = normalizeMarkdownLinkLabels(result);
  result = escapeAngleBracketsInMarkdownTables(result);

  return normalizeNestedListIndentation(result);
}
function stripLeadingDocsChrome(text: string): string {
  const lines = text.split('\n');
  const cleaned = lines.map((line, index) => {
    if (index >= CHROME_SCAN_LINE_LIMIT) return line;
    const trimmed = line.trim();
    return LEADING_DOCS_CHROME_PATTERNS.some((pattern) => pattern.test(trimmed))
      ? ''
      : line;
  });
  return cleaned.join('\n').replace(REGEX.DOUBLE_NEWLINE_REDUCER, '\n\n');
}
function fixConcatenatedProperties(text: string): string {
  return applyUntilStable(text, REGEX.CONCATENATED_PROPS, '$1$2\n\n$3');
}
function applyGlobalRegexes(text: string, options?: CleanupOptions): string {
  const checkAbort = createAbortChecker(options);

  const passes: readonly TextPass[] = [
    {
      stage: 'markdown:cleanup:nbsp',
      transform: (t) => t.replace(/\u00A0/g, ' '),
    },
    {
      stage: 'markdown:cleanup:headings',
      transform: (t) =>
        t
          .replace(REGEX.HEADING_SPACING, '$1\n\n$2')
          .replace(REGEX.HEADING_CODE_BLOCK, '$1\n\n```'),
    },
    {
      stage: 'markdown:cleanup:typedoc',
      enabled: () => config.markdownCleanup.removeTypeDocComments,
      transform: removeTypeDocArtifacts,
    },
    {
      stage: 'markdown:cleanup:skip-links',
      enabled: () => config.markdownCleanup.removeSkipLinks,
      transform: removeSkipLinks,
    },
    {
      stage: 'markdown:cleanup:spacing',
      transform: normalizeMarkdownSpacing,
    },
    {
      stage: 'markdown:cleanup:properties',
      transform: fixConcatenatedProperties,
    },
    {
      stage: 'markdown:cleanup:permalinks',
      transform: stripTrailingHeadingPermalinks,
    },
  ];

  let result = text;
  for (const pass of passes) {
    if (pass.enabled !== undefined && !pass.enabled()) continue;
    checkAbort(pass.stage);
    result = pass.transform(result);
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

export function processFencedContent(
  content: string,
  processTextSegment: (text: string) => string
): string {
  // Normalize line endings to \n
  const normalizedContent = content.replace(/\r\n/g, '\n');
  const FENCE_BLOCK_REGEX =
    /^[ \t]*(`{3,}|~{3,})[^\n]*(?:\n[\s\S]*?)?(?:^[ \t]*\1[ \t]*$|$(?!\n))/gm;

  const parts: string[] = [];
  let lastIndex = 0;

  for (const match of normalizedContent.matchAll(FENCE_BLOCK_REGEX)) {
    const matchStart = match.index;
    if (matchStart > lastIndex) {
      parts.push(
        processTextSegment(normalizedContent.slice(lastIndex, matchStart))
      );
    }
    parts.push(match[0]);
    lastIndex = matchStart + match[0].length;
  }

  if (lastIndex < normalizedContent.length) {
    parts.push(processTextSegment(normalizedContent.slice(lastIndex)));
  }

  return parts.join('');
}

function stripLeadingBreadcrumbNoise(text: string): string {
  return text.replace(
    /^([^\n#>|`\-*+\d[\]()]{1,40})\n(\s*\n)?(?=#{1,2}\s)/,
    ''
  );
}

function stripCopyButtonText(text: string): string {
  return text.replace(/\[Copy\]\(#copy\)\s*/gi, '');
}

export function cleanupMarkdownArtifacts(
  content: string,
  options?: CleanupOptions
): string {
  if (!content) return '';

  throwIfAborted(options?.signal, options?.url ?? '', 'markdown:cleanup:begin');

  let result = stripCopyButtonText(
    processFencedContent(content, (text) =>
      processTextBuffer(text.split('\n'), options)
    ).trim()
  );

  if (!options?.preserveEmptyHeadings) {
    throwIfAborted(
      options?.signal,
      options?.url ?? '',
      'markdown:cleanup:empty-headings'
    );
    result = removeEmptyHeadingSections(result);
  }

  return stripLeadingBreadcrumbNoise(stripLeadingDocsChrome(result));
}
