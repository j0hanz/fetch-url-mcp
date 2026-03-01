import { AsyncLocalStorage } from 'node:async_hooks';
import { EventEmitter } from 'node:events';
import { accessSync, constants as fsConstants, readFileSync } from 'node:fs';
import { findPackageJSON } from 'node:module';
import { isIP } from 'node:net';
import process from 'node:process';
import { domainToASCII } from 'node:url';
import { inspect, stripVTControlCharacters } from 'node:util';

import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { type StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

import {
  getErrorMessage,
  isAbortError,
  sha256Hex,
  stableStringify as stableJsonStringify,
  startAbortableIntervalLoop,
} from './utils.js';

export const serverVersion: string = readServerVersion(import.meta.url);
type LogLevel = 'debug' | 'info' | 'warn' | 'error';
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
  return parseIntegerValue(envValue, min, max) ?? undefined;
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

function assertFileReadable(filePath: string, envVar: string): void {
  try {
    accessSync(filePath, fsConstants.R_OK);
  } catch {
    throw new ConfigError(
      `${envVar} points to "${filePath}" which does not exist or is not readable`
    );
  }
}

const MAX_HTML_BYTES = 10 * 1024 * 1024;
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

  const entries: [keyof WorkerResourceLimits, number | undefined][] = [
    [
      'maxOldGenerationSizeMb',
      parseOptionalInteger(env['TRANSFORM_WORKER_MAX_OLD_GENERATION_MB'], 1),
    ],
    [
      'maxYoungGenerationSizeMb',
      parseOptionalInteger(env['TRANSFORM_WORKER_MAX_YOUNG_GENERATION_MB'], 1),
    ],
    [
      'codeRangeSizeMb',
      parseOptionalInteger(env['TRANSFORM_WORKER_CODE_RANGE_MB'], 1),
    ],
    ['stackSizeMb', parseOptionalInteger(env['TRANSFORM_WORKER_STACK_MB'], 1)],
  ];

  for (const [key, value] of entries) {
    if (value === undefined) continue;
    limits[key] = value;
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

  if (keyFile) assertFileReadable(keyFile, 'SERVER_TLS_KEY_FILE');
  if (certFile) assertFileReadable(certFile, 'SERVER_TLS_CERT_FILE');
  if (caFile) assertFileReadable(caFile, 'SERVER_TLS_CA_FILE');

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
const requireProtocolVersionHeaderOnSessionInit = parseBoolean(
  env['MCP_STRICT_PROTOCOL_VERSION_HEADER'],
  true
);
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
      requireProtocolVersionHeaderOnSessionInit,
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
    cancelAckTimeoutMs: parseInteger(
      env['TRANSFORM_CANCEL_ACK_TIMEOUT_MS'],
      200,
      50,
      5000
    ),
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
    emitStatusNotifications: parseBoolean(
      env['TASKS_STATUS_NOTIFICATIONS'],
      false
    ),
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
    allowedHosts: parseAllowedHosts(env['ALLOWED_HOSTS']),
    apiKey: env['API_KEY'],
    allowRemote,
    allowLocalFetch: parseBoolean(env['ALLOW_LOCAL_FETCH'], false),
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

const CachedPayloadSchema = z.strictObject({
  content: z.string().optional(),
  markdown: z.string().optional(),
  title: z.string().optional(),
});
type CachedPayload = z.infer<typeof CachedPayloadSchema>;
interface CacheEntry {
  url: string;
  title?: string;
  content: string;
  fetchedAt: string;
  expiresAt: string;
}
interface CacheKeyParts {
  namespace: string;
  urlHash: string;
}
interface CacheSetOptions {
  force?: boolean;
}
interface CacheGetOptions {
  force?: boolean;
}
interface CacheEntryMetadata {
  url: string;
  title?: string;
}
interface StoredCacheEntry extends CacheEntry {
  expiresAtMs: number;
}
interface CacheUpdateEvent {
  cacheKey: string;
  namespace: string;
  urlHash: string;
  listChanged: boolean;
}
type CacheUpdateListener = (event: CacheUpdateEvent) => unknown;
const CACHE_CONSTANTS = {
  URL_HASH_LENGTH: 32,
  VARY_HASH_LENGTH: 16,
} as const;
export function parseCachedPayload(raw: string): CachedPayload | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return CachedPayloadSchema.parse(parsed);
  } catch {
    return null;
  }
}
export function resolveCachedPayloadContent(
  payload: CachedPayload
): string | null {
  return payload.markdown ?? payload.content ?? null;
}
function createHashFragment(input: string, length: number): string {
  return sha256Hex(input).substring(0, length);
}
function buildCacheKey(
  namespace: string,
  urlHash: string,
  varyHash?: string
): string {
  return varyHash
    ? `${namespace}:${urlHash}.${varyHash}`
    : `${namespace}:${urlHash}`;
}
function resolveVaryString(
  vary: Record<string, unknown> | string
): string | null {
  if (typeof vary === 'string') return vary;

  try {
    return stableJsonStringify(vary);
  } catch {
    return null;
  }
}
export function createCacheKey(
  namespace: string,
  url: string,
  vary?: Record<string, unknown> | string
): string | null {
  if (!namespace || !url) return null;

  const urlHash = createHashFragment(url, CACHE_CONSTANTS.URL_HASH_LENGTH);

  let varyHash: string | undefined;

  if (vary) {
    const varyString = resolveVaryString(vary);
    if (varyString === null) return null;

    if (varyString) {
      varyHash = createHashFragment(
        varyString,
        CACHE_CONSTANTS.VARY_HASH_LENGTH
      );
    }
  }

  return buildCacheKey(namespace, urlHash, varyHash);
}
export function parseCacheKey(cacheKey: string): CacheKeyParts | null {
  if (!cacheKey) return null;
  const separatorIndex = cacheKey.indexOf(':');
  if (separatorIndex === -1) return null;

  const namespace = cacheKey.slice(0, separatorIndex);
  const urlHash = cacheKey.slice(separatorIndex + 1);
  if (!namespace || !urlHash) return null;
  return { namespace, urlHash };
}
class InMemoryCacheStore {
  private readonly max = config.cache.maxKeys;
  private readonly maxBytes = config.cache.maxSizeBytes;
  private readonly ttlMs = config.cache.ttl * 1000;

  private readonly entries = new Map<string, StoredCacheEntry>();
  private readonly updateEmitter = new EventEmitter();

  private currentBytes = 0;

  isEnabled(): boolean {
    return config.cache.enabled;
  }

  private isExpired(entry: StoredCacheEntry, now = Date.now()): boolean {
    return entry.expiresAtMs <= now;
  }

  keys(): readonly string[] {
    if (!this.isEnabled()) return [];
    const now = Date.now();

    const result: string[] = [];
    for (const [key, entry] of this.entries) {
      if (!this.isExpired(entry, now)) result.push(key);
    }
    return result;
  }

  onUpdate(listener: CacheUpdateListener): () => void {
    const wrapped = (event: CacheUpdateEvent): void => {
      try {
        const result = listener(event);
        if (result instanceof Promise) {
          void result.catch((error: unknown) => {
            this.logError(
              'Cache update listener failed (async)',
              event.cacheKey,
              error
            );
          });
        }
      } catch (error) {
        this.logError('Cache update listener failed', event.cacheKey, error);
      }
    };

    this.updateEmitter.on('update', wrapped);
    return () => {
      this.updateEmitter.off('update', wrapped);
    };
  }

  get(
    cacheKey: string | null,
    options?: CacheGetOptions
  ): CacheEntry | undefined {
    if (!cacheKey || (!this.isEnabled() && !options?.force)) return undefined;

    const entry = this.entries.get(cacheKey);
    if (!entry) return undefined;

    const now = Date.now();
    if (this.isExpired(entry, now)) {
      this.delete(cacheKey);
      // listChanged=false: lazy eviction on read is silent — only writes change
      // the list. Clients must not rely on list-changed events from reads.
      this.notify(cacheKey, false);
      return undefined;
    }

    // Refresh LRU position
    this.entries.delete(cacheKey);
    this.entries.set(cacheKey, entry);

    return entry;
  }

  private delete(cacheKey: string): boolean {
    const entry = this.entries.get(cacheKey);
    if (entry) {
      this.currentBytes -= entry.content.length;
      this.entries.delete(cacheKey);
      return true;
    }
    return false;
  }

  private evictOldestEntry(): boolean {
    const firstKey = this.entries.keys().next();
    return !firstKey.done && this.delete(firstKey.value);
  }

  set(
    cacheKey: string | null,
    content: string,
    metadata: CacheEntryMetadata,
    options?: CacheSetOptions
  ): void {
    if (!cacheKey || !content) return;
    if (!this.isEnabled() && !options?.force) return;

    const now = Date.now();
    const expiresAtMs = now + this.ttlMs;

    // Check size limit before insertion
    const entrySize = content.length;
    if (entrySize > this.maxBytes) {
      logWarn('Cache entry exceeds max size', {
        key: cacheKey,
        size: entrySize,
        max: this.maxBytes,
      });
      return;
    }

    let listChanged = !this.entries.has(cacheKey);

    // Evict if needed (size-based)
    while (this.currentBytes + entrySize > this.maxBytes) {
      if (this.evictOldestEntry()) {
        listChanged = true;
      } else {
        break;
      }
    }

    const entry: StoredCacheEntry = {
      url: metadata.url,
      content,
      fetchedAt: new Date(now).toISOString(),
      expiresAt: new Date(expiresAtMs).toISOString(),
      expiresAtMs,
      ...(metadata.title ? { title: metadata.title } : {}),
    };

    if (this.entries.has(cacheKey)) {
      this.delete(cacheKey);
    }

    this.entries.set(cacheKey, entry);
    this.currentBytes += entrySize;

    // Eviction (LRU: first insertion-order key) - Count based
    if (this.entries.size > this.max && this.evictOldestEntry()) {
      listChanged = true;
    }

    this.notify(cacheKey, listChanged);
  }

  private notify(cacheKey: string, listChanged: boolean): void {
    if (this.updateEmitter.listenerCount('update') === 0) return;
    const parts = parseCacheKey(cacheKey);
    if (!parts) return;
    this.updateEmitter.emit('update', { cacheKey, ...parts, listChanged });
  }

  /**
   * Read an entry without updating its LRU position.
   * Use this for metadata access (e.g. resource listing) to avoid polluting the
   * eviction order; expired entries are treated as absent but not evicted here.
   */
  peek(cacheKey: string | null): CacheEntry | undefined {
    if (!cacheKey) return undefined;
    const entry = this.entries.get(cacheKey);
    if (!entry) return undefined;
    if (this.isExpired(entry)) return undefined;
    return entry;
  }

  private logError(message: string, cacheKey: string, error: unknown): void {
    logWarn(message, {
      key: cacheKey.length > 100 ? cacheKey.slice(0, 100) : cacheKey,
      error: getErrorMessage(error),
    });
  }
}
const store = new InMemoryCacheStore();
export function onCacheUpdate(listener: CacheUpdateListener): () => void {
  return store.onUpdate(listener);
}
export function get(
  cacheKey: string | null,
  options?: CacheGetOptions
): CacheEntry | undefined {
  return store.get(cacheKey, options);
}
export function set(
  cacheKey: string | null,
  content: string,
  metadata: CacheEntryMetadata,
  options?: CacheSetOptions
): void {
  store.set(cacheKey, content, metadata, options);
}
export function keys(): readonly string[] {
  return store.keys();
}
export function getEntryMeta(
  cacheKey: string
): { url: string; title?: string } | undefined {
  const entry = store.peek(cacheKey);
  if (!entry) return undefined;
  return entry.title !== undefined
    ? { url: entry.url, title: entry.title }
    : { url: entry.url };
}
export function isEnabled(): boolean {
  return store.isEnabled();
}
function hasPackageJsonVersion(value: unknown): value is { version: string } {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as { version?: unknown };
  return typeof record.version === 'string';
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

type LogMetadata = Record<string, unknown>;
interface RequestContext {
  readonly requestId: string;
  readonly sessionId?: string;
  readonly operationId?: string;
}
const requestContext = new AsyncLocalStorage<RequestContext>({
  name: 'requestContext',
});
let mcpServer: McpServer | undefined;
const sessionServers = new Map<string, McpServer>();
let stderrAvailable = true;
process.stderr.on('error', () => {
  stderrAvailable = false;
});
export function setMcpServer(server: McpServer): void {
  mcpServer = server;
}
export function registerMcpSessionServer(
  sessionId: string,
  server: McpServer
): void {
  if (!sessionId) return;
  sessionServers.set(sessionId, server);
}
export function unregisterMcpSessionServer(sessionId: string): void {
  if (!sessionId) return;
  sessionServers.delete(sessionId);
}
export function unregisterMcpSessionServerByServer(server: McpServer): void {
  for (const [sessionId, mappedServer] of sessionServers.entries()) {
    if (mappedServer !== server) continue;
    sessionServers.delete(sessionId);
  }
}
export function resolveMcpSessionIdByServer(
  server: McpServer
): string | undefined {
  for (const [sessionId, mappedServer] of sessionServers.entries()) {
    if (mappedServer === server) return sessionId;
  }
  return undefined;
}
export function runWithRequestContext<T>(
  context: RequestContext,
  fn: () => T
): T {
  return requestContext.run(context, fn);
}
function getRequestContext(): RequestContext | undefined {
  return requestContext.getStore();
}
export function getRequestId(): string | undefined {
  const context = getRequestContext();
  return context?.requestId;
}
function getSessionId(): string | undefined {
  return getRequestContext()?.sessionId;
}
export function getOperationId(): string | undefined {
  return getRequestContext()?.operationId;
}
function isDebugEnabled(): boolean {
  return config.logging.level === 'debug';
}
function buildContextMetadata(): LogMetadata | undefined {
  const ctx = requestContext.getStore();
  if (!ctx) return undefined;

  const { requestId, operationId, sessionId } = ctx;
  const includeSession = sessionId && isDebugEnabled();

  if (!requestId && !operationId && !includeSession) return undefined;

  const meta: LogMetadata = {};
  if (requestId) meta['requestId'] = requestId;
  if (operationId) meta['operationId'] = operationId;
  if (includeSession) meta['sessionId'] = sessionId;

  return meta;
}
function mergeMetadata(meta?: LogMetadata): LogMetadata | undefined {
  const contextMeta = buildContextMetadata();
  const hasMeta = meta && Object.keys(meta).length > 0;

  if (!contextMeta && !hasMeta) return undefined;
  if (!contextMeta) return meta;
  if (!hasMeta) return contextMeta;

  return { ...contextMeta, ...meta };
}
function formatMetadata(meta?: LogMetadata): string {
  const merged = mergeMetadata(meta);
  if (!merged) return '';

  return ` ${inspect(merged, { breakLength: Infinity, colors: false, compact: true, sorted: true })}`;
}
function createTimestamp(): string {
  return new Date().toISOString();
}
function formatLogEntry(
  level: LogLevel,
  message: string,
  meta?: LogMetadata
): string {
  if (config.logging.format === 'json') {
    const merged = mergeMetadata(meta);
    const entry: Record<string, unknown> = {
      timestamp: createTimestamp(),
      level: level.toUpperCase(),
      message,
    };
    if (merged) {
      Object.assign(entry, merged);
    }
    return JSON.stringify(entry);
  }
  return `[${createTimestamp()}] ${level.toUpperCase()}: ${message}${formatMetadata(meta)}`;
}
const LEVEL_PRIORITY: Readonly<Record<LogLevel, number>> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};
function shouldLog(level: LogLevel): boolean {
  return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[config.logging.level];
}
function mapToMcpLevel(
  level: LogLevel
): 'debug' | 'info' | 'warning' | 'error' {
  switch (level) {
    case 'warn':
      return 'warning';
    case 'error':
      return 'error';
    case 'debug':
      return 'debug';
    case 'info':
    default:
      return 'info';
  }
}
function resolveErrorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return 'unknown error';
}
function safeWriteStderr(line: string): void {
  if (!stderrAvailable) return;
  if (process.stderr.destroyed || process.stderr.writableEnded) {
    stderrAvailable = false;
    return;
  }
  try {
    process.stderr.write(line);
  } catch {
    // Logging must never take down the process (e.g. EPIPE).
    stderrAvailable = false;
  }
}
function writeLog(level: LogLevel, message: string, meta?: LogMetadata): void {
  if (!shouldLog(level)) return;

  const line = formatLogEntry(level, message, meta);
  safeWriteStderr(`${stripVTControlCharacters(line)}\n`);

  const sessionId = getSessionId();
  const server = sessionId
    ? (sessionServers.get(sessionId) ?? mcpServer)
    : mcpServer;
  if (!server) return;
  if (!server.isConnected()) return;

  try {
    server.server
      .sendLoggingMessage(
        {
          level: mapToMcpLevel(level),
          logger: 'fetch-url-mcp',
          // Preserve existing behavior: MCP payload includes only message + provided meta (not ALS context meta).
          data: meta ? { message, ...meta } : message,
        },
        sessionId
      )
      .catch((err: unknown) => {
        if (!isDebugEnabled()) return;
        const errorText = resolveErrorText(err);

        safeWriteStderr(
          `[${createTimestamp()}] WARN: Failed to forward log to MCP${
            sessionId ? ` (sessionId=${sessionId})` : ''
          }: ${errorText}\n`
        );
      });
  } catch (err: unknown) {
    if (!isDebugEnabled()) return;

    const errorText = resolveErrorText(err);
    safeWriteStderr(
      `[${createTimestamp()}] WARN: Failed to forward log to MCP (sync error): ${errorText}\n`
    );
  }
}
export function logInfo(message: string, meta?: LogMetadata): void {
  writeLog('info', message, meta);
}
export function logDebug(message: string, meta?: LogMetadata): void {
  writeLog('debug', message, meta);
}
export function logWarn(message: string, meta?: LogMetadata): void {
  writeLog('warn', message, meta);
}
export function logError(message: string, error?: Error | LogMetadata): void {
  const errorMeta: LogMetadata =
    error instanceof Error
      ? { error: error.message, stack: error.stack }
      : (error ?? {});
  writeLog('error', message, errorMeta);
}
export function setLogLevel(level: string): void {
  const normalized = level.toLowerCase();
  // Map MCP logging levels (RFC 5424 subset) to internal levels.
  if (normalized === 'debug') {
    config.logging.level = 'debug';
  } else if (normalized === 'info' || normalized === 'notice') {
    config.logging.level = 'info';
  } else if (normalized === 'warning' || normalized === 'warn') {
    config.logging.level = 'warn';
  } else if (
    normalized === 'error' ||
    normalized === 'critical' ||
    normalized === 'alert' ||
    normalized === 'emergency'
  ) {
    config.logging.level = 'error';
  }
}
export function redactUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    url.username = '';
    url.password = '';
    url.hash = '';
    url.search = '';
    return url.toString();
  } catch {
    return rawUrl;
  }
}
export interface SessionEntry {
  readonly server: McpServer;
  readonly transport: StreamableHTTPServerTransport;
  createdAt: number;
  lastSeen: number;
  protocolInitialized: boolean;
  negotiatedProtocolVersion: string;
  authFingerprint: string;
}
export interface SessionStore {
  get: (sessionId: string) => SessionEntry | undefined;
  touch: (sessionId: string) => void;
  set: (sessionId: string, entry: SessionEntry) => void;
  remove: (sessionId: string) => SessionEntry | undefined;
  size: () => number;
  inFlight: () => number;
  incrementInFlight: () => void;
  decrementInFlight: () => void;
  clear: () => SessionEntry[];
  evictExpired: () => SessionEntry[];
  evictOldest: () => SessionEntry | undefined;
}
interface SlotTracker {
  readonly releaseSlot: () => void;
  readonly markInitialized: () => void;
  readonly isInitialized: () => boolean;
}
type CloseHandler = (() => void) | undefined;
export function composeCloseHandlers(
  first: CloseHandler,
  second: CloseHandler
): CloseHandler {
  if (!first) return second;
  if (!second) return first;

  return () => {
    try {
      first();
    } finally {
      second();
    }
  };
}
const MIN_CLEANUP_INTERVAL_MS = 10_000;
const MAX_CLEANUP_INTERVAL_MS = 60_000;
const SESSION_CLOSE_BATCH_SIZE = 10;
function getCleanupIntervalMs(sessionTtlMs: number): number {
  return Math.min(
    Math.max(Math.floor(sessionTtlMs / 2), MIN_CLEANUP_INTERVAL_MS),
    MAX_CLEANUP_INTERVAL_MS
  );
}
function handleSessionCleanupError(error: unknown): void {
  if (isAbortError(error)) return;
  logWarn('Session cleanup loop failed', { error: getErrorMessage(error) });
}
function getRejectedSettledResult<T>(
  result: PromiseSettledResult<T>
): PromiseRejectedResult | undefined {
  return result.status === 'rejected' ? result : undefined;
}
function logRejectedSettledResults(
  results: readonly PromiseSettledResult<unknown>[],
  message: string
): void {
  for (const result of results) {
    const rejected = getRejectedSettledResult(result);
    if (!rejected) continue;

    logWarn(message, { error: getErrorMessage(rejected.reason) });
  }
}
function isSessionExpired(
  session: SessionEntry,
  now: number,
  sessionTtlMs: number
): boolean {
  if (sessionTtlMs <= 0) return false;
  return now - session.lastSeen > sessionTtlMs;
}
function chunkArray<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}
class SessionCleanupLoop {
  constructor(
    private readonly store: SessionStore,
    private readonly sessionTtlMs: number,
    private readonly onEvictSession?:
      | ((session: SessionEntry) => Promise<void> | void)
      | undefined,
    private readonly cleanupIntervalMsOverride?: number
  ) {}

  start(): AbortController {
    const controller = new AbortController();
    const intervalMs =
      this.cleanupIntervalMsOverride ?? getCleanupIntervalMs(this.sessionTtlMs);

    startAbortableIntervalLoop(intervalMs, Date.now, {
      signal: controller.signal,
      onTick: async (getNow) => {
        await this.handleTick(getNow(), controller.signal);
      },
      onError: handleSessionCleanupError,
    });

    return controller;
  }

  private async handleTick(now: number, signal: AbortSignal): Promise<void> {
    const evicted = this.store.evictExpired();

    for (const batch of chunkArray(evicted, SESSION_CLOSE_BATCH_SIZE)) {
      const results = await Promise.allSettled(
        batch.map(async (session) => this.closeExpiredSession(session))
      );

      logRejectedSettledResults(
        results,
        'Failed to process expired session cleanup task'
      );

      if (signal.aborted) return;
    }

    if (evicted.length > 0) {
      logInfo('Expired sessions evicted', {
        evicted: evicted.length,
        timestamp: new Date(now).toISOString(),
      });
    }
  }

  private async closeExpiredSession(session: SessionEntry): Promise<void> {
    if (this.onEvictSession) {
      try {
        await this.onEvictSession(session);
      } catch (error) {
        logWarn('Expired session pre-close hook failed', {
          error: getErrorMessage(error),
        });
      }
    }

    try {
      unregisterMcpSessionServerByServer(session.server);
    } catch (error) {
      logWarn('Failed to unregister session server', {
        error: getErrorMessage(error),
      });
    }

    const [transportResult, serverResult] = await Promise.allSettled([
      session.transport.close(),
      session.server.close(),
    ]);

    const transportRejected = getRejectedSettledResult(transportResult);
    const serverRejected = getRejectedSettledResult(serverResult);

    this.logCloseFailure('transport', transportRejected?.reason);
    this.logCloseFailure('server', serverRejected?.reason);
  }

  private logCloseFailure(
    target: 'transport' | 'server',
    error: unknown
  ): void {
    if (error == null) return;

    logWarn(`Failed to close expired session ${target}`, {
      error: getErrorMessage(error),
    });
  }
}
export function startSessionCleanupLoop(
  store: SessionStore,
  sessionTtlMs: number,
  options?: {
    onEvictSession?: (session: SessionEntry) => Promise<void> | void;
    cleanupIntervalMs?: number;
  }
): AbortController {
  return new SessionCleanupLoop(
    store,
    sessionTtlMs,
    options?.onEvictSession,
    options?.cleanupIntervalMs
  ).start();
}
function moveSessionToEnd(
  sessions: Map<string, SessionEntry>,
  sessionId: string,
  session: SessionEntry
): void {
  sessions.delete(sessionId);
  sessions.set(sessionId, session);
}
function removeSessionById(
  sessions: Map<string, SessionEntry>,
  sessionId: string
): SessionEntry | undefined {
  const session = sessions.get(sessionId);
  sessions.delete(sessionId);
  return session;
}
function isBlankSessionId(sessionId: string): boolean {
  return sessionId.length === 0;
}
class InMemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, SessionEntry>();
  private inflight = 0;

  constructor(private readonly sessionTtlMs: number) {}

  get(sessionId: string): SessionEntry | undefined {
    if (isBlankSessionId(sessionId)) return undefined;
    return this.sessions.get(sessionId);
  }

  touch(sessionId: string): void {
    if (isBlankSessionId(sessionId)) return;

    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.lastSeen = Date.now();
    moveSessionToEnd(this.sessions, sessionId, session);
  }

  set(sessionId: string, entry: SessionEntry): void {
    if (isBlankSessionId(sessionId)) return;
    moveSessionToEnd(this.sessions, sessionId, entry);
  }

  remove(sessionId: string): SessionEntry | undefined {
    if (isBlankSessionId(sessionId)) return undefined;
    return removeSessionById(this.sessions, sessionId);
  }

  size(): number {
    return this.sessions.size;
  }

  inFlight(): number {
    return this.inflight;
  }

  incrementInFlight(): void {
    this.inflight += 1;
  }

  decrementInFlight(): void {
    if (this.inflight === 0) return;
    this.inflight -= 1;
  }

  clear(): SessionEntry[] {
    const entries = [...this.sessions.values()];
    this.sessions.clear();
    return entries;
  }

  evictExpired(): SessionEntry[] {
    const now = Date.now();
    const evicted: SessionEntry[] = [];

    for (const [id, session] of this.sessions.entries()) {
      if (!isSessionExpired(session, now, this.sessionTtlMs)) continue;
      this.sessions.delete(id);
      evicted.push(session);
    }

    return evicted;
  }

  evictOldest(): SessionEntry | undefined {
    const oldest = this.sessions.keys().next();
    if (oldest.done) return undefined;

    return removeSessionById(this.sessions, oldest.value);
  }
}
export function createSessionStore(sessionTtlMs: number): SessionStore {
  return new InMemorySessionStore(sessionTtlMs);
}
class SessionSlotTracker implements SlotTracker {
  private slotReleased = false;
  private initialized = false;

  constructor(private readonly store: SessionStore) {}

  releaseSlot(): void {
    if (this.slotReleased) return;
    this.slotReleased = true;
    this.store.decrementInFlight();
  }

  markInitialized(): void {
    this.initialized = true;
  }

  isInitialized(): boolean {
    return this.initialized;
  }
}
export function createSlotTracker(store: SessionStore): SlotTracker {
  return new SessionSlotTracker(store);
}
function currentLoad(store: SessionStore): number {
  return store.size() + store.inFlight();
}
export function reserveSessionSlot(
  store: SessionStore,
  maxSessions: number
): boolean {
  if (maxSessions <= 0) return false;
  if (currentLoad(store) >= maxSessions) return false;

  store.incrementInFlight();
  return true;
}
function isAtCapacity(store: SessionStore, maxSessions: number): boolean {
  return currentLoad(store) >= maxSessions;
}
export function ensureSessionCapacity({
  store,
  maxSessions,
  evictOldest,
}: {
  store: SessionStore;
  maxSessions: number;
  evictOldest: (store: SessionStore) => boolean;
}): boolean {
  if (maxSessions <= 0) return false;

  const currentSize = store.size();
  const inflight = store.inFlight();

  if (currentSize + inflight < maxSessions) return true;

  const canFreeSlot =
    currentSize >= maxSessions && currentSize - 1 + inflight < maxSessions;

  if (!canFreeSlot) return false;
  if (!evictOldest(store)) return false;

  return !isAtCapacity(store, maxSessions);
}
