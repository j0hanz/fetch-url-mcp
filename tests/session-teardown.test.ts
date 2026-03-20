import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import {
  teardownSessionRegistration,
  teardownSessionResources,
} from '../dist/http/session-teardown.js';
import {
  registerMcpSessionServer,
  resolveMcpSessionIdByServer,
} from '../dist/lib/core.js';
import { taskManager } from '../dist/tasks/manager.js';

describe('session teardown helpers', () => {
  it('teardownSessionRegistration cancels owner-scoped tasks and unregisters the session', async () => {
    const sessionId = `test-session-${Date.now()}`;
    const server = new McpServer(
      { name: 'test-session-server', version: '0.0.0' },
      { capabilities: { tools: {} } }
    );
    registerMcpSessionServer(sessionId, server);

    const task = taskManager.createTask(
      undefined,
      'Task started',
      `session:${sessionId}`
    );

    teardownSessionRegistration(
      server,
      'The task was cancelled because the MCP session expired.'
    );

    assert.equal(resolveMcpSessionIdByServer(server), undefined);
    assert.equal(
      taskManager.getTask(task.taskId, `session:${sessionId}`)?.status,
      'cancelled'
    );

    await server.close();
  });

  it('teardownSessionResources applies the same owner-task cancellation before closing resources', async () => {
    const sessionId = `test-session-close-${Date.now()}`;
    const server = new McpServer(
      { name: 'test-session-close-server', version: '0.0.0' },
      { capabilities: { tools: {} } }
    );
    registerMcpSessionServer(sessionId, server);

    const transportClose = mock.fn(async () => {});
    const task = taskManager.createTask(
      undefined,
      'Task started',
      `session:${sessionId}`
    );

    await teardownSessionResources(
      {
        server,
        transport: { close: transportClose } as unknown as Parameters<
          typeof teardownSessionResources
        >[0]['transport'],
      },
      {
        cancelMessage:
          'The task was cancelled because the HTTP server is shutting down.',
        closeTransportReason: 'shutdown-session-close',
        closeServerReason: 'shutdown-session-close',
        unregisterByServer: true,
        awaitClose: true,
      }
    );

    assert.equal(resolveMcpSessionIdByServer(server), undefined);
    assert.equal(
      taskManager.getTask(task.taskId, `session:${sessionId}`)?.status,
      'cancelled'
    );
    assert.equal(transportClose.mock.calls.length, 1);
  });
});
