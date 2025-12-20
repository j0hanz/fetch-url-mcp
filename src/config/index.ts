function parseInteger(
  envValue: string | undefined,
  defaultValue: number,
  min?: number,
  max?: number
): number {
  if (!envValue) return defaultValue;
  const parsed = parseInt(envValue, 10);
  if (isNaN(parsed)) return defaultValue;
  if (min !== undefined && parsed < min) return defaultValue;
  if (max !== undefined && parsed > max) return defaultValue;
  return parsed;
}

function parseBoolean(
  envValue: string | undefined,
  defaultValue: boolean
): boolean {
  if (!envValue) return defaultValue;
  return envValue !== 'false';
}

function parseLogLevel(
  envValue: string | undefined
): 'debug' | 'info' | 'warn' | 'error' {
  const level = envValue?.toLowerCase();
  if (
    level === 'debug' ||
    level === 'info' ||
    level === 'warn' ||
    level === 'error'
  ) {
    return level;
  }
  return 'info';
}

export const config = {
  server: {
    name: 'superFetch',
    version: '1.0.0',
    port: parseInteger(process.env.PORT, 3000, 1024, 65535),
    host: process.env.HOST ?? '127.0.0.1',
  },
  fetcher: {
    timeout: parseInteger(process.env.FETCH_TIMEOUT, 30000, 5000, 120000),
    maxRedirects: 5,
    userAgent: process.env.USER_AGENT ?? 'superFetch-MCP/1.0',
    maxContentLength: 10485760,
  },
  cache: {
    enabled: parseBoolean(process.env.CACHE_ENABLED, true),
    ttl: parseInteger(process.env.CACHE_TTL, 3600, 60, 86400),
    maxKeys: parseInteger(process.env.CACHE_MAX_KEYS, 100, 10, 1000),
  },
  extraction: {
    extractMainContent: parseBoolean(process.env.EXTRACT_MAIN_CONTENT, true),
    includeMetadata: parseBoolean(process.env.INCLUDE_METADATA, true),
    maxBlockLength: 5000,
    minParagraphLength: 10,
  },
  logging: {
    level: parseLogLevel(process.env.LOG_LEVEL),
    enabled: parseBoolean(process.env.ENABLE_LOGGING, true),
  },
  constants: {
    maxHtmlSize: 10 * 1024 * 1024,
    maxContentSize: 5 * 1024 * 1024,
    maxUrlLength: 2048,
  },
  security: {
    blockedHosts: new Set([
      'localhost',
      '127.0.0.1',
      '0.0.0.0',
      '::1',
      '169.254.169.254',
      'metadata.google.internal',
      'metadata.azure.com',
      '100.100.100.200',
      'instance-data',
    ]),
    blockedIpPatterns: [
      /^10\./,
      /^172\.(1[6-9]|2\d|3[01])\./,
      /^192\.168\./,
      /^127\./,
      /^0\./,
      /^169\.254\./,
      /^fc00:/i,
      /^fe80:/i,
      /^::ffff:127\./,
      /^::ffff:10\./,
      /^::ffff:172\.(1[6-9]|2\d|3[01])\./,
      /^::ffff:192\.168\./,
    ] as readonly RegExp[],
    blockedHeaders: new Set([
      'host',
      'authorization',
      'cookie',
      'x-forwarded-for',
      'x-real-ip',
      'proxy-authorization',
    ]),
  },
} as const;
