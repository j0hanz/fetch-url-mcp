import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createMcpServer } from '../dist/mcp.js';

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

  describe('Resources', () => {
    it('registers and handles internal://config resource', async () => {
      const server = await createMcpServer();
      const resourceName = 'config';
      // Access private property for testing
      // @ts-ignore
      const templates = server._registeredResourceTemplates;
      // @ts-ignore
      const resource = templates[resourceName];

      assert.ok(resource, 'Config resource should be registered');

      const uri = new URL('internal://config');
      // Use the actual internal handler name: readCallback
      const result = await resource.readCallback(uri);

      assert.ok(result.contents, 'Result should have contents');
      assert.strictEqual(result.contents.length, 1);
      assert.strictEqual(result.contents[0].mimeType, 'application/json');

      const configData = JSON.parse(result.contents[0].text);
      assert.ok(configData.server, 'Config should contain server info');
      assert.ok(configData.fetcher, 'Config should contain fetcher info');

      // Verify security measures
      if (configData.auth?.clientSecret) {
        assert.equal(
          configData.auth.clientSecret,
          '<REDACTED>',
          'Client secret should be redacted'
        );
      }
      if (configData.security?.apiKey) {
        assert.equal(
          configData.security.apiKey,
          '<REDACTED>',
          'API key should be redacted'
        );
      }
    });
  });

  describe('Prompts', () => {
    it('registers summarize-webpage prompt', async () => {
      const server = await createMcpServer();
      // Access private property for testing
      // @ts-ignore
      const prompts = server._registeredPrompts;
      const promptName = 'summarize-webpage';
      // @ts-ignore
      const prompt = prompts[promptName];

      assert.ok(prompt, 'Summarize webpage prompt should be registered');
      assert.strictEqual(
        prompt.description,
        'Summarize the content of a webpage given its URL.'
      );
      assert.ok(prompt.argsSchema, 'Prompt should have args schema');

      // Test prompt execution
      const result = await prompt.callback({ url: 'https://example.com' });
      assert.ok(result.messages, 'Result should have messages');
      assert.strictEqual(result.messages.length, 1);
      assert.ok(
        result.messages[0].content.text.includes('https://example.com'),
        'Message should contain URL'
      );
    });
  });
});
