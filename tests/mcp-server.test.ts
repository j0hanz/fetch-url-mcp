import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createMcpServer } from '../dist/mcp.js';

describe('MCP Server', () => {
  describe('createMcpServer', () => {
    it('creates a server instance', () => {
      const server = createMcpServer();
      assert.ok(server, 'Server should be created');
      assert.ok(server.server, 'Server should have underlying server');
      assert.strictEqual(
        typeof server.close,
        'function',
        'Server should have close method'
      );
    });

    it('can set error handler on server', () => {
      const server = createMcpServer();
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
  });

  describe('Server lifecycle', () => {
    it('can close server cleanly', async () => {
      const server = createMcpServer();
      await server.close();
      assert.ok(true, 'Server should close without errors');
    });

    it('can create and close multiple servers', async () => {
      const server1 = createMcpServer();
      const server2 = createMcpServer();

      await server1.close();
      await server2.close();

      assert.ok(true, 'Multiple servers should close cleanly');
    });

    it('handles close() called twice gracefully', async () => {
      const server = createMcpServer();
      await server.close();
      await server.close(); // Should not throw
      assert.ok(true, 'Closing twice should be safe');
    });
  });

  describe('Server error handling', () => {
    it('error handler does not throw when error is passed', () => {
      const server = createMcpServer();
      const error = new Error('Test error');

      // Should not throw when error handler is invoked
      assert.doesNotThrow(() => {
        if (server.server.onerror) {
          server.server.onerror(error);
        }
      }, 'Error handler should not throw');
    });

    it('error handler handles non-Error objects', () => {
      const server = createMcpServer();

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
});
