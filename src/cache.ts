import type { ServerResponse } from 'node:http';

import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  ErrorCode,
  McpError,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { config } from './config.js';
import { sha256Hex } from './crypto.js';
import { getErrorMessage } from './errors.js';
import { stableStringify as stableJsonStringify } from './json.js';
import { logDebug, logWarn } from './observability.js';
import { isObject } from './type-guards.js';

/* -------------------------------------------------------------------------------------------------
 * Types (public)
 * ------------------------------------------------------------------------------------------------- */

export interface CacheEntry {
  url: string;
  title?: string;
  content: string;
  fetchedAt: string;
  expiresAt: string;
}

export interface CachedPayload {
  content?: string;
  markdown?: string;
  title?: string;
}

export interface CacheKeyParts {
  namespace: string;
  urlHash: string;
}

export interface McpIcon {
  src: string;
  mimeType: string;
  sizes: string[];
}

/* -------------------------------------------------------------------------------------------------
 * Cached payload codec
 * ------------------------------------------------------------------------------------------------- */

function hasOptionalStringProperty(
  value: Record<string, unknown>,
  key: string
): boolean {
  const prop = value[key];
  return prop === undefined ? true : typeof prop === 'string';
}

function isCachedPayload(value: unknown): value is CachedPayload {
  if (!isObject(value)) return false;
  if (!hasOptionalStringProperty(value, 'content')) return false;
  if (!hasOptionalStringProperty(value, 'markdown')) return false;
  if (!hasOptionalStringProperty(value, 'title')) return false;
  return true;
}

class CachedPayloadCodec {
  parse(raw: string): CachedPayload | null {
    try {
      const parsed: unknown = JSON.parse(raw);
      return isCachedPayload(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  resolveContent(payload: CachedPayload): string | null {
    if (typeof payload.markdown === 'string') return payload.markdown;
    if (typeof payload.content === 'string') return payload.content;
    return null;
  }
}

const payloadCodec = new CachedPayloadCodec();

export function parseCachedPayload(raw: string): CachedPayload | null {
  return payloadCodec.parse(raw);
}

export function resolveCachedPayloadContent(
  payload: CachedPayload
): string | null {
  return payloadCodec.resolveContent(payload);
}

/* -------------------------------------------------------------------------------------------------
 * Cache key codec (hashing + parsing + resource URI)
 * ------------------------------------------------------------------------------------------------- */

const CACHE_HASH = {
  URL_HASH_LENGTH: 32,
  VARY_HASH_LENGTH: 16,
} as const;

function stableStringify(value: unknown): string | null {
  try {
    return stableJsonStringify(value);
  } catch {
    return null;
  }
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

function getVaryHash(
  vary?: Record<string, unknown> | string
): string | undefined | null {
  if (!vary) return undefined;

  const varyString = typeof vary === 'string' ? vary : stableStringify(vary);
  if (varyString === null) return null;
  if (!varyString) return undefined;

  return createHashFragment(varyString, CACHE_HASH.VARY_HASH_LENGTH);
}

function buildCacheResourceUri(namespace: string, urlHash: string): string {
  return `superfetch://cache/${namespace}/${urlHash}`;
}

class CacheKeyCodec {
  create(
    namespace: string,
    url: string,
    vary?: Record<string, unknown> | string
  ): string | null {
    if (!namespace || !url) return null;

    const urlHash = createHashFragment(url, CACHE_HASH.URL_HASH_LENGTH);
    const varyHash = getVaryHash(vary);
    if (varyHash === null) return null;

    return buildCacheKey(namespace, urlHash, varyHash);
  }

  parse(cacheKey: string): CacheKeyParts | null {
    if (!cacheKey) return null;
    const [namespace, ...rest] = cacheKey.split(':');
    const urlHash = rest.join(':');
    if (!namespace || !urlHash) return null;
    return { namespace, urlHash };
  }

  toResourceUri(cacheKey: string): string | null {
    const parts = this.parse(cacheKey);
    if (!parts) return null;
    return buildCacheResourceUri(parts.namespace, parts.urlHash);
  }
}

const cacheKeyCodec = new CacheKeyCodec();

export function createCacheKey(
  namespace: string,
  url: string,
  vary?: Record<string, unknown> | string
): string | null {
  return cacheKeyCodec.create(namespace, url, vary);
}

export function parseCacheKey(cacheKey: string): CacheKeyParts | null {
  return cacheKeyCodec.parse(cacheKey);
}

export function toResourceUri(cacheKey: string): string | null {
  return cacheKeyCodec.toResourceUri(cacheKey);
}

/* -------------------------------------------------------------------------------------------------
 * In-memory LRU cache (native)
 * Contract:
 * - Max entries: config.cache.maxKeys
 * - TTL in ms: config.cache.ttl * 1000
 * - Access does NOT extend TTL
 * ------------------------------------------------------------------------------------------------- */

class NativeLruCache<K, V> {
  private readonly max: number;
  private readonly ttlMs: number;
  private readonly entries = new Map<K, { value: V; expiresAtMs: number }>();
  private nextPurgeAtMs = 0;

  constructor({ max, ttlMs }: { max: number; ttlMs: number }) {
    this.max = max;
    this.ttlMs = ttlMs;
  }

  get(key: K): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;

    if (this.isExpired(entry, Date.now())) {
      this.entries.delete(key);
      return undefined;
    }

    // Refresh LRU order without extending TTL.
    this.entries.delete(key);
    this.entries.set(key, entry);

    return entry.value;
  }

  set(key: K, value: V): void {
    if (this.max <= 0 || this.ttlMs <= 0) return;

    const now = Date.now();
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAtMs: now + this.ttlMs });

    this.maybePurge(now);

    while (this.entries.size > this.max) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey === undefined) break;
      this.entries.delete(oldestKey);
    }
  }

  keys(): readonly K[] {
    this.maybePurge(Date.now());
    return [...this.entries.keys()];
  }

  private maybePurge(now: number): void {
    if (this.entries.size > this.max || now >= this.nextPurgeAtMs) {
      this.purgeExpired(now);
      this.nextPurgeAtMs = now + this.ttlMs;
    }
  }

  private purgeExpired(now: number): void {
    for (const [key, entry] of this.entries) {
      if (this.isExpired(entry, now)) this.entries.delete(key);
    }
  }

  private isExpired(entry: { expiresAtMs: number }, now: number): boolean {
    return entry.expiresAtMs <= now;
  }
}

interface CacheUpdateEvent {
  cacheKey: string;
  namespace: string;
  urlHash: string;
}
type CacheUpdateListener = (event: CacheUpdateEvent) => void;

interface CacheEntryMetadata {
  url: string;
  title?: string;
}

class InMemoryCacheStore {
  private readonly cache = new NativeLruCache<string, CacheEntry>({
    max: config.cache.maxKeys,
    ttlMs: config.cache.ttl * 1000,
  });

  private readonly listeners = new Set<CacheUpdateListener>();

  isEnabled(): boolean {
    return config.cache.enabled;
  }

  keys(): readonly string[] {
    return [...this.cache.keys()];
  }

  onUpdate(listener: CacheUpdateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get(cacheKey: string | null): CacheEntry | undefined {
    if (!this.isReadable(cacheKey)) return undefined;
    return this.run(cacheKey, 'Cache get error', () =>
      this.cache.get(cacheKey)
    );
  }

  set(
    cacheKey: string | null,
    content: string,
    metadata: CacheEntryMetadata
  ): void {
    if (!this.isWritable(cacheKey, content)) return;

    this.run(cacheKey, 'Cache set error', () => {
      const now = Date.now();
      const expiresAtMs = now + config.cache.ttl * 1000; // preserve existing behavior
      const entry = this.buildEntry(content, metadata, now, expiresAtMs);
      this.cache.set(cacheKey, entry);
      this.notify(cacheKey);
    });
  }

  private isReadable(cacheKey: string | null): cacheKey is string {
    return config.cache.enabled && Boolean(cacheKey);
  }

  private isWritable(
    cacheKey: string | null,
    content: string
  ): cacheKey is string {
    return config.cache.enabled && Boolean(cacheKey) && Boolean(content);
  }

  private run<T>(
    cacheKey: string,
    message: string,
    operation: () => T
  ): T | undefined {
    try {
      return operation();
    } catch (error: unknown) {
      this.logError(message, cacheKey, error);
      return undefined;
    }
  }

  private buildEntry(
    content: string,
    metadata: CacheEntryMetadata,
    fetchedAtMs: number,
    expiresAtMs: number
  ): CacheEntry {
    return {
      url: metadata.url,
      content,
      fetchedAt: new Date(fetchedAtMs).toISOString(),
      expiresAt: new Date(expiresAtMs).toISOString(),
      ...(metadata.title === undefined ? {} : { title: metadata.title }),
    };
  }

  private notify(cacheKey: string): void {
    if (this.listeners.size === 0) return;

    const parts = cacheKeyCodec.parse(cacheKey);
    if (!parts) return;

    const event: CacheUpdateEvent = { cacheKey, ...parts };
    for (const listener of this.listeners) listener(event);
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

export function get(cacheKey: string | null): CacheEntry | undefined {
  return store.get(cacheKey);
}

export function set(
  cacheKey: string | null,
  content: string,
  metadata: CacheEntryMetadata
): void {
  store.set(cacheKey, content, metadata);
}

export function keys(): readonly string[] {
  return store.keys();
}

export function isEnabled(): boolean {
  return store.isEnabled();
}

/* -------------------------------------------------------------------------------------------------
 * MCP cached content resource (superfetch://cache/markdown/{urlHash})
 * ------------------------------------------------------------------------------------------------- */

const CACHE_NAMESPACE = 'markdown';
const HASH_PATTERN = /^[a-f0-9.]+$/i;
const INVALID_CACHE_PARAMS_MESSAGE = 'Invalid cache resource parameters';

function throwInvalidCacheParams(): never {
  throw new McpError(ErrorCode.InvalidParams, INVALID_CACHE_PARAMS_MESSAGE);
}

function resolveStringParam(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function isValidNamespace(namespace: string): boolean {
  return namespace === CACHE_NAMESPACE;
}

function isValidHash(hash: string): boolean {
  return HASH_PATTERN.test(hash) && hash.length >= 8 && hash.length <= 64;
}

function requireRecordParams(value: unknown): Record<string, unknown> {
  if (!isObject(value)) throwInvalidCacheParams();
  return value;
}

function requireParamString(
  params: Record<string, unknown>,
  key: 'namespace' | 'urlHash'
): string {
  const resolved = resolveStringParam(params[key]);
  if (!resolved) {
    throw new McpError(
      ErrorCode.InvalidParams,
      'Both namespace and urlHash parameters are required'
    );
  }
  return resolved;
}

function resolveCacheParams(params: unknown): {
  namespace: string;
  urlHash: string;
} {
  const parsed = requireRecordParams(params);
  const namespace = requireParamString(parsed, 'namespace');
  const urlHash = requireParamString(parsed, 'urlHash');

  if (!isValidNamespace(namespace) || !isValidHash(urlHash)) {
    throwInvalidCacheParams();
  }

  return { namespace, urlHash };
}

function isValidCacheResourceUri(uri: string): boolean {
  if (!uri) return false;

  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }

  if (parsed.protocol !== 'superfetch:') return false;
  if (parsed.hostname !== 'cache') return false;

  const parts = parsed.pathname.split('/').filter(Boolean);
  if (parts.length !== 2) return false;

  const [namespace, urlHash] = parts;
  if (!namespace || !urlHash) return false;

  return isValidNamespace(namespace) && isValidHash(urlHash);
}

function buildResourceEntry(
  namespace: string,
  urlHash: string
): {
  name: string;
  uri: string;
  description: string;
  mimeType: string;
} {
  return {
    name: `${namespace}:${urlHash}`,
    uri: buildCacheResourceUri(namespace, urlHash),
    description: `Cached content entry for ${namespace}`,
    mimeType: 'text/markdown',
  };
}

function listCachedResources(): {
  resources: ReturnType<typeof buildResourceEntry>[];
} {
  const resources = keys()
    .map((key) => {
      const parts = cacheKeyCodec.parse(key);
      if (parts?.namespace !== CACHE_NAMESPACE) return null;
      return buildResourceEntry(parts.namespace, parts.urlHash);
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

  return { resources };
}

function appendServerOnClose(server: McpServer, handler: () => void): void {
  const previousOnClose = server.server.onclose;
  server.server.onclose = () => {
    previousOnClose?.();
    handler();
  };
}

function attachInitializedGate(server: McpServer): () => boolean {
  let initialized = false;
  const previousInitialized = server.server.oninitialized;
  server.server.oninitialized = () => {
    initialized = true;
    previousInitialized?.();
  };
  return () => initialized;
}

function getClientResourceCapabilities(server: McpServer): {
  listChanged: boolean;
  subscribe: boolean;
} {
  const caps = server.server.getClientCapabilities();
  if (!caps || !isObject(caps)) return { listChanged: false, subscribe: false };

  const { resources } = caps as { resources?: unknown };
  if (!isObject(resources)) return { listChanged: false, subscribe: false };

  const { listChanged, subscribe } = resources as {
    listChanged?: boolean;
    subscribe?: boolean;
  };

  return { listChanged: listChanged === true, subscribe: subscribe === true };
}

function registerResourceSubscriptionHandlers(server: McpServer): Set<string> {
  const subscriptions = new Set<string>();

  server.server.setRequestHandler(SubscribeRequestSchema, (request) => {
    const { uri } = request.params;
    if (!isValidCacheResourceUri(uri)) {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid resource URI');
    }
    subscriptions.add(uri);
    return {};
  });

  server.server.setRequestHandler(UnsubscribeRequestSchema, (request) => {
    const { uri } = request.params;
    if (!isValidCacheResourceUri(uri)) {
      throw new McpError(ErrorCode.InvalidParams, 'Invalid resource URI');
    }
    subscriptions.delete(uri);
    return {};
  });

  appendServerOnClose(server, () => {
    subscriptions.clear();
  });
  return subscriptions;
}

function notifyResourceUpdate(
  server: McpServer,
  uri: string,
  subscriptions: Set<string>
): void {
  if (!server.isConnected()) return;
  if (!subscriptions.has(uri)) return;

  void server.server.sendResourceUpdated({ uri }).catch((error: unknown) => {
    logWarn('Failed to send resource update notification', {
      uri,
      error: getErrorMessage(error),
    });
  });
}

function requireCacheEntry(cacheKey: string): { content: string } {
  const cached = get(cacheKey);
  if (!cached) {
    throw new McpError(
      -32002,
      `Content not found in cache for key: ${cacheKey}`
    );
  }
  return cached;
}

function buildMarkdownContentResponse(
  uri: URL,
  content: string
): { contents: { uri: string; mimeType: string; text: string }[] } {
  const payload = payloadCodec.parse(content);
  const resolvedContent = payload ? payloadCodec.resolveContent(payload) : null;

  if (!resolvedContent) {
    throw new McpError(
      ErrorCode.InternalError,
      'Cached markdown content is missing'
    );
  }

  return {
    contents: [
      { uri: uri.href, mimeType: 'text/markdown', text: resolvedContent },
    ],
  };
}

function buildCachedContentResponse(
  uri: URL,
  cacheKey: string
): { contents: { uri: string; mimeType: string; text: string }[] } {
  const cached = requireCacheEntry(cacheKey);
  return buildMarkdownContentResponse(uri, cached.content);
}

function registerCacheContentResource(
  server: McpServer,
  serverIcons?: McpIcon[]
): void {
  server.registerResource(
    'cached-content',
    new ResourceTemplate('superfetch://cache/{namespace}/{urlHash}', {
      list: listCachedResources,
    }),
    {
      title: 'Cached Content',
      description:
        'Access previously fetched web content from cache. Namespace: markdown. UrlHash: SHA-256 hash of the URL.',
      mimeType: 'text/markdown',
      ...(serverIcons ? { icons: serverIcons } : {}),
    },
    (uri, params) => {
      const { namespace, urlHash } = resolveCacheParams(params);
      const cacheKey = `${namespace}:${urlHash}`;
      return buildCachedContentResponse(uri, cacheKey);
    }
  );
}

function registerCacheUpdateSubscription(
  server: McpServer,
  subscriptions: Set<string>,
  isInitialized: () => boolean
): void {
  const unsubscribe = onCacheUpdate(({ cacheKey }) => {
    if (!server.isConnected() || !isInitialized()) return;

    const { listChanged, subscribe } = getClientResourceCapabilities(server);

    if (subscribe) {
      const resourceUri = cacheKeyCodec.toResourceUri(cacheKey);
      if (resourceUri) notifyResourceUpdate(server, resourceUri, subscriptions);
    }

    if (listChanged) {
      server.sendResourceListChanged();
    }
  });

  appendServerOnClose(server, unsubscribe);
}

export function registerCachedContentResource(
  server: McpServer,
  serverIcons?: McpIcon[]
): void {
  const isInitialized = attachInitializedGate(server);
  const subscriptions = registerResourceSubscriptionHandlers(server);

  registerCacheContentResource(server, serverIcons);
  registerCacheUpdateSubscription(server, subscriptions, isInitialized);
}

/* -------------------------------------------------------------------------------------------------
 * Filename generation
 * ------------------------------------------------------------------------------------------------- */

const MAX_FILENAME_LENGTH = 200;
const UNSAFE_CHARS_REGEX = /[<>:"/\\|?*]|\p{C}/gu;
const WHITESPACE_REGEX = /\s+/g;

function trimHyphens(value: string): string {
  let start = 0;
  let end = value.length;

  while (start < end && value[start] === '-') start += 1;
  while (end > start && value[end - 1] === '-') end -= 1;

  return value.slice(start, end);
}

function stripCommonPageExtension(segment: string): string {
  return segment.replace(/\.(html?|php|aspx?|jsp)$/i, '');
}

function normalizeUrlFilenameSegment(segment: string): string | null {
  const cleaned = stripCommonPageExtension(segment);
  if (!cleaned) return null;
  if (cleaned === 'index') return null;
  return cleaned;
}

function getLastPathSegment(url: URL): string | null {
  const segments = url.pathname.split('/').filter(Boolean);
  if (segments.length === 0) return null;
  return segments[segments.length - 1] ?? null;
}

function extractFilenameFromUrl(url: string): string | null {
  try {
    const urlObj = new URL(url);
    const lastSegment = getLastPathSegment(urlObj);
    if (!lastSegment) return null;
    return normalizeUrlFilenameSegment(lastSegment);
  } catch {
    return null;
  }
}

function slugifyTitle(title: string): string | null {
  const slug = title
    .toLowerCase()
    .trim()
    .replace(UNSAFE_CHARS_REGEX, '')
    .replace(WHITESPACE_REGEX, '-')
    .replace(/-+/g, '-');

  const trimmed = trimHyphens(slug);
  return trimmed || null;
}

function sanitizeFilename(name: string, extension: string): string {
  let sanitized = name
    .replace(UNSAFE_CHARS_REGEX, '')
    .replace(WHITESPACE_REGEX, '-')
    .trim();

  const maxBase = MAX_FILENAME_LENGTH - extension.length;
  if (sanitized.length > maxBase) {
    sanitized = sanitized.substring(0, maxBase);
  }

  return `${sanitized}${extension}`;
}

export function generateSafeFilename(
  url: string,
  title?: string,
  hashFallback?: string,
  extension = '.md'
): string {
  const fromUrl = extractFilenameFromUrl(url);
  if (fromUrl) return sanitizeFilename(fromUrl, extension);

  if (title) {
    const fromTitle = slugifyTitle(title);
    if (fromTitle) return sanitizeFilename(fromTitle, extension);
  }

  if (hashFallback) {
    return `${hashFallback.substring(0, 16)}${extension}`;
  }

  return `download-${Date.now()}${extension}`;
}

/* -------------------------------------------------------------------------------------------------
 * Download handler
 * ------------------------------------------------------------------------------------------------- */

interface DownloadParams {
  namespace: string;
  hash: string;
}

interface DownloadPayload {
  content: string;
  contentType: string;
  fileName: string;
}

function parseDownloadParams(
  namespace: unknown,
  hash: unknown
): DownloadParams | null {
  const resolvedNamespace = resolveStringParam(namespace);
  const resolvedHash = resolveStringParam(hash);

  if (!resolvedNamespace || !resolvedHash) return null;
  if (!isValidNamespace(resolvedNamespace)) return null;
  if (!isValidHash(resolvedHash)) return null;

  return { namespace: resolvedNamespace, hash: resolvedHash };
}

function buildCacheKeyFromParams(params: DownloadParams): string {
  return `${params.namespace}:${params.hash}`;
}

function sendJsonError(
  res: ServerResponse,
  status: number,
  error: string,
  code: string
): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error, code }));
}

function respondBadRequest(res: ServerResponse, message: string): void {
  sendJsonError(res, 400, message, 'BAD_REQUEST');
}

function respondNotFound(res: ServerResponse): void {
  sendJsonError(res, 404, 'Content not found or expired', 'NOT_FOUND');
}

function respondServiceUnavailable(res: ServerResponse): void {
  sendJsonError(
    res,
    503,
    'Download service is disabled',
    'SERVICE_UNAVAILABLE'
  );
}

function buildContentDisposition(fileName: string): string {
  const encodedName = encodeURIComponent(fileName).replace(/'/g, '%27');
  return `attachment; filename="${fileName}"; filename*=UTF-8''${encodedName}`;
}

function sendDownloadPayload(
  res: ServerResponse,
  payload: DownloadPayload
): void {
  const disposition = buildContentDisposition(payload.fileName);
  res.setHeader('Content-Type', payload.contentType);
  res.setHeader('Content-Disposition', disposition);
  res.setHeader('Cache-Control', `private, max-age=${config.cache.ttl}`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(payload.content);
}

function resolveDownloadPayload(
  params: DownloadParams,
  cacheEntry: CacheEntry
): DownloadPayload | null {
  const payload = payloadCodec.parse(cacheEntry.content);
  if (!payload) return null;

  const content = payloadCodec.resolveContent(payload);
  if (!content) return null;

  const safeTitle =
    typeof payload.title === 'string' ? payload.title : undefined;
  const fileName = generateSafeFilename(
    cacheEntry.url,
    cacheEntry.title ?? safeTitle,
    params.hash,
    '.md'
  );

  return {
    content,
    contentType: 'text/markdown; charset=utf-8',
    fileName,
  };
}

export function handleDownload(
  res: ServerResponse,
  namespace: string,
  hash: string
): void {
  if (!config.cache.enabled) {
    respondServiceUnavailable(res);
    return;
  }

  const params = parseDownloadParams(namespace, hash);
  if (!params) {
    respondBadRequest(res, 'Invalid namespace or hash format');
    return;
  }

  const cacheKey = buildCacheKeyFromParams(params);
  const cacheEntry = get(cacheKey);

  if (!cacheEntry) {
    logDebug('Download request for missing cache key', { cacheKey });
    respondNotFound(res);
    return;
  }

  const payload = resolveDownloadPayload(params, cacheEntry);
  if (!payload) {
    logDebug('Download payload unavailable', { cacheKey });
    respondNotFound(res);
    return;
  }

  logDebug('Serving download', { cacheKey, fileName: payload.fileName });
  sendDownloadPayload(res, payload);
}
