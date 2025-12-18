import { config } from '../config/index.js';

import { logWarn } from '../services/logger.js';

export function truncateHtml(html: string): string {
  const maxSize = config.constants.maxHtmlSize;

  if (html.length <= maxSize) {
    return html;
  }

  logWarn('HTML content exceeds maximum size, truncating', {
    size: html.length,
    maxSize,
  });

  return html.substring(0, maxSize);
}
