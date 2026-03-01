import { parseArgs } from 'node:util';

import { getErrorMessage } from './lib/utils.js';

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
