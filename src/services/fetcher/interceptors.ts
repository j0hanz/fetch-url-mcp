import { randomUUID } from 'node:crypto';
import diagnosticsChannel from 'node:diagnostics_channel';
import { performance } from 'node:perf_hooks';

import { isSystemError } from '../../utils/error-utils.js';

import { logDebug, logError, logWarn } from '../logger.js';

const fetchChannel = diagnosticsChannel.channel('superfetch.fetch');

interface FetchTelemetryContext {
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
    requestId: randomUUID(),
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
  publishFetchEnd(context, response.status, duration);

  logDebug('HTTP Response', {
    requestId: context.requestId,
    status: response.status,
    url: context.url,
    ...buildResponseMeta(response, contentSize, duration),
  });

  logSlowRequestIfNeeded(context, duration);
}

function publishFetchEnd(
  context: FetchTelemetryContext,
  status: number,
  duration: number
): void {
  if (!fetchChannel.hasSubscribers) return;
  fetchChannel.publish({
    type: 'end',
    requestId: context.requestId,
    status,
    duration,
  });
}

function buildResponseMeta(
  response: Response,
  contentSize: number | undefined,
  duration: number
): { contentType?: string; duration: string; size?: string } {
  const contentType = response.headers.get('content-type') ?? undefined;
  const contentLength =
    response.headers.get('content-length') ?? contentSize?.toString();

  return {
    contentType,
    duration: `${Math.round(duration)}ms`,
    size: contentLength,
  };
}

function logSlowRequestIfNeeded(
  context: FetchTelemetryContext,
  duration: number
): void {
  if (duration <= 5000) return;
  logWarn('Slow HTTP request detected', {
    requestId: context.requestId,
    url: context.url,
    duration: `${Math.round(duration)}ms`,
  });
}

export function recordFetchError(
  context: FetchTelemetryContext,
  error: unknown,
  status?: number
): void {
  const duration = performance.now() - context.startTime;
  const err = error instanceof Error ? error : new Error(String(error));
  const code = isSystemError(err) ? err.code : undefined;

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
