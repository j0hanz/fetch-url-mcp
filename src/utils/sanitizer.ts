// Pre-compiled regex patterns for hot path optimization
const WHITESPACE_REGEX = /\s+/g;

export function sanitizeText(text: string | null | undefined): string {
  if (text == null) return '';
  if (typeof text !== 'string') return String(text);
  return text.replace(WHITESPACE_REGEX, ' ').trim();
}

export function truncateText(text: string, maxLength: number): string {
  if (maxLength < 4) {
    return text.length > 0 ? text.charAt(0) : '';
  }
  if (text.length <= maxLength) {
    return text;
  }
  return text.substring(0, maxLength - 3) + '...';
}
