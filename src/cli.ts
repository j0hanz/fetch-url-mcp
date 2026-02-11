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
  'superfetch MCP server',
  '',
  'Usage:',
  '  superfetch [--stdio|-s] [--help|-h] [--version|-v]',
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
      values: {
        stdio: values.stdio,
        help: values.help,
        version: values.version,
      },
    };
  } catch (error: unknown) {
    return {
      ok: false,
      message: toErrorMessage(error),
    };
  }
}
