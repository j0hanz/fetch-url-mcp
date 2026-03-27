import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import {
  getTaskCapableTool,
  getTaskCapableToolSupport,
  hasRegisteredTaskCapableTools,
  hasTaskCapableTool,
  registerTaskCapableTool,
  setTaskCapableToolSupport,
  unregisterTaskCapableTool,
} from '../src/tasks/registry.js';

function createRegistryTestServer(): McpServer {
  return new McpServer(
    { name: 'task-registry-test', version: '0.0.0' },
    { capabilities: { tools: {} } }
  );
}

function makeDummyDescriptor(
  name: string,
  taskSupport?: 'required' | 'optional' | 'forbidden'
) {
  return {
    name,
    parseArguments: (args: unknown) => args,
    execute: async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }),
    ...(taskSupport !== undefined ? { taskSupport } : {}),
  };
}

describe('task-capable tool registry', () => {
  const servers: McpServer[] = [];

  afterEach(async () => {
    await Promise.allSettled(servers.splice(0).map((server) => server.close()));
  });

  function registerServer(): McpServer {
    const server = createRegistryTestServer();
    servers.push(server);
    return server;
  }

  describe('registerTaskCapableTool', () => {
    it('registers a tool and makes it retrievable', () => {
      const server = registerServer();
      registerTaskCapableTool(server, makeDummyDescriptor('alpha'));
      assert.ok(hasTaskCapableTool(server, 'alpha'));
      assert.ok(getTaskCapableTool(server, 'alpha'));
    });

    it('defaults taskSupport to "optional" when not provided', () => {
      const server = registerServer();
      registerTaskCapableTool(server, makeDummyDescriptor('alpha'));
      assert.equal(getTaskCapableToolSupport(server, 'alpha'), 'optional');
    });

    it('preserves explicit "forbidden" taskSupport', () => {
      const server = registerServer();
      registerTaskCapableTool(
        server,
        makeDummyDescriptor('alpha', 'forbidden')
      );
      assert.equal(getTaskCapableToolSupport(server, 'alpha'), 'forbidden');
    });

    it('preserves explicit "required" taskSupport', () => {
      const server = registerServer();
      registerTaskCapableTool(server, makeDummyDescriptor('alpha', 'required'));
      assert.equal(getTaskCapableToolSupport(server, 'alpha'), 'required');
    });

    it('overwrites a previous registration on the same server', () => {
      const server = registerServer();
      registerTaskCapableTool(server, makeDummyDescriptor('alpha', 'optional'));
      registerTaskCapableTool(
        server,
        makeDummyDescriptor('alpha', 'forbidden')
      );
      assert.equal(getTaskCapableToolSupport(server, 'alpha'), 'forbidden');
    });

    it('does not leak registrations across servers', () => {
      const alphaServer = registerServer();
      const betaServer = registerServer();

      registerTaskCapableTool(alphaServer, makeDummyDescriptor('alpha'));

      assert.equal(hasTaskCapableTool(betaServer, 'alpha'), false);
      assert.equal(getTaskCapableTool(betaServer, 'alpha'), undefined);
    });
  });

  describe('unregisterTaskCapableTool', () => {
    it('removes a registered tool', () => {
      const server = registerServer();
      registerTaskCapableTool(server, makeDummyDescriptor('alpha'));
      unregisterTaskCapableTool(server, 'alpha');
      assert.equal(hasTaskCapableTool(server, 'alpha'), false);
      assert.equal(getTaskCapableTool(server, 'alpha'), undefined);
    });

    it('does not throw for an unregistered name', () => {
      const server = registerServer();
      assert.doesNotThrow(() =>
        unregisterTaskCapableTool(server, 'nonexistent')
      );
    });
  });

  describe('getTaskCapableTool / getTaskCapableToolSupport', () => {
    it('returns undefined for unknown tools', () => {
      const server = registerServer();
      assert.equal(getTaskCapableTool(server, 'nonexistent'), undefined);
      assert.equal(getTaskCapableToolSupport(server, 'nonexistent'), undefined);
    });
  });

  describe('hasRegisteredTaskCapableTools', () => {
    it('returns false when registry is empty', () => {
      const server = registerServer();
      assert.equal(hasRegisteredTaskCapableTools(server), false);
    });

    it('returns true after a tool is registered', () => {
      const server = registerServer();
      registerTaskCapableTool(server, makeDummyDescriptor('alpha'));
      assert.equal(hasRegisteredTaskCapableTools(server), true);
    });
  });

  describe('setTaskCapableToolSupport', () => {
    it('changes support level for an existing tool', () => {
      const server = registerServer();
      registerTaskCapableTool(server, makeDummyDescriptor('alpha', 'optional'));
      setTaskCapableToolSupport(server, 'alpha', 'forbidden');
      assert.equal(getTaskCapableToolSupport(server, 'alpha'), 'forbidden');
    });

    it('is a no-op for unregistered tools', () => {
      const server = registerServer();
      assert.doesNotThrow(() =>
        setTaskCapableToolSupport(server, 'nonexistent', 'optional')
      );
    });
  });
});
