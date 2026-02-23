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

describe('health endpoint', () => {
  it('returns 200 with minimal public status payload by default', () => {
    const script = `
      import { startHttpServer } from './dist/http/native.js';
      import { request } from 'node:http';

      const server = await startHttpServer();
      const port = server.port;

      const result = await new Promise((resolve) => {
        const req = request(
          { hostname: '127.0.0.1', port, path: '/health', method: 'GET' },
          (res) => {
            let body = '';
            res.on('data', (chunk) => { body += chunk; });
            res.on('end', () => {
              resolve({
                status: res.statusCode,
                body: JSON.parse(body),
              });
            });
          }
        );
        req.on('error', (error) => resolve({ error: error.message }));
        req.end();
      });

      await server.shutdown('test');
      console.log('${RESULT_MARKER}' + JSON.stringify(result));
    `;

    const { stdout, stderr, status } = runIsolatedNode(script, {
      PORT: '0',
      HOST: '127.0.0.1',
      ACCESS_TOKENS: 'test-token',
    });

    assert.equal(status, 0, `Process failed: ${stderr}`);

    const result = parseMarkedJson<{
      status: number;
      body: {
        status: string;
        version: string;
        uptime: number;
        timestamp: string;
      };
    }>(stdout);

    assert.equal(result.status, 200);
    assert.equal(result.body.status, 'ok');
    assert.equal(typeof result.body.version, 'string');
    assert.ok(result.body.version.length > 0, 'version should not be empty');
    assert.equal(typeof result.body.uptime, 'number');
    assert.ok(result.body.uptime >= 0, 'uptime should be non-negative');
    assert.equal(typeof result.body.timestamp, 'string');
    assert.ok(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(result.body.timestamp),
      'timestamp should be ISO format'
    );
    assert.equal('stats' in result.body, false);
    assert.equal('perf' in result.body, false);
    assert.equal('process' in result.body, false);
  });

  it('returns detailed metrics for authenticated verbose health checks', () => {
    const script = `
      import { startHttpServer } from './dist/http/native.js';
      import { request } from 'node:http';

      const server = await startHttpServer();
      const port = server.port;

      const result = await new Promise((resolve) => {
        const req = request(
          {
            hostname: '127.0.0.1',
            port,
            path: '/health?verbose=true',
            method: 'GET',
            headers: {
              authorization: 'Bearer test-token',
            },
          },
          (res) => {
            let body = '';
            res.on('data', (chunk) => { body += chunk; });
            res.on('end', () => {
              resolve({
                status: res.statusCode,
                body: JSON.parse(body),
              });
            });
          }
        );
        req.on('error', (error) => resolve({ error: error.message }));
        req.end();
      });

      await server.shutdown('test');
      console.log('${RESULT_MARKER}' + JSON.stringify(result));
    `;

    const { stdout, stderr, status } = runIsolatedNode(script, {
      PORT: '0',
      HOST: '127.0.0.1',
      ACCESS_TOKENS: 'test-token',
    });

    assert.equal(status, 0, `Process failed: ${stderr}`);

    const result = parseMarkedJson<{
      status: number;
      body: {
        status: string;
        version: string;
        uptime: number;
        timestamp: string;
        stats: {
          activeSessions: number;
          cacheKeys: number;
          workerPool: {
            queueDepth: number;
            activeWorkers: number;
            capacity: number;
          };
        };
      };
    }>(stdout);

    assert.equal(result.status, 200);
    assert.equal(result.body.status, 'ok');
    assert.equal(typeof result.body.stats, 'object');
    assert.equal(typeof result.body.stats.activeSessions, 'number');
    assert.equal(typeof result.body.stats.cacheKeys, 'number');
    assert.equal(typeof result.body.stats.workerPool, 'object');
    assert.equal(typeof result.body.stats.workerPool.queueDepth, 'number');
    assert.equal(typeof result.body.stats.workerPool.activeWorkers, 'number');
    assert.equal(typeof result.body.stats.workerPool.capacity, 'number');
  });
});
