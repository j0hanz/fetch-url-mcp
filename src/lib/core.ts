import { AsyncLocalStorage } from 'node:async_hooks';
import process from 'node:process';
import {
  getSystemErrorMessage,
  inspect,
  stripVTControlCharacters,
} from 'node:util';

import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { config, type LogLevel } from './config.js';
import { LOG_SESSION } from './logger-names.js';
import type { SessionEntry } from './session.js';
import type { SessionStore } from './session.js';
import {
  getErrorMessage,
  isAbortError,
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

type LogMetadata = Record<string, unknown>;
interface RequestContext {
  readonly requestId: string;
  readonly sessionId?: string;
  readonly operationId?: string;
}
const requestContext = new AsyncLocalStorage<RequestContext>({
  name: 'requestContext',
});
const LOG_METADATA_MAX_DEPTH = 5;
const URL_METADATA_KEY_SUFFIXES = [
  'url',
  'uri',
  'href',
  'origin',
  'location',
  'referer',
  'referrer',
] as const;
let mcpServer: McpServer | undefined;
const sessionServers = new Map<string, McpServer>();
const sessionOwnerKeys = new Map<string, string>();
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
export function registerMcpSessionOwnerKey(
  sessionId: string,
  ownerKey: string
): void {
  if (!sessionId || !ownerKey) return;
  sessionOwnerKeys.set(sessionId, ownerKey);
}
export function unregisterMcpSessionServer(sessionId: string): void {
  if (!sessionId) return;
  sessionServers.delete(sessionId);
  sessionOwnerKeys.delete(sessionId);
  sessionMcpLogLevels.delete(sessionId);
}
export function unregisterMcpSessionServerByServer(server: McpServer): void {
  for (const [sessionId, mappedServer] of sessionServers.entries()) {
    if (mappedServer !== server) continue;
    sessionServers.delete(sessionId);
    sessionOwnerKeys.delete(sessionId);
    sessionMcpLogLevels.delete(sessionId);
  }
}
export function resolveMcpSessionOwnerKey(
  sessionId: string
): string | undefined {
  return sessionOwnerKeys.get(sessionId);
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

function isUrlLikeKey(key: string): boolean {
  const normalized = key
    .replaceAll(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase();
  return URL_METADATA_KEY_SUFFIXES.some(
    (suffix) =>
      normalized === suffix ||
      normalized.endsWith(`_${suffix}`) ||
      normalized.endsWith(`-${suffix}`)
  );
}

function redactUrlValue(value: string): string {
  if (!URL.canParse(value)) return value;

  const parsed = URL.parse(value);
  if (!parsed) return value;
  if (
    parsed.username.length === 0 &&
    parsed.password.length === 0 &&
    parsed.search.length === 0 &&
    parsed.hash.length === 0
  ) {
    return value;
  }

  return redactUrl(value);
}

function sanitizeLogValue(
  value: unknown,
  options: {
    includeStack: boolean;
    depth?: number;
    seen?: WeakSet<object>;
    key?: string;
  }
): unknown {
  const {
    includeStack,
    depth = 0,
    seen = new WeakSet<object>(),
    key,
  } = options;

  if (depth >= LOG_METADATA_MAX_DEPTH) {
    return '[truncated]';
  }

  if (
    value === null ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }

  if (typeof value === 'string') {
    return key && isUrlLikeKey(key) ? redactUrlValue(value) : value;
  }

  if (typeof value === 'bigint') return value.toString();
  if (value instanceof URL) return redactUrl(value.toString());
  if (value instanceof Error) {
    const sanitized: Record<string, unknown> = {
      error: value.message,
      ...(value.name && value.name !== 'Error'
        ? { errorName: value.name }
        : {}),
    };

    if ('code' in value) {
      const errorCode = value.code;
      if (typeof errorCode === 'string' || typeof errorCode === 'number') {
        sanitized['code'] = errorCode;
      }
    }

    if ('errno' in value && typeof value.errno === 'number') {
      try {
        const sysMsg = getSystemErrorMessage(value.errno);
        if (sysMsg) sanitized['sysError'] = sysMsg;
      } catch {
        // ignore
      }
    }

    if (includeStack && value.stack) {
      sanitized['stack'] = value.stack;
    }

    return sanitized;
  }

  if (Array.isArray(value)) {
    return value
      .map((entry) =>
        sanitizeLogValue(entry, { includeStack, depth: depth + 1, seen })
      )
      .filter((entry) => entry !== undefined);
  }

  if (isPlainLogObject(value)) {
    if (seen.has(value)) return '[circular]';
    seen.add(value);

    const sanitized: Record<string, unknown> = {};
    for (const [entryKey, entryValue] of Object.entries(value)) {
      if (
        isSensitiveKey(entryKey) &&
        (!includeStack || entryKey.toLowerCase() !== 'stack')
      ) {
        continue;
      }

      const normalized = sanitizeLogValue(entryValue, {
        includeStack,
        depth: depth + 1,
        seen,
        key: entryKey,
      });
      if (normalized !== undefined) {
        sanitized[entryKey] = normalized;
      }
    }
    return sanitized;
  }

  return undefined;
}

function sanitizeLogMetadata(
  meta: LogMetadata | undefined,
  options: { includeStack: boolean }
): LogMetadata | undefined {
  if (!meta || Object.keys(meta).length === 0) return undefined;

  const sanitized = sanitizeLogValue(meta, options);
  return isPlainLogObject(sanitized) && Object.keys(sanitized).length > 0
    ? sanitized
    : undefined;
}

function formatMetadata(meta?: LogMetadata): string {
  const merged = sanitizeLogMetadata(mergeMetadata(meta), {
    includeStack: true,
  });
  if (!merged) return '';

  return ` ${inspect(merged, { breakLength: Infinity, colors: false, compact: true, sorted: true })}`;
}
function createTimestamp(): string {
  const now = new Date();
  return now.toISOString();
}
function formatLogEntry(
  level: LogLevel,
  message: string,
  meta?: LogMetadata,
  logger?: string
): string {
  if (config.logging.format === 'json') {
    const merged = sanitizeLogMetadata(mergeMetadata(meta), {
      includeStack: true,
    });
    const entry: Record<string, unknown> = {
      timestamp: createTimestamp(),
      level: level.toUpperCase(),
      ...(logger ? { logger } : {}),
      message,
    };
    if (merged) {
      Object.assign(entry, merged);
    }
    return JSON.stringify(entry);
  }
  const loggerTag = logger ? ` [${logger}]` : '';
  return `[${createTimestamp()}] ${level.toUpperCase()}${loggerTag}: ${message}${formatMetadata(meta)}`;
}
const LEVEL_PRIORITY: Readonly<Record<LogLevel, number>> = {
  debug: 0,
  info: 1,
  notice: 2,
  warn: 3,
  error: 4,
  critical: 5,
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
  if (level === 'warn') return 'warning';
  return level;
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

const MCP_LOG_SENSITIVE_PATTERNS = [
  'password',
  'secret',
  'token',
  'authorization',
  'credential',
  'key',
  'cookie',
  'stack',
];

function isSensitiveKey(key: string): boolean {
  const lowerKey = key.toLowerCase();
  return MCP_LOG_SENSITIVE_PATTERNS.some((p) => lowerKey.includes(p));
}

function isPlainLogObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function buildMcpLogData(
  message: string,
  meta?: LogMetadata
): Record<string, unknown> {
  const sanitized = sanitizeLogMetadata(meta, { includeStack: false });
  if (!sanitized) {
    return { message };
  }

  // Ensure `message` from system isn't overwritten by `meta.message`,
  // but keep the original meta message around if present.
  const payload = { ...sanitized };
  if ('message' in payload) {
    payload['_message'] = payload['message'];
  }
  payload['message'] = message;

  return payload;
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
const DEFAULT_LOGGER = 'fetch-url-mcp';

interface RateLimiter {
  tokens: number;
  lastRefill: number;
  dropped: number;
}
const MCP_RATE_LIMIT_CAPACITY = 200;
const MCP_RATE_LIMIT_REFILL_RATE = 50; // per second
const mcpRateLimiters = new Map<string, RateLimiter>();

// Returns true if allowed, false if dropped.
function checkMcpRateLimit(sessionId = ''): {
  allowed: boolean;
  droppedCount: number;
} {
  const now = Date.now();
  let limit = mcpRateLimiters.get(sessionId);
  if (!limit) {
    limit = { tokens: MCP_RATE_LIMIT_CAPACITY, lastRefill: now, dropped: 0 };
    mcpRateLimiters.set(sessionId, limit);
  }

  const elapsed = now - limit.lastRefill;
  if (elapsed >= 1000) {
    const refillTokens = Math.floor(
      (elapsed / 1000) * MCP_RATE_LIMIT_REFILL_RATE
    );
    limit.tokens = Math.min(
      MCP_RATE_LIMIT_CAPACITY,
      limit.tokens + refillTokens
    );
    limit.lastRefill = now;
  }

  if (limit.tokens > 0) {
    limit.tokens--;
    const droppedCount = limit.dropped;
    if (droppedCount > 0) {
      limit.dropped = 0;
    }
    return { allowed: true, droppedCount };
  }

  limit.dropped++;
  return { allowed: false, droppedCount: 0 };
}

function writeLog(
  level: LogLevel,
  message: string,
  meta?: LogMetadata,
  logger?: string
): void {
  const sessionId = getSessionId();
  if (shouldLog(level)) {
    const line = formatLogEntry(level, message, meta, logger);
    safeWriteStderr(`${stripVTControlCharacters(line)}\n`);
  }

  forwardMcpLog(level, message, meta, sessionId, logger);
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
  sessionId: string | undefined,
  logger?: string
): void {
  const server = resolveLogServer(sessionId);
  if (!server) return;
  if (!shouldForwardMcpLog(level, sessionId)) return;

  const { allowed, droppedCount } = checkMcpRateLimit(sessionId);
  if (!allowed) return;

  try {
    const safeLogger = logger ?? DEFAULT_LOGGER;

    if (droppedCount > 0) {
      server.server
        .sendLoggingMessage(
          {
            level: 'warning',
            logger: safeLogger,
            data: {
              message: 'MCP log messages dropped due to high volume',
              droppedCount,
            },
          },
          sessionId
        )
        .catch(() => {});
    }

    server.server
      .sendLoggingMessage(
        {
          level: toMcpLogLevel(level),
          logger: safeLogger,
          data: buildMcpLogData(message, mergeMetadata(meta)),
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
export function logInfo(
  message: string,
  meta?: LogMetadata,
  logger?: string
): void {
  writeLog('info', message, meta, logger);
}
export function logDebug(
  message: string,
  meta?: LogMetadata,
  logger?: string
): void {
  writeLog('debug', message, meta, logger);
}
export function logNotice(
  message: string,
  meta?: LogMetadata,
  logger?: string
): void {
  writeLog('notice', message, meta, logger);
}
export function logWarn(
  message: string,
  meta?: LogMetadata,
  logger?: string
): void {
  writeLog('warn', message, meta, logger);
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

export function logError(
  message: string,
  error?: Error | LogMetadata,
  logger?: string
): void {
  const errorMeta: LogMetadata =
    error instanceof Error ? formatErrorMeta(error) : (error ?? {});
  writeLog('error', message, errorMeta, logger);
}
export function logCritical(
  message: string,
  error?: Error | LogMetadata,
  logger?: string
): void {
  const errorMeta: LogMetadata =
    error instanceof Error ? formatErrorMeta(error) : (error ?? {});
  writeLog('critical', message, errorMeta, logger);
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
  logWarn(
    'Session cleanup loop failed',
    { error: getErrorMessage(error) },
    LOG_SESSION
  );
}
function logRejectedSettledResults(
  results: readonly PromiseSettledResult<unknown>[],
  message: string
): void {
  for (const result of results) {
    if (result.status === 'rejected') {
      logWarn(message, { error: getErrorMessage(result.reason) }, LOG_SESSION);
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
      logInfo(
        'Expired sessions evicted',
        {
          evicted: evicted.length,
          timestamp: new Date(now).toISOString(),
        },
        LOG_SESSION
      );
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
        logWarn(
          'Expired session pre-close hook failed',
          {
            error: getErrorMessage(error),
          },
          LOG_SESSION
        );
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
      logWarn(
        'Session close operation failed or timed out',
        {
          error: getErrorMessage(error),
        },
        LOG_SESSION
      );
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }

    try {
      unregisterMcpSessionServer(sessionId);
    } catch (error) {
      logWarn(
        'Failed to unregister session server',
        {
          error: getErrorMessage(error),
        },
        LOG_SESSION
      );
    }
  }

  private logCloseFailure(
    target: 'transport' | 'server',
    error: unknown
  ): void {
    if (error == null) return;

    logWarn(
      `Failed to close expired session ${target}`,
      {
        error: getErrorMessage(error),
      },
      LOG_SESSION
    );
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
  const loop = new SessionCleanupLoop(
    store,
    sessionTtlMs,
    options?.onEvictSession,
    options?.cleanupIntervalMs
  );
  return loop.start();
}
