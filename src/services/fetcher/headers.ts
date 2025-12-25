import { validateHeaderName, validateHeaderValue } from 'node:http';

import { config } from '../../config/index.js';

function isValidHeader(key: string, value: string): boolean {
  try {
    validateHeaderName(key);
    validateHeaderValue(key, value);
    return true;
  } catch {
    return false;
  }
}

export function sanitizeHeaders(
  headers?: Record<string, string>
): Record<string, string> | undefined {
  if (!headers || Object.keys(headers).length === 0) {
    return undefined;
  }

  const { blockedHeaders } = config.security;
  const sanitized: Record<string, string> = {};

  for (const [key, value] of Object.entries(headers)) {
    if (!blockedHeaders.has(key.toLowerCase()) && isValidHeader(key, value)) {
      sanitized[key] = value;
    }
  }

  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}
