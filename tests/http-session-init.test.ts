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

describe('http session initialization', () => {
  it('supports multiple initialize requests with independent sessions', () => {
    const script = `
      import { startHttpServer } from './dist/http/native.js';
      import { request } from 'node:http';

      const server = await startHttpServer();
      const port = server.port;

      function initialize(versionHeader) {
        const body = JSON.stringify({
          jsonrpc: '2.0',
          id: String(Math.random()),
          method: 'initialize',
          params: {
            protocolVersion: '2025-11-25',
            capabilities: {},
            clientInfo: { name: 'test-client', version: '1.0.0' },
          },
        });

        return new Promise((resolve) => {
          const headers = {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            authorization: 'Bearer test-token',
            host: '127.0.0.1',
          };
          if (versionHeader !== undefined) {
            headers['mcp-protocol-version'] = versionHeader;
          }

          const req = request(
            { hostname: '127.0.0.1', port, path: '/mcp', method: 'POST', headers },
            (res) => {
              let raw = '';
              res.on('data', (chunk) => { raw += chunk; });
              res.on('end', () => {
                resolve({
                  status: res.statusCode ?? 0,
                  sessionId: res.headers['mcp-session-id'] ?? null,
                  hasInitializeResult: raw.includes('"protocolVersion"'),
                });
              });
            }
          );
          req.on('error', (error) => resolve({ error: error.message }));
          req.write(body);
          req.end();
        });
      }

      const first = await initialize('2025-11-25');
      const second = await initialize('2025-11-25');
      const legacy = await initialize('2025-03-26');
      const missingHeader = await initialize(undefined);

      await server.shutdown('TEST');
      console.error('${RESULT_MARKER}' + JSON.stringify({ first, second, legacy, missingHeader }));
    `;

    const result = runIsolatedNode(script, {
      HOST: '127.0.0.1',
      PORT: '0',
      ACCESS_TOKENS: 'test-token',
      ALLOW_REMOTE: 'false',
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = parseMarkedJson<{
      first: {
        status: number;
        sessionId: string | null;
        hasInitializeResult: boolean;
      };
      second: {
        status: number;
        sessionId: string | null;
        hasInitializeResult: boolean;
      };
      legacy: {
        status: number;
        sessionId: string | null;
        hasInitializeResult: boolean;
      };
      missingHeader: {
        status: number;
        sessionId: string | null;
        hasInitializeResult: boolean;
      };
    }>(result.stderr);

    assert.equal(payload.first.status, 200);
    assert.equal(typeof payload.first.sessionId, 'string');
    assert.equal(payload.first.hasInitializeResult, true);

    assert.equal(payload.second.status, 200);
    assert.equal(typeof payload.second.sessionId, 'string');
    assert.equal(payload.second.hasInitializeResult, true);
    assert.notEqual(payload.first.sessionId, payload.second.sessionId);

    assert.equal(payload.legacy.status, 200);
    assert.equal(typeof payload.legacy.sessionId, 'string');
    assert.equal(payload.legacy.hasInitializeResult, true);

    assert.equal(payload.missingHeader.status, 200);
    assert.equal(typeof payload.missingHeader.sessionId, 'string');
    assert.equal(payload.missingHeader.hasInitializeResult, true);
  });

  it('rejects POST /mcp initialize requests without required Accept media types', () => {
    const script = `
      import { startHttpServer } from './dist/http/native.js';
      import { request } from 'node:http';

      const server = await startHttpServer();
      const port = server.port;

      const body = JSON.stringify({
        jsonrpc: '2.0',
        id: 'init-no-accept',
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'test-client', version: '1.0.0' },
        },
      });

      const result = await new Promise((resolve) => {
        const req = request(
          {
            hostname: '127.0.0.1',
            port,
            path: '/mcp',
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              accept: 'application/json',
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
                body: raw,
              });
            });
          }
        );
        req.on('error', (error) => resolve({ error: error.message }));
        req.write(body);
        req.end();
      });

      await server.shutdown('TEST');
      console.error('${RESULT_MARKER}' + JSON.stringify(result));
    `;

    const result = runIsolatedNode(script, {
      HOST: '127.0.0.1',
      PORT: '0',
      ACCESS_TOKENS: 'test-token',
      ALLOW_REMOTE: 'false',
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = parseMarkedJson<{ status: number; body: string }>(
      result.stderr
    );

    assert.equal(payload.status, 400);
    assert.match(
      payload.body,
      /Accept header must include application\/json and text\/event-stream/
    );
  });
});
