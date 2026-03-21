import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const RESULT_MARKER = '__RESULT__';
const CHILD_TIMEOUT_MS = 30_000;

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

describe('http session regressions', () => {
  it('blocks GET and DELETE until notifications/initialized and keeps the session usable afterwards', () => {
    const script = `
      import { startHttpServer } from './dist/http/native.js';
      import { request } from 'node:http';

      const server = await startHttpServer();
      const port = server.port;

      function send({ method = 'POST', sessionId, body }) {
        return new Promise((resolve) => {
          const headers = {
            authorization: 'Bearer test-token',
            host: '127.0.0.1',
            'mcp-protocol-version': '2025-11-25',
          };
          if (method === 'GET') {
            headers.accept = 'text/event-stream';
          } else {
            headers.accept = 'application/json, text/event-stream';
            headers['content-type'] = 'application/json';
          }
          if (sessionId) headers['mcp-session-id'] = sessionId;

          const req = request(
            { hostname: '127.0.0.1', port, path: '/mcp', method, headers },
            (res) => {
              let raw = '';
              res.on('data', (chunk) => { raw += chunk; });
              res.on('end', () => {
                resolve({
                  status: res.statusCode ?? 0,
                  bodyPreview: raw.slice(0, 512),
                  sessionId: res.headers['mcp-session-id'] ?? null,
                  containsTools: raw.includes('"tools"'),
                });
              });
            }
          );
          req.on('error', (error) => resolve({ error: error.message }));
          if (body) req.write(JSON.stringify(body));
          req.end();
        });
      }

      const init = await send({
        body: {
          jsonrpc: '2.0',
          id: 'init',
          method: 'initialize',
          params: {
            protocolVersion: '2025-11-25',
            capabilities: {},
            clientInfo: { name: 'test-client', version: '1.0.0' },
          },
        },
      });

      const sid = init.sessionId;
      const getBeforeInit = await send({ method: 'GET', sessionId: sid });
      const deleteBeforeInit = await send({ method: 'DELETE', sessionId: sid });
      const initialized = await send({
        sessionId: sid,
        body: { jsonrpc: '2.0', method: 'notifications/initialized', params: {} },
      });
      const listAfterInit = await send({
        sessionId: sid,
        body: { jsonrpc: '2.0', id: 'list', method: 'tools/list', params: {} },
      });

      await server.shutdown('TEST');
      console.error('${RESULT_MARKER}' + JSON.stringify({
        init,
        getBeforeInit,
        deleteBeforeInit,
        initialized,
        listAfterInit,
      }));
    `;

    const result = runIsolatedNode(script, {
      HOST: '127.0.0.1',
      PORT: '0',
      ACCESS_TOKENS: 'test-token',
      ALLOW_REMOTE: 'false',
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = parseMarkedJson<{
      init: { status: number; sessionId: string | null };
      getBeforeInit: { status: number; bodyPreview: string };
      deleteBeforeInit: { status: number; bodyPreview: string };
      initialized: { status: number };
      listAfterInit: { status: number; containsTools: boolean };
    }>(result.stderr);

    assert.equal(payload.init.status, 200);
    assert.equal(typeof payload.init.sessionId, 'string');
    assert.equal(payload.getBeforeInit.status, 400);
    assert.match(payload.getBeforeInit.bodyPreview, /Session not initialized/);
    assert.equal(payload.deleteBeforeInit.status, 400);
    assert.match(
      payload.deleteBeforeInit.bodyPreview,
      /Session not initialized/
    );
    assert.equal(payload.initialized.status, 202);
    assert.equal(payload.listAfterInit.status, 200);
    assert.equal(payload.listAfterInit.containsTools, true);
  });

  it(
    'expires sessions that never send notifications/initialized',
    { timeout: 25_000 },
    () => {
      const script = `
        import { startHttpServer } from './dist/http/native.js';
        import { request } from 'node:http';

        const server = await startHttpServer();
        const port = server.port;

        function send(body, sessionId) {
          return new Promise((resolve) => {
            const headers = {
              'content-type': 'application/json',
              accept: 'application/json, text/event-stream',
              authorization: 'Bearer test-token',
              host: '127.0.0.1',
              'mcp-protocol-version': '2025-11-25',
            };
            if (sessionId) headers['mcp-session-id'] = sessionId;

            const req = request(
              { hostname: '127.0.0.1', port, path: '/mcp', method: 'POST', headers },
              (res) => {
                let raw = '';
                res.on('data', (chunk) => { raw += chunk; });
                res.on('end', () => {
                  resolve({
                    status: res.statusCode ?? 0,
                    bodyPreview: raw.slice(0, 512),
                    sessionId: res.headers['mcp-session-id'] ?? null,
                  });
                });
              }
            );
            req.on('error', (error) => resolve({ error: error.message }));
            req.write(JSON.stringify(body));
            req.end();
          });
        }

        const init = await send({
          jsonrpc: '2.0',
          id: 'init',
          method: 'initialize',
          params: {
            protocolVersion: '2025-11-25',
            capabilities: {},
            clientInfo: { name: 'test-client', version: '1.0.0' },
          },
        });

        await new Promise((resolve) => setTimeout(resolve, 11_000));

        const afterTimeout = await send(
          { jsonrpc: '2.0', id: 'list', method: 'tools/list', params: {} },
          init.sessionId
        );

        await server.shutdown('TEST');
        console.error('${RESULT_MARKER}' + JSON.stringify({ init, afterTimeout }));
      `;

      const result = runIsolatedNode(script, {
        HOST: '127.0.0.1',
        PORT: '0',
        ACCESS_TOKENS: 'test-token',
        ALLOW_REMOTE: 'false',
      });

      assert.equal(result.status, 0, result.stderr);
      const payload = parseMarkedJson<{
        init: { status: number; sessionId: string | null };
        afterTimeout: { status: number; bodyPreview: string };
      }>(result.stderr);

      assert.equal(payload.init.status, 200);
      assert.equal(typeof payload.init.sessionId, 'string');
      assert.equal(payload.afterTimeout.status, 404);
      assert.match(payload.afterTimeout.bodyPreview, /Session not found/);
    }
  );

  it('reports malformed initialize and oversized /mcp bodies precisely', () => {
    const script = `
      import { startHttpServer } from './dist/http/native.js';
      import { request } from 'node:http';

      const server = await startHttpServer();
      const port = server.port;

      function sendRaw(body) {
        return new Promise((resolve) => {
          const req = request(
            {
              hostname: '127.0.0.1',
              port,
              path: '/mcp',
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                accept: 'application/json, text/event-stream',
                authorization: 'Bearer test-token',
                host: '127.0.0.1',
                'mcp-protocol-version': '2025-11-25',
              },
            },
            (res) => {
              let raw = '';
              res.on('data', (chunk) => { raw += chunk; });
              res.on('end', () => {
                resolve({
                  status: res.statusCode ?? 0,
                  bodyPreview: raw.slice(0, 512),
                });
              });
            }
          );
          req.on('error', (error) => resolve({ error: error.message }));
          req.write(body);
          req.end();
        });
      }

      const malformedInitialize = await sendRaw(JSON.stringify({
        jsonrpc: '2.0',
        id: 'bad-init',
        method: 'initialize',
        params: {
          capabilities: {},
          clientInfo: { name: 'test-client', version: '1.0.0' },
        },
      }));

      const padding = 'x'.repeat(1024 * 1024 + 128);
      const oversizedBody = await sendRaw(JSON.stringify({
        jsonrpc: '2.0',
        id: 'oversized-init',
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'test-client', version: '1.0.0' },
          padding,
        },
      }));

      await server.shutdown('TEST');
      console.error('${RESULT_MARKER}' + JSON.stringify({
        malformedInitialize,
        oversizedBody,
      }));
    `;

    const result = runIsolatedNode(script, {
      HOST: '127.0.0.1',
      PORT: '0',
      ACCESS_TOKENS: 'test-token',
      ALLOW_REMOTE: 'false',
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = parseMarkedJson<{
      malformedInitialize: { status: number; bodyPreview: string };
      oversizedBody: { status: number; bodyPreview: string };
    }>(result.stderr);

    assert.equal(payload.malformedInitialize.status, 400);
    assert.match(
      payload.malformedInitialize.bodyPreview,
      /Invalid initialize request/
    );
    assert.equal(payload.oversizedBody.status, 413);
    assert.match(payload.oversizedBody.bodyPreview, /Request body too large/);
  });
});
