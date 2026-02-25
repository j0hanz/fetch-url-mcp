import { parseArgs } from 'node:util';

export interface CliValues {
  readonly stdio: boolean;
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

export type CliParseResult = CliParseSuccess | CliParseFailure;

const usageLines = [
  'Fetch URL MCP server',
  '',
  'Usage:',
  '  fetch-url-mcp [--stdio|-s] [--help|-h] [--version|-v]',
  '',
  'Options:',
  '  --stdio, -s   Run in stdio mode (no HTTP server).',
  '  --help, -h    Show this help message.',
  '  --version, -v Show server version.',
  '',
] as const;

const optionSchema = {
  stdio: { type: 'boolean', short: 's', default: false },
  help: { type: 'boolean', short: 'h', default: false },
  version: { type: 'boolean', short: 'v', default: false },
} as const;

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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

    return {
      ok: true,
      values: buildCliValues(values),
    };
  } catch (error: unknown) {
    return {
      ok: false,
      message: toErrorMessage(error),
    };
  }
}
