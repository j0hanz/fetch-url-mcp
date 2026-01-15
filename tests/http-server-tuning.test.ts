import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const RESULT_MARKER = '__RESULT__';

function runIsolatedNode(
  script: string,
  env: Record<string, string | undefined>
): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', script],
    {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      encoding: 'utf8',
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

describe('http server tuning helpers', () => {
  it('applyHttpServerTuning does nothing by default', async () => {
    const script = `
      import { applyHttpServerTuning } from './dist/http.js';
      const server = { headersTimeout: 123, requestTimeout: 456, keepAliveTimeout: 789 };
      applyHttpServerTuning(server);
      console.error('${RESULT_MARKER}' + JSON.stringify(server));
    `;

    const result = runIsolatedNode(script, {
      SERVER_HEADERS_TIMEOUT_MS: undefined,
      SERVER_REQUEST_TIMEOUT_MS: undefined,
      SERVER_KEEP_ALIVE_TIMEOUT_MS: undefined,
    });

    assert.equal(result.status, 0, result.stderr);
    const server = parseMarkedJson<{
      headersTimeout: number;
      requestTimeout: number;
      keepAliveTimeout: number;
    }>(result.stderr);
    assert.equal(server.headersTimeout, 123);
    assert.equal(server.requestTimeout, 456);
    assert.equal(server.keepAliveTimeout, 789);
  });

  it('applyHttpServerTuning applies configured timeouts', async () => {
    const script = `
      import { applyHttpServerTuning } from './dist/http.js';
      const server = {};
      applyHttpServerTuning(server);
      console.error('${RESULT_MARKER}' + JSON.stringify(server));
    `;

    const result = runIsolatedNode(script, {
      SERVER_HEADERS_TIMEOUT_MS: '5000',
      SERVER_REQUEST_TIMEOUT_MS: '6000',
      SERVER_KEEP_ALIVE_TIMEOUT_MS: '7000',
    });

    assert.equal(result.status, 0, result.stderr);
    const server = parseMarkedJson<{
      headersTimeout?: number;
      requestTimeout?: number;
      keepAliveTimeout?: number;
    }>(result.stderr);
    assert.equal(server.headersTimeout, 5000);
    assert.equal(server.requestTimeout, 6000);
    assert.equal(server.keepAliveTimeout, 7000);
  });

  it('drainConnectionsOnShutdown is a no-op by default', async () => {
    const script = `
      import { drainConnectionsOnShutdown } from './dist/http.js';
      let idleCalls = 0;
      let allCalls = 0;
      const server = {
        closeIdleConnections: () => { idleCalls += 1; },
        closeAllConnections: () => { allCalls += 1; },
      };
      drainConnectionsOnShutdown(server);
      console.error('${RESULT_MARKER}' + JSON.stringify({ idleCalls, allCalls }));
    `;

    const result = runIsolatedNode(script, {
      SERVER_SHUTDOWN_CLOSE_IDLE: undefined,
      SERVER_SHUTDOWN_CLOSE_ALL: undefined,
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = parseMarkedJson<{
      idleCalls: number;
      allCalls: number;
    }>(result.stderr);
    assert.equal(payload.idleCalls, 0);
    assert.equal(payload.allCalls, 0);
  });

  it('drainConnectionsOnShutdown closes idle connections when enabled', async () => {
    const script = `
      import { drainConnectionsOnShutdown } from './dist/http.js';
      let idleCalls = 0;
      const server = {
        closeIdleConnections: () => { idleCalls += 1; },
      };
      drainConnectionsOnShutdown(server);
      console.error('${RESULT_MARKER}' + JSON.stringify({ idleCalls }));
    `;

    const result = runIsolatedNode(script, {
      SERVER_SHUTDOWN_CLOSE_IDLE: 'true',
      SERVER_SHUTDOWN_CLOSE_ALL: undefined,
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = parseMarkedJson<{ idleCalls: number }>(result.stderr);
    assert.equal(payload.idleCalls, 1);
  });

  it('drainConnectionsOnShutdown closes all connections when enabled', async () => {
    const script = `
      import { drainConnectionsOnShutdown } from './dist/http.js';
      let allCalls = 0;
      const server = {
        closeAllConnections: () => { allCalls += 1; },
      };
      drainConnectionsOnShutdown(server);
      console.error('${RESULT_MARKER}' + JSON.stringify({ allCalls }));
    `;

    const result = runIsolatedNode(script, {
      SERVER_SHUTDOWN_CLOSE_ALL: 'true',
      SERVER_SHUTDOWN_CLOSE_IDLE: undefined,
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = parseMarkedJson<{ allCalls: number }>(result.stderr);
    assert.equal(payload.allCalls, 1);
  });

  it('startHttpServer starts and stops without connecting', async () => {
    const script = `
      import { startHttpServer } from './dist/http.js';

      const server = await startHttpServer({ registerSignalHandlers: false });
      await server.stop();
      console.error('${RESULT_MARKER}' + JSON.stringify({ host: server.host, port: server.port, url: server.url }));
    `;

    const result = runIsolatedNode(script, {
      HOST: '127.0.0.1',
      PORT: '0',
      ACCESS_TOKENS: 'test-token',
      ALLOW_REMOTE: 'false',
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = parseMarkedJson<{
      host: string;
      port: number;
      url: string;
    }>(result.stderr);

    assert.equal(payload.host, '127.0.0.1');
    assert.equal(typeof payload.port, 'number');
    assert.ok(payload.port > 0);
    assert.ok(payload.url.startsWith('http://127.0.0.1:'));
  });
});
