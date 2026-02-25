import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test('mcp fetch-url client supports task mode', async (t) => {
  const repoRoot = path.resolve(__dirname, '..');
  const builtClientPath = path.join(
    repoRoot,
    'dist',
    'examples',
    'mcp-fetch-url-client.js'
  );
  const sourceClientPath = path.join(
    repoRoot,
    'examples',
    'mcp-fetch-url-client.ts'
  );
  const clientPath = existsSync(builtClientPath)
    ? builtClientPath
    : sourceClientPath;
  if (!existsSync(clientPath)) {
    t.skip(
      'Example client not present (neither dist/examples nor examples source exists)'
    );
    return;
  }
  const mockServerPath = path.join(
    repoRoot,
    'tests',
    'fixtures',
    'mock-fetch-url-server.js'
  );

  const { stdout } = await execFileAsync(
    process.execPath,
    [
      clientPath,
      'https://example.com/mock',
      '--task',
      '--server',
      mockServerPath,
      '--cwd',
      repoRoot,
    ],
    { cwd: repoRoot }
  );

  assert.match(stdout, /# Mock Fetch/);
  assert.match(stdout, /https:\/\/example.com\/mock/);
});
