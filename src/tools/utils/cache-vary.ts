import { config } from '../../config/index.js';

import { normalizeHeaderRecord } from '../../utils/header-normalizer.js';

export function appendHeaderVary(
  cacheVary: Record<string, unknown> | string | undefined,
  customHeaders?: Record<string, string>
): Record<string, unknown> | string | undefined {
  const headers = normalizeHeaderRecord(
    customHeaders,
    config.security.blockedHeaders,
    { trimValues: true }
  );

  if (!headers) return cacheVary;
  if (!cacheVary) return { headers };
  return typeof cacheVary === 'string'
    ? { key: cacheVary, headers }
    : { ...cacheVary, headers };
}
