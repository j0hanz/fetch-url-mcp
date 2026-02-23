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

describe('http duplicate-header protection', () => {
  it('rejects duplicate single-value headers', () => {
    const script = `
      import { createConnection } from 'node:net';
      import { startHttpServer } from './dist/http/native.js';

      const server = await startHttpServer();
      const port = server.port;

      function sendRawRequest() {
        return new Promise((resolve, reject) => {
          const socket = createConnection({ host: '127.0.0.1', port }, () => {
            socket.write(
              [
                'GET /health HTTP/1.1',
                'Host: 127.0.0.1',
                'Authorization: Bearer token-a',
                'Authorization: Bearer token-b',
                'Connection: close',
                '',
                '',
              ].join('\\r\\n')
            );
          });

          let raw = '';
          socket.setEncoding('utf8');
          socket.on('data', (chunk) => {
            raw += chunk;
          });
          socket.once('end', () => {
            const line = raw.split('\\r\\n')[0] ?? '';
            const match = /^HTTP\\/\\d\\.\\d\\s+(\\d+)/.exec(line);
            resolve({ status: match ? Number.parseInt(match[1], 10) : 0 });
          });
          socket.once('error', (error) => reject(error));
        });
      }

      const response = await sendRawRequest();
      await server.shutdown('TEST');
      console.error('${RESULT_MARKER}' + JSON.stringify(response));
    `;

    const result = runIsolatedNode(script, {
      HOST: '127.0.0.1',
      PORT: '0',
      ACCESS_TOKENS: 'test-token',
      ALLOW_REMOTE: 'false',
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = parseMarkedJson<{ status: number }>(result.stderr);
    assert.equal(payload.status, 400);
  });
});
