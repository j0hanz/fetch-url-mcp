import { readFileSync } from 'node:fs';
import { findPackageJSON } from 'node:module';
import { isIP } from 'node:net';
import process from 'node:process';
import { domainToASCII } from 'node:url';

function readServerVersion(moduleUrl: string): string {
  const packageJsonPath = findPackageJSON(moduleUrl);
  if (!packageJsonPath) throw new Error('package.json not found');
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as {
    version?: string;
  };
  if (typeof packageJson.version !== 'string') {
    throw new Error('package.json version is missing');
  }
  return packageJson.version;
}

export const serverVersion: string = readServerVersion(import.meta.url);

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

export type TransformWorkerMode = 'threads' | 'process';

type AuthMode = 'oauth' | 'static';

class ConfigError extends Error {
  override name = 'ConfigError';
}

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

function buildIpv4(parts: readonly [number, number, number, number]): string {
  return parts.join('.');
}

function stripTrailingDots(value: string): string {
  let result = value;
  while (result.endsWith('.')) result = result.slice(0, -1);
  return result;
}

function formatHostForUrl(hostname: string): string {
  if (hostname.includes(':') && !hostname.startsWith('['))
    return `[${hostname}]`;
  return hostname;
}

function normalizeHostname(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  const lowered = trimmed.toLowerCase();
  const ipType = isIP(lowered);
  if (ipType) return stripTrailingDots(lowered);

  const ascii = domainToASCII(lowered);
  return ascii ? stripTrailingDots(ascii) : null;
}

function normalizeHostValue(value: string): string | null {
  const raw = value.trim();
  if (!raw) return null;

  // Full URL
  if (raw.includes('://')) {
    if (!URL.canParse(raw)) return null;
    return normalizeHostname(new URL(raw).hostname);
  }

  // host[:port]
  const candidateUrl = `http://${raw}`;
  if (URL.canParse(candidateUrl)) {
    return normalizeHostname(new URL(candidateUrl).hostname);
  }

  const lowered = raw.toLowerCase();

  // [::1]:port
  if (lowered.startsWith('[')) {
    const end = lowered.indexOf(']');
    if (end === -1) return null;
    return normalizeHostname(lowered.slice(1, end));
  }

  // Bare IPv6
  if (isIP(lowered) === 6) return stripTrailingDots(lowered);

  // Split host:port (single colon only)
  const firstColon = lowered.indexOf(':');
  if (firstColon === -1) return normalizeHostname(lowered);
  if (lowered.includes(':', firstColon + 1)) return null;

  const host = lowered.slice(0, firstColon);
  return host ? normalizeHostname(host) : null;
}

function parseIntegerValue(
  envValue: string | undefined,
  min?: number,
  max?: number
): number | null {
  if (!envValue) return null;
  const parsed = Number.parseInt(envValue, 10);
  if (Number.isNaN(parsed)) return null;
  if (min !== undefined && parsed < min) return null;
  if (max !== undefined && parsed > max) return null;
  return parsed;
}

function parseOptionalInteger(
  envValue: string | undefined,
  min?: number,
  max?: number
): number | undefined {
  const parsed = parseIntegerValue(envValue, min, max);
  return parsed ?? undefined;
}

function parseInteger(
  envValue: string | undefined,
  defaultValue: number,
  min?: number,
  max?: number
): number {
  return parseIntegerValue(envValue, min, max) ?? defaultValue;
}

function parseBoolean(
  envValue: string | undefined,
  defaultValue: boolean
): boolean {
  if (!envValue) return defaultValue;
  return envValue.trim().toLowerCase() !== 'false';
}

function parseList(envValue: string | undefined): string[] {
  if (!envValue) return [];
  return envValue
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function parseListOrDefault(
  envValue: string | undefined,
  defaultValue: readonly string[]
): string[] {
  const parsed = parseList(envValue);
  return parsed.length > 0 ? parsed : [...defaultValue];
}

function normalizeLocale(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const lowered = trimmed.toLowerCase();
  if (lowered === 'system' || lowered === 'default') return undefined;
  return trimmed;
}

function isLogLevel(value: string): value is LogLevel {
  return ALLOWED_LOG_LEVELS.has(value);
}

function parseLogLevel(envValue: string | undefined): LogLevel {
  if (!envValue) return 'info';
  const level = envValue.toLowerCase();
  return isLogLevel(level) ? level : 'info';
}

function parseTransformWorkerMode(
  envValue: string | undefined
): TransformWorkerMode {
  if (!envValue) return 'threads';
  const normalized = envValue.trim().toLowerCase();
  if (normalized === 'process' || normalized === 'fork') return 'process';
  return 'threads';
}

function parsePort(envValue: string | undefined): number {
  if (envValue?.trim() === '0') return 0;
  return parseInteger(envValue, 3000, 1024, 65535);
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

function readOptionalFilePath(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

const MAX_HTML_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_INLINE_CONTENT_CHARS = parseInteger(
  env['MAX_INLINE_CONTENT_CHARS'],
  0,
  0,
  MAX_HTML_BYTES
);
const DEFAULT_SESSION_TTL_MS = 30 * 60 * 1000;
const DEFAULT_SESSION_INIT_TIMEOUT_MS = 10000;
const DEFAULT_MAX_SESSIONS = 200;
const DEFAULT_USER_AGENT = `fetch-url-mcp/${serverVersion}`;
const DEFAULT_TOOL_TIMEOUT_PADDING_MS = 5000;
const DEFAULT_TRANSFORM_TIMEOUT_MS = 30000;

const DEFAULT_FETCH_TIMEOUT_MS = parseInteger(
  env['FETCH_TIMEOUT_MS'],
  15000,
  1000,
  60000
);
const DEFAULT_TOOL_TIMEOUT_MS =
  DEFAULT_FETCH_TIMEOUT_MS +
  DEFAULT_TRANSFORM_TIMEOUT_MS +
  DEFAULT_TOOL_TIMEOUT_PADDING_MS;
const DEFAULT_TASKS_MAX_TOTAL = parseInteger(env['TASKS_MAX_TOTAL'], 5000, 1);
const DEFAULT_TASKS_MAX_PER_OWNER = parseInteger(
  env['TASKS_MAX_PER_OWNER'],
  1000,
  1
);
const RESOLVED_TASKS_MAX_PER_OWNER = Math.min(
  DEFAULT_TASKS_MAX_PER_OWNER,
  DEFAULT_TASKS_MAX_TOTAL
);

interface WorkerResourceLimits {
  maxOldGenerationSizeMb?: number;
  maxYoungGenerationSizeMb?: number;
  codeRangeSizeMb?: number;
  stackSizeMb?: number;
}

function resolveWorkerResourceLimits(): WorkerResourceLimits | undefined {
  const limits: WorkerResourceLimits = {};
  let hasAny = false;
  const maxOldGenerationSizeMb = parseOptionalInteger(
    env['TRANSFORM_WORKER_MAX_OLD_GENERATION_MB'],
    1
  );
  const maxYoungGenerationSizeMb = parseOptionalInteger(
    env['TRANSFORM_WORKER_MAX_YOUNG_GENERATION_MB'],
    1
  );
  const codeRangeSizeMb = parseOptionalInteger(
    env['TRANSFORM_WORKER_CODE_RANGE_MB'],
    1
  );
  const stackSizeMb = parseOptionalInteger(env['TRANSFORM_WORKER_STACK_MB'], 1);

  if (maxOldGenerationSizeMb !== undefined) {
    limits.maxOldGenerationSizeMb = maxOldGenerationSizeMb;
    hasAny = true;
  }
  if (maxYoungGenerationSizeMb !== undefined) {
    limits.maxYoungGenerationSizeMb = maxYoungGenerationSizeMb;
    hasAny = true;
  }
  if (codeRangeSizeMb !== undefined) {
    limits.codeRangeSizeMb = codeRangeSizeMb;
    hasAny = true;
  }
  if (stackSizeMb !== undefined) {
    limits.stackSizeMb = stackSizeMb;
    hasAny = true;
  }

  return hasAny ? limits : undefined;
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

interface OAuthUrls {
  issuerUrl: URL | undefined;
  authorizationUrl: URL | undefined;
  tokenUrl: URL | undefined;
  revocationUrl: URL | undefined;
  registrationUrl: URL | undefined;
  introspectionUrl: URL | undefined;
  resourceUrl: URL;
}

type OAuthModeInputs = Pick<
  OAuthUrls,
  'issuerUrl' | 'authorizationUrl' | 'tokenUrl' | 'introspectionUrl'
>;

function readOAuthUrls(baseUrl: URL): OAuthUrls {
  const issuerUrl = readUrlEnv('OAUTH_ISSUER_URL');
  const authorizationUrl = readUrlEnv('OAUTH_AUTHORIZATION_URL');
  const tokenUrl = readUrlEnv('OAUTH_TOKEN_URL');
  const revocationUrl = readUrlEnv('OAUTH_REVOCATION_URL');
  const registrationUrl = readUrlEnv('OAUTH_REGISTRATION_URL');
  const introspectionUrl = readUrlEnv('OAUTH_INTROSPECTION_URL');
  const resourceUrl = new URL('/mcp', baseUrl);

  return {
    issuerUrl,
    authorizationUrl,
    tokenUrl,
    revocationUrl,
    registrationUrl,
    introspectionUrl,
    resourceUrl,
  };
}

function resolveAuthMode(urls: OAuthModeInputs): AuthMode {
  const oauthConfigured = [
    urls.issuerUrl,
    urls.authorizationUrl,
    urls.tokenUrl,
    urls.introspectionUrl,
  ].some((value) => value !== undefined);

  return oauthConfigured ? 'oauth' : 'static';
}

function collectStaticTokens(): string[] {
  const staticTokens = new Set<string>(parseList(env['ACCESS_TOKENS']));
  if (env['API_KEY']) staticTokens.add(env['API_KEY']);
  return [...staticTokens];
}

function buildAuthConfig(baseUrl: URL): AuthConfig {
  const urls = readOAuthUrls(baseUrl);
  const mode = resolveAuthMode(urls);

  return {
    mode,
    ...urls,
    requiredScopes: parseList(env['OAUTH_REQUIRED_SCOPES']),
    clientId: env['OAUTH_CLIENT_ID'],
    clientSecret: env['OAUTH_CLIENT_SECRET'],
    introspectionTimeoutMs: 5000,
    staticTokens: collectStaticTokens(),
  };
}

function buildHttpsConfig(): HttpsConfig {
  const keyFile = readOptionalFilePath(env['SERVER_TLS_KEY_FILE']);
  const certFile = readOptionalFilePath(env['SERVER_TLS_CERT_FILE']);
  const caFile = readOptionalFilePath(env['SERVER_TLS_CA_FILE']);

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

const BLOCKED_IP_PATTERNS: readonly RegExp[] = [
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
];

const BLOCKED_IP_PATTERN =
  /^(?:10\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.168\.|127\.|0\.|169\.254\.|100\.64\.|fc00:|fd00:|fe80:)/i;
const BLOCKED_IPV4_MAPPED_PATTERN =
  /^::ffff:(?:127\.|10\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.)/i;

const host = (env['HOST'] ?? LOOPBACK_V4).trim();
const port = parsePort(env['PORT']);
const httpsConfig = buildHttpsConfig();
const maxConnections = parseInteger(env['SERVER_MAX_CONNECTIONS'], 0, 0);
const headersTimeoutMs = parseOptionalInteger(
  env['SERVER_HEADERS_TIMEOUT_MS'],
  1
);
const requestTimeoutMs = parseOptionalInteger(
  env['SERVER_REQUEST_TIMEOUT_MS'],
  0
);
const keepAliveTimeoutMs = parseOptionalInteger(
  env['SERVER_KEEP_ALIVE_TIMEOUT_MS'],
  1
);
const keepAliveTimeoutBufferMs = parseOptionalInteger(
  env['SERVER_KEEP_ALIVE_TIMEOUT_BUFFER_MS'],
  0
);
const maxHeadersCount = parseOptionalInteger(
  env['SERVER_MAX_HEADERS_COUNT'],
  1
);
const blockPrivateConnections = parseBoolean(
  env['SERVER_BLOCK_PRIVATE_CONNECTIONS'],
  false
);
const allowRemote = parseBoolean(env['ALLOW_REMOTE'], false);

const baseUrl = new URL(
  `${httpsConfig.enabled ? 'https' : 'http'}://${formatHostForUrl(host)}:${port}`
);

interface RuntimeState {
  httpMode: boolean;
}

const runtimeState: RuntimeState = {
  httpMode: false,
};

export const config = {
  server: {
    name: 'fetch-url-mcp',
    version: serverVersion,
    port,
    host,
    https: httpsConfig,
    sessionTtlMs: DEFAULT_SESSION_TTL_MS,
    sessionInitTimeoutMs: DEFAULT_SESSION_INIT_TIMEOUT_MS,
    maxSessions: DEFAULT_MAX_SESSIONS,
    http: {
      headersTimeoutMs,
      requestTimeoutMs,
      keepAliveTimeoutMs,
      keepAliveTimeoutBufferMs,
      maxHeadersCount,
      maxConnections,
      blockPrivateConnections,
      shutdownCloseIdleConnections: true,
      shutdownCloseAllConnections: false,
    },
  },
  fetcher: {
    timeout: DEFAULT_FETCH_TIMEOUT_MS,
    maxRedirects: 5,
    userAgent: env['USER_AGENT'] ?? DEFAULT_USER_AGENT,
    maxContentLength: MAX_HTML_BYTES,
  },
  transform: {
    timeoutMs: DEFAULT_TRANSFORM_TIMEOUT_MS,
    stageWarnRatio: 0.5,
    metadataFormat: 'markdown',
    maxWorkerScale: 4,
    workerMode: parseTransformWorkerMode(env['TRANSFORM_WORKER_MODE']),
    workerResourceLimits: resolveWorkerResourceLimits(),
  },
  tools: {
    enabled: ['fetch-url'],
    timeoutMs: DEFAULT_TOOL_TIMEOUT_MS,
  },
  tasks: {
    maxTotal: DEFAULT_TASKS_MAX_TOTAL,
    maxPerOwner: RESOLVED_TASKS_MAX_PER_OWNER,
  },
  cache: {
    enabled: parseBoolean(env['CACHE_ENABLED'], true),
    ttl: 86400,
    maxKeys: 100,
    maxSizeBytes: 50 * 1024 * 1024, // 50MB
  },
  extraction: {
    maxBlockLength: 5000,
    minParagraphLength: 10,
  },
  noiseRemoval: {
    extraTokens: parseList(env['FETCH_URL_MCP_EXTRA_NOISE_TOKENS']),
    extraSelectors: parseList(env['FETCH_URL_MCP_EXTRA_NOISE_SELECTORS']),
    enabledCategories: [
      'cookie-banners',
      'newsletters',
      'social-share',
      'nav-footer',
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
  },
  markdownCleanup: {
    promoteOrphanHeadings: true,
    removeSkipLinks: true,
    removeTocBlocks: true,
    removeTypeDocComments: true,
    headingKeywords: parseListOrDefault(
      env['MARKDOWN_HEADING_KEYWORDS'],
      DEFAULT_HEADING_KEYWORDS
    ),
  },
  i18n: {
    locale: normalizeLocale(env['FETCH_URL_MCP_LOCALE']),
  },
  logging: {
    level: parseLogLevel(env['LOG_LEVEL']),
    format: env['LOG_FORMAT']?.toLowerCase() === 'json' ? 'json' : 'text',
  },
  constants: {
    maxHtmlSize: MAX_HTML_BYTES,
    maxUrlLength: 2048,
    maxInlineContentChars: MAX_INLINE_CONTENT_CHARS,
  },
  security: {
    blockedHosts: BLOCKED_HOSTS,
    blockedIpPatterns: BLOCKED_IP_PATTERNS,
    blockedIpPattern: BLOCKED_IP_PATTERN,
    blockedIpv4MappedPattern: BLOCKED_IPV4_MAPPED_PATTERN,
    allowedHosts: parseAllowedHosts(env['ALLOWED_HOSTS']),
    apiKey: env['API_KEY'],
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
