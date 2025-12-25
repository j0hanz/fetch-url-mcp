import { randomUUID } from 'node:crypto';
import diagnosticsChannel from 'node:diagnostics_channel';
import { performance } from 'node:perf_hooks';

import { logDebug, logError, logWarn } from '../logger.js';

const fetchChannel = diagnosticsChannel.channel('superfetch.fetch');

export interface FetchTelemetryContext {
  requestId: string;
  startTime: number;
  url: string;
  method: string;
}

export function startFetchTelemetry(
  url: string,
  method: string
): FetchTelemetryContext {
  const context: FetchTelemetryContext = {
    requestId: randomUUID().substring(0, 8),
    startTime: performance.now(),
    url,
    method: method.toUpperCase(),
  };

  if (fetchChannel.hasSubscribers) {
    fetchChannel.publish({
      type: 'start',
      requestId: context.requestId,
      method: context.method,
      url: context.url,
    });
  }

  logDebug('HTTP Request', {
    requestId: context.requestId,
    method: context.method,
    url: context.url,
  });

  return context;
}

export function recordFetchResponse(
  context: FetchTelemetryContext,
  response: Response,
  contentSize?: number
): void {
  const duration = performance.now() - context.startTime;
  const contentType = response.headers.get('content-type') ?? undefined;
  const contentLength =
    response.headers.get('content-length') ?? contentSize?.toString();

  if (fetchChannel.hasSubscribers) {
    fetchChannel.publish({
      type: 'end',
      requestId: context.requestId,
      status: response.status,
      duration,
    });
  }

  logDebug('HTTP Response', {
    requestId: context.requestId,
    status: response.status,
    url: context.url,
    contentType,
    duration: `${Math.round(duration)}ms`,
    size: contentLength,
  });

  if (duration > 5000) {
    logWarn('Slow HTTP request detected', {
      requestId: context.requestId,
      url: context.url,
      duration: `${Math.round(duration)}ms`,
    });
  }
}

export function recordFetchError(
  context: FetchTelemetryContext,
  error: unknown,
  status?: number
): void {
  const duration = performance.now() - context.startTime;
  const err = error instanceof Error ? error : new Error(String(error));
  const code =
    typeof (err as NodeJS.ErrnoException).code === 'string'
      ? (err as NodeJS.ErrnoException).code
      : undefined;

  if (fetchChannel.hasSubscribers) {
    fetchChannel.publish({
      type: 'error',
      requestId: context.requestId,
      url: context.url,
      error: err.message,
      code,
      status,
      duration,
    });
  }

  const log = status === 429 ? logWarn : logError;
  log('HTTP Request Error', {
    requestId: context.requestId,
    url: context.url,
    status,
    code,
    error: err.message,
  });
}
