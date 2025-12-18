import { config } from '../config/index.js';

import { logWarn } from '../services/logger.js';

/**
 * Truncate HTML to maximum size while preserving tag boundaries
 * Prevents incomplete HTML by finding the last complete tag within limits
 */
export function truncateHtml(html: string): string {
  if (html.length <= config.constants.maxHtmlSize) {
    return html;
  }

  logWarn('HTML content exceeds maximum size, truncating at safe boundary', {
    size: html.length,
    maxSize: config.constants.maxHtmlSize,
  });

  // Use lastIndexOf for O(log n) reverse search - find last complete tag
  const lastTag = html.lastIndexOf('>', config.constants.maxHtmlSize);

  // If we found a tag boundary near the limit (within 10% buffer), use it
  if (lastTag !== -1 && lastTag > config.constants.maxHtmlSize * 0.9) {
    return html.substring(0, lastTag + 1);
  }

  // Fallback: simple truncation if no suitable boundary found
  return html.substring(0, config.constants.maxHtmlSize);
}
