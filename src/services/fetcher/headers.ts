import { config } from '../../config/index.js';

const CRLF_REGEX = /[\r\n]/;

export function sanitizeHeaders(
  headers?: Record<string, string>
): Record<string, string> | undefined {
  if (!headers || Object.keys(headers).length === 0) {
    return undefined;
  }

  const { blockedHeaders } = config.security;
  const sanitized: Record<string, string> = {};

  for (const [key, value] of Object.entries(headers)) {
    if (
      !blockedHeaders.has(key.toLowerCase()) &&
      !CRLF_REGEX.test(key) &&
      !CRLF_REGEX.test(value)
    ) {
      sanitized[key] = value;
    }
  }

  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}
