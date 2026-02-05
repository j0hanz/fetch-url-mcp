#!/usr/bin/env node
import process from 'node:process';
import { parseArgs } from 'node:util';

import { serverVersion } from './config.js';
import { startHttpServer } from './http-native.js';
import { startStdioServer } from './mcp.js';
import { logError } from './observability.js';

function printUsage(): void {
  process.stdout.write(
    [
      'superfetch MCP server',
      '',
      'Usage:',
      '  superfetch [--stdio] [--help] [--version]',
      '',
      'Options:',
      '  --stdio    Run in stdio mode (no HTTP server).',
      '  --help     Show this help message.',
      '  --version  Show server version.',
      '',
    ].join('\n')
  );
}

const { values } = parseArgs({
  options: {
    stdio: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
    version: { type: 'boolean', default: false },
  },
});

if (values.help) {
  printUsage();
  process.exit(0);
}

if (values.version) {
  process.stdout.write(`${serverVersion}\n`);
  process.exit(0);
}
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

function registerHttpSignalHandlers(): void {
  process.once('SIGINT', () => {
    if (shouldAttemptShutdown()) attemptShutdown('SIGINT');
  });
  process.once('SIGTERM', () => {
    if (shouldAttemptShutdown()) attemptShutdown('SIGTERM');
  });
}

function handleFatalError(label: string, error: Error, signal: string): void {
  logError(label, error);
  process.stderr.write(`${label}: ${error.message}\n`);

  if (shouldAttemptShutdown()) {
    attemptShutdown(signal);
    return;
  }

  process.exit(1);
}

process.on('uncaughtException', (error) => {
  handleFatalError('Uncaught exception', error, 'UNCAUGHT_EXCEPTION');
});

process.on('unhandledRejection', (reason) => {
  const error = reason instanceof Error ? reason : new Error(String(reason));
  handleFatalError('Unhandled rejection', error, 'UNHANDLED_REJECTION');
});

try {
  if (isStdioMode) {
    await startStdioServer();
  } else {
    const { shutdown } = await startHttpServer();
    shutdownHandlerRef.current = shutdown;
    registerHttpSignalHandlers();
  }
} catch (error: unknown) {
  logError(
    'Failed to start server',
    error instanceof Error ? error : undefined
  );
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Failed to start server: ${message}\n`);
  process.exit(1);
}
