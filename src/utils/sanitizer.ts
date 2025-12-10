/**
 * Sanitizes text content by collapsing whitespace and trimming
 * Returns empty string for null/undefined input
 */
export function sanitizeText(text: string | null | undefined): string {
  if (text == null) return '';
  if (typeof text !== 'string') return String(text);
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Truncates text to a maximum length with ellipsis
 * @param text - Text to truncate
 * @param maxLength - Maximum length (must be > 3 to accommodate ellipsis)
 * @returns Truncated text with ellipsis if needed
 */
export function truncateText(text: string, maxLength: number): string {
  if (maxLength < 4) {
    return text.length > 0 ? text.charAt(0) : '';
  }
  if (text.length <= maxLength) {
    return text;
  }
  return text.substring(0, maxLength - 3) + '...';
}
