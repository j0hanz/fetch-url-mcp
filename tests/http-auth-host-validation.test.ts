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

describe('http auth and host/origin validation', () => {
  it('rejects disallowed host and origin headers', () => {
    const script = `
      import { startHttpServer } from './dist/http/native.js';
      import { request } from 'node:http';

      const server = await startHttpServer();
      const port = server.port;

      function sendRequest(headers, path = '/health') {
        return new Promise((resolve) => {
          const req = request(
            { hostname: '127.0.0.1', port, path, method: 'GET', headers },
            (res) => {
              res.resume();
              res.on('end', () =>
                resolve({ status: res.statusCode ?? 0 })
              );
            }
          );
          req.on('error', (error) => resolve({ error: error.message }));
          req.end();
        });
      }

      const ok = await sendRequest({ host: '127.0.0.1' });
      const badHost = await sendRequest({ host: 'evil.com' });
      const badOrigin = await sendRequest({
        host: '127.0.0.1',
        origin: 'https://evil.com',
      });

      await server.shutdown('TEST');
      console.error('${RESULT_MARKER}' + JSON.stringify({ ok, badHost, badOrigin }));
    `;

    const result = runIsolatedNode(script, {
      HOST: '127.0.0.1',
      PORT: '0',
      ACCESS_TOKENS: 'test-token',
      ALLOW_REMOTE: 'false',
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = parseMarkedJson<{
      ok: { status: number };
      badHost: { status: number };
      badOrigin: { status: number };
    }>(result.stderr);

    assert.equal(payload.ok.status, 200);
    assert.equal(payload.badHost.status, 403);
    assert.equal(payload.badOrigin.status, 403);
  });

  it('returns RFC9728 discovery metadata on unauthorized MCP requests', () => {
    const script = `
      import { startHttpServer } from './dist/http/native.js';
      import { request } from 'node:http';

      const server = await startHttpServer();
      const port = server.port;

      function sendRequest(options) {
        return new Promise((resolve) => {
          const req = request(options, (res) => {
            let raw = '';
            res.on('data', (chunk) => { raw += chunk; });
            res.on('end', () =>
              resolve({
                status: res.statusCode ?? 0,
                headers: res.headers,
                body: raw,
              })
            );
          });
          req.on('error', (error) => resolve({ error: error.message }));
          req.end();
        });
      }

      const unauthorized = await sendRequest({
        hostname: '127.0.0.1',
        port,
        path: '/mcp',
        method: 'POST',
        headers: {
          host: '127.0.0.1',
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
      });

      const metadata = await sendRequest({
        hostname: '127.0.0.1',
        port,
        path: '/.well-known/oauth-protected-resource/mcp',
        method: 'GET',
        headers: { host: '127.0.0.1' },
      });

      await server.shutdown('TEST');
      console.error('${RESULT_MARKER}' + JSON.stringify({ unauthorized, metadata }));
    `;

    const result = runIsolatedNode(script, {
      HOST: '127.0.0.1',
      PORT: '0',
      ACCESS_TOKENS: 'test-token',
      ALLOW_REMOTE: 'false',
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = parseMarkedJson<{
      unauthorized: {
        status: number;
        headers: Record<string, string | string[] | undefined>;
      };
      metadata: {
        status: number;
        body: string;
      };
    }>(result.stderr);

    assert.equal(payload.unauthorized.status, 401);
    const challenge = payload.unauthorized.headers['www-authenticate'];
    assert.equal(typeof challenge, 'string');
    assert.match(challenge, /Bearer resource_metadata=".+"/);

    assert.equal(payload.metadata.status, 200);
    assert.match(payload.metadata.body, /"resource"/);
    assert.match(payload.metadata.body, /"bearer_methods_supported"/);
  });

  it('accepts X-API-Key for static auth', () => {
    const script = `
      import { startHttpServer } from './dist/http/native.js';
      import { request } from 'node:http';

      const server = await startHttpServer();
      const port = server.port;

      function sendRequest(headers, path) {
        return new Promise((resolve) => {
          const req = request(
            { hostname: '127.0.0.1', port, path, method: 'GET', headers },
            (res) => {
              res.resume();
              res.on('end', () =>
                resolve({ status: res.statusCode ?? 0 })
              );
            }
          );
          req.on('error', (error) => resolve({ error: error.message }));
          req.end();
        });
      }

      const response = await sendRequest(
        { host: '127.0.0.1', 'x-api-key': 'test-token' },
        '/mcp/downloads/markdown/deadbeef'
      );

      await server.shutdown('TEST');
      console.error('${RESULT_MARKER}' + JSON.stringify({ response }));
    `;

    const result = runIsolatedNode(script, {
      HOST: '127.0.0.1',
      PORT: '0',
      API_KEY: 'test-token',
      ALLOW_REMOTE: 'false',
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = parseMarkedJson<{ response: { status: number } }>(
      result.stderr
    );

    assert.equal(payload.response.status, 404);
  });
});
