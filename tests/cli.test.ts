import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseCliArgs, renderCliUsage } from '../dist/cli.js';

function assertParseSuccess(args: readonly string[]): {
  stdio: boolean;
  help: boolean;
  version: boolean;
} {
  const result = parseCliArgs(args);
  assert.equal(result.ok, true);
  if (!result.ok) {
    throw new Error(`Expected parse success, got: ${result.message}`);
  }
  return result.values;
}

function assertParseError(args: readonly string[]): string {
  const result = parseCliArgs(args);
  assert.equal(result.ok, false);
  if (result.ok) {
    throw new Error('Expected parse error but parsing succeeded');
  }
  return result.message;
}

describe('parseCliArgs', () => {
  it('parses long-form flags', () => {
    assert.deepEqual(assertParseSuccess(['--stdio']), {
      stdio: true,
      help: false,
      version: false,
    });
  });

  it('parses short-form aliases', () => {
    assert.deepEqual(assertParseSuccess(['-h']), {
      stdio: false,
      help: true,
      version: false,
    });
    assert.deepEqual(assertParseSuccess(['-v']), {
      stdio: false,
      help: false,
      version: true,
    });
    assert.deepEqual(assertParseSuccess(['-s']), {
      stdio: true,
      help: false,
      version: false,
    });
  });

  it('rejects unknown options', () => {
    const message = assertParseError(['--unknown']);
    assert.match(message, /unknown option/i);
  });

  it('rejects positional arguments', () => {
    const message = assertParseError(['build']);
    assert.match(message, /unexpected argument|positionals/i);
  });
});

describe('renderCliUsage', () => {
  it('includes short and long options', () => {
    const usage = renderCliUsage();
    assert.match(usage, /--stdio\|-s/);
    assert.match(usage, /--help\|-h/);
    assert.match(usage, /--version\|-v/);
  });
});
