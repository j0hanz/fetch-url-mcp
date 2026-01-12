#!/usr/bin/env node
import { parseArgs } from 'node:util';

import { startHttpServer } from './http.js';
import { startStdioServer } from './mcp.js';
import { logError } from './observability.js';

const { values } = parseArgs({
  options: {
    stdio: { type: 'boolean', default: false },
  },
});
const isStdioMode = values.stdio;
let isShuttingDown = false;

const shutdownHandlerRef: { current?: (signal: string) => Promise<void> } = {};

function shouldAttemptShutdown(): boolean {
  return !isShuttingDown && !isStdioMode && Boolean(shutdownHandlerRef.current);
}

function attemptShutdown(signal: string): void {
  if (!shutdownHandlerRef.current) return;
  isShuttingDown = true;
  process.stderr.write('Attempting graceful shutdown...\n');
  void shutdownHandlerRef.current(signal);
}

process.on('uncaughtException', (error) => {
  logError('Uncaught exception', error);
  process.stderr.write(`Uncaught exception: ${error.message}\n`);

  if (shouldAttemptShutdown()) {
    attemptShutdown('UNCAUGHT_EXCEPTION');
    return;
  }

  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  const error = reason instanceof Error ? reason : new Error(String(reason));
  logError('Unhandled rejection', error);
  process.stderr.write(`Unhandled rejection: ${error.message}\n`);

  if (shouldAttemptShutdown()) {
    attemptShutdown('UNHANDLED_REJECTION');
    return;
  }

  process.exit(1);
});

try {
  if (isStdioMode) {
    await startStdioServer();
  } else {
    const { shutdown } = await startHttpServer();
    shutdownHandlerRef.current = shutdown;
  }
} catch (error) {
  logError(
    'Failed to start server',
    error instanceof Error ? error : undefined
  );
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Failed to start server: ${message}\n`);
  process.exit(1);
}
