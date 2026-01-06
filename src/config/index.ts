import os from 'node:os';

import packageJson from '../../package.json' with { type: 'json' };
import { SIZE_LIMITS, TIMEOUT } from './constants.js';
import type { LogLevel } from './types/runtime.js';

function parseInteger(
  envValue: string | undefined,
  defaultValue: number,
  min?: number,
  max?: number
): number {
  if (!envValue) return defaultValue;
  const parsed = parseInt(envValue, 10);
  if (Number.isNaN(parsed)) return defaultValue;
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

interface RuntimeState {
  httpMode: boolean;
}

const runtimeState: RuntimeState = {
  httpMode: false,
};

export const config = {
  server: {
    name: 'superFetch',
    version: packageJson.version,
    port: parseInteger(process.env.PORT, 3000, 1024, 65535),
    host,
    trustProxy: parseBoolean(process.env.TRUST_PROXY, false),
    sessionTtlMs: parseInteger(
      process.env.SESSION_TTL_MS,
      TIMEOUT.DEFAULT_SESSION_TTL_MS,
      TIMEOUT.MIN_SESSION_TTL_MS,
      TIMEOUT.MAX_SESSION_TTL_MS
    ),
    sessionInitTimeoutMs: parseInteger(
      process.env.SESSION_INIT_TIMEOUT_MS,
      10000,
      1000,
      60000
    ),
    maxSessions: parseInteger(process.env.MAX_SESSIONS, 200, 10, 10000),
  },
  fetcher: {
    timeout: parseInteger(
      process.env.FETCH_TIMEOUT,
      TIMEOUT.DEFAULT_FETCH_TIMEOUT_MS,
      TIMEOUT.MIN_FETCH_TIMEOUT_MS,
      TIMEOUT.MAX_FETCH_TIMEOUT_MS
    ),
    maxRedirects: 5,
    userAgent: process.env.USER_AGENT ?? 'superFetch-MCP/1.0',
    maxContentLength: SIZE_LIMITS.TEN_MB,
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
  workers: {
    poolSize: Math.min(Math.max(os.availableParallelism() - 1, 1), 32),
  },
  logging: {
    level: parseLogLevel(process.env.LOG_LEVEL),
    enabled: parseBoolean(process.env.ENABLE_LOGGING, true),
  },
  constants: {
    maxHtmlSize: SIZE_LIMITS.TEN_MB,
    maxContentSize: SIZE_LIMITS.FIVE_MB,
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
  runtime: runtimeState,
} as const;

export function enableHttpMode(): void {
  runtimeState.httpMode = true;
}
