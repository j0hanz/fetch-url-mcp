import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createMcpServer } from '../dist/server.js';

/**
 * SDK compatibility guard tests.
 *
 * These tests assert internal MCP SDK structures that task-handlers.ts depends on
 * via Reflect.get and monkey-patching (see S-2, S-3 in task-handlers.ts).
 *
 * If any of these tests fail after an SDK upgrade, task-mode tools will silently
 * stop working. Update the code in src/lib/task-handlers.ts accordingly.
 */
describe('SDK compatibility guard', () => {
  it('server.server._requestHandlers is a Map', async () => {
    const server = await createMcpServer();
    const handlers: unknown = Reflect.get(server.server, '_requestHandlers');
    assert.ok(
      handlers instanceof Map,
      '_requestHandlers must be a Map (task call interception depends on this)'
    );
    await server.close();
  });

  it('_requestHandlers contains tools/call as a function', async () => {
    const server = await createMcpServer();
    const handlers = Reflect.get(server.server, '_requestHandlers') as Map<
      string,
      unknown
    >;
    const toolsCallHandler = handlers.get('tools/call');
    assert.strictEqual(
      typeof toolsCallHandler,
      'function',
      'tools/call handler must be a function (task routing depends on this)'
    );
    await server.close();
  });

  it('server.close is a writable function', async () => {
    const server = await createMcpServer();
    assert.strictEqual(typeof server.close, 'function');

    // Verify it can be replaced (monkey-patching for lifecycle cleanup)
    const original = server.close;
    const replacement = async (): Promise<void> => original.call(server);
    server.close = replacement;
    assert.strictEqual(
      server.close,
      replacement,
      'server.close must be writable'
    );
    await server.close();
  });

  it('server.server.onclose is assignable', async () => {
    const server = await createMcpServer();
    const original = server.server.onclose;

    // Verify it can be reassigned (lifecycle cleanup hook depends on this)
    const replacement = (): void => original?.();
    server.server.onclose = replacement;
    assert.strictEqual(
      server.server.onclose,
      replacement,
      'server.server.onclose must be assignable'
    );
    await server.close();
  });

  it('server.server._capabilities exposes tasks.requests', async () => {
    const server = await createMcpServer();
    const capabilities: unknown = Reflect.get(server.server, '_capabilities');
    assert.ok(
      typeof capabilities === 'object' && capabilities !== null,
      '_capabilities must be an object (setTaskToolCallCapability depends on this)'
    );
    const tasks = (capabilities as Record<string, unknown>)['tasks'];
    assert.ok(
      typeof tasks === 'object' && tasks !== null,
      '_capabilities.tasks must be an object'
    );
    const requests = (tasks as Record<string, unknown>)['requests'];
    assert.ok(
      typeof requests === 'object' && requests !== null,
      '_capabilities.tasks.requests must be an object'
    );
    await server.close();
  });
});
