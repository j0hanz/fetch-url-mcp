export function sanitizeText(text: string | null | undefined): string {
  if (text == null) return '';
  if (typeof text !== 'string') return String(text);
  return text.replace(/\s+/g, ' ').trim();
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
