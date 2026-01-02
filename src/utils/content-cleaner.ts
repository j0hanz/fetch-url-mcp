const NOISE_PATTERN = new RegExp(
  [
    '^(share|copy|like|follow|subscribe|download|print|save)$',
    '^(copy to clipboard|copied!?|copy code|copy link)$',
    '^(show more|show less|load more|view more|read more|see all|view all)$',
    '^(next|previous|prev|back|forward|home|menu|close|skip to)$',
    '^(table of contents|toc|on this page)$',
    '^(loading\\.{0,3}|please wait\\.{0,3}|\\.{2,})$',
    '^(n\\/a|tbd|todo|coming soon|placeholder)$',
    '^\\d+\\s*(comments?|replies?|likes?|shares?|views?)$',
    '^[/\\\\>→»›]+$',
  ].join('|'),
  'i'
);

const MIN_PARAGRAPH_LENGTH = 20;
const MIN_HEADING_LENGTH = 2;
const MIN_LIST_ITEM_LENGTH = 3;
const MAX_REGEX_INPUT_LENGTH = 500;

function isNoiseText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  if (trimmed.length > MAX_REGEX_INPUT_LENGTH) return false;
  return NOISE_PATTERN.test(trimmed);
}

export function cleanParagraph(text: string): string | null {
  const trimmed = text.trim();

  if (trimmed.length < MIN_PARAGRAPH_LENGTH) {
    if (!/[.!?]$/.test(trimmed)) {
      return null;
    }
  }

  if (isNoiseText(trimmed)) {
    return null;
  }

  return trimmed;
}

export function cleanHeading(text: string): string | null {
  let cleaned = text.trim();

  if (cleaned.length < MIN_HEADING_LENGTH) {
    return null;
  }

  cleaned = cleaned.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  cleaned = cleaned.replace(/\s*Link for (this heading|[\w\s]+)\s*$/i, '');
  cleaned = cleaned.replace(/\s*#+\s*$/, '');

  if (isNoiseText(cleaned)) {
    return null;
  }

  return cleaned.trim();
}

export function cleanListItems(items: readonly string[]): readonly string[] {
  return items
    .map((item) => item.trim())
    .filter((item) => {
      if (item.length < MIN_LIST_ITEM_LENGTH) return false;
      if (isNoiseText(item)) return false;
      return true;
    });
}

export function cleanCodeBlock(code: string): string | null {
  const trimmed = code.trim();

  if (trimmed.length === 0) {
    return null;
  }

  if (trimmed.length < 3 && !/^[{}[\]();<>]$/.test(trimmed)) {
    return null;
  }

  return trimmed;
}

export function removeInlineTimestamps(text: string): string {
  return text
    .replace(
      /\b\d+\s*(seconds?|minutes?|hours?|days?|weeks?|months?|years?)\s*ago\b/gi,
      ''
    )
    .replace(
      /\b(updated|modified|edited|created|published)\s*:?\s*\d+\s*(seconds?|minutes?|hours?|days?|weeks?|months?|years?)\s*ago\b/gi,
      ''
    )
    .replace(
      /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\s+\d{1,2},?\s+\d{4}\b/gi,
      ''
    )
    .replace(/\s{2,}/g, ' ')
    .trim();
}
