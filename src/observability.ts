import { AsyncLocalStorage } from 'node:async_hooks';
import process from 'node:process';
import { inspect, stripVTControlCharacters } from 'node:util';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { config, type LogLevel } from './config.js';

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
  return getRequestContext()?.requestId;
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
