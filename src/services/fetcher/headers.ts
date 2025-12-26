import { config } from '../../config/index.js';

export function sanitizeHeaders(
  headers?: Record<string, string>
): Record<string, string> | undefined {
  if (!headers || Object.keys(headers).length === 0) return undefined;

  const normalized = normalizeHeaders(headers, config.security.blockedHeaders);
  const iterator = normalized.keys();
  if (iterator.next().done) return undefined;

  return Object.fromEntries(normalized.entries());
}

function normalizeHeaders(
  headers: Record<string, string>,
  blockedHeaders: Set<string>
): Headers {
  const normalized = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (blockedHeaders.has(key.toLowerCase())) continue;
    setHeaderSafe(normalized, key, value);
  }
  return normalized;
}

function setHeaderSafe(headers: Headers, key: string, value: string): void {
  try {
    headers.set(key, value);
  } catch {
    // Ignore invalid header values
  }
}
