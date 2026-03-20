import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { logWarn } from './core.js';
import { isObject } from './utils.js';

type CleanupCallback = () => void;
type RequestHandlerFn = (request: unknown, extra?: unknown) => Promise<unknown>;

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

export function getSdkCallToolHandler(
  server: McpServer
): RequestHandlerFn | null {
  const maybeHandlers: unknown = Reflect.get(server.server, '_requestHandlers');
  if (!(maybeHandlers instanceof Map)) return null;

  const handler: unknown = maybeHandlers.get('tools/call');
  return typeof handler === 'function' ? (handler as RequestHandlerFn) : null;
}

export function setTaskToolCallCapability(
  server: McpServer,
  enabled: boolean
): void {
  const capabilities: unknown = Reflect.get(server.server, '_capabilities');
  if (!isObject(capabilities)) return;

  const tasks = isObject(capabilities.tasks)
    ? (capabilities.tasks as Record<string, unknown>)
    : undefined;
  if (!tasks) return;

  const requests = isObject(tasks.requests)
    ? (tasks.requests as Record<string, unknown>)
    : undefined;
  if (!requests) return;

  if (enabled) {
    requests.tools = { call: {} };
    return;
  }

  delete requests.tools;
}
