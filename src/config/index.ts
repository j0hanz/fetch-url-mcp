import packageJson from '../../package.json' with { type: 'json' };
import type { LogLevel } from './types.js';

function parseInteger(
  envValue: string | undefined,
  defaultValue: number,
  min?: number,
  max?: number
): number {
  const parsed = parseRawInteger(envValue, defaultValue);
  return clampInteger(parsed, defaultValue, min, max);
}

function parseRawInteger(
  envValue: string | undefined,
  defaultValue: number
): number {
  if (!envValue) return defaultValue;
  const parsed = parseInt(envValue, 10);
  return Number.isNaN(parsed) ? defaultValue : parsed;
}

function clampInteger(
  value: number,
  defaultValue: number,
  min?: number,
  max?: number
): number {
  if (min !== undefined && value < min) return defaultValue;
  if (max !== undefined && value > max) return defaultValue;
  return value;
}

function parseBoolean(
  envValue: string | undefined,
  defaultValue: boolean
): boolean {
  if (!envValue) return defaultValue;
  return envValue !== 'false';
}

function parseLogLevel(envValue: string | undefined): LogLevel {
  const level = envValue?.toLowerCase();
  if (!level) return 'info';
  return isLogLevel(level) ? level : 'info';
}

const ALLOWED_LOG_LEVELS: ReadonlySet<LogLevel> = new Set([
  'debug',
  'info',
  'warn',
  'error',
]);

function isLogLevel(value: string): value is LogLevel {
  return ALLOWED_LOG_LEVELS.has(value as LogLevel);
}

const host = process.env.HOST ?? '127.0.0.1';
const isLoopbackHost =
  host === '127.0.0.1' || host === '::1' || host === 'localhost';

export const config = {
  server: {
    name: 'superFetch',
    version: packageJson.version,
    port: parseInteger(process.env.PORT, 3000, 1024, 65535),
    host,
    sessionTtlMs: parseInteger(
      process.env.SESSION_TTL_MS,
      30 * 60 * 1000,
      60 * 1000,
      24 * 60 * 60 * 1000
    ),
    maxSessions: parseInteger(process.env.MAX_SESSIONS, 200, 10, 10000),
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
    maxInlineContentChars: parseInteger(
      process.env.MAX_INLINE_CONTENT_CHARS,
      20000,
      1000,
      200000
    ),
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
      /^100\.64\./,
      /^fc00:/i,
      /^fd00:/i,
      /^fe80:/i,
      /^::ffff:127\./,
      /^::ffff:10\./,
      /^::ffff:172\.(1[6-9]|2\d|3[01])\./,
      /^::ffff:192\.168\./,
      /^::ffff:169\.254\./,
    ] as readonly RegExp[],
    blockedHeaders: new Set([
      'host',
      'authorization',
      'cookie',
      'x-forwarded-for',
      'x-real-ip',
      'proxy-authorization',
    ]),
    apiKey: process.env.API_KEY,
    allowRemote: parseBoolean(process.env.ALLOW_REMOTE, false),
    requireAuth: parseBoolean(process.env.REQUIRE_AUTH, !isLoopbackHost),
  },
  rateLimit: {
    enabled: parseBoolean(process.env.RATE_LIMIT_ENABLED, true),
    maxRequests: parseInteger(process.env.RATE_LIMIT_MAX, 100, 1, 10000),
    windowMs: parseInteger(
      process.env.RATE_LIMIT_WINDOW_MS,
      60000,
      1000,
      3600000
    ),
    cleanupIntervalMs: parseInteger(
      process.env.RATE_LIMIT_CLEANUP_MS,
      60000,
      10000,
      3600000
    ),
  },
} as const;
