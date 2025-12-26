#!/usr/bin/env node
import { parseArgs } from 'node:util';

import { logError } from './services/logger.js';

import { startHttpServer } from './http/server.js';
import { startStdioServer } from './server.js';

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
});

if (isStdioMode) {
  await startStdioServer();
} else {
  const { shutdown } = await startHttpServer();
  shutdownHandlerRef.current = shutdown;
}
