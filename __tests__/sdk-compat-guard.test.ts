import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import {
  getSdkCallToolHandler,
  setTaskToolCallCapability,
} from '../dist/lib/mcp-interop.js';

// ── SDK private API compatibility guard ─────────────────────────────
//
// These tests verify that the internal properties the codebase depends on
// (`_requestHandlers`, `_capabilities`) are present on the SDK's McpServer
// instance.  When an MCP SDK upgrade changes these internals, these tests
// fail *first*, preventing silent runtime breakage.
// ─────────────────────────────────────────────────────────────────────

describe('SDK compatibility guard', () => {
  let server: McpServer;

  before(async () => {
    server = new McpServer(
      { name: 'compat-test', version: '0.0.0' },
      {
        capabilities: {
          tools: {},
          tasks: {
            list: {},
            cancel: {},
            requests: { tools: { call: {} } },
          },
        },
      }
    );

    // Register a dummy tool so the handler map has a 'tools/call' entry.
    server.tool('test-tool', {}, async () => ({
      content: [{ type: 'text', text: 'ok' }],
    }));

    // Connect via an in-memory transport to trigger handler registration.
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    // We only need the server side; drain the client transport.
    clientTransport.close();
  });

  after(async () => {
    await server.close();
  });

  // ── _requestHandlers ────────────────────────────────────────────

  describe('_requestHandlers', () => {
    it('is a Map on the inner Server instance', () => {
      const handlers: unknown = Reflect.get(server.server, '_requestHandlers');
      assert.ok(handlers instanceof Map, '_requestHandlers should be a Map');
    });

    it('contains a tools/call handler after tool registration', () => {
      const handlers = Reflect.get(server.server, '_requestHandlers') as Map<
        string,
        unknown
      >;
      const handler = handlers.get('tools/call');
      assert.equal(
        typeof handler,
        'function',
        'tools/call handler should be a function'
      );
    });

    it('getSdkCallToolHandler returns the handler function', () => {
      const handler = getSdkCallToolHandler(server);
      assert.equal(
        typeof handler,
        'function',
        'getSdkCallToolHandler should return a function'
      );
    });
  });

  // ── _capabilities ───────────────────────────────────────────────

  describe('_capabilities', () => {
    it('is a plain object on the inner Server instance', () => {
      const caps: unknown = Reflect.get(server.server, '_capabilities');
      assert.ok(
        caps !== null && typeof caps === 'object' && !Array.isArray(caps),
        '_capabilities should be a plain object'
      );
    });

    it('setTaskToolCallCapability(enabled=true) adds tasks.requests.tools.call', () => {
      setTaskToolCallCapability(server, true);

      const caps = Reflect.get(server.server, '_capabilities') as Record<
        string,
        unknown
      >;
      const tasks = caps['tasks'] as Record<string, unknown> | undefined;
      assert.ok(tasks, 'capabilities.tasks should exist');

      const requests = tasks['requests'] as Record<string, unknown> | undefined;
      assert.ok(requests, 'capabilities.tasks.requests should exist');
      assert.ok(
        requests['tools'],
        'capabilities.tasks.requests.tools should exist'
      );
    });

    it('setTaskToolCallCapability(enabled=false) removes tasks.requests.tools', () => {
      // Ensure it's enabled first.
      setTaskToolCallCapability(server, true);
      setTaskToolCallCapability(server, false);

      const caps = Reflect.get(server.server, '_capabilities') as Record<
        string,
        unknown
      >;
      const tasks = caps['tasks'] as Record<string, unknown> | undefined;
      assert.ok(tasks, 'capabilities.tasks should still exist');

      const requests = tasks['requests'] as Record<string, unknown> | undefined;
      assert.ok(requests, 'capabilities.tasks.requests should still exist');
      assert.equal(
        requests['tools'],
        undefined,
        'capabilities.tasks.requests.tools should be removed'
      );
    });
  });
});
