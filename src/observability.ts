import { AsyncLocalStorage } from 'node:async_hooks';
import process from 'node:process';
import { inspect } from 'node:util';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { config, type LogLevel } from './config.js';

export type LogMetadata = Record<string, unknown>;

interface RequestContext {
  readonly requestId: string;
  readonly sessionId?: string;
  readonly operationId?: string;
}

const requestContext = new AsyncLocalStorage<RequestContext>();
let mcpServer: McpServer | undefined;

export function setMcpServer(server: McpServer): void {
  mcpServer = server;
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

function buildContextMetadata(): LogMetadata {
  const ctx = getRequestContext();
  if (!ctx) return {};

  const meta: LogMetadata = {};

  // Preserve existing behavior: only include truthy IDs.
  if (ctx.requestId) meta.requestId = ctx.requestId;
  if (ctx.operationId) meta.operationId = ctx.operationId;
  if (ctx.sessionId && isDebugEnabled()) meta.sessionId = ctx.sessionId;

  return meta;
}

function mergeMetadata(meta?: LogMetadata): LogMetadata | undefined {
  const merged: LogMetadata = { ...buildContextMetadata(), ...(meta ?? {}) };
  return Object.keys(merged).length > 0 ? merged : undefined;
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
  return `[${createTimestamp()}] ${level.toUpperCase()}: ${message}${formatMetadata(meta)}`;
}

function shouldLog(level: LogLevel): boolean {
  // Debug logs only when LOG_LEVEL=debug
  if (level === 'debug') return isDebugEnabled();
  // All other levels always log
  return true;
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

function safeWriteStderr(line: string): void {
  try {
    process.stderr.write(line);
  } catch {
    // Logging must never take down the process (e.g. EPIPE).
  }
}

function writeLog(level: LogLevel, message: string, meta?: LogMetadata): void {
  if (!shouldLog(level)) return;

  safeWriteStderr(`${formatLogEntry(level, message, meta)}\n`);

  const server = mcpServer;
  if (!server) return;

  const sessionId = getSessionId();

  try {
    server.server
      .sendLoggingMessage(
        {
          level: mapToMcpLevel(level),
          // Preserve existing behavior: MCP payload includes only message + provided meta (not ALS context meta).
          data: meta ? { message, ...meta } : message,
        },
        sessionId
      )
      .catch((err: unknown) => {
        if (!isDebugEnabled()) return;

        let errorText = 'unknown error';
        if (err instanceof Error) {
          errorText = err.message;
        } else if (typeof err === 'string') {
          errorText = err;
        }

        safeWriteStderr(
          `[${createTimestamp()}] WARN: Failed to forward log to MCP${
            sessionId ? ` (sessionId=${sessionId})` : ''
          }: ${errorText}\n`
        );
      });
  } catch (err: unknown) {
    if (!isDebugEnabled()) return;

    const errorText = err instanceof Error ? err.message : 'unknown error';
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

export function redactUrl(rawUrl: string): string {
  if (!URL.canParse(rawUrl)) return rawUrl;
  const url = new URL(rawUrl);
  url.username = '';
  url.password = '';
  url.hash = '';
  url.search = '';
  return url.toString();
}
