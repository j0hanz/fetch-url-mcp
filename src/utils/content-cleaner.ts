/**
 * Post-processing content cleaner for removing noise artifacts
 * that slip through Readability extraction.
 */

// Patterns for noise content removal - exact matches (case-insensitive)
const NOISE_PATTERNS: RegExp[] = [
  // Relative timestamps (standalone)
  /^\d+\s*(seconds?|minutes?|hours?|days?|weeks?|months?|years?)\s*ago$/i,
  /^(just now|recently|today|yesterday|last week|last month)$/i,
  /^(updated|modified|edited|created|published)\s*:?\s*\d+\s*(seconds?|minutes?|hours?|days?|weeks?|months?|years?)\s*ago$/i,
  /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\s+\d{1,2},?\s+\d{4}$/i,
  /^\d{1,2}\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\s+\d{4}$/i,
  /^\d{4}-\d{2}-\d{2}$/i, // ISO date
  /^last\s+updated\s*:?/i,

  // Share/action button labels (standalone)
  /^(share|copy|like|follow|subscribe|download|print|save|bookmark|tweet|pin it|email|export)$/i,
  /^(copy to clipboard|copied!?|copy code|copy link)$/i,
  /^(share on|share to|share via)\s+(twitter|facebook|linkedin|reddit|x|email)$/i,

  // UI artifacts and button labels
  /^(click to copy|expand|collapse|show more|show less|load more|view more|read more|see more|see all|view all)$/i,
  /^(toggle|switch|enable|disable|on|off)$/i,
  /^(edit|delete|remove|add|new|create|update|cancel|confirm|submit|reset|clear)$/i,
  /^(open in|view in|edit in)\s+\w+$/i,
  /^(try it|run|execute|play|preview|demo|live demo|playground)$/i,
  /^(source|view source|edit this page|edit on github|improve this doc)$/i,

  // Empty or placeholder content
  /^(loading\.{0,3}|please wait\.{0,3}|\.{2,})$/i,
  /^(n\/a|tbd|todo|coming soon|placeholder|untitled)$/i,

  // Navigation artifacts
  /^(next|previous|prev|back|forward|home|menu|close|open|skip to|jump to|go to)$/i,
  /^(table of contents|toc|contents|on this page|in this article|in this section)$/i,
  /^(scroll to top|back to top|top)$/i,

  // Cookie/consent/legal notices
  /^(accept|reject|accept all|reject all|cookie settings|privacy settings|manage preferences)$/i,
  /^(accept cookies|decline cookies|cookie policy|privacy policy|terms of service|terms & conditions)$/i,

  // Comment/reaction counts
  /^\d+\s*(comments?|replies?|reactions?|responses?)$/i,

  // Social counts and engagement
  /^\d+\s*(likes?|shares?|views?|followers?|retweets?|stars?|forks?|claps?|upvotes?|downvotes?)$/i,
  /^(liked by|shared by|followed by)\s+\d+/i,

  // Version badges (standalone)
  /^v?\d+\.\d+(\.\d+)?(-\w+)?$/i, // v1.2.3, 1.2.3-beta
  /^(stable|beta|alpha|rc|preview|experimental|deprecated|legacy|new|updated)$/i,

  // Empty structural elements
  /^(a|b|c|d|e|f|g|h|i|j|k|l|m|n|o|p|q|r|s|t|u|v|w|x|y|z)$/i, // Single letters
  /^panel\s*[a-z]?$/i, // Panel A, Panel B, etc.

  // API explorer artifacts
  /^(required|optional|default|type|example|description|parameters?|returns?|response|request)$/i,
  /^(get|post|put|patch|delete|head|options)\s*$/i, // HTTP methods alone

  // Interactive element labels
  /^(drag|drop|resize|zoom|scroll|swipe|tap|click|hover|focus)(\s+to\s+\w+)?$/i,
  /^(drag the|move the|resize the|drag to|click to)\s+\w+/i,

  // Breadcrumb separators
  /^[/\\>→»›]+$/,

  // Advertisement markers
  /^(ad|advertisement|sponsored|promoted|partner content)$/i,
];

// Patterns that indicate noise when text is very short (< 25 chars)
const SHORT_TEXT_NOISE_PATTERNS: RegExp[] = [
  /^#\w+$/, // Hashtags only
  /^@\w+$/, // Mentions only
  /^\d+$/, // Numbers only
  /^[•·→←↑↓►▼▲◄▶◀■□●○★☆✓✗✔✘×]+$/, // Bullet/arrow/symbol characters only
  /^[,;:\-–—]+$/, // Punctuation only
  /^\[\d+\]$/, // Reference numbers [1], [2]
  /^\(\d+\)$/, // Reference numbers (1), (2)
  /^fig\.?\s*\d+$/i, // Figure references
  /^table\s*\d+$/i, // Table references
  /^step\s*\d+$/i, // Step numbers alone
  /^note:?$/i, // "Note" alone
  /^tip:?$/i, // "Tip" alone
  /^warning:?$/i, // "Warning" alone
  /^info:?$/i, // "Info" alone
  /^caution:?$/i, // "Caution" alone
];

// Patterns to detect content that's likely part of UI chrome (not main content)
const UI_CHROME_PATTERNS: RegExp[] = [
  /^(sign in|sign up|log in|log out|register|create account)$/i,
  /^(search|search\.\.\.|search docs|search documentation)$/i,
  /^(dark mode|light mode|theme|language|locale)$/i,
  /^(feedback|report issue|report a bug|file an issue|suggest edit)$/i,
  /^(documentation|docs|api|reference|guide|tutorial|examples?)$/i,
  /^(version|changelog|release notes|what's new)$/i,
];

// Minimum lengths for different content types
const MIN_PARAGRAPH_LENGTH = 20;
const MIN_HEADING_LENGTH = 2;
const MIN_LIST_ITEM_LENGTH = 3;
const SHORT_TEXT_THRESHOLD = 25;

/**
 * Check if text matches any noise pattern
 */
function isNoiseText(text: string): boolean {
  const trimmed = text.trim();

  // Empty or whitespace-only
  if (!trimmed) {
    return true;
  }

  // Check against all noise patterns
  for (const pattern of NOISE_PATTERNS) {
    if (pattern.test(trimmed)) {
      return true;
    }
  }

  // Check short text patterns for brief content
  if (trimmed.length < SHORT_TEXT_THRESHOLD) {
    for (const pattern of SHORT_TEXT_NOISE_PATTERNS) {
      if (pattern.test(trimmed)) {
        return true;
      }
    }

    // Also check UI chrome patterns for short text
    for (const pattern of UI_CHROME_PATTERNS) {
      if (pattern.test(trimmed)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Check if text looks like placeholder/demo content
 */
function isPlaceholderContent(text: string): boolean {
  const trimmed = text.trim().toLowerCase();

  // Common placeholder patterns in examples
  const placeholders = [
    /^lorem ipsum/i,
    /^sample text/i,
    /^placeholder/i,
    /^example (text|content|data)/i,
    /^test (text|content|data)/i,
    /^your (text|content|name|email) here/i,
    /^enter (your|a) /i,
    /^type (your|a|something) /i,
  ];

  for (const pattern of placeholders) {
    if (pattern.test(trimmed)) {
      return true;
    }
  }

  return false;
}

/**
 * Clean paragraph text by removing noise
 */
export function cleanParagraph(text: string): string | null {
  const trimmed = text.trim();

  // Too short to be meaningful
  if (trimmed.length < MIN_PARAGRAPH_LENGTH) {
    // Allow very short paragraphs if they end with punctuation (likely real content)
    if (!/[.!?]$/.test(trimmed)) {
      return null;
    }
  }

  // Is noise content
  if (isNoiseText(trimmed)) {
    return null;
  }

  // Is placeholder content (in paragraphs, not in examples)
  if (isPlaceholderContent(trimmed)) {
    return null;
  }

  return trimmed;
}

/**
 * Clean heading text by removing noise and markdown link syntax
 */
export function cleanHeading(text: string): string | null {
  let cleaned = text.trim();

  // Too short
  if (cleaned.length < MIN_HEADING_LENGTH) {
    return null;
  }

  // Remove markdown link syntax: [Text](#anchor) -> Text
  cleaned = cleaned.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');

  // Remove trailing anchor links like "Link for this heading"
  cleaned = cleaned.replace(/\s*Link for (this heading|[\w\s]+)\s*$/i, '');

  // Remove trailing hash symbols often used for anchor links
  cleaned = cleaned.replace(/\s*#+\s*$/, '');

  // Is noise content
  if (isNoiseText(cleaned)) {
    return null;
  }

  return cleaned.trim();
}

/**
 * Clean list items by filtering out noise
 */
export function cleanListItems(items: string[]): string[] {
  return items
    .map((item) => item.trim())
    .filter((item) => {
      if (item.length < MIN_LIST_ITEM_LENGTH) return false;
      if (isNoiseText(item)) return false;
      return true;
    });
}

/**
 * Clean code block text - minimal cleaning to preserve code integrity
 */
export function cleanCodeBlock(code: string): string | null {
  const trimmed = code.trim();

  // Empty code block
  if (trimmed.length === 0) {
    return null;
  }

  // Very short code blocks that are likely just labels
  if (trimmed.length < 3 && !/^[{}[\]();<>]$/.test(trimmed)) {
    return null;
  }

  return trimmed;
}

/**
 * Strip markdown link syntax from text for cleaner slugs/display
 * [Text](#anchor) -> Text
 * [Text](url) -> Text
 */
export function stripMarkdownLinks(text: string): string {
  return text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
}

/**
 * Remove common timestamp patterns from text (inline removal)
 * Use when you want to strip timestamps from within longer content
 */
export function removeInlineTimestamps(text: string): string {
  return (
    text
      // Remove "X days/hours/etc ago" patterns
      .replace(
        /\b\d+\s*(seconds?|minutes?|hours?|days?|weeks?|months?|years?)\s*ago\b/gi,
        ''
      )
      // Remove "Updated: date" patterns
      .replace(
        /\b(updated|modified|edited|created|published)\s*:?\s*\d+\s*(seconds?|minutes?|hours?|days?|weeks?|months?|years?)\s*ago\b/gi,
        ''
      )
      // Remove standalone dates
      .replace(
        /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\s+\d{1,2},?\s+\d{4}\b/gi,
        ''
      )
      // Clean up extra whitespace
      .replace(/\s{2,}/g, ' ')
      .trim()
  );
}
