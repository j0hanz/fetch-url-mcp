import { config } from '../../config/index.js';

export function normalizeHeadersForCache(
  headers?: Record<string, string>
): Record<string, string> | undefined {
  if (!headers || Object.keys(headers).length === 0) return undefined;

  const normalized = buildNormalizedHeaders(
    headers,
    config.security.blockedHeaders
  );
  const iterator = normalized.keys();
  if (iterator.next().done) return undefined;

  return Object.fromEntries(normalized.entries());
}

export function appendHeaderVary(
  cacheVary: Record<string, unknown> | string | undefined,
  customHeaders?: Record<string, string>
): Record<string, unknown> | string | undefined {
  const headerVary = normalizeHeadersForCache(customHeaders);

  if (!cacheVary && !headerVary) return undefined;

  if (typeof cacheVary === 'string') {
    return buildStringVary(cacheVary, headerVary);
  }

  if (!headerVary) return cacheVary;
  return { ...(cacheVary ?? {}), headers: headerVary };
}

function buildNormalizedHeaders(
  headers: Record<string, string>,
  blockedHeaders: Set<string>
): Headers {
  const normalized = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (blockedHeaders.has(key.toLowerCase())) continue;
    setHeaderValue(normalized, key, value);
  }
  return normalized;
}

function setHeaderValue(headers: Headers, key: string, value: string): void {
  try {
    headers.set(key, value.trim());
  } catch {
    // Ignore invalid headers for cache keys
  }
}

function buildStringVary(
  key: string,
  headerVary: Record<string, string> | undefined
): Record<string, unknown> {
  if (!headerVary) return { key };
  return { key, headers: headerVary };
}
