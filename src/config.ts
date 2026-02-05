import packageJson from '../package.json' with { type: 'json' };

export const serverVersion: string = packageJson.version;

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type TransformMetadataFormat = 'markdown' | 'frontmatter';

const { env } = process;

class ConfigError extends Error {
  override name = 'ConfigError';
}

function buildIpv4(parts: readonly [number, number, number, number]): string {
  return parts.join('.');
}

function formatHostForUrl(hostname: string): string {
  // IPv6 literal in URLs must be wrapped in brackets.
  if (hostname.includes(':') && !hostname.startsWith('['))
    return `[${hostname}]`;
  return hostname;
}

function normalizeHostValue(value: string): string | null {
  const raw = value.trim();
  if (!raw) return null;

  // Accept full URLs (e.g. "https://example.com:443/path") by extracting the hostname.
  if (raw.includes('://') && URL.canParse(raw)) {
    return new URL(raw).hostname.toLowerCase();
  }

  const trimmed = raw.toLowerCase();

  // Bracketed IPv6 literal, possibly with a port: "[::1]:8080"
  if (trimmed.startsWith('[')) {
    if (!trimmed.includes(']')) return null;
    const end = trimmed.indexOf(']');
    return trimmed.slice(1, end);
  }

  if (!trimmed.includes(':')) return trimmed;
  const firstColon = trimmed.indexOf(':');

  // If there are multiple colons, assume an IPv6 literal without brackets.
  if (trimmed.includes(':', firstColon + 1)) return trimmed;

  // Otherwise treat as "host:port".
  const host = trimmed.slice(0, firstColon);
  return host || null;
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
  const parsed = Number.parseInt(envValue, 10);
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

  // Anything except "false" enables.
  return envValue.trim().toLowerCase() !== 'false';
}

function parseList(envValue: string | undefined): string[] {
  if (!envValue) return [];
  return envValue
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function parseFloatOrDefault(
  envValue: string | undefined,
  defaultValue: number
): number {
  if (!envValue) return defaultValue;
  const parsed = Number.parseFloat(envValue);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

function parseUrlEnv(value: string | undefined, name: string): URL | undefined {
  if (!value) return undefined;
  if (!URL.canParse(value)) {
    throw new ConfigError(`Invalid ${name} value: ${value}`);
  }
  return new URL(value);
}

function readUrlEnv(name: string): URL | undefined {
  return parseUrlEnv(env[name], name);
}

function parseAllowedHosts(envValue: string | undefined): Set<string> {
  const hosts = new Set<string>();
  for (const entry of parseList(envValue)) {
    const normalized = normalizeHostValue(entry);
    if (normalized) hosts.add(normalized);
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
  return normalized === 'frontmatter' ? 'frontmatter' : 'markdown';
}

const SIZE_LIMITS = {
  TEN_MB: 10 * 1024 * 1024,
};

const TIMEOUT = {
  DEFAULT_FETCH_TIMEOUT_MS: parseInteger(
    env.FETCH_TIMEOUT_MS,
    15000,
    1000,
    60000
  ),
  DEFAULT_SESSION_TTL_MS: 30 * 60 * 1000,
  DEFAULT_TRANSFORM_TIMEOUT_MS: parseInteger(
    env.TRANSFORM_TIMEOUT_MS,
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
      parseUrlEnv(env.OAUTH_RESOURCE_URL, 'OAUTH_RESOURCE_URL') ??
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
  const staticTokens = new Set<string>(parseList(env.ACCESS_TOKENS));
  if (env.API_KEY) staticTokens.add(env.API_KEY);
  return [...staticTokens];
}

function buildAuthConfig(baseUrl: URL): AuthConfig {
  const urls = readOAuthUrls(baseUrl);
  const mode = resolveAuthMode(env.AUTH_MODE?.toLowerCase(), urls);

  return {
    mode,
    ...urls,
    requiredScopes: parseList(env.OAUTH_REQUIRED_SCOPES),
    clientId: env.OAUTH_CLIENT_ID,
    clientSecret: env.OAUTH_CLIENT_SECRET,
    introspectionTimeoutMs: parseInteger(
      env.OAUTH_INTROSPECTION_TIMEOUT_MS,
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

const host = (env.HOST ?? LOOPBACK_V4).trim();
const port =
  env.PORT?.trim() === '0' ? 0 : parseInteger(env.PORT, 3000, 1024, 65535);

const baseUrl = new URL(`http://${formatHostForUrl(host)}:${port}`);

const allowRemote = parseBoolean(env.ALLOW_REMOTE, false);

interface RuntimeState {
  httpMode: boolean;
}

const runtimeState: RuntimeState = {
  httpMode: false,
};

export const config = {
  server: {
    name: 'superFetch',
    version: serverVersion,
    port,
    host,
    sessionTtlMs: TIMEOUT.DEFAULT_SESSION_TTL_MS,
    sessionInitTimeoutMs: 10000,
    maxSessions: 200,
    http: {
      headersTimeoutMs: parseOptionalInteger(
        env.SERVER_HEADERS_TIMEOUT_MS,
        1000,
        600000
      ),
      requestTimeoutMs: parseOptionalInteger(
        env.SERVER_REQUEST_TIMEOUT_MS,
        1000,
        600000
      ),
      keepAliveTimeoutMs: parseOptionalInteger(
        env.SERVER_KEEP_ALIVE_TIMEOUT_MS,
        1000,
        600000
      ),
      shutdownCloseIdleConnections: parseBoolean(
        env.SERVER_SHUTDOWN_CLOSE_IDLE,
        false
      ),
      shutdownCloseAllConnections: parseBoolean(
        env.SERVER_SHUTDOWN_CLOSE_ALL,
        false
      ),
    },
  },
  fetcher: {
    timeout: TIMEOUT.DEFAULT_FETCH_TIMEOUT_MS,
    maxRedirects: 5,
    userAgent: env.USER_AGENT ?? 'superFetch-MCP/2.0',
    maxContentLength: SIZE_LIMITS.TEN_MB,
  },
  transform: {
    timeoutMs: TIMEOUT.DEFAULT_TRANSFORM_TIMEOUT_MS,
    stageWarnRatio: parseFloatOrDefault(env.TRANSFORM_STAGE_WARN_RATIO, 0.5),
    metadataFormat: parseTransformMetadataFormat(env.TRANSFORM_METADATA_FORMAT),
    maxWorkerScale: parseInteger(env.TRANSFORM_WORKER_MAX_SCALE, 4, 1, 16),
  },
  tools: {
    enabled: parseList(env.ENABLED_TOOLS ?? 'fetch-url'),
    timeoutMs: parseInteger(
      env.TOOL_TIMEOUT_MS,
      DEFAULT_TOOL_TIMEOUT_MS,
      1000,
      300000
    ),
  },
  cache: {
    enabled: parseBoolean(env.CACHE_ENABLED, true),
    ttl: parseInteger(env.CACHE_TTL, 3600, 60, 86400),
    maxKeys: 100,
  },
  extraction: {
    maxBlockLength: 5000,
    minParagraphLength: 10,
  },
  noiseRemoval: {
    extraTokens: parseList(env.SUPERFETCH_EXTRA_NOISE_TOKENS),
    extraSelectors: parseList(env.SUPERFETCH_EXTRA_NOISE_SELECTORS),
    enabledCategories: parseList(
      env.NOISE_REMOVAL_CATEGORIES ??
        'cookie-banners,newsletters,social-share,nav-footer'
    ),
    debug: parseBoolean(env.DEBUG_NOISE_REMOVAL, false),
    aggressiveMode: parseBoolean(env.SUPERFETCH_AGGRESSIVE_NOISE, false),
    preserveSvgCanvas: parseBoolean(env.SUPERFETCH_PRESERVE_SVG_CANVAS, false),
    weights: {
      hidden: parseInteger(env.NOISE_WEIGHT_HIDDEN, 50, 0, 100),
      structural: parseInteger(env.NOISE_WEIGHT_STRUCTURAL, 50, 0, 100),
      promo: parseInteger(env.NOISE_WEIGHT_PROMO, 35, 0, 100),
      stickyFixed: parseInteger(env.NOISE_WEIGHT_STICKY_FIXED, 30, 0, 100),
      threshold: parseInteger(env.NOISE_WEIGHT_THRESHOLD, 50, 0, 100),
    },
  },
  markdownCleanup: {
    promoteOrphanHeadings: parseBoolean(
      env.MARKDOWN_PROMOTE_ORPHAN_HEADINGS,
      true
    ),
    removeSkipLinks: parseBoolean(env.MARKDOWN_REMOVE_SKIP_LINKS, true),
    removeTocBlocks: parseBoolean(env.MARKDOWN_REMOVE_TOC_BLOCKS, true),
  },
  logging: {
    level: parseLogLevel(env.LOG_LEVEL),
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
    // Fast IP block regexes.
    blockedIpPattern:
      /^(?:10\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.168\.|127\.|0\.|169\.254\.|100\.64\.|fc00:|fd00:|fe80:)/i,
    blockedIpv4MappedPattern:
      /^::ffff:(?:127\.|10\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.)/i,
    allowedHosts: parseAllowedHosts(env.ALLOWED_HOSTS),
    apiKey: env.API_KEY,
    allowRemote,
  },
  auth: buildAuthConfig(baseUrl),
  rateLimit: {
    enabled: true,
    maxRequests: parseInteger(env.RATE_LIMIT_MAX, 100, 1, 10000),
    windowMs: parseInteger(env.RATE_LIMIT_WINDOW_MS, 60000, 1000, 3600000),
    cleanupIntervalMs: 60000,
  },
  runtime: runtimeState,
};

export function enableHttpMode(): void {
  runtimeState.httpMode = true;
}
