#!/usr/bin/env node
import process from 'node:process';
import { parseArgs } from 'node:util';

import { serverVersion } from './lib/config.js';
import { logError, Loggers } from './lib/core.js';
import { getErrorMessage, toError } from './lib/error/index.js';

import { startHttpServer } from './http/index.js';
import { startStdioServer } from './server.js';

interface CliValues {
  readonly stdio: boolean;
  readonly http: boolean;
  readonly help: boolean;
  readonly version: boolean;
}

interface CliParseSuccess {
  readonly ok: true;
  readonly values: CliValues;
}

interface CliParseFailure {
  readonly ok: false;
  readonly message: string;
}

type CliParseResult = CliParseSuccess | CliParseFailure;

const usageLines = [
  'Fetch URL MCP server',
  '',
  'Usage:',
  '  fetch-url-mcp [--stdio|-s | --http] [--help|-h] [--version|-v]',
  '',
  'Options:',
  '  --stdio, -s   Run in stdio mode (default).',
  '  --http        Run in Streamable HTTP mode.',
  '  --help, -h    Show this help message.',
  '  --version, -v Show server version.',
  '',
] as const;

const optionSchema = {
  stdio: { type: 'boolean', short: 's', default: false },
  http: { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h', default: false },
  version: { type: 'boolean', short: 'v', default: false },
} as const;

type ParsedValues = ReturnType<typeof parseArgs>['values'];
type CliFlagKey = keyof CliValues;

function toBoolean(value: ParsedValues[keyof ParsedValues]): boolean {
  return value === true;
}

function readCliFlag(values: ParsedValues, key: CliFlagKey): boolean {
  return toBoolean(values[key]);
}

function buildCliValues(values: ParsedValues): CliValues {
  return {
    stdio: readCliFlag(values, 'stdio'),
    http: readCliFlag(values, 'http'),
    help: readCliFlag(values, 'help'),
    version: readCliFlag(values, 'version'),
  };
}

export function renderCliUsage(): string {
  return `${usageLines.join('\n')}\n`;
}

export function parseCliArgs(args: readonly string[]): CliParseResult {
  try {
    const { values } = parseArgs({
      args: [...args],
      options: optionSchema,
      strict: true,
      allowPositionals: false,
    });

    const cliValues = buildCliValues(values);
    if (cliValues.stdio && cliValues.http) {
      return {
        ok: false,
        message: 'Choose either --stdio or --http, not both',
      };
    }

    return {
      ok: true,
      values: cliValues,
    };
  } catch (error: unknown) {
    return {
      ok: false,
      message: getErrorMessage(error),
    };
  }
}

const FORCE_EXIT_TIMEOUT_MS = 10_000;
let forcedExitTimer: NodeJS.Timeout | undefined;

function writeAndExit(
  stream: NodeJS.WriteStream,
  text: string,
  code: number
): never {
  stream.write(text);
  process.exit(code);
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
  writeAndExit(
    process.stderr,
    `Invalid arguments: ${parseResult.message}\n\n${renderCliUsage()}`,
    1
  );
}
const { values } = parseResult;

if (values.help) {
  writeAndExit(process.stdout, renderCliUsage(), 0);
}

if (values.version) {
  writeAndExit(process.stdout, `${serverVersion}\n`, 0);
}
const isStdioMode = !values.http;
let isShuttingDown = false;

const shutdownHandlerRef: { current?: (signal: string) => Promise<void> } = {};

function shouldAttemptShutdown(): boolean {
  return !isShuttingDown && Boolean(shutdownHandlerRef.current);
}

function attemptShutdown(signal: string): void {
  if (!shutdownHandlerRef.current) return;
  isShuttingDown = true;
  process.stderr.write('Attempting graceful shutdown...\n');
  void shutdownHandlerRef.current(signal);
}

function registerSignalHandlers(
  signals: readonly NodeJS.Signals[],
  handler: (signal: NodeJS.Signals) => void
): void {
  for (const signal of signals) {
    process.once(signal, () => {
      handler(signal);
    });
  }
}

function registerHttpSignalHandlers(): void {
  const tryShutdown = (signal: NodeJS.Signals): void => {
    if (shouldAttemptShutdown()) attemptShutdown(signal);
  };

  registerSignalHandlers(['SIGINT', 'SIGTERM'], tryShutdown);
}

function writeStartupError(error: Error): void {
  logError('Failed to start server', error, Loggers.LOG_SERVER);
  process.stderr.write(`Failed to start server: ${error.message}\n`);
  process.exitCode = 1;
  scheduleForcedExit('Startup failure');
}

function handleFatalError(label: string, error: Error, signal: string): void {
  logError(label, error, Loggers.LOG_SERVER);
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
    const { shutdown } = await startStdioServer();
    shutdownHandlerRef.current = shutdown;
  } else {
    const { shutdown } = await startHttpServer();
    shutdownHandlerRef.current = shutdown;
    registerHttpSignalHandlers();
  }
} catch (error: unknown) {
  writeStartupError(toError(error));
}
