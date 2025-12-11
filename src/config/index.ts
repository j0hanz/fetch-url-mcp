/**
 * Safely parses an integer from environment variable with validation
 * Environment variables can still be used for deployment overrides (e.g., PORT=8080 npm start)
 */
function parseIntEnv(
  value: string | undefined,
  defaultValue: number,
  min = 0,
  max = Number.MAX_SAFE_INTEGER
): number {
  if (!value) return defaultValue;
  const parsed = parseInt(value, 10);
  if (isNaN(parsed)) return defaultValue;
  return Math.max(min, Math.min(max, parsed));
}

export const config = {
  server: {
    name: 'superFetch',
    version: '1.0.0',
    port: parseIntEnv(process.env.PORT, 3000, 1, 65535),
    host: process.env.HOST ?? '127.0.0.1',
  },
  fetcher: {
    timeout: parseIntEnv(process.env.FETCH_TIMEOUT, 30000, 1000, 120000), // 1s-120s
    maxRedirects: parseIntEnv(process.env.MAX_REDIRECTS, 5, 0, 20),
    userAgent: process.env.USER_AGENT ?? 'superFetch-MCP/1.0',
    maxContentLength: parseIntEnv(
      process.env.MAX_CONTENT_LENGTH,
      10485760,
      1024,
      52428800
    ), // 1KB-50MB
  },
  cache: {
    enabled: process.env.CACHE_ENABLED !== 'false',
    ttl: parseIntEnv(process.env.CACHE_TTL, 3600, 60, 86400), // 1min-24hr
    maxKeys: parseIntEnv(process.env.CACHE_MAX_KEYS, 100, 10, 10000),
  },
  extraction: {
    extractMainContent: process.env.EXTRACT_MAIN_CONTENT !== 'false',
    includeMetadata: process.env.INCLUDE_METADATA !== 'false',
    maxBlockLength: parseIntEnv(process.env.MAX_BLOCK_LENGTH, 5000, 100, 50000),
    minParagraphLength: parseIntEnv(
      process.env.MIN_PARAGRAPH_LENGTH,
      10,
      0,
      1000
    ),
  },
  logging: {
    level: process.env.LOG_LEVEL ?? 'info',
    enabled: process.env.ENABLE_LOGGING !== 'false',
  },
} as const;
