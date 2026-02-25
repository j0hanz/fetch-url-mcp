import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { logWarn } from './observability.js';

type CleanupCallback = () => void;

const patchedCleanupServers = new WeakSet<McpServer>();
const serverCleanupCallbacks = new WeakMap<McpServer, Set<CleanupCallback>>();

function getServerCleanupCallbackSet(server: McpServer): Set<CleanupCallback> {
  let callbacks = serverCleanupCallbacks.get(server);
  if (!callbacks) {
    callbacks = new Set<CleanupCallback>();
    serverCleanupCallbacks.set(server, callbacks);
  }
  return callbacks;
}

// Safety: drainServerCleanupCallbacks is idempotent against double-fire.
// callbacks.clear() runs before iteration so a second call (e.g. from both
// server.close and server.server.onclose firing) always sees an empty Set.
function drainServerCleanupCallbacks(server: McpServer): void {
  const callbacks = serverCleanupCallbacks.get(server);
  if (!callbacks || callbacks.size === 0) return;

  const pending = [...callbacks];
  callbacks.clear();
  for (const callback of pending) {
    try {
      callback();
    } catch (error: unknown) {
      logWarn('Server cleanup callback failed', { error });
    }
  }
}

function ensureServerCleanupHooks(server: McpServer): void {
  if (patchedCleanupServers.has(server)) return;
  patchedCleanupServers.add(server);

  const originalOnClose = server.server.onclose;
  server.server.onclose = () => {
    drainServerCleanupCallbacks(server);
    originalOnClose?.();
  };

  // Monkey-patching is isolated here until the SDK exposes a first-class
  // lifecycle cleanup registration API.
  const originalClose = server.close.bind(server);
  server.close = async (): Promise<void> => {
    drainServerCleanupCallbacks(server);
    await originalClose();
  };
}

export function registerServerLifecycleCleanup(
  server: McpServer,
  callback: CleanupCallback
): void {
  ensureServerCleanupHooks(server);
  getServerCleanupCallbackSet(server).add(callback);
}
