import { AsyncLocalStorage } from 'node:async_hooks';
import { EventEmitter } from 'node:events';
import { accessSync, constants as fsConstants, readFileSync } from 'node:fs';
import { findPackageJSON } from 'node:module';
import { isIP } from 'node:net';
import process from 'node:process';
import {
  getSystemErrorMessage,
  inspect,
  stripVTControlCharacters,
} from 'node:util';

import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { type StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import {
  buildIpv4,
  normalizeHostname,
  stripTrailingDots,
} from './net-utils.js';
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
const EnvParser = {
  integerValue(
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
  },
  optionalInteger(
    envValue: string | undefined,
    min?: number,
    max?: number
  ): number | undefined {
    return EnvParser.integerValue(envValue, min, max) ?? undefined;
  },
  integer(
    envValue: string | undefined,
    defaultValue: number,
    min?: number,
    max?: number
  ): number {
    return EnvParser.integerValue(envValue, min, max) ?? defaultValue;
  },
  boolean(envValue: string | undefined, defaultValue: boolean): boolean {
    if (!envValue) return defaultValue;
    return envValue.trim().toLowerCase() !== 'false';
  },
  list(
    envValue: string | undefined,
    defaultValue?: readonly string[]
  ): string[] {
    if (!envValue) return defaultValue ? [...defaultValue] : [];
    const parsed = envValue
      .split(/[\s,]+/)
      .map((entry) => entry.trim())
      .filter(Boolean);
    return parsed.length > 0 || !defaultValue ? parsed : [...defaultValue];
  },
  locale(value: string | undefined): string | undefined {
    if (!value) return undefined;
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    const lowered = trimmed.toLowerCase();
    if (lowered === 'system' || lowered === 'default') return undefined;
    return trimmed;
  },
  logLevel(envValue: string | undefined): LogLevel {
    if (!envValue) return 'info';
    const level = envValue.toLowerCase();
    return ALLOWED_LOG_LEVELS.has(level) ? (level as LogLevel) : 'info';
  },
  transformWorkerMode(envValue: string | undefined): TransformWorkerMode {
    if (!envValue) return 'threads';
    const normalized = envValue.trim().toLowerCase();
    if (normalized === 'process' || normalized === 'fork') return 'process';
    return 'threads';
  },
  url(value: string | undefined, name: string): URL | undefined {
    if (!value) return undefined;
    if (!URL.canParse(value)) {
      throw new ConfigError(`Invalid ${name} value: ${value}`);
    }
    return new URL(value);
  },
  allowedHosts(envValue: string | undefined): Set<string> {
    return new Set(
      EnvParser.list(envValue)
        .map((h) => EnvParser.normalizeHostValue(h))
        .filter((h): h is string => h !== null)
    );
  },
  optionalFilePath(value: string | undefined): string | undefined {
    if (!value) return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  },
  normalizeHostValue(value: string): string | null {
    const raw = value.trim();
    if (!raw) return null;

    if (raw.includes('://') && URL.canParse(raw)) {
      return normalizeHostname(new URL(raw).hostname);
    }

    const candidateUrl = `http://${raw}`;
    if (URL.canParse(candidateUrl)) {
      return normalizeHostname(new URL(candidateUrl).hostname);
    }

    const lowered = raw.toLowerCase();

    if (lowered.startsWith('[')) {
      const end = lowered.indexOf(']');
      if (end === -1) return null;
      return normalizeHostname(lowered.slice(1, end));
    }

    if (isIP(lowered) === 6) return stripTrailingDots(lowered);

    const firstColon = lowered.indexOf(':');
    if (firstColon === -1) return normalizeHostname(lowered);
    if (lowered.includes(':', firstColon + 1)) return null;

    const host = lowered.slice(0, firstColon);
    return host ? normalizeHostname(host) : null;
  },
  formatHostForUrl(hostname: string): string {
    if (hostname.includes(':') && !hostname.startsWith('['))
      return `[${hostname}]`;
    return hostname;
  },
};

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
const MAX_INLINE_CONTENT_CHARS = EnvParser.integer(
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
const DEFAULT_FETCH_TIMEOUT_MS = EnvParser.integer(
  env['FETCH_TIMEOUT_MS'],
  15000,
  1000,
  60000
);
const DEFAULT_TOOL_TIMEOUT_MS =
  DEFAULT_FETCH_TIMEOUT_MS +
  DEFAULT_TRANSFORM_TIMEOUT_MS +
  DEFAULT_TOOL_TIMEOUT_PADDING_MS;
const DEFAULT_TASKS_MAX_TOTAL = EnvParser.integer(
  env['TASKS_MAX_TOTAL'],
  5000,
  1
);
const DEFAULT_TASKS_MAX_PER_OWNER = EnvParser.integer(
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
  const maxOldGenerationSizeMb = EnvParser.optionalInteger(
    env['TRANSFORM_WORKER_MAX_OLD_GENERATION_MB'],
    1
  );
  const maxYoungGenerationSizeMb = EnvParser.optionalInteger(
    env['TRANSFORM_WORKER_MAX_YOUNG_GENERATION_MB'],
    1
  );
  const codeRangeSizeMb = EnvParser.optionalInteger(
    env['TRANSFORM_WORKER_CODE_RANGE_MB'],
    1
  );
  const stackSizeMb = EnvParser.optionalInteger(
    env['TRANSFORM_WORKER_STACK_MB'],
    1
  );

  if (
    maxOldGenerationSizeMb === undefined &&
    maxYoungGenerationSizeMb === undefined &&
    codeRangeSizeMb === undefined &&
    stackSizeMb === undefined
  ) {
    return undefined;
  }

  const limits: WorkerResourceLimits = {};
  if (maxOldGenerationSizeMb !== undefined)
    limits.maxOldGenerationSizeMb = maxOldGenerationSizeMb;
  if (maxYoungGenerationSizeMb !== undefined)
    limits.maxYoungGenerationSizeMb = maxYoungGenerationSizeMb;
  if (codeRangeSizeMb !== undefined) limits.codeRangeSizeMb = codeRangeSizeMb;
  if (stackSizeMb !== undefined) limits.stackSizeMb = stackSizeMb;
  return limits;
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
  const issuerUrl = EnvParser.url(env['OAUTH_ISSUER_URL'], 'OAUTH_ISSUER_URL');
  const authorizationUrl = EnvParser.url(
    env['OAUTH_AUTHORIZATION_URL'],
    'OAUTH_AUTHORIZATION_URL'
  );
  const tokenUrl = EnvParser.url(env['OAUTH_TOKEN_URL'], 'OAUTH_TOKEN_URL');
  const revocationUrl = EnvParser.url(
    env['OAUTH_REVOCATION_URL'],
    'OAUTH_REVOCATION_URL'
  );
  const registrationUrl = EnvParser.url(
    env['OAUTH_REGISTRATION_URL'],
    'OAUTH_REGISTRATION_URL'
  );
  const introspectionUrl = EnvParser.url(
    env['OAUTH_INTROSPECTION_URL'],
    'OAUTH_INTROSPECTION_URL'
  );
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
const port =
  env['PORT']?.trim() === '0'
    ? 0
    : EnvParser.integer(env['PORT'], 3000, 1024, 65535);
const httpsConfig = buildHttpsConfig();
const allowRemote = EnvParser.boolean(env['ALLOW_REMOTE'], false);
const baseUrl = new URL(
  `${httpsConfig.enabled ? 'https' : 'http'}://${EnvParser.formatHostForUrl(host)}:${port}`
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
      headersTimeoutMs: EnvParser.optionalInteger(
        env['SERVER_HEADERS_TIMEOUT_MS'],
        1
      ),
      requestTimeoutMs: EnvParser.optionalInteger(
        env['SERVER_REQUEST_TIMEOUT_MS'],
        0
      ),
      keepAliveTimeoutMs: EnvParser.optionalInteger(
        env['SERVER_KEEP_ALIVE_TIMEOUT_MS'],
        1
      ),
      keepAliveTimeoutBufferMs: EnvParser.optionalInteger(
        env['SERVER_KEEP_ALIVE_TIMEOUT_BUFFER_MS'],
        0
      ),
      maxHeadersCount: EnvParser.optionalInteger(
        env['SERVER_MAX_HEADERS_COUNT'],
        1
      ),
      maxConnections: EnvParser.integer(env['SERVER_MAX_CONNECTIONS'], 0, 0),
      blockPrivateConnections: EnvParser.boolean(
        env['SERVER_BLOCK_PRIVATE_CONNECTIONS'],
        false
      ),
      requireProtocolVersionHeaderOnSessionInit: EnvParser.boolean(
        env['MCP_STRICT_PROTOCOL_VERSION_HEADER'],
        true
      ),
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
    cancelAckTimeoutMs: EnvParser.integer(
      env['TRANSFORM_CANCEL_ACK_TIMEOUT_MS'],
      200,
      50,
      5000
    ),
    workerMode: EnvParser.transformWorkerMode(env['TRANSFORM_WORKER_MODE']),
    workerResourceLimits: resolveWorkerResourceLimits(),
  },
  tools: {
    enabled: ['fetch-url'],
    timeoutMs: DEFAULT_TOOL_TIMEOUT_MS,
  },
  tasks: {
    maxTotal: DEFAULT_TASKS_MAX_TOTAL,
    maxPerOwner: RESOLVED_TASKS_MAX_PER_OWNER,
    emitStatusNotifications: EnvParser.boolean(
      env['TASKS_STATUS_NOTIFICATIONS'],
      false
    ),
    requireInterception: EnvParser.boolean(
      env['TASKS_REQUIRE_INTERCEPTION'],
      true
    ),
  },
  cache: {
    enabled: EnvParser.boolean(env['CACHE_ENABLED'], true),
    ttl: 86400,
    maxKeys: 100,
    maxSizeBytes: 50 * 1024 * 1024, // 50MB
  },
  extraction: {
    maxBlockLength: 5000,
    minParagraphLength: 10,
  },
  noiseRemoval: {
    extraTokens: EnvParser.list(env['FETCH_URL_MCP_EXTRA_NOISE_TOKENS']),
    extraSelectors: EnvParser.list(env['FETCH_URL_MCP_EXTRA_NOISE_SELECTORS']),
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
    headingKeywords: EnvParser.list(
      env['MARKDOWN_HEADING_KEYWORDS'],
      DEFAULT_HEADING_KEYWORDS
    ),
  },
  i18n: {
    locale: EnvParser.locale(env['FETCH_URL_MCP_LOCALE']),
  },
  logging: {
    level: EnvParser.logLevel(env['LOG_LEVEL']),
    format: env['LOG_FORMAT']?.toLowerCase() === 'json' ? 'json' : 'text',
  },
  constants: {
    maxHtmlSize: MAX_HTML_BYTES,
    maxUrlLength: 2048,
    maxInlineContentChars: MAX_INLINE_CONTENT_CHARS,
  },
  security: {
    blockedHosts: BLOCKED_HOSTS,
    allowedHosts: EnvParser.allowedHosts(env['ALLOWED_HOSTS']),
    apiKey: env['API_KEY'],
    allowRemote,
    allowLocalFetch: EnvParser.boolean(env['ALLOW_LOCAL_FETCH'], false),
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
export function createCacheKey(
  namespace: string,
  url: string,
  vary?: Record<string, unknown> | string
): string | null {
  if (!namespace || !url) return null;

  const urlHash = sha256Hex(url).substring(0, 32);

  if (!vary) return `${namespace}:${urlHash}`;

  const varyString =
    typeof vary === 'string'
      ? vary
      : (() => {
          try {
            return stableJsonStringify(vary);
          } catch {
            return null;
          }
        })();
  if (varyString === null) return null;

  const varyHash = varyString
    ? sha256Hex(varyString).substring(0, 16)
    : undefined;
  return varyHash
    ? `${namespace}:${urlHash}.${varyHash}`
    : `${namespace}:${urlHash}`;
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
): { url: string; title?: string; fetchedAt?: string } | undefined {
  const entry = store.peek(cacheKey);
  if (!entry) return undefined;
  return {
    url: entry.url,
    ...(entry.title !== undefined ? { title: entry.title } : {}),
    ...(entry.fetchedAt ? { fetchedAt: entry.fetchedAt } : {}),
  };
}
export function isEnabled(): boolean {
  return store.isEnabled();
}
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
const sessionMcpLogLevels = new Map<string, LogLevel>();
let stdioMcpLogLevel: LogLevel | undefined;
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
  sessionMcpLogLevels.delete(sessionId);
}
export function unregisterMcpSessionServerByServer(server: McpServer): void {
  for (const [sessionId, mappedServer] of sessionServers.entries()) {
    if (mappedServer !== server) continue;
    sessionServers.delete(sessionId);
    sessionMcpLogLevels.delete(sessionId);
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
export function getSessionId(): string | undefined {
  return getRequestContext()?.sessionId;
}
export function getOperationId(): string | undefined {
  return getRequestContext()?.operationId;
}
function isDebugEnabled(): boolean {
  return config.logging.level === 'debug';
}
function mergeMetadata(meta?: LogMetadata): LogMetadata | undefined {
  const ctx = requestContext.getStore();
  const hasMeta = meta && Object.keys(meta).length > 0;

  if (!ctx) return hasMeta ? meta : undefined;

  const { requestId, operationId, sessionId } = ctx;
  const includeSession = sessionId && isDebugEnabled();

  if (!requestId && !operationId && !includeSession)
    return hasMeta ? meta : undefined;

  const contextMeta: LogMetadata = {};
  if (requestId) contextMeta['requestId'] = requestId;
  if (operationId) contextMeta['operationId'] = operationId;
  if (includeSession) contextMeta['sessionId'] = sessionId;

  return hasMeta ? { ...contextMeta, ...meta } : contextMeta;
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
const LOG_LEVEL_ALIASES: Readonly<Record<string, LogLevel>> = {
  debug: 'debug',
  info: 'info',
  notice: 'info',
  warning: 'warn',
  warn: 'warn',
  error: 'error',
  critical: 'error',
  alert: 'error',
  emergency: 'error',
};
function normalizeLogLevel(level: string): LogLevel | undefined {
  return LOG_LEVEL_ALIASES[level.toLowerCase()];
}
function shouldForwardMcpLog(level: LogLevel, sessionId?: string): boolean {
  const mcpLevel = sessionId
    ? (sessionMcpLogLevels.get(sessionId) ?? config.logging.level)
    : (stdioMcpLogLevel ?? config.logging.level);
  return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[mcpLevel];
}
function resolveErrorText(err: unknown): string {
  if (err instanceof Error) {
    if ('errno' in err && typeof err.errno === 'number') {
      try {
        const sysMsg = getSystemErrorMessage(err.errno);
        if (sysMsg) return `${err.message} (${sysMsg})`;
      } catch {
        // ignore
      }
    }
    return err.message;
  }
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
  const sessionId = getSessionId();
  if (shouldLog(level)) {
    const line = formatLogEntry(level, message, meta);
    safeWriteStderr(`${stripVTControlCharacters(line)}\n`);
  }

  const server = sessionId ? sessionServers.get(sessionId) : mcpServer;
  if (!server) return;
  if (!server.isConnected()) return;
  if (!shouldForwardMcpLog(level, sessionId)) return;

  try {
    server.server
      .sendLoggingMessage(
        {
          level: level === 'warn' ? 'warning' : level,
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
function formatErrorMeta(error: Error): LogMetadata {
  const meta: LogMetadata = { error: error.message, stack: error.stack };
  if ('errno' in error && typeof error.errno === 'number') {
    try {
      const sysMsg = getSystemErrorMessage(error.errno);
      if (sysMsg) meta['sysError'] = sysMsg;
    } catch {
      // ignore
    }
  }
  return meta;
}

export function logError(message: string, error?: Error | LogMetadata): void {
  const errorMeta: LogMetadata =
    error instanceof Error ? formatErrorMeta(error) : (error ?? {});
  writeLog('error', message, errorMeta);
}
export function getMcpLogLevel(sessionId?: string): LogLevel {
  if (sessionId) {
    return sessionMcpLogLevels.get(sessionId) ?? config.logging.level;
  }
  return stdioMcpLogLevel ?? config.logging.level;
}
export function setLogLevel(level: string, sessionId?: string): void {
  const normalized = normalizeLogLevel(level);
  if (!normalized) return;

  if (sessionId) {
    sessionMcpLogLevels.set(sessionId, normalized);
    return;
  }

  stdioMcpLogLevel = normalized;
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
function logRejectedSettledResults(
  results: readonly PromiseSettledResult<unknown>[],
  message: string
): void {
  for (const result of results) {
    if (result.status === 'rejected') {
      logWarn(message, { error: getErrorMessage(result.reason) });
    }
  }
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

    for (let i = 0; i < evicted.length; i += SESSION_CLOSE_BATCH_SIZE) {
      const batch = evicted.slice(i, i + SESSION_CLOSE_BATCH_SIZE);
      const results = await Promise.allSettled(
        batch.map((session) => this.closeExpiredSession(session))
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

    if (transportResult.status === 'rejected') {
      this.logCloseFailure('transport', transportResult.reason);
    }
    if (serverResult.status === 'rejected') {
      this.logCloseFailure('server', serverResult.reason);
    }
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
class InMemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, SessionEntry>();
  private inflight = 0;

  constructor(private readonly sessionTtlMs: number) {}

  get(sessionId: string): SessionEntry | undefined {
    if (sessionId.length === 0) return undefined;
    return this.sessions.get(sessionId);
  }

  touch(sessionId: string): void {
    if (sessionId.length === 0) return;

    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.lastSeen = Date.now();
    this.sessions.delete(sessionId);
    this.sessions.set(sessionId, session);
  }

  set(sessionId: string, entry: SessionEntry): void {
    if (sessionId.length === 0) return;
    this.sessions.delete(sessionId);
    this.sessions.set(sessionId, entry);
  }

  remove(sessionId: string): SessionEntry | undefined {
    if (sessionId.length === 0) return undefined;
    const session = this.sessions.get(sessionId);
    this.sessions.delete(sessionId);
    return session;
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
      if (this.sessionTtlMs <= 0 || now - session.lastSeen <= this.sessionTtlMs)
        continue;
      this.sessions.delete(id);
      evicted.push(session);
    }

    return evicted;
  }

  evictOldest(): SessionEntry | undefined {
    const oldest = this.sessions.keys().next();
    if (oldest.done) return undefined;

    const session = this.sessions.get(oldest.value);
    this.sessions.delete(oldest.value);
    return session;
  }
}
export function createSessionStore(sessionTtlMs: number): SessionStore {
  return new InMemorySessionStore(sessionTtlMs);
}
export function createSlotTracker(store: SessionStore): SlotTracker {
  let slotReleased = false;
  let initialized = false;

  return {
    releaseSlot(): void {
      if (slotReleased) return;
      slotReleased = true;
      store.decrementInFlight();
    },
    markInitialized(): void {
      initialized = true;
    },
    isInitialized(): boolean {
      return initialized;
    },
  };
}
export function reserveSessionSlot(
  store: SessionStore,
  maxSessions: number
): boolean {
  if (maxSessions <= 0) return false;
  if (store.size() + store.inFlight() >= maxSessions) return false;

  store.incrementInFlight();
  return true;
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

  return store.size() + store.inFlight() < maxSessions;
}
