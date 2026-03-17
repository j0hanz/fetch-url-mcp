import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  config,
  getMcpLogLevel,
  logError,
  logInfo,
  registerMcpSessionServer,
  runWithRequestContext,
  unregisterMcpSessionServer,
} from '../dist/lib/core.js';
import { createMcpServer } from '../dist/server.js';

function getPrivateMap(target: object, key: string): Map<string, unknown> {
  const value = Reflect.get(target, key);
  assert.ok(value instanceof Map, `${key} should be a Map`);
  return value;
}

describe('logging/setLevel session scoping', () => {
  it('applies MCP log level to the active session without mutating base config', async () => {
    const server = await createMcpServer();
    const sessionId = `logging-session-${Date.now()}`;
    const defaultLevel =
      config.logging.level === 'warn' ? 'warning' : config.logging.level;

    try {
      registerMcpSessionServer(sessionId, server);
      const requestHandlers = getPrivateMap(server.server, '_requestHandlers');
      const handler = requestHandlers.get('logging/setLevel');
      assert.equal(typeof handler, 'function');

      await runWithRequestContext(
        {
          requestId: 'log-level-request',
          operationId: 'log-level-request',
          sessionId,
        },
        async () => {
          await (handler as (request: unknown) => Promise<unknown> | unknown)({
            method: 'logging/setLevel',
            params: { level: 'error' },
          });
        }
      );

      assert.equal(getMcpLogLevel(sessionId), 'error');
      assert.equal(getMcpLogLevel(`${sessionId}-other`), defaultLevel);
      assert.equal(config.logging.level, defaultLevel);
    } finally {
      unregisterMcpSessionServer(sessionId);
      await server.close();
    }
  });

  it('omits stack traces from MCP logging payloads', async (t) => {
    const server = await createMcpServer();
    let sentMessage: unknown;

    try {
      t.mock.method(server, 'isConnected', () => true);
      t.mock.method(
        server.server,
        'sendLoggingMessage',
        async (message: unknown) => {
          sentMessage = message;
        }
      );

      logError('Tool execution failed', new Error('Boom'));
      await new Promise((resolve) => setImmediate(resolve));

      const payload = sentMessage as { data?: Record<string, unknown> };
      const data = payload.data;

      assert.ok(data);
      assert.equal(data.message, 'Tool execution failed');
      assert.equal(data.error, 'Boom');
      assert.equal('stack' in data, false);
    } finally {
      await server.close();
    }
  });

  it('preserves RFC 5424 severity thresholds for MCP log forwarding', async (t) => {
    const server = await createMcpServer();
    const sessionId = `logging-threshold-${Date.now()}`;
    const sentMessages: unknown[] = [];

    try {
      registerMcpSessionServer(sessionId, server);
      t.mock.method(server, 'isConnected', () => true);
      t.mock.method(
        server.server,
        'sendLoggingMessage',
        async (message: unknown) => {
          sentMessages.push(message);
        }
      );

      const requestHandlers = getPrivateMap(server.server, '_requestHandlers');
      const handler = requestHandlers.get('logging/setLevel');
      assert.equal(typeof handler, 'function');

      await runWithRequestContext(
        {
          requestId: 'log-notice-request',
          operationId: 'log-notice-request',
          sessionId,
        },
        async () => {
          await (handler as (request: unknown) => Promise<unknown> | unknown)({
            method: 'logging/setLevel',
            params: { level: 'notice' },
          });
          logInfo('Informational');
          logError('Ordinary error');
        }
      );

      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(getMcpLogLevel(sessionId), 'notice');
      assert.equal(sentMessages.length, 1);
      assert.deepEqual(sentMessages[0], {
        level: 'error',
        logger: 'fetch-url-mcp',
        data: 'Ordinary error',
      });

      sentMessages.length = 0;

      await runWithRequestContext(
        {
          requestId: 'log-alert-request',
          operationId: 'log-alert-request',
          sessionId,
        },
        async () => {
          await (handler as (request: unknown) => Promise<unknown> | unknown)({
            method: 'logging/setLevel',
            params: { level: 'alert' },
          });
          logError('Still not severe enough');
        }
      );

      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(getMcpLogLevel(sessionId), 'alert');
      assert.equal(sentMessages.length, 0);
    } finally {
      unregisterMcpSessionServer(sessionId);
      await server.close();
    }
  });
});
