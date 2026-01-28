import type { ServerResponse } from 'node:http';

import { LRUCache } from 'lru-cache';

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
import { isRecord } from './type-guards.js';

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

export function parseCachedPayload(raw: string): CachedPayload | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return isCachedPayload(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function resolveCachedPayloadContent(
  payload: CachedPayload
): string | null {
  if (typeof payload.markdown === 'string') {
    return payload.markdown;
  }
  if (typeof payload.content === 'string') {
    return payload.content;
  }
  return null;
}

function hasOptionalStringProperty(
  value: Record<string, unknown>,
  key: string
): boolean {
  const prop = value[key];
  if (prop === undefined) return true;
  return typeof prop === 'string';
}

function isCachedPayload(value: unknown): value is CachedPayload {
  if (!isRecord(value)) return false;
  if (!hasOptionalStringProperty(value, 'content')) return false;
  if (!hasOptionalStringProperty(value, 'markdown')) return false;
  if (!hasOptionalStringProperty(value, 'title')) return false;
  return true;
}

export interface CacheKeyParts {
  namespace: string;
  urlHash: string;
}

const CACHE_HASH = {
  URL_HASH_LENGTH: 32,
  VARY_HASH_LENGTH: 16,
};

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
  let varyString: string | null;
  if (typeof vary === 'string') {
    varyString = vary;
  } else {
    varyString = stableStringify(vary);
  }
  if (varyString === null) return null;
  if (!varyString) return undefined;
  return createHashFragment(varyString, CACHE_HASH.VARY_HASH_LENGTH);
}

export function createCacheKey(
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

export function parseCacheKey(cacheKey: string): CacheKeyParts | null {
  if (!cacheKey) return null;
  const [namespace, ...rest] = cacheKey.split(':');
  const urlHash = rest.join(':');
  if (!namespace || !urlHash) return null;
  return { namespace, urlHash };
}

function buildCacheResourceUri(namespace: string, urlHash: string): string {
  return `superfetch://cache/${namespace}/${urlHash}`;
}

export function toResourceUri(cacheKey: string): string | null {
  const parts = parseCacheKey(cacheKey);
  if (!parts) return null;
  return buildCacheResourceUri(parts.namespace, parts.urlHash);
}

const contentCache = new LRUCache<string, CacheEntry>({
  max: config.cache.maxKeys,
  ttl: config.cache.ttl * 1000,
  updateAgeOnGet: false,
});

interface CacheUpdateEvent {
  cacheKey: string;
  namespace: string;
  urlHash: string;
}

type CacheUpdateListener = (event: CacheUpdateEvent) => void;

const updateListeners = new Set<CacheUpdateListener>();

export function onCacheUpdate(listener: CacheUpdateListener): () => void {
  updateListeners.add(listener);
  return () => {
    updateListeners.delete(listener);
  };
}

function notifyCacheUpdate(cacheKey: string): void {
  if (updateListeners.size === 0) return;
  const parts = parseCacheKey(cacheKey);
  if (!parts) return;
  const event: CacheUpdateEvent = { cacheKey, ...parts };
  for (const listener of updateListeners) {
    listener(event);
  }
}

interface CacheEntryMetadata {
  url: string;
  title?: string;
}

export function get(cacheKey: string | null): CacheEntry | undefined {
  if (!isCacheReadable(cacheKey)) return undefined;
  return runCacheOperation(cacheKey, 'Cache get error', () =>
    contentCache.get(cacheKey)
  );
}

function isCacheReadable(cacheKey: string | null): cacheKey is string {
  return config.cache.enabled && Boolean(cacheKey);
}

function isCacheWritable(
  cacheKey: string | null,
  content: string
): cacheKey is string {
  return config.cache.enabled && Boolean(cacheKey) && Boolean(content);
}

function runCacheOperation<T>(
  cacheKey: string,
  message: string,
  operation: () => T
): T | undefined {
  try {
    return operation();
  } catch (error: unknown) {
    logCacheError(message, cacheKey, error);
    return undefined;
  }
}

export function set(
  cacheKey: string | null,
  content: string,
  metadata: CacheEntryMetadata
): void {
  if (!isCacheWritable(cacheKey, content)) return;
  runCacheOperation(cacheKey, 'Cache set error', () => {
    const now = Date.now();
    const expiresAtMs = now + config.cache.ttl * 1000;
    const entry = buildCacheEntry({
      content,
      metadata,
      fetchedAtMs: now,
      expiresAtMs,
    });
    persistCacheEntry(cacheKey, entry);
  });
}

export function keys(): readonly string[] {
  return [...contentCache.keys()];
}

export function isEnabled(): boolean {
  return config.cache.enabled;
}

function buildCacheEntry({
  content,
  metadata,
  fetchedAtMs,
  expiresAtMs,
}: {
  content: string;
  metadata: CacheEntryMetadata;
  fetchedAtMs: number;
  expiresAtMs: number;
}): CacheEntry {
  return {
    url: metadata.url,
    content,
    fetchedAt: new Date(fetchedAtMs).toISOString(),
    expiresAt: new Date(expiresAtMs).toISOString(),
    ...(metadata.title === undefined ? {} : { title: metadata.title }),
  };
}

function persistCacheEntry(cacheKey: string, entry: CacheEntry): void {
  contentCache.set(cacheKey, entry);
  notifyCacheUpdate(cacheKey);
}

function logCacheError(
  message: string,
  cacheKey: string,
  error: unknown
): void {
  logWarn(message, {
    key: cacheKey.length > 100 ? cacheKey.slice(0, 100) : cacheKey,
    error: getErrorMessage(error),
  });
}

const CACHE_NAMESPACE = 'markdown';
const HASH_PATTERN = /^[a-f0-9.]+$/i;
const INVALID_CACHE_PARAMS_MESSAGE = 'Invalid cache resource parameters';

function throwInvalidCacheParams(): never {
  throw new McpError(ErrorCode.InvalidParams, INVALID_CACHE_PARAMS_MESSAGE);
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

function requireRecordParams(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throwInvalidCacheParams();
  }
  return value;
}

function requireParamString(
  params: Record<string, unknown>,
  key: 'namespace' | 'urlHash'
): string {
  const raw = params[key];
  const resolved = resolveStringParam(raw);
  if (!resolved) {
    throw new McpError(
      ErrorCode.InvalidParams,
      'Both namespace and urlHash parameters are required'
    );
  }
  return resolved;
}

function isValidNamespace(namespace: string): boolean {
  return namespace === CACHE_NAMESPACE;
}

function isValidHash(hash: string): boolean {
  return HASH_PATTERN.test(hash) && hash.length >= 8 && hash.length <= 64;
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

function resolveStringParam(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
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
      const parts = parseCacheKey(key);
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
  if (!caps || !isRecord(caps)) {
    return { listChanged: false, subscribe: false };
  }

  const { resources } = caps as { resources?: unknown };
  if (!isRecord(resources)) {
    return { listChanged: false, subscribe: false };
  }

  const { listChanged, subscribe } = resources as {
    listChanged?: boolean;
    subscribe?: boolean;
  };

  return {
    listChanged: listChanged === true,
    subscribe: subscribe === true,
  };
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

export function registerCachedContentResource(server: McpServer): void {
  const isInitialized = attachInitializedGate(server);
  const subscriptions = registerResourceSubscriptionHandlers(server);
  registerCacheContentResource(server);
  registerCacheUpdateSubscription(server, subscriptions, isInitialized);
}

function buildCachedContentResponse(
  uri: URL,
  cacheKey: string
): { contents: { uri: string; mimeType: string; text: string }[] } {
  const cached = requireCacheEntry(cacheKey);
  return buildMarkdownContentResponse(uri, cached.content);
}

function registerCacheContentResource(server: McpServer): void {
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
      const resourceUri = toResourceUri(cacheKey);
      if (resourceUri) {
        notifyResourceUpdate(server, resourceUri, subscriptions);
      }
    }

    if (listChanged) {
      server.sendResourceListChanged();
    }
  });

  appendServerOnClose(server, unsubscribe);
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
  const payload = parseCachedPayload(content);
  const resolvedContent = payload ? resolveCachedPayloadContent(payload) : null;

  if (!resolvedContent) {
    throw new McpError(
      ErrorCode.InternalError,
      'Cached markdown content is missing'
    );
  }

  return {
    contents: [
      {
        uri: uri.href,
        mimeType: 'text/markdown',
        text: resolvedContent,
      },
    ],
  };
}

interface DownloadParams {
  namespace: string;
  hash: string;
}

interface DownloadPayload {
  content: string;
  contentType: string;
  fileName: string;
}

function isSingleParam(value: unknown): value is string {
  return typeof value === 'string';
}

function parseDownloadParams(
  namespace: unknown,
  hash: unknown
): DownloadParams | null {
  if (!isSingleParam(namespace) || !isSingleParam(hash)) return null;
  if (!namespace || !hash) return null;
  if (!isValidNamespace(namespace)) return null;
  if (!isValidHash(hash)) return null;

  return { namespace, hash };
}

function buildCacheKeyFromParams(params: DownloadParams): string {
  return `${params.namespace}:${params.hash}`;
}

function respondBadRequest(res: ServerResponse, message: string): void {
  res.writeHead(400, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({
      error: message,
      code: 'BAD_REQUEST',
    })
  );
}

function respondNotFound(res: ServerResponse): void {
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({
      error: 'Content not found or expired',
      code: 'NOT_FOUND',
    })
  );
}

function respondServiceUnavailable(res: ServerResponse): void {
  res.writeHead(503, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({
      error: 'Download service is disabled',
      code: 'SERVICE_UNAVAILABLE',
    })
  );
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

function getLastPathSegment(url: URL): string | null {
  const segments = url.pathname.split('/').filter(Boolean);
  if (segments.length === 0) return null;
  const lastSegment = segments[segments.length - 1];
  return lastSegment ?? null;
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

const MAX_FILENAME_LENGTH = 200;
const UNSAFE_CHARS_REGEX = /[<>:"/\\|?*]|\p{C}/gu;
const WHITESPACE_REGEX = /\s+/g;

function trimHyphens(value: string): string {
  let start = 0;
  let end = value.length;

  while (start < end && value[start] === '-') {
    start += 1;
  }
  while (end > start && value[end - 1] === '-') {
    end -= 1;
  }

  return value.slice(start, end);
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

  // Truncate if too long
  const maxBase = MAX_FILENAME_LENGTH - extension.length;
  if (sanitized.length > maxBase) {
    sanitized = sanitized.substring(0, maxBase);
  }

  return `${sanitized}${extension}`;
}

function resolveDownloadPayload(
  params: DownloadParams,
  cacheEntry: CacheEntry
): DownloadPayload | null {
  const payload = parseCachedPayload(cacheEntry.content);
  if (!payload) return null;

  const content = resolveCachedPayloadContent(payload);
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
