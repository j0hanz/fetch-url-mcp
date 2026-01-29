import packageJson from '../package.json' with { type: 'json' };

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type TransformMetadataFormat = 'markdown' | 'frontmatter';

function buildIpv4(parts: readonly [number, number, number, number]): string {
  return parts.join('.');
}

function formatHostForUrl(hostname: string): string {
  if (hostname.includes(':') && !hostname.startsWith('[')) {
    return `[${hostname}]`;
  }
  return hostname;
}

function normalizeHostValue(value: string): string | null {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return null;

  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']');
    if (end === -1) return null;
    return trimmed.slice(1, end);
  }

  const colonIndex = trimmed.indexOf(':');
  if (colonIndex !== -1) {
    return trimmed.slice(0, colonIndex);
  }

  return trimmed;
}

const ALLOWED_LOG_LEVELS: ReadonlySet<string> = new Set([
  'debug',
  'info',
  'warn',
  'error',
]);

function isLogLevel(value: string): value is LogLevel {
  return ALLOWED_LOG_LEVELS.has(value);
}

function isOutsideRange(
  value: number,
  min: number | undefined,
  max: number | undefined
): boolean {
  return (
    (min !== undefined && value < min) || (max !== undefined && value > max)
  );
}

function parseIntegerValue(
  envValue: string | undefined,
  min?: number,
  max?: number
): number | null {
  if (!envValue) return null;
  const parsed = parseInt(envValue, 10);
  if (Number.isNaN(parsed)) return null;
  if (isOutsideRange(parsed, min, max)) return null;
  return parsed;
}

function parseInteger(
  envValue: string | undefined,
  defaultValue: number,
  min?: number,
  max?: number
): number {
  return parseIntegerValue(envValue, min, max) ?? defaultValue;
}

function parseOptionalInteger(
  envValue: string | undefined,
  min?: number,
  max?: number
): number | undefined {
  return parseIntegerValue(envValue, min, max) ?? undefined;
}

function parseBoolean(
  envValue: string | undefined,
  defaultValue: boolean
): boolean {
  if (!envValue) return defaultValue;
  return envValue !== 'false';
}

function parseList(envValue: string | undefined): string[] {
  if (!envValue) return [];
  return envValue
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function parseUrlEnv(value: string | undefined, name: string): URL | undefined {
  if (!value) return undefined;
  if (!URL.canParse(value)) {
    throw new Error(`Invalid ${name} value: ${value}`);
  }
  return new URL(value);
}

function readUrlEnv(name: string): URL | undefined {
  return parseUrlEnv(process.env[name], name);
}

function parseAllowedHosts(envValue: string | undefined): Set<string> {
  const hosts = new Set<string>();
  for (const entry of parseList(envValue)) {
    const normalized = normalizeHostValue(entry);
    if (normalized) {
      hosts.add(normalized);
    }
  }
  return hosts;
}

function parseLogLevel(envValue: string | undefined): LogLevel {
  const level = envValue?.toLowerCase();
  if (!level) return 'info';
  return isLogLevel(level) ? level : 'info';
}

function parseTransformMetadataFormat(
  envValue: string | undefined
): TransformMetadataFormat {
  const normalized = envValue?.trim().toLowerCase();
  if (normalized === 'frontmatter') return 'frontmatter';
  return 'markdown';
}

const SIZE_LIMITS = {
  TEN_MB: 10 * 1024 * 1024,
};

const TIMEOUT = {
  DEFAULT_FETCH_TIMEOUT_MS: 15000,
  DEFAULT_SESSION_TTL_MS: 30 * 60 * 1000,
  DEFAULT_TRANSFORM_TIMEOUT_MS: parseInteger(
    process.env.TRANSFORM_TIMEOUT_MS,
    30000,
    5000,
    120000
  ),
};

const DEFAULT_TOOL_TIMEOUT_MS =
  TIMEOUT.DEFAULT_FETCH_TIMEOUT_MS +
  TIMEOUT.DEFAULT_TRANSFORM_TIMEOUT_MS +
  5000;

interface AuthConfig {
  mode: 'oauth' | 'static';
  issuerUrl: URL | undefined;
  authorizationUrl: URL | undefined;
  tokenUrl: URL | undefined;
  revocationUrl: URL | undefined;
  registrationUrl: URL | undefined;
  introspectionUrl: URL | undefined;
  resourceUrl: URL;
  requiredScopes: string[];
  clientId: string | undefined;
  clientSecret: string | undefined;
  introspectionTimeoutMs: number;
  staticTokens: string[];
}

function readCoreOAuthUrls(): {
  issuerUrl: URL | undefined;
  authorizationUrl: URL | undefined;
  tokenUrl: URL | undefined;
} {
  return {
    issuerUrl: readUrlEnv('OAUTH_ISSUER_URL'),
    authorizationUrl: readUrlEnv('OAUTH_AUTHORIZATION_URL'),
    tokenUrl: readUrlEnv('OAUTH_TOKEN_URL'),
  };
}

function readOptionalOAuthUrls(baseUrl: URL): {
  revocationUrl: URL | undefined;
  registrationUrl: URL | undefined;
  introspectionUrl: URL | undefined;
  resourceUrl: URL;
} {
  return {
    revocationUrl: readUrlEnv('OAUTH_REVOCATION_URL'),
    registrationUrl: readUrlEnv('OAUTH_REGISTRATION_URL'),
    introspectionUrl: readUrlEnv('OAUTH_INTROSPECTION_URL'),
    resourceUrl:
      parseUrlEnv(process.env.OAUTH_RESOURCE_URL, 'OAUTH_RESOURCE_URL') ??
      new URL('/mcp', baseUrl),
  };
}

function readOAuthUrls(baseUrl: URL): {
  issuerUrl: URL | undefined;
  authorizationUrl: URL | undefined;
  tokenUrl: URL | undefined;
  revocationUrl: URL | undefined;
  registrationUrl: URL | undefined;
  introspectionUrl: URL | undefined;
  resourceUrl: URL;
} {
  return { ...readCoreOAuthUrls(), ...readOptionalOAuthUrls(baseUrl) };
}

function resolveAuthMode(
  authModeEnv: string | undefined,
  urls: {
    issuerUrl: URL | undefined;
    authorizationUrl: URL | undefined;
    tokenUrl: URL | undefined;
    introspectionUrl: URL | undefined;
  }
): 'oauth' | 'static' {
  if (authModeEnv === 'oauth') return 'oauth';
  if (authModeEnv === 'static') return 'static';

  const oauthConfigured = [
    urls.issuerUrl,
    urls.authorizationUrl,
    urls.tokenUrl,
    urls.introspectionUrl,
  ].some((value) => value !== undefined);
  return oauthConfigured ? 'oauth' : 'static';
}

function collectStaticTokens(): string[] {
  const staticTokens = new Set<string>(parseList(process.env.ACCESS_TOKENS));
  if (process.env.API_KEY) {
    staticTokens.add(process.env.API_KEY);
  }
  return [...staticTokens];
}

function buildAuthConfig(baseUrl: URL): AuthConfig {
  const urls = readOAuthUrls(baseUrl);
  const mode = resolveAuthMode(process.env.AUTH_MODE?.toLowerCase(), urls);

  return {
    mode,
    ...urls,
    requiredScopes: parseList(process.env.OAUTH_REQUIRED_SCOPES),
    clientId: process.env.OAUTH_CLIENT_ID,
    clientSecret: process.env.OAUTH_CLIENT_SECRET,
    introspectionTimeoutMs: parseInteger(
      process.env.OAUTH_INTROSPECTION_TIMEOUT_MS,
      5000,
      1000,
      30000
    ),
    staticTokens: collectStaticTokens(),
  };
}

const LOOPBACK_V4 = buildIpv4([127, 0, 0, 1]);
const ANY_V4 = buildIpv4([0, 0, 0, 0]);
const METADATA_V4_AWS = buildIpv4([169, 254, 169, 254]);
const METADATA_V4_AZURE = buildIpv4([100, 100, 100, 200]);

const host = process.env.HOST ?? LOOPBACK_V4;
const port =
  process.env.PORT?.trim() === '0'
    ? 0
    : parseInteger(process.env.PORT, 3000, 1024, 65535);
const baseUrl = new URL(`http://${formatHostForUrl(host)}:${port}`);

const allowRemote = parseBoolean(process.env.ALLOW_REMOTE, false);

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
    http: {
      headersTimeoutMs: parseOptionalInteger(
        process.env.SERVER_HEADERS_TIMEOUT_MS,
        1000,
        600000
      ),
      requestTimeoutMs: parseOptionalInteger(
        process.env.SERVER_REQUEST_TIMEOUT_MS,
        1000,
        600000
      ),
      keepAliveTimeoutMs: parseOptionalInteger(
        process.env.SERVER_KEEP_ALIVE_TIMEOUT_MS,
        1000,
        600000
      ),
      shutdownCloseIdleConnections: parseBoolean(
        process.env.SERVER_SHUTDOWN_CLOSE_IDLE,
        false
      ),
      shutdownCloseAllConnections: parseBoolean(
        process.env.SERVER_SHUTDOWN_CLOSE_ALL,
        false
      ),
    },
  },
  fetcher: {
    timeout: TIMEOUT.DEFAULT_FETCH_TIMEOUT_MS,
    maxRedirects: 5,
    userAgent: process.env.USER_AGENT ?? 'superFetch-MCP/2.0',
    maxContentLength: SIZE_LIMITS.TEN_MB,
  },
  transform: {
    timeoutMs: TIMEOUT.DEFAULT_TRANSFORM_TIMEOUT_MS,
    metadataFormat: parseTransformMetadataFormat(
      process.env.TRANSFORM_METADATA_FORMAT
    ),
  },
  tools: {
    timeoutMs: parseInteger(
      process.env.TOOL_TIMEOUT_MS,
      DEFAULT_TOOL_TIMEOUT_MS,
      1000,
      300000
    ),
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
  noiseRemoval: {
    extraTokens: parseList(process.env.SUPERFETCH_EXTRA_NOISE_TOKENS),
    extraSelectors: parseList(process.env.SUPERFETCH_EXTRA_NOISE_SELECTORS),
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
    ] as const,
    // Combined regex patterns for fast IP blocking (used in fetch.ts)
    // Split into two patterns to reduce complexity while maintaining performance
    blockedIpPattern:
      /^(?:10\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.168\.|127\.|0\.|169\.254\.|100\.64\.|fc00:|fd00:|fe80:)/i,
    blockedIpv4MappedPattern:
      /^::ffff:(?:127\.|10\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.)/i,
    allowedHosts: parseAllowedHosts(process.env.ALLOWED_HOSTS),
    apiKey: process.env.API_KEY,
    allowRemote,
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
