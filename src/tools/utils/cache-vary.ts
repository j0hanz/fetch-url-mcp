import { config } from '../../config/index.js';

const CRLF_REGEX = /[\r\n]/;

function sanitizeHeaderValue(value: string): string {
  return value.trim();
}

export function normalizeHeadersForCache(
  headers?: Record<string, string>
): Record<string, string> | undefined {
  if (!headers || Object.keys(headers).length === 0) {
    return undefined;
  }

  const { blockedHeaders } = config.security;
  const normalized: Record<string, string> = {};

  for (const [key, value] of Object.entries(headers)) {
    const lowerKey = key.toLowerCase();
    if (
      !blockedHeaders.has(lowerKey) &&
      !CRLF_REGEX.test(key) &&
      !CRLF_REGEX.test(value)
    ) {
      normalized[lowerKey] = sanitizeHeaderValue(value);
    }
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export function appendHeaderVary(
  cacheVary: Record<string, unknown> | string | undefined,
  customHeaders?: Record<string, string>
): Record<string, unknown> | string | undefined {
  const headerVary = normalizeHeadersForCache(customHeaders);

  if (!cacheVary && !headerVary) {
    return undefined;
  }

  if (typeof cacheVary === 'string') {
    return headerVary
      ? { key: cacheVary, headers: headerVary }
      : { key: cacheVary };
  }

  return headerVary ? { ...(cacheVary ?? {}), headers: headerVary } : cacheVary;
}
