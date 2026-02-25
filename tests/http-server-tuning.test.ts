import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const RESULT_MARKER = '__RESULT__';
const CHILD_TIMEOUT_MS = 20000;

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

describe('http server tuning helpers', () => {
  it('applyHttpServerTuning does nothing by default', async () => {
    const script = `
      import { applyHttpServerTuning } from './dist/lib/server-tuning.js';
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

  it('drainConnectionsOnShutdown always closes idle connections', async () => {
    const script = `
      import { drainConnectionsOnShutdown } from './dist/lib/server-tuning.js';
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
    assert.equal(payload.idleCalls, 1);
    assert.equal(payload.allCalls, 0);
  });

  it('drainConnectionsOnShutdown closes idle connections when enabled', async () => {
    const script = `
      import { drainConnectionsOnShutdown } from './dist/lib/server-tuning.js';
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

  it('requires ALLOW_REMOTE for non-loopback bindings', async () => {
    const script = `
      import { startHttpServer } from './dist/http/native.js';

      let server;
      try {
        server = await startHttpServer();
      } catch (error) {
        console.error('${RESULT_MARKER}' + JSON.stringify({ error: error?.message ?? 'unknown' }));
        process.exit(0);
      }

      await server.shutdown('TEST');
      console.error('${RESULT_MARKER}' + JSON.stringify({ started: true }));
    `;

    const result = runIsolatedNode(script, {
      HOST: '0.0.0.0',
      PORT: '0',
      ACCESS_TOKENS: 'test-token',
      ALLOW_REMOTE: 'false',
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = parseMarkedJson<{ error?: string; started?: boolean }>(
      result.stderr
    );
    assert.ok(payload.error);
    assert.match(payload.error ?? '', /ALLOW_REMOTE/i);
  });

  it('startHttpServer starts and stops without connecting', async () => {
    const script = `
      import { startHttpServer } from './dist/http/native.js';

      const server = await startHttpServer();
      await server.shutdown('TEST');
      console.error('${RESULT_MARKER}' + JSON.stringify({ host: server.host, port: server.port, url: \`http://\${server.host}:\${server.port}\` }));
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
