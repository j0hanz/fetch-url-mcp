import { AsyncLocalStorage } from 'node:async_hooks';
import { EventEmitter } from 'node:events';
import process from 'node:process';
import {
  getSystemErrorMessage,
  inspect,
  stripVTControlCharacters,
} from 'node:util';

import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { config, type LogLevel } from './config.js';
import type { SessionEntry } from './session.js';
import type { SessionStore } from './session.js';
import {
  getErrorMessage,
  isAbortError,
  sha256Hex,
  stableStringify as stableJsonStringify,
  startAbortableIntervalLoop,
} from './utils.js';

export { config, enableHttpMode, serverVersion } from './config.js';

type McpLogLevel =
  | 'debug'
  | 'info'
  | 'notice'
  | 'warning'
  | 'error'
  | 'critical'
  | 'alert'
  | 'emergency';

const PRIMARY_HASH_LENGTH = 32;
const VARY_HASH_LENGTH = 16;

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

  const urlHash = sha256Hex(url).substring(0, PRIMARY_HASH_LENGTH);

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
    ? sha256Hex(varyString).substring(0, VARY_HASH_LENGTH)
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

  private ensureCapacity(
    cacheKey: string,
    entrySize: number
  ): { ok: boolean; listChanged: boolean } {
    if (entrySize > this.maxBytes) {
      logWarn('Cache entry exceeds max size', {
        key: cacheKey,
        size: entrySize,
        max: this.maxBytes,
      });
      return { ok: false, listChanged: false };
    }

    let listChanged = false;
    while (this.currentBytes + entrySize > this.maxBytes) {
      if (this.evictOldestEntry()) {
        listChanged = true;
      } else {
        break;
      }
    }
    return { ok: true, listChanged };
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
    const entrySize = content.length;

    // Reject oversized entries before deleting the old one to avoid data loss
    if (entrySize > this.maxBytes) {
      logWarn('Cache entry exceeds max size', {
        key: cacheKey,
        size: entrySize,
        max: this.maxBytes,
      });
      return;
    }

    const isUpdate = this.entries.has(cacheKey);
    if (isUpdate) {
      this.delete(cacheKey);
    }

    const capacity = this.ensureCapacity(cacheKey, entrySize);
    if (!capacity.ok) return;

    let listChanged = !isUpdate || capacity.listChanged;

    const entry: StoredCacheEntry = {
      url: metadata.url,
      content,
      fetchedAt: new Date(now).toISOString(),
      expiresAt: new Date(expiresAtMs).toISOString(),
      expiresAtMs,
      ...(metadata.title ? { title: metadata.title } : {}),
    };

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
const sessionMcpLogLevels = new Map<string, McpLogLevel>();
let stdioMcpLogLevel: McpLogLevel | undefined;
let stderrAvailable = true;
process.stderr.on('error', () => {
  stderrAvailable = false;
  // Recover after transient EPIPE — stderr may become writable again.
  setTimeout(() => {
    if (!process.stderr.destroyed && !process.stderr.writableEnded) {
      stderrAvailable = true;
    }
  }, 5_000).unref();
});
export function setMcpServer(server: McpServer): void {
  if (mcpServer) {
    logWarn('setMcpServer called when server already set — overwriting');
  }
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
const MCP_LOG_LEVEL_PRIORITY: Readonly<Record<McpLogLevel, number>> = {
  emergency: 0,
  alert: 1,
  critical: 2,
  error: 3,
  warning: 4,
  notice: 5,
  info: 6,
  debug: 7,
};
const LOG_LEVEL_ALIASES: Readonly<Record<string, McpLogLevel>> = {
  debug: 'debug',
  info: 'info',
  notice: 'notice',
  warning: 'warning',
  warn: 'warning',
  error: 'error',
  critical: 'critical',
  alert: 'alert',
  emergency: 'emergency',
};
function normalizeLogLevel(level: string): McpLogLevel | undefined {
  return LOG_LEVEL_ALIASES[level.toLowerCase()];
}
// Map internal log levels to standard RFC 5424 severities
function toMcpLogLevel(level: LogLevel): McpLogLevel {
  return level === 'warn' ? 'warning' : level;
}
function shouldForwardMcpLog(level: LogLevel, sessionId?: string): boolean {
  const emittedLevel = toMcpLogLevel(level);
  const configuredLevel = sessionId
    ? (sessionMcpLogLevels.get(sessionId) ??
      toMcpLogLevel(config.logging.level))
    : (stdioMcpLogLevel ?? toMcpLogLevel(config.logging.level));
  return (
    MCP_LOG_LEVEL_PRIORITY[emittedLevel] <=
    MCP_LOG_LEVEL_PRIORITY[configuredLevel]
  );
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

const MCP_LOG_META_BLOCKLIST = new Set(['stack']);
const MCP_LOG_MAX_DEPTH = 5;

function isPlainLogObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sanitizeMcpLogValue(value: unknown, depth = 0): unknown {
  if (depth >= MCP_LOG_MAX_DEPTH) {
    return '[truncated]';
  }

  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }

  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Error) return value.message;

  if (Array.isArray(value)) {
    return value
      .map((entry) => sanitizeMcpLogValue(entry, depth + 1))
      .filter((entry) => entry !== undefined);
  }

  if (isPlainLogObject(value)) {
    const sanitized: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (MCP_LOG_META_BLOCKLIST.has(key)) continue;

      const normalized = sanitizeMcpLogValue(entry, depth + 1);
      if (normalized !== undefined) {
        sanitized[key] = normalized;
      }
    }
    return sanitized;
  }

  return undefined;
}

function buildMcpLogData(
  message: string,
  meta?: LogMetadata
): string | Record<string, unknown> {
  if (!meta || Object.keys(meta).length === 0) {
    return message;
  }

  const sanitized = sanitizeMcpLogValue(meta);
  if (!isPlainLogObject(sanitized) || Object.keys(sanitized).length === 0) {
    return { message };
  }

  return {
    ...sanitized,
    message,
  };
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

  forwardMcpLog(level, message, meta, sessionId);
}
function resolveLogServer(
  sessionId: string | undefined
): McpServer | undefined {
  const server = sessionId ? sessionServers.get(sessionId) : mcpServer;
  if (!server) return undefined;
  return server.isConnected() ? server : undefined;
}

function forwardMcpLog(
  level: LogLevel,
  message: string,
  meta: LogMetadata | undefined,
  sessionId: string | undefined
): void {
  const server = resolveLogServer(sessionId);
  if (!server) return;
  if (!shouldForwardMcpLog(level, sessionId)) return;

  try {
    server.server
      .sendLoggingMessage(
        {
          level: level === 'warn' ? 'warning' : level,
          logger: 'fetch-url-mcp',
          data: buildMcpLogData(message, meta),
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
export function getMcpLogLevel(sessionId?: string): McpLogLevel {
  if (sessionId) {
    return (
      sessionMcpLogLevels.get(sessionId) ?? toMcpLogLevel(config.logging.level)
    );
  }
  return stdioMcpLogLevel ?? toMcpLogLevel(config.logging.level);
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
  const url = URL.parse(rawUrl);
  if (!url) return rawUrl;
  url.username = '';
  url.password = '';
  url.hash = '';
  url.search = '';
  return url.toString();
}
export type { SessionEntry, SessionStore } from './session.js';
export {
  composeCloseHandlers,
  createSessionStore,
  createSlotTracker,
  ensureSessionCapacity,
  reserveSessionSlot,
} from './session.js';

const MIN_CLEANUP_INTERVAL_MS = 10_000;
const MAX_CLEANUP_INTERVAL_MS = 60_000;
const SESSION_CLOSE_BATCH_SIZE = 10;
const SESSION_CLOSE_TIMEOUT_MS = 5_000;
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
        batch.map(({ id, entry }) => this.closeExpiredSession(id, entry))
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

  private async closeExpiredSession(
    sessionId: string,
    session: SessionEntry
  ): Promise<void> {
    if (this.onEvictSession) {
      try {
        await this.onEvictSession(session);
      } catch (error) {
        logWarn('Expired session pre-close hook failed', {
          error: getErrorMessage(error),
        });
      }
    }

    const closePromise = Promise.allSettled([
      session.transport.close(),
      session.server.close(),
    ]);

    let timeoutId: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error('Session close timed out'));
      }, SESSION_CLOSE_TIMEOUT_MS);
      timeoutId.unref();
    });

    try {
      const [transportResult, serverResult] = await Promise.race([
        closePromise,
        timeoutPromise,
      ]);

      if (transportResult.status === 'rejected') {
        this.logCloseFailure('transport', transportResult.reason);
      }
      if (serverResult.status === 'rejected') {
        this.logCloseFailure('server', serverResult.reason);
      }
    } catch (error) {
      logWarn('Session close operation failed or timed out', {
        error: getErrorMessage(error),
      });
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }

    try {
      unregisterMcpSessionServer(sessionId);
    } catch (error) {
      logWarn('Failed to unregister session server', {
        error: getErrorMessage(error),
      });
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
