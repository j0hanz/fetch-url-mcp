import { buildIpv4 } from '../utils/ip-address.js';

import packageJson from '../../package.json' with { type: 'json' };
import { buildAuthConfig } from './auth-config.js';
import { SIZE_LIMITS, TIMEOUT } from './constants.js';
import {
  parseAllowedHosts,
  parseBoolean,
  parseInteger,
  parseLogLevel,
} from './env-parsers.js';

function formatHostForUrl(hostname: string): string {
  if (hostname.includes(':') && !hostname.startsWith('[')) {
    return `[${hostname}]`;
  }
  return hostname;
}

const LOOPBACK_V4 = buildIpv4([127, 0, 0, 1]);
const ANY_V4 = buildIpv4([0, 0, 0, 0]);
const METADATA_V4_AWS = buildIpv4([169, 254, 169, 254]);
const METADATA_V4_AZURE = buildIpv4([100, 100, 100, 200]);

const host = process.env.HOST ?? LOOPBACK_V4;
const port = parseInteger(process.env.PORT, 3000, 1024, 65535);
const baseUrl = new URL(`http://${formatHostForUrl(host)}:${port}`);

const isRemoteHost = host === ANY_V4 || host === '::';

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
    port,
    host,
    sessionTtlMs: TIMEOUT.DEFAULT_SESSION_TTL_MS,
    sessionInitTimeoutMs: 10000,
    maxSessions: 200,
  },
  fetcher: {
    timeout: TIMEOUT.DEFAULT_FETCH_TIMEOUT_MS,
    maxRedirects: 5,
    userAgent: process.env.USER_AGENT ?? 'superFetch-MCP/2.0',
    maxContentLength: SIZE_LIMITS.TEN_MB,
  },
  cache: {
    enabled: parseBoolean(process.env.CACHE_ENABLED, true),
    ttl: parseInteger(process.env.CACHE_TTL, 3600, 60, 86400),
    maxKeys: 100,
  },
  extraction: {
    maxBlockLength: 5000,
    minParagraphLength: 10,
  },
  logging: {
    level: parseLogLevel(process.env.LOG_LEVEL),
  },
  constants: {
    maxHtmlSize: SIZE_LIMITS.TEN_MB,
    maxUrlLength: 2048,
    maxInlineContentChars: 20000,
  },
  security: {
    blockedHosts: new Set([
      'localhost',
      LOOPBACK_V4,
      ANY_V4,
      '::1',
      METADATA_V4_AWS,
      'metadata.google.internal',
      'metadata.azure.com',
      METADATA_V4_AZURE,
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
    ],
    allowedHosts: parseAllowedHosts(process.env.ALLOWED_HOSTS),
    apiKey: process.env.API_KEY,
    allowRemote: isRemoteHost,
  },
  auth: buildAuthConfig(baseUrl),
  rateLimit: {
    enabled: true,
    maxRequests: 100,
    windowMs: 60000,
    cleanupIntervalMs: 60000,
  },
  runtime: runtimeState,
};

export function enableHttpMode(): void {
  runtimeState.httpMode = true;
}
