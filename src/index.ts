#!/usr/bin/env node
import process from 'node:process';

import { parseCliArgs, renderCliUsage } from './cli.js';
import { serverVersion } from './config.js';
import { startHttpServer } from './http/native.js';
import { logError } from './observability.js';
import { startStdioServer } from './server.js';

const FORCE_EXIT_TIMEOUT_MS = 10_000;
let forcedExitTimer: NodeJS.Timeout | undefined;

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function scheduleForcedExit(reason: string): void {
  if (forcedExitTimer) return;
  forcedExitTimer = setTimeout(() => {
    process.stderr.write(`${reason}; forcing exit.\n`);
    process.exit(1);
  }, FORCE_EXIT_TIMEOUT_MS);
  forcedExitTimer.unref();
}

const parseResult = parseCliArgs(process.argv.slice(2));
if (!parseResult.ok) {
  process.stderr.write(`Invalid arguments: ${parseResult.message}\n\n`);
  process.stderr.write(renderCliUsage());
  process.exit(1);
}
const { values } = parseResult;

if (values.help) {
  process.stdout.write(renderCliUsage());
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
  process.exitCode = 1;

  if (shouldAttemptShutdown()) {
    attemptShutdown(signal);
    scheduleForcedExit('Graceful shutdown timed out');
    return;
  }

  scheduleForcedExit('Fatal error without shutdown handler');
}

process.on('uncaughtException', (error) => {
  handleFatalError('Uncaught exception', error, 'UNCAUGHT_EXCEPTION');
});

process.on('unhandledRejection', (reason) => {
  handleFatalError(
    'Unhandled rejection',
    toError(reason),
    'UNHANDLED_REJECTION'
  );
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
  const resolvedError = toError(error);
  logError('Failed to start server', resolvedError);
  const { message } = resolvedError;
  process.stderr.write(`Failed to start server: ${message}\n`);
  process.exitCode = 1;
  scheduleForcedExit('Startup failure');
}
