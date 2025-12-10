/**
 * Sanitizes text content by collapsing whitespace and trimming
 */
export function sanitizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Truncates text to a maximum length with ellipsis
 */
export function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return text.substring(0, maxLength - 3) + '...';
}
