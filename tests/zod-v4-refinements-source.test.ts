import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { isMcpRequestBody } from '../src/lib/mcp-tools.js';

const RESULT_MARKER = '__RESULT__';
const CHILD_TIMEOUT_MS = 20000;

function runSourceNode(
  script: string,
  env: Record<string, string | undefined>
): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '--import', 'tsx/esm', '-e', script],
    {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      encoding: 'utf8',
      timeout: CHILD_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      env: {
        ...process.env,
        ...env,
      },
    }
  );

  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status,
  };
}

function parseMarkedJson<T>(output: string): T {
  const markerIndex = output.lastIndexOf(RESULT_MARKER);
  assert.ok(markerIndex >= 0, `Missing result marker. stderr: ${output}`);
  return JSON.parse(output.slice(markerIndex + RESULT_MARKER.length)) as T;
}

describe('zod v4 env flag parsing', () => {
  it('treats 0/no/off values as false across config booleans', () => {
    const script = `
      import { config } from './src/lib/core.ts';
      console.error('${RESULT_MARKER}' + JSON.stringify({
        allowRemote: config.security.allowRemote,
        blockPrivateConnections: config.server.http.blockPrivateConnections,
        emitStatusNotifications: config.tasks.emitStatusNotifications,
        requireInterception: config.tasks.requireInterception,
        cacheEnabled: config.cache.enabled,
        allowLocalFetch: config.security.allowLocalFetch,
      }));
    `;

    const result = runSourceNode(script, {
      ALLOW_REMOTE: '0',
      SERVER_BLOCK_PRIVATE_CONNECTIONS: 'off',
      TASKS_STATUS_NOTIFICATIONS: 'no',
      TASKS_REQUIRE_INTERCEPTION: '0',
      CACHE_ENABLED: '0',
      ALLOW_LOCAL_FETCH: 'off',
    });

    assert.equal(result.status, 0, result.stderr);
    const flags = parseMarkedJson<{
      allowRemote: boolean;
      blockPrivateConnections: boolean;
      emitStatusNotifications: boolean;
      requireInterception: boolean;
      cacheEnabled: boolean;
      allowLocalFetch: boolean;
    }>(result.stderr);

    assert.deepEqual(flags, {
      allowRemote: false,
      blockPrivateConnections: false,
      emitStatusNotifications: false,
      requireInterception: false,
      cacheEnabled: false,
      allowLocalFetch: false,
    });
  });

  it('accepts 1/yes/on values as true across config booleans', () => {
    const script = `
      import { config } from './src/lib/core.ts';
      console.error('${RESULT_MARKER}' + JSON.stringify({
        allowRemote: config.security.allowRemote,
        blockPrivateConnections: config.server.http.blockPrivateConnections,
        emitStatusNotifications: config.tasks.emitStatusNotifications,
        requireInterception: config.tasks.requireInterception,
        cacheEnabled: config.cache.enabled,
        allowLocalFetch: config.security.allowLocalFetch,
      }));
    `;

    const result = runSourceNode(script, {
      ALLOW_REMOTE: '1',
      SERVER_BLOCK_PRIVATE_CONNECTIONS: 'yes',
      TASKS_STATUS_NOTIFICATIONS: 'on',
      TASKS_REQUIRE_INTERCEPTION: '1',
      CACHE_ENABLED: 'yes',
      ALLOW_LOCAL_FETCH: 'on',
    });

    assert.equal(result.status, 0, result.stderr);
    const flags = parseMarkedJson<{
      allowRemote: boolean;
      blockPrivateConnections: boolean;
      emitStatusNotifications: boolean;
      requireInterception: boolean;
      cacheEnabled: boolean;
      allowLocalFetch: boolean;
    }>(result.stderr);

    assert.deepEqual(flags, {
      allowRemote: true,
      blockPrivateConnections: true,
      emitStatusNotifications: true,
      requireInterception: true,
      cacheEnabled: true,
      allowLocalFetch: true,
    });
  });
});

describe('zod v4 JSON-RPC params validation', () => {
  it('accepts arbitrary params with an object _meta payload', () => {
    assert.equal(
      isMcpRequestBody({
        jsonrpc: '2.0',
        method: 'ping',
        params: {
          _meta: { traceId: 'abc123' },
          arbitrary: 'value',
          nested: { ok: true },
        },
      }),
      true
    );
  });

  it('rejects request params when _meta is not an object record', () => {
    assert.equal(
      isMcpRequestBody({
        jsonrpc: '2.0',
        method: 'ping',
        params: {
          _meta: 'invalid',
          arbitrary: 'value',
        },
      }),
      false
    );
  });
});
