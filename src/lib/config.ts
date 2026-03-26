import { readFileSync } from 'node:fs';
import { findPackageJSON } from 'node:module';
import process from 'node:process';

import { z } from 'zod';

import {
  buildIpv4,
  isIP,
  normalizeHostname,
  stripTrailingDots,
} from './url.js';
import { getErrorMessage } from './utils.js';

// ── Version ─────────────────────────────────────────────────────────

function hasPackageJsonVersion(value: unknown): value is { version: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { version?: unknown }).version === 'string'
  );
}

function readServerVersion(moduleUrl: string): string {
  const packageJsonPath = findPackageJSON(moduleUrl);
  if (!packageJsonPath) throw new Error('package.json not found');

  let packageJson: unknown;
  try {
    packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
  } catch (error) {
    throw new Error(
      `Failed to parse package.json at ${packageJsonPath}: ${getErrorMessage(error)}`,
      { cause: error }
    );
  }
  if (!hasPackageJsonVersion(packageJson)) {
    throw new Error(`package.json version is missing at ${packageJsonPath}`);
  }

  return packageJson.version;
}

export const serverVersion: string = readServerVersion(import.meta.url);

// ── Types ───────────────────────────────────────────────────────────

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];
const ALLOWED_LOG_LEVELS: ReadonlySet<string> = new Set(LOG_LEVELS);

const DEFAULT_HEADING_KEYWORDS = [
  'overview',
  'introduction',
  'summary',
  'conclusion',
  'prerequisites',
  'requirements',
  'installation',
  'configuration',
  'usage',
  'features',
  'limitations',
  'troubleshooting',
  'faq',
  'resources',
  'references',
  'changelog',
  'license',
  'acknowledgments',
  'appendix',
] as const;

type TransformWorkerMode = 'threads' | 'process';
type AuthMode = 'oauth' | 'static';

class ConfigError extends Error {
  override name = 'ConfigError';
}

// ── Environment ─────────────────────────────────────────────────────

function isMissingEnvFileError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const { code } = error as { code?: string };
  return code === 'ENOENT' || code === 'ERR_ENV_FILE_NOT_FOUND';
}

function loadEnvFileIfAvailable(): void {
  if (typeof process.loadEnvFile !== 'function') return;
  try {
    process.loadEnvFile();
  } catch (error) {
    if (isMissingEnvFileError(error)) return;
    throw error;
  }
}

loadEnvFileIfAvailable();

const { env } = process;

const ENV_BOOLEAN_SCHEMA = z.stringbool({
  truthy: ['true', '1', 'yes', 'on'],
  falsy: ['false', '0', 'no', 'off'],
});

interface IntegerParseOptions {
  min?: number;
  max?: number;
  envName?: string;
}

// ── Host parsing helpers ────────────────────────────────────────────

function tryParseUrlHost(raw: string): string | null | undefined {
  if (raw.includes('://')) {
    const hostname = URL.parse(raw)?.hostname;
    if (hostname) return normalizeHostname(hostname);
  }
  const candidateHostname = URL.parse(`http://${raw}`)?.hostname;
  if (candidateHostname) return normalizeHostname(candidateHostname);
  return undefined;
}

function tryParseIpv6Bracket(lowered: string): string | null | undefined {
  if (!lowered.startsWith('[')) return undefined;
  const end = lowered.indexOf(']');
  return end === -1 ? null : normalizeHostname(lowered.slice(1, end));
}

function tryParseHostPort(lowered: string): string | null {
  const firstColon = lowered.indexOf(':');
  if (firstColon === -1) return normalizeHostname(lowered);
  if (lowered.includes(':', firstColon + 1)) return null;
  const host = lowered.slice(0, firstColon);
  return host ? normalizeHostname(host) : null;
}

// ── EnvParser ───────────────────────────────────────────────────────

const EnvParser = {
  integerValue(
    envValue: string | undefined,
    opts?: IntegerParseOptions
  ): number | null {
    if (!envValue) return null;
    const parsed = Number.parseInt(envValue, 10);
    if (Number.isNaN(parsed)) {
      if (opts?.envName)
        process.stderr.write(
          `Warning: ignoring invalid ${opts.envName} value "${envValue}" (not an integer)\n`
        );
      return null;
    }
    if (
      (opts?.min !== undefined && parsed < opts.min) ||
      (opts?.max !== undefined && parsed > opts.max)
    ) {
      if (opts.envName)
        process.stderr.write(
          `Warning: ignoring out-of-range ${opts.envName} value ${parsed} (allowed: ${opts.min ?? '-∞'}..${opts.max ?? '∞'})\n`
        );
      return null;
    }
    return parsed;
  },
  optionalInteger(
    envValue: string | undefined,
    opts?: IntegerParseOptions
  ): number | undefined {
    return EnvParser.integerValue(envValue, opts) ?? undefined;
  },
  integer(
    envValue: string | undefined,
    defaultValue: number,
    opts?: IntegerParseOptions
  ): number {
    return EnvParser.integerValue(envValue, opts) ?? defaultValue;
  },
  boolean(
    envValue: string | undefined,
    defaultValue: boolean,
    envName?: string
  ): boolean {
    const trimmed = envValue?.trim();
    if (!trimmed) return defaultValue;
    const parsed = ENV_BOOLEAN_SCHEMA.safeParse(trimmed);
    if (!parsed.success) {
      if (envName)
        process.stderr.write(
          `Warning: ignoring invalid ${envName} value "${envValue ?? ''}" (expected true/false, 1/0, yes/no, or on/off)\n`
        );
      return defaultValue;
    }
    return parsed.data;
  },
  list(
    envValue: string | undefined,
    defaultValue?: readonly string[]
  ): string[] {
    if (!envValue) return defaultValue ? [...defaultValue] : [];
    const parsed = envValue
      .split(/[\s,]+/)
      .map((e) => e.trim())
      .filter(Boolean);
    return parsed.length > 0 || !defaultValue ? parsed : [...defaultValue];
  },
  locale(value: string | undefined): string | undefined {
    const lowered = value?.trim().toLowerCase();
    return !lowered || lowered === 'system' || lowered === 'default'
      ? undefined
      : lowered;
  },
  logLevel(envValue: string | undefined): LogLevel {
    const level = envValue?.toLowerCase();
    if (!level || !ALLOWED_LOG_LEVELS.has(level)) {
      if (envValue)
        process.stderr.write(
          `Warning: ignoring invalid LOG_LEVEL value "${envValue}", using default "info"\n`
        );
      return 'info';
    }
    return level as LogLevel;
  },
  transformWorkerMode(envValue: string | undefined): TransformWorkerMode {
    const normalized = envValue?.trim().toLowerCase();
    return normalized === 'process' || normalized === 'fork'
      ? 'process'
      : 'threads';
  },
  url(value: string | undefined, name: string): URL | undefined {
    if (!value) return undefined;
    const parsed = URL.parse(value);
    if (!parsed) throw new ConfigError(`Invalid ${name} value: ${value}`);
    return parsed;
  },
  allowedHosts(envValue: string | undefined): Set<string> {
    return new Set(
      EnvParser.list(envValue)
        .map((h) => EnvParser.normalizeHostValue(h))
        .filter((h): h is string => h !== null)
    );
  },
  optionalFilePath(value: string | undefined): string | undefined {
    const trimmed = value?.trim();
    return trimmed === '' ? undefined : trimmed;
  },
  normalizeHostValue(value: string): string | null {
    const raw = value.trim();
    if (!raw) return null;

    const fromUrl = tryParseUrlHost(raw);
    if (fromUrl !== undefined) return fromUrl;

    const lowered = raw.toLowerCase();

    const fromBracket = tryParseIpv6Bracket(lowered);
    if (fromBracket !== undefined) return fromBracket;

    if (isIP(lowered) === 6) return stripTrailingDots(lowered);

    return tryParseHostPort(lowered);
  },
  formatHostForUrl(hostname: string): string {
    if (hostname.includes(':') && !hostname.startsWith('['))
      return `[${hostname}]`;
    return hostname;
  },
};

// ── Constants ───────────────────────────────────────────────────────

const MAX_HTML_BYTES = 10 * 1024 * 1024;
const MAX_INLINE_CONTENT_CHARS = EnvParser.integer(
  env['MAX_INLINE_CONTENT_CHARS'],
  0,
  { min: 0, max: MAX_HTML_BYTES, envName: 'MAX_INLINE_CONTENT_CHARS' }
);
const DEFAULT_SESSION_TTL_MS = 30 * 60 * 1000;
const DEFAULT_SESSION_INIT_TIMEOUT_MS = 10000;
const DEFAULT_MAX_SESSIONS = 200;
const DEFAULT_USER_AGENT = `fetch-url-mcp/${serverVersion}`;
const DEFAULT_TOOL_TIMEOUT_PADDING_MS = 5000;
const DEFAULT_TRANSFORM_TIMEOUT_MS = 30000;
const DEFAULT_FETCH_TIMEOUT_MS = EnvParser.integer(
  env['FETCH_TIMEOUT_MS'],
  15000,
  { min: 1000, max: 60000, envName: 'FETCH_TIMEOUT_MS' }
);
const DEFAULT_TOOL_TIMEOUT_MS =
  DEFAULT_FETCH_TIMEOUT_MS +
  DEFAULT_TRANSFORM_TIMEOUT_MS +
  DEFAULT_TOOL_TIMEOUT_PADDING_MS;
const DEFAULT_TASKS_MAX_TOTAL = EnvParser.integer(
  env['TASKS_MAX_TOTAL'],
  5000,
  { min: 1, envName: 'TASKS_MAX_TOTAL' }
);
const DEFAULT_TASKS_MAX_PER_OWNER = EnvParser.integer(
  env['TASKS_MAX_PER_OWNER'],
  1000,
  { min: 1, envName: 'TASKS_MAX_PER_OWNER' }
);
const RESOLVED_TASKS_MAX_PER_OWNER = Math.min(
  DEFAULT_TASKS_MAX_PER_OWNER,
  DEFAULT_TASKS_MAX_TOTAL
);

// ── Config section interfaces ───────────────────────────────────────

interface WorkerResourceLimits {
  maxOldGenerationSizeMb?: number;
  maxYoungGenerationSizeMb?: number;
  codeRangeSizeMb?: number;
  stackSizeMb?: number;
}

function resolveWorkerResourceLimits(): WorkerResourceLimits | undefined {
  const limits: WorkerResourceLimits = {};
  const keys: Record<keyof WorkerResourceLimits, string> = {
    maxOldGenerationSizeMb: 'TRANSFORM_WORKER_MAX_OLD_GENERATION_MB',
    maxYoungGenerationSizeMb: 'TRANSFORM_WORKER_MAX_YOUNG_GENERATION_MB',
    codeRangeSizeMb: 'TRANSFORM_WORKER_CODE_RANGE_MB',
    stackSizeMb: 'TRANSFORM_WORKER_STACK_MB',
  };

  let hasLimits = false;
  for (const [prop, envKey] of Object.entries(keys)) {
    const val = EnvParser.optionalInteger(env[envKey], {
      min: 1,
      envName: envKey,
    });
    if (val !== undefined) {
      limits[prop as keyof WorkerResourceLimits] = val;
      hasLimits = true;
    }
  }

  return hasLimits ? limits : undefined;
}

interface AuthConfig {
  mode: AuthMode;
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

interface HttpsConfig {
  enabled: boolean;
  keyFile: string | undefined;
  certFile: string | undefined;
  caFile: string | undefined;
}

function buildAuthConfig(baseUrl: URL): AuthConfig {
  const parseUrl = (key: string): URL | undefined =>
    EnvParser.url(env[key], key);

  const issuerUrl = parseUrl('OAUTH_ISSUER_URL');
  const authorizationUrl = parseUrl('OAUTH_AUTHORIZATION_URL');
  const tokenUrl = parseUrl('OAUTH_TOKEN_URL');
  const revocationUrl = parseUrl('OAUTH_REVOCATION_URL');
  const registrationUrl = parseUrl('OAUTH_REGISTRATION_URL');
  const introspectionUrl = parseUrl('OAUTH_INTROSPECTION_URL');
  const resourceUrl = new URL('/mcp', baseUrl);

  const oauthConfigured =
    issuerUrl !== undefined ||
    authorizationUrl !== undefined ||
    tokenUrl !== undefined ||
    introspectionUrl !== undefined;

  const tokens = EnvParser.list(env['ACCESS_TOKENS']);
  if (env['API_KEY']) tokens.push(env['API_KEY']);

  return {
    mode: oauthConfigured ? 'oauth' : 'static',
    issuerUrl,
    authorizationUrl,
    tokenUrl,
    revocationUrl,
    registrationUrl,
    introspectionUrl,
    resourceUrl,
    requiredScopes: EnvParser.list(env['OAUTH_REQUIRED_SCOPES']),
    clientId: env['OAUTH_CLIENT_ID'],
    clientSecret: env['OAUTH_CLIENT_SECRET'],
    introspectionTimeoutMs: 5000,
    staticTokens: [...new Set(tokens)],
  };
}

function buildHttpsConfig(): HttpsConfig {
  const keyFile = EnvParser.optionalFilePath(env['SERVER_TLS_KEY_FILE']);
  const certFile = EnvParser.optionalFilePath(env['SERVER_TLS_CERT_FILE']);
  const caFile = EnvParser.optionalFilePath(env['SERVER_TLS_CA_FILE']);

  if ((keyFile && !certFile) || (!keyFile && certFile)) {
    throw new ConfigError(
      'Both SERVER_TLS_KEY_FILE and SERVER_TLS_CERT_FILE must be set together'
    );
  }

  return {
    enabled: Boolean(keyFile && certFile),
    keyFile,
    certFile,
    caFile,
  };
}

// ── Blocked hosts ───────────────────────────────────────────────────

const LOOPBACK_V4 = buildIpv4([127, 0, 0, 1]);
const ANY_V4 = buildIpv4([0, 0, 0, 0]);
const METADATA_V4_AWS = buildIpv4([169, 254, 169, 254]);
const METADATA_V4_AZURE = buildIpv4([100, 100, 100, 200]);
const BLOCKED_HOSTS = new Set<string>([
  'localhost',
  LOOPBACK_V4,
  ANY_V4,
  '::1',
  METADATA_V4_AWS,
  'metadata.google.internal',
  'metadata.azure.com',
  METADATA_V4_AZURE,
  'instance-data',
]);

// ── Server binding ──────────────────────────────────────────────────

const host = (env['HOST'] ?? LOOPBACK_V4).trim();
const port =
  env['PORT']?.trim() === '0'
    ? 0
    : EnvParser.integer(env['PORT'], 3000, {
        min: 1024,
        max: 65535,
        envName: 'PORT',
      });
const httpsConfig = buildHttpsConfig();
const allowRemote = EnvParser.boolean(
  env['ALLOW_REMOTE'],
  false,
  'ALLOW_REMOTE'
);
const baseUrl = new URL(
  `${httpsConfig.enabled ? 'https' : 'http'}://${EnvParser.formatHostForUrl(host)}:${port}`
);

// ── Runtime state ───────────────────────────────────────────────────

interface RuntimeState {
  httpMode: boolean;
}

const runtimeState: RuntimeState = {
  httpMode: false,
};

// ── Config section builders ─────────────────────────────────────────

interface AppServerHttpConfig {
  headersTimeoutMs: number | undefined;
  requestTimeoutMs: number | undefined;
  keepAliveTimeoutMs: number | undefined;
  keepAliveTimeoutBufferMs: number | undefined;
  maxHeadersCount: number | undefined;
  maxConnections: number;
  blockPrivateConnections: boolean;
  shutdownCloseIdleConnections: boolean;
  shutdownCloseAllConnections: boolean;
}

interface AppServerConfig {
  name: string;
  version: string;
  port: number;
  host: string;
  https: HttpsConfig;
  sessionTtlMs: number;
  sessionInitTimeoutMs: number;
  maxSessions: number;
  http: AppServerHttpConfig;
}

function buildServerConfig(): AppServerConfig {
  const parseOptInt = (key: string, min = 1): number | undefined =>
    EnvParser.optionalInteger(env[key], { min, envName: key });

  return {
    name: 'fetch-url-mcp',
    version: serverVersion,
    port,
    host,
    https: httpsConfig,
    sessionTtlMs: DEFAULT_SESSION_TTL_MS,
    sessionInitTimeoutMs: DEFAULT_SESSION_INIT_TIMEOUT_MS,
    maxSessions: DEFAULT_MAX_SESSIONS,
    http: {
      headersTimeoutMs: parseOptInt('SERVER_HEADERS_TIMEOUT_MS'),
      requestTimeoutMs: parseOptInt('SERVER_REQUEST_TIMEOUT_MS', 0),
      keepAliveTimeoutMs: parseOptInt('SERVER_KEEP_ALIVE_TIMEOUT_MS'),
      keepAliveTimeoutBufferMs: parseOptInt(
        'SERVER_KEEP_ALIVE_TIMEOUT_BUFFER_MS',
        0
      ),
      maxHeadersCount: parseOptInt('SERVER_MAX_HEADERS_COUNT'),
      maxConnections: EnvParser.integer(env['SERVER_MAX_CONNECTIONS'], 0, {
        min: 0,
        envName: 'SERVER_MAX_CONNECTIONS',
      }),
      blockPrivateConnections: EnvParser.boolean(
        env['SERVER_BLOCK_PRIVATE_CONNECTIONS'],
        false,
        'SERVER_BLOCK_PRIVATE_CONNECTIONS'
      ),
      shutdownCloseIdleConnections: true,
      shutdownCloseAllConnections: false,
    },
  };
}

interface AppFetcherConfig {
  timeout: number;
  maxRedirects: number;
  userAgent: string;
  maxContentLength: number;
}

function buildFetcherConfig(): AppFetcherConfig {
  return {
    timeout: DEFAULT_FETCH_TIMEOUT_MS,
    maxRedirects: 5,
    userAgent: env['USER_AGENT'] ?? DEFAULT_USER_AGENT,
    maxContentLength: MAX_HTML_BYTES,
  };
}

interface AppTransformConfig {
  timeoutMs: number;
  stageWarnRatio: number;
  metadataFormat: string;
  maxWorkerScale: number;
  cancelAckTimeoutMs: number;
  workerMode: TransformWorkerMode;
  workerResourceLimits: WorkerResourceLimits | undefined;
}

function buildTransformConfig(): AppTransformConfig {
  return {
    timeoutMs: DEFAULT_TRANSFORM_TIMEOUT_MS,
    stageWarnRatio: 0.5,
    metadataFormat: 'markdown',
    maxWorkerScale: 4,
    cancelAckTimeoutMs: EnvParser.integer(
      env['TRANSFORM_CANCEL_ACK_TIMEOUT_MS'],
      200,
      { min: 50, max: 5000, envName: 'TRANSFORM_CANCEL_ACK_TIMEOUT_MS' }
    ),
    workerMode: EnvParser.transformWorkerMode(env['TRANSFORM_WORKER_MODE']),
    workerResourceLimits: resolveWorkerResourceLimits(),
  };
}

interface AppTasksConfig {
  maxTotal: number;
  maxPerOwner: number;
  emitStatusNotifications: boolean;
  requireInterception: boolean;
}

function buildTasksConfig(): AppTasksConfig {
  return {
    maxTotal: DEFAULT_TASKS_MAX_TOTAL,
    maxPerOwner: RESOLVED_TASKS_MAX_PER_OWNER,
    emitStatusNotifications: EnvParser.boolean(
      env['TASKS_STATUS_NOTIFICATIONS'],
      false,
      'TASKS_STATUS_NOTIFICATIONS'
    ),
    requireInterception: EnvParser.boolean(
      env['TASKS_REQUIRE_INTERCEPTION'],
      true,
      'TASKS_REQUIRE_INTERCEPTION'
    ),
  };
}

interface AppCacheConfig {
  enabled: boolean;
  ttl: number;
  maxKeys: number;
  maxSizeBytes: number;
}

function buildCacheConfig(): AppCacheConfig {
  return {
    enabled: EnvParser.boolean(env['CACHE_ENABLED'], true, 'CACHE_ENABLED'),
    ttl: 86400,
    maxKeys: 100,
    maxSizeBytes: 50 * 1024 * 1024,
  };
}

interface AppNoiseRemovalConfig {
  extraTokens: string[];
  extraSelectors: string[];
  enabledCategories: string[];
  debug: boolean;
  aggressiveMode: boolean;
  preserveSvgCanvas: boolean;
  weights: {
    hidden: number;
    structural: number;
    promo: number;
    stickyFixed: number;
    threshold: number;
  };
}

function buildNoiseRemovalConfig(): AppNoiseRemovalConfig {
  return {
    extraTokens: EnvParser.list(env['FETCH_URL_MCP_EXTRA_NOISE_TOKENS']),
    extraSelectors: EnvParser.list(env['FETCH_URL_MCP_EXTRA_NOISE_SELECTORS']),
    enabledCategories: [
      'cookie-banners',
      'newsletters',
      'social-share',
      'nav-footer',
      'author-blocks',
      'related-content',
    ],
    debug: false,
    aggressiveMode: false,
    preserveSvgCanvas: false,
    weights: {
      hidden: 50,
      structural: 50,
      promo: 35,
      stickyFixed: 30,
      threshold: 50,
    },
  };
}

interface AppMarkdownCleanupConfig {
  promoteOrphanHeadings: boolean;
  removeSkipLinks: boolean;
  removeTocBlocks: boolean;
  removeTypeDocComments: boolean;
  headingKeywords: string[];
}

function buildMarkdownCleanupConfig(): AppMarkdownCleanupConfig {
  return {
    promoteOrphanHeadings: true,
    removeSkipLinks: true,
    removeTocBlocks: true,
    removeTypeDocComments: true,
    headingKeywords: EnvParser.list(
      env['MARKDOWN_HEADING_KEYWORDS'],
      DEFAULT_HEADING_KEYWORDS
    ),
  };
}

// ── Config object ───────────────────────────────────────────────────

export const config = {
  server: buildServerConfig(),
  fetcher: buildFetcherConfig(),
  transform: buildTransformConfig(),
  tools: {
    enabled: ['fetch-url'],
    timeoutMs: DEFAULT_TOOL_TIMEOUT_MS,
  },
  tasks: buildTasksConfig(),
  cache: buildCacheConfig(),
  extraction: {
    maxBlockLength: 5000,
    minParagraphLength: 10,
  },
  noiseRemoval: buildNoiseRemovalConfig(),
  markdownCleanup: buildMarkdownCleanupConfig(),
  i18n: {
    locale: EnvParser.locale(env['FETCH_URL_MCP_LOCALE']),
  },
  logging: {
    level: EnvParser.logLevel(env['LOG_LEVEL']),
    format: env['LOG_FORMAT']?.toLowerCase() === 'json' ? 'json' : 'text',
  },
  constants: {
    maxHtmlBytes: MAX_HTML_BYTES,
    maxUrlLength: 2048,
    maxInlineContentChars: MAX_INLINE_CONTENT_CHARS,
  },
  security: {
    blockedHosts: BLOCKED_HOSTS,
    allowedHosts: EnvParser.allowedHosts(env['ALLOWED_HOSTS']),
    apiKey: env['API_KEY'],
    allowRemote,
    allowLocalFetch: EnvParser.boolean(
      env['ALLOW_LOCAL_FETCH'],
      false,
      'ALLOW_LOCAL_FETCH'
    ),
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
