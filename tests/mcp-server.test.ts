import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createMcpServer } from '../dist/server.js';

function getPrivateMap(target: object, key: string): Map<string, unknown> {
  const value = Reflect.get(target, key);
  assert.ok(value instanceof Map, `${key} should be a Map`);
  return value;
}

function getPrivateObject<T extends object>(
  target: object,
  key: string
): T | undefined {
  const value = Reflect.get(target, key);
  if (value === undefined) return undefined;
  assert.ok(value && typeof value === 'object', `${key} should be an object`);
  return value as T;
}

describe('MCP Server', () => {
  describe('createMcpServer', () => {
    it('creates a server instance', async () => {
      const server = await createMcpServer();
      assert.ok(server, 'Server should be created');
      assert.ok(server.server, 'Server should have underlying server');
      assert.strictEqual(
        typeof server.close,
        'function',
        'Server should have close method'
      );
    });

    it('can set error handler on server', async () => {
      const server = await createMcpServer();
      let errorCaught: Error | null = null;

      server.server.onerror = (error) => {
        errorCaught = error instanceof Error ? error : new Error(String(error));
      };

      assert.strictEqual(
        typeof server.server.onerror,
        'function',
        'Error handler should be settable'
      );

      // Test the handler
      const testError = new Error('test');
      if (server.server.onerror) {
        server.server.onerror(testError);
      }
      assert.strictEqual(
        errorCaught,
        testError,
        'Error handler should receive errors'
      );
    });

    it('publishes extended server info metadata', async () => {
      const server = await createMcpServer();

      const serverInfo = getPrivateObject<{
        title?: string;
        description?: string;
        websiteUrl?: string;
      }>(server.server, '_serverInfo');

      assert.ok(serverInfo, 'Server info should be available');
      assert.equal(serverInfo?.title, 'Fetch URL');
      assert.equal(
        serverInfo?.description,
        'Fetch web pages and convert them into clean, AI-readable Markdown.'
      );
      assert.equal(
        serverInfo?.websiteUrl,
        'https://github.com/j0hanz/fetch-url-mcp'
      );

      const capabilities = getPrivateObject<{
        resources?: { subscribe?: boolean; listChanged?: boolean };
      }>(server.server, '_capabilities');
      assert.equal(capabilities?.resources?.subscribe, true);
      assert.equal(capabilities?.resources?.listChanged, true);
    });
  });

  describe('Server lifecycle', () => {
    it('can close server cleanly', async () => {
      const server = await createMcpServer();
      await server.close();
      assert.ok(true, 'Server should close without errors');
    });

    it('can create and close multiple servers', async () => {
      const server1 = await createMcpServer();
      const server2 = await createMcpServer();

      await server1.close();
      await server2.close();

      assert.ok(true, 'Multiple servers should close cleanly');
    });

    it('handles close() called twice gracefully', async () => {
      const server = await createMcpServer();
      await server.close();
      await server.close(); // Should not throw
      assert.ok(true, 'Closing twice should be safe');
    });
  });

  describe('Server error handling', () => {
    it('error handler does not throw when error is passed', async () => {
      const server = await createMcpServer();
      const error = new Error('Test error');

      // Should not throw when error handler is invoked
      assert.doesNotThrow(() => {
        if (server.server.onerror) {
          server.server.onerror(error);
        }
      }, 'Error handler should not throw');
    });

    it('error handler handles non-Error objects', async () => {
      const server = await createMcpServer();

      // Should handle string errors
      assert.doesNotThrow(() => {
        if (server.server.onerror) {
          server.server.onerror('string error' as never);
        }
      }, 'Should handle string errors');

      // Should handle object errors
      assert.doesNotThrow(() => {
        if (server.server.onerror) {
          server.server.onerror({ message: 'object error' } as never);
        }
      }, 'Should handle object errors');
    });
  });

  describe('Prompts', () => {
    it('registers get-help prompt', async () => {
      const server = await createMcpServer();
      const prompts = getPrivateObject<
        Record<string, { callback?: (...args: unknown[]) => unknown }>
      >(server, '_registeredPrompts');
      const prompt = prompts?.['get-help'];

      assert.ok(prompt, 'get-help prompt should be registered');
      assert.equal(typeof prompt.callback, 'function');
    });
  });

  describe('Protocol handlers', () => {
    it('registers logging/setLevel request handling', async () => {
      const server = await createMcpServer();
      const requestHandlers = getPrivateMap(server.server, '_requestHandlers');

      assert.ok(
        requestHandlers.has('logging/setLevel'),
        'logging/setLevel handler should be registered'
      );
    });

    it('rejects unsupported logging/setLevel values', async () => {
      const server = await createMcpServer();
      const requestHandlers = getPrivateMap(server.server, '_requestHandlers');

      const handler = requestHandlers.get('logging/setLevel');
      assert.equal(
        typeof handler,
        'function',
        'logging/setLevel handler should be registered'
      );
      const loggingSetLevelHandler = handler as (request: unknown) => unknown;

      assert.throws(() =>
        loggingSetLevelHandler({
          method: 'logging/setLevel',
          params: { level: 'verbose' },
        })
      );
    });

    it('registers notifications/cancelled handling', async () => {
      const server = await createMcpServer();
      const notificationHandlers = getPrivateMap(
        server.server,
        '_notificationHandlers'
      );

      assert.ok(
        notificationHandlers.has('notifications/cancelled'),
        'notifications/cancelled handler should be registered'
      );
    });
  });
});
