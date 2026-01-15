import { setInterval as setIntervalPromise } from 'node:timers/promises';

import type { Express, Request, Response } from 'express';

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
import { logDebug, logWarn } from './observability.js';
import { isRecord } from './utils.js';

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
  URL_HASH_LENGTH: 16,
  VARY_HASH_LENGTH: 12,
};

const CACHE_VARY_LIMITS = {
  MAX_STRING_LENGTH: 4096,
  MAX_KEYS: 64,
  MAX_ARRAY_LENGTH: 64,
  MAX_DEPTH: 6,
  MAX_NODES: 512,
};

interface StableStringifyState {
  depth: number;
  nodes: number;
  readonly stack: WeakSet<object>;
}

function bumpStableStringifyNodeCount(state: StableStringifyState): boolean {
  state.nodes += 1;
  return state.nodes <= CACHE_VARY_LIMITS.MAX_NODES;
}

function stableStringifyPrimitive(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  const json = JSON.stringify(value);
  return typeof json === 'string' ? json : '';
}

function stableStringifyArray(
  value: unknown[],
  state: StableStringifyState
): string | null {
  if (value.length > CACHE_VARY_LIMITS.MAX_ARRAY_LENGTH) {
    return null;
  }

  const parts: string[] = ['['];
  let length = 1;

  for (let index = 0; index < value.length; index += 1) {
    if (index > 0) {
      parts.push(',');
      length += 1;
      if (length > CACHE_VARY_LIMITS.MAX_STRING_LENGTH) return null;
    }

    const entry = stableStringifyInner(value[index], state);
    if (entry === null) return null;

    parts.push(entry);
    length += entry.length;
    if (length > CACHE_VARY_LIMITS.MAX_STRING_LENGTH) return null;
  }

  parts.push(']');
  length += 1;

  return length > CACHE_VARY_LIMITS.MAX_STRING_LENGTH ? null : parts.join('');
}

function stableStringifyRecord(
  value: Record<string, unknown>,
  state: StableStringifyState
): string | null {
  const keys = Object.keys(value);
  if (keys.length > CACHE_VARY_LIMITS.MAX_KEYS) {
    return null;
  }

  keys.sort((a, b) => a.localeCompare(b));

  const parts: string[] = ['{'];
  let length = 1;
  let isFirst = true;

  for (const key of keys) {
    const entryValue = value[key];
    if (entryValue === undefined) continue;

    const encodedValue = stableStringifyInner(entryValue, state);
    if (encodedValue === null) return null;

    const entry = `${JSON.stringify(key)}:${encodedValue}`;

    if (!isFirst) {
      parts.push(',');
      length += 1;
      if (length > CACHE_VARY_LIMITS.MAX_STRING_LENGTH) return null;
    }

    parts.push(entry);
    length += entry.length;
    if (length > CACHE_VARY_LIMITS.MAX_STRING_LENGTH) return null;

    isFirst = false;
  }

  parts.push('}');
  length += 1;

  return length > CACHE_VARY_LIMITS.MAX_STRING_LENGTH ? null : parts.join('');
}

function stableStringifyObject(
  value: object,
  state: StableStringifyState
): string | null {
  if (state.stack.has(value)) {
    return null;
  }

  if (state.depth >= CACHE_VARY_LIMITS.MAX_DEPTH) {
    return null;
  }

  state.stack.add(value);
  state.depth += 1;
  try {
    if (Array.isArray(value)) {
      return stableStringifyArray(value, state);
    }

    return isRecord(value) ? stableStringifyRecord(value, state) : null;
  } finally {
    state.depth -= 1;
    state.stack.delete(value);
  }
}

function stableStringifyInner(
  value: unknown,
  state: StableStringifyState
): string | null {
  if (!bumpStableStringifyNodeCount(state)) {
    return null;
  }

  if (value === null || value === undefined) {
    return '';
  }

  if (typeof value !== 'object') {
    return stableStringifyPrimitive(value);
  }

  return stableStringifyObject(value, state);
}

function stableStringify(value: unknown): string | null {
  const state: StableStringifyState = {
    depth: 0,
    nodes: 0,
    stack: new WeakSet(),
  };

  return stableStringifyInner(value, state);
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
    varyString =
      vary.length > CACHE_VARY_LIMITS.MAX_STRING_LENGTH ? null : vary;
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

export function toResourceUri(cacheKey: string): string | null {
  const parts = parseCacheKey(cacheKey);
  if (!parts) return null;
  return `superfetch://cache/${parts.namespace}/${parts.urlHash}`;
}

interface CacheItem {
  entry: CacheEntry;
  expiresAt: number;
}
const contentCache = new Map<string, CacheItem>();
let cleanupController: AbortController | null = null;

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

function startCleanupLoop(): void {
  if (cleanupController) return;
  cleanupController = new AbortController();
  void runCleanupLoop(cleanupController.signal).catch((error: unknown) => {
    if (error instanceof Error && error.name !== 'AbortError') {
      logWarn('Cache cleanup loop failed', { error: getErrorMessage(error) });
    }
  });
}

async function runCleanupLoop(signal: AbortSignal): Promise<void> {
  const intervalMs = Math.floor(config.cache.ttl * 1000);
  for await (const getNow of setIntervalPromise(intervalMs, Date.now, {
    signal,
    ref: false,
  })) {
    enforceCacheLimits(getNow());
  }
}

function enforceCacheLimits(now: number): void {
  for (const [key, item] of contentCache.entries()) {
    if (now > item.expiresAt) {
      contentCache.delete(key);
    }
  }
  trimCacheToMaxKeys();
}

interface CacheEntryMetadata {
  url: string;
  title?: string;
}

export function get(cacheKey: string | null): CacheEntry | undefined {
  if (!isCacheReadable(cacheKey)) return undefined;
  return runCacheOperation(cacheKey, 'Cache get error', () =>
    readCacheEntry(cacheKey)
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
  } catch (error) {
    logCacheError(message, cacheKey, error);
    return undefined;
  }
}

function readCacheEntry(cacheKey: string): CacheEntry | undefined {
  const now = Date.now();
  return readCacheItem(cacheKey, now)?.entry;
}

function isExpired(item: CacheItem, now: number): boolean {
  return now > item.expiresAt;
}

function readCacheItem(cacheKey: string, now: number): CacheItem | undefined {
  const item = contentCache.get(cacheKey);
  if (!item) return undefined;

  if (isExpired(item, now)) {
    contentCache.delete(cacheKey);
    return undefined;
  }

  return item;
}

export function set(
  cacheKey: string | null,
  content: string,
  metadata: CacheEntryMetadata
): void {
  if (!isCacheWritable(cacheKey, content)) return;
  runCacheOperation(cacheKey, 'Cache set error', () => {
    startCleanupLoop();
    const now = Date.now();
    const expiresAtMs = now + config.cache.ttl * 1000;
    const entry = buildCacheEntry({
      content,
      metadata,
      fetchedAtMs: now,
      expiresAtMs,
    });
    persistCacheEntry(cacheKey, entry, expiresAtMs);
  });
}

export function keys(): readonly string[] {
  return Array.from(contentCache.keys());
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

function persistCacheEntry(
  cacheKey: string,
  entry: CacheEntry,
  expiresAtMs: number
): void {
  contentCache.set(cacheKey, { entry, expiresAt: expiresAtMs });
  trimCacheToMaxKeys();
  notifyCacheUpdate(cacheKey);
}

function trimCacheToMaxKeys(): void {
  if (contentCache.size <= config.cache.maxKeys) return;
  removeOldestEntries(contentCache.size - config.cache.maxKeys);
}

function removeOldestEntries(count: number): void {
  const iterator = contentCache.keys();
  for (let removed = 0; removed < count; removed += 1) {
    const next = iterator.next();
    if (next.done) break;
    contentCache.delete(next.value);
  }
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

function resolveCacheParams(params: unknown): {
  namespace: string;
  urlHash: string;
} {
  const parsed = requireRecordParams(params);
  const namespace = requireParamString(parsed, 'namespace');
  const urlHash = requireParamString(parsed, 'urlHash');

  if (!isValidNamespace(namespace) || !isValidHash(urlHash)) {
    throw new McpError(
      ErrorCode.InvalidParams,
      'Invalid cache resource parameters'
    );
  }

  return { namespace, urlHash };
}

function requireRecordParams(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new McpError(
      ErrorCode.InvalidParams,
      'Invalid cache resource parameters'
    );
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
    uri: `superfetch://cache/${namespace}/${urlHash}`,
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

function registerResourceSubscriptionHandlers(server: McpServer): Set<string> {
  const subscriptions = new Set<string>();

  server.server.setRequestHandler(SubscribeRequestSchema, (request) => {
    subscriptions.add(request.params.uri);
    return {};
  });

  server.server.setRequestHandler(UnsubscribeRequestSchema, (request) => {
    subscriptions.delete(request.params.uri);
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
  const subscriptions = registerResourceSubscriptionHandlers(server);
  registerCacheContentResource(server);
  registerCacheUpdateSubscription(server, subscriptions);
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
  subscriptions: Set<string>
): void {
  const unsubscribe = onCacheUpdate(({ cacheKey }) => {
    const resourceUri = toResourceUri(cacheKey);
    if (!resourceUri) return;

    notifyResourceUpdate(server, resourceUri, subscriptions);
    if (server.isConnected()) {
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

function validateNamespace(namespace: string): boolean {
  return namespace === 'markdown';
}

function validateHash(hash: string): boolean {
  return HASH_PATTERN.test(hash) && hash.length >= 8 && hash.length <= 64;
}

function isSingleParam(value: string | string[] | undefined): value is string {
  return typeof value === 'string';
}

function parseDownloadParams(req: Request): DownloadParams | null {
  const { namespace, hash } = req.params;

  if (!isSingleParam(namespace) || !isSingleParam(hash)) return null;
  if (!namespace || !hash) return null;
  if (!validateNamespace(namespace)) return null;
  if (!validateHash(hash)) return null;

  return { namespace, hash };
}

function buildCacheKeyFromParams(params: DownloadParams): string {
  return `${params.namespace}:${params.hash}`;
}

function respondBadRequest(res: Response, message: string): void {
  res.status(400).json({
    error: message,
    code: 'BAD_REQUEST',
  });
}

function respondNotFound(res: Response): void {
  res.status(404).json({
    error: 'Content not found or expired',
    code: 'NOT_FOUND',
  });
}

function respondServiceUnavailable(res: Response): void {
  res.status(503).json({
    error: 'Download service is disabled',
    code: 'SERVICE_UNAVAILABLE',
  });
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

function sendDownloadPayload(res: Response, payload: DownloadPayload): void {
  const disposition = buildContentDisposition(payload.fileName);
  res.setHeader('Content-Type', payload.contentType);
  res.setHeader('Content-Disposition', disposition);
  res.setHeader('Cache-Control', `private, max-age=${config.cache.ttl}`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.send(payload.content);
}

function handleDownload(req: Request, res: Response): void {
  if (!config.cache.enabled) {
    respondServiceUnavailable(res);
    return;
  }

  const params = parseDownloadParams(req);
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

export function registerDownloadRoutes(app: Express): void {
  app.get('/mcp/downloads/:namespace/:hash', handleDownload);
}
