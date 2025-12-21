import { config } from '../config/index.js';
import type { LogLevel, LogMetadata } from '../config/types.js';

import { getRequestId, getSessionId } from './context.js';

function formatMetadata(meta?: LogMetadata): string {
  const requestId = getRequestId();
  const sessionId = getSessionId();

  const contextMeta: LogMetadata = {};
  if (requestId) contextMeta.requestId = requestId;
  if (sessionId) contextMeta.sessionId = sessionId;

  const merged = { ...contextMeta, ...meta };
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
  if (!config.logging.enabled) return false;
  if (level === 'debug') return config.logging.level === 'debug';
  return true;
}

export function logInfo(message: string, meta?: LogMetadata): void {
  if (shouldLog('info')) {
    console.log(formatLogEntry('info', message, meta));
  }
}

export function logDebug(message: string, meta?: LogMetadata): void {
  if (shouldLog('debug')) {
    console.debug(formatLogEntry('debug', message, meta));
  }
}

export function logWarn(message: string, meta?: LogMetadata): void {
  if (shouldLog('warn')) {
    console.warn(formatLogEntry('warn', message, meta));
  }
}

export function logError(message: string, error?: Error | LogMetadata): void {
  if (!shouldLog('error')) return;

  const errorMeta: LogMetadata =
    error instanceof Error
      ? { error: error.message, stack: error.stack }
      : (error ?? {});

  console.error(formatLogEntry('error', message, errorMeta));
}
