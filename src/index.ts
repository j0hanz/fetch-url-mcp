#!/usr/bin/env node
import { logError } from './services/logger.js';

import { startHttpServer } from './http/server.js';
import { startStdioServer } from './server.js';

const isStdioMode = process.argv.includes('--stdio');
let isShuttingDown = false;

const shutdownHandlerRef: { current?: (signal: string) => Promise<void> } = {};

process.on('uncaughtException', (error) => {
  logError('Uncaught exception', error);
  process.stderr.write(`Uncaught exception: ${error.message}\n`);

  if (!isShuttingDown && !isStdioMode && shutdownHandlerRef.current) {
    isShuttingDown = true;
    process.stderr.write('Attempting graceful shutdown...\n');
    void shutdownHandlerRef.current('UNCAUGHT_EXCEPTION');
  } else {
    process.exit(1);
  }
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
