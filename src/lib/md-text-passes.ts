import { config } from './core.js';

// ── ASCII code constants ────────────────────────────────────────────
export const ASCII_HASH = 35;
export const ASCII_ASTERISK = 42;
export const ASCII_PLUS = 43;
export const ASCII_DASH = 45;
export const ASCII_PERIOD = 46;
export const ASCII_DIGIT_0 = 48;
export const ASCII_DIGIT_9 = 57;
export const ASCII_EXCLAMATION = 33;
export const ASCII_QUESTION = 63;
export const ASCII_BRACKET_OPEN = 91;

// ── Title heuristic thresholds ──────────────────────────────────────
export const TITLE_MIN_WORDS = 2;
export const TITLE_MAX_WORDS = 10;
export const TITLE_MIN_CAPITALIZED = 2;

// ── Processing limits ───────────────────────────────────────────────
export const HAS_FOLLOWING_LOOKAHEAD = 10;
export const PROPERTY_FIX_MAX_PASSES = 5;
export const MAX_LINE_LENGTH = 80;

// ── TOC thresholds ──────────────────────────────────────────────────
export const TOC_SCAN_LIMIT = 20;
export const TOC_MAX_NON_EMPTY = 12;
export const TOC_LINK_RATIO_THRESHOLD = 0.8;

// ── Fence pattern ───────────────────────────────────────────────────
export const FENCE_PATTERN = /^\s*(`{3,}|~{3,})/;

// ── Regex collection ────────────────────────────────────────────────
export const REGEX = {
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
  HTML_DOC_START: /^(<!doctype|<html)/i,
  COMBINED_LINE_REMOVALS:
    /^(?:\[Skip to (?:main )?(?:content|navigation)\]\(#[^)]*\)|\[Skip link\]\(#[^)]*\)|Was this page helpful\??|\[Back to top\]\(#[^)]*\)|\[\s*\]\(https?:\/\/[^)]*\))\s*$/gim,
  ZERO_WIDTH_ANCHOR: /\[(?:\s|\u200B)*\]\(#[^)]*\)[ \t]*/g,
  CONCATENATED_PROPS:
    /([a-z_][a-z0-9_]{0,30}\??:\s+)([\u0022\u201C][^\u0022\u201C\u201D]*[\u0022\u201D])([a-z_][a-z0-9_]{0,30}\??:)/g,
  DOUBLE_NEWLINE_REDUCER: /\n{3,}/g,
  SOURCE_KEY: /^source:\s/im,
  HEADING_SPACING: /(^#{1,6}\s[^\n]*)\n([^\n])/gm,
  HEADING_CODE_BLOCK: /(^#{1,6}\s+\w+)```/gm,
  SPACING_LINK_FIX: /\]\(([^)]+)\)\[/g,
  SPACING_ADJ_COMBINED: /(?:\]\([^)]+\)|`[^`]+`)(?=[A-Za-z0-9])/g,
  SPACING_CODE_PAD_BEFORE: /(\S)[ \t]{2,}(?=`[^`\n]+`)/g,
  SPACING_CODE_PAD_AFTER: /(`[^`\n]+`)[ \t]{2,}(?=\S)/g,
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
export const HEADING_KEYWORDS = new Set(
  config.markdownCleanup.headingKeywords.map((value) =>
    value.toLocaleLowerCase(config.i18n.locale)
  )
);

// ── Prefix patterns ─────────────────────────────────────────────────
export const SPECIAL_PREFIXES =
  /^(?:example|note|tip|warning|important|caution):\s+\S/i;

// ── TypeDoc prefixes ────────────────────────────────────────────────
export const TYPEDOC_PREFIXES = [
  'Defined in:',
  'Returns:',
  'Since:',
  'See also:',
] as const;

// ── TextPass pipeline type ──────────────────────────────────────────
export interface TextPass {
  readonly stage: string;
  readonly enabled?: () => boolean;
  readonly apply: (text: string) => string;
}
