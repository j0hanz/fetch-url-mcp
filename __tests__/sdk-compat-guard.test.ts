import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import {
  getSdkCallToolHandler,
  setTaskToolCallCapability,
} from '../src/lib/mcp-interop.js';

function assertRecord(
  value: unknown,
  message: string
): asserts value is Record<string, unknown> {
  assert.ok(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    message
  );
}

function getPrivateHandlerMap(server: McpServer): Map<string, unknown> {
  const handlers: unknown = Reflect.get(server.server, '_requestHandlers');
  assert.ok(handlers instanceof Map, '_requestHandlers should be a Map');
  return handlers;
}

function getPrivateCapabilities(server: McpServer): Record<string, unknown> {
  const caps: unknown = Reflect.get(server.server, '_capabilities');
  assertRecord(caps, '_capabilities should be a plain object');
  return caps;
}

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
      const handlers = getPrivateHandlerMap(server);
      assert.ok(handlers instanceof Map, '_requestHandlers should be a Map');
    });

    it('contains a tools/call handler after tool registration', () => {
      const handlers = getPrivateHandlerMap(server);
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
      const caps = getPrivateCapabilities(server);
      assertRecord(caps, '_capabilities should be a plain object');
    });

    it('setTaskToolCallCapability(enabled=true) adds tasks.requests.tools.call', () => {
      setTaskToolCallCapability(server, true);

      const caps = getPrivateCapabilities(server);
      const tasks = caps['tasks'];
      assertRecord(tasks, 'capabilities.tasks should exist');
      assert.ok(tasks, 'capabilities.tasks should exist');

      const requests = tasks['requests'];
      assertRecord(requests, 'capabilities.tasks.requests should exist');
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

      const caps = getPrivateCapabilities(server);
      const tasks = caps['tasks'];
      assertRecord(tasks, 'capabilities.tasks should still exist');
      assert.ok(tasks, 'capabilities.tasks should still exist');

      const requests = tasks['requests'];
      assertRecord(requests, 'capabilities.tasks.requests should still exist');
      assert.ok(requests, 'capabilities.tasks.requests should still exist');
      assert.equal(
        requests['tools'],
        undefined,
        'capabilities.tasks.requests.tools should be removed'
      );
    });
  });
});
