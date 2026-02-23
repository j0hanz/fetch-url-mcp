import { config } from './config.js';
import { logDebug, logWarn } from './observability.js';

interface HttpServerTuningTarget {
  headersTimeout?: number;
  requestTimeout?: number;
  keepAliveTimeout?: number;
  keepAliveTimeoutBuffer?: number;
  maxHeadersCount?: number | null;
  maxConnections?: number;
  on?: (event: string, listener: (...args: unknown[]) => void) => void;
  closeIdleConnections?: () => void;
  closeAllConnections?: () => void;
}

const DROP_LOG_INTERVAL_MS = 10_000;

function setIfDefined<T>(
  value: T | undefined,
  setter: (resolved: T) => void
): void {
  if (value === undefined) return;
  setter(value);
}

function assignServerValue<T extends keyof HttpServerTuningTarget>(
  server: HttpServerTuningTarget,
  key: T,
  value: HttpServerTuningTarget[T] | undefined
): void {
  setIfDefined(value, (resolved) => {
    server[key] = resolved;
  });
}

export function applyHttpServerTuning(server: HttpServerTuningTarget): void {
  const {
    headersTimeoutMs,
    requestTimeoutMs,
    keepAliveTimeoutMs,
    keepAliveTimeoutBufferMs,
    maxHeadersCount,
    maxConnections,
  } = config.server.http;

  assignServerValue(server, 'headersTimeout', headersTimeoutMs);
  assignServerValue(server, 'requestTimeout', requestTimeoutMs);
  assignServerValue(server, 'keepAliveTimeout', keepAliveTimeoutMs);
  assignServerValue(server, 'keepAliveTimeoutBuffer', keepAliveTimeoutBufferMs);
  assignServerValue(server, 'maxHeadersCount', maxHeadersCount);

  if (typeof maxConnections === 'number' && maxConnections > 0) {
    server.maxConnections = maxConnections;

    if (typeof server.on === 'function') {
      let lastLoggedAt = 0;
      let droppedSinceLastLog = 0;

      server.on('drop', (data: unknown) => {
        droppedSinceLastLog += 1;
        const now = Date.now();
        if (now - lastLoggedAt < DROP_LOG_INTERVAL_MS) return;

        logWarn('Incoming connection dropped (maxConnections reached)', {
          maxConnections,
          dropped: droppedSinceLastLog,
          data,
        });

        lastLoggedAt = now;
        droppedSinceLastLog = 0;
      });
    }
  }
}

export function drainConnectionsOnShutdown(
  server: HttpServerTuningTarget
): void {
  if (typeof server.closeIdleConnections === 'function') {
    server.closeIdleConnections();
    logDebug('Closed idle HTTP connections during shutdown');
  }
}
