import { McpServer } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { z } from 'zod';

import {
  registerTaskCapableTool,
  registerTaskHandlers,
} from '../src/tasks/manager.js';

describe('public MCP handler registration', () => {
  const servers: McpServer[] = [];

  afterEach(async () => {
    await Promise.allSettled(servers.splice(0).map((server) => server.close()));
  });

  function createServer(): McpServer {
    const server = new McpServer(
      { name: 'compat-test', version: '0.0.0' },
      {
        capabilities: {
          tools: {},
          tasks: {
            list: {},
            cancel: {},
            delete: {},
            requests: { tools: { call: {} } },
          },
        },
      }
    );
    servers.push(server);
    return server;
  }

  it('registers tools/call through the public request handler API', async () => {
    const server = createServer();

    registerTaskCapableTool(server, {
      name: 'test-tool',
      parseArguments: () => ({}),
      execute: async () => ({
        content: [{ type: 'text', text: 'ok' }],
      }),
      taskSupport: 'optional',
    });

    registerTaskHandlers(server);

    const handlers: unknown = Reflect.get(server.server, '_requestHandlers');
    assert.ok(handlers instanceof Map);
    assert.equal(typeof handlers.get('tools/call'), 'function');
  });

  it('registers tasks/delete through the public fallback request handler', async () => {
    const server = createServer();
    registerTaskHandlers(server);

    assert.equal(typeof server.server.fallbackRequestHandler, 'function');
  });

  it('still supports normal tool registration on the same server', () => {
    const server = createServer();

    const registeredTool = server.registerTool(
      'registered-tool',
      {
        inputSchema: z.object({}),
        outputSchema: z.object({ ok: z.boolean() }),
      },
      async () => ({
        content: [{ type: 'text', text: '{"ok":true}' }],
        structuredContent: { ok: true },
      })
    );

    registeredTool.execution = { taskSupport: 'optional' };

    assert.deepEqual(registeredTool.execution, { taskSupport: 'optional' });
  });
});
