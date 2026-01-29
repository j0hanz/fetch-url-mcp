import { AsyncLocalStorage } from 'node:async_hooks';

import { config, type LogLevel } from './config.js';

export type LogMetadata = Record<string, unknown>;

interface RequestContext {
  readonly requestId: string;
  readonly sessionId?: string;
  readonly operationId?: string;
}

const requestContext = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(
  context: RequestContext,
  fn: () => T
): T {
  return requestContext.run(context, fn);
}

export function getRequestId(): string | undefined {
  return requestContext.getStore()?.requestId;
}

export function getSessionId(): string | undefined {
  return requestContext.getStore()?.sessionId;
}

export function getOperationId(): string | undefined {
  return requestContext.getStore()?.operationId;
}

function buildContextMetadata(): LogMetadata {
  const requestId = getRequestId();
  const sessionId = getSessionId();
  const operationId = getOperationId();

  const contextMeta: LogMetadata = {};
  if (requestId) contextMeta.requestId = requestId;
  if (sessionId && config.logging.level === 'debug')
    contextMeta.sessionId = sessionId;
  if (operationId) contextMeta.operationId = operationId;

  return contextMeta;
}

function formatMetadata(meta?: LogMetadata): string {
  const merged = { ...buildContextMetadata(), ...meta };
  return Object.keys(merged).length > 0 ? ` ${JSON.stringify(merged)}` : '';
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
  if (level === 'debug') return config.logging.level === 'debug';
  // All other levels always log
  return true;
}

function writeLog(level: LogLevel, message: string, meta?: LogMetadata): void {
  if (!shouldLog(level)) return;
  process.stderr.write(`${formatLogEntry(level, message, meta)}\n`);
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

export function redactHeaders(
  headers: Record<string, unknown>
): Record<string, unknown> {
  const redacted = { ...headers };
  const sensitiveKeys = ['authorization', 'cookie', 'set-cookie', 'x-api-key'];

  for (const key of Object.keys(redacted)) {
    if (sensitiveKeys.includes(key.toLowerCase())) {
      redacted[key] = '[REDACTED]';
    }
  }
  return redacted;
}
