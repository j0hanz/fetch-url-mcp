import { randomUUID } from 'node:crypto';

import type { Request, Response } from 'express';

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

import { config } from '../config/index.js';
import type { McpRequestBody } from '../config/types/runtime.js';

import { logError, logInfo, logWarn } from '../services/logger.js';

import { getErrorMessage } from '../utils/error-utils.js';

import { createMcpServer } from '../server.js';
import {
  createSlotTracker,
  ensureSessionCapacity,
  reserveSessionSlot,
  respondBadRequest,
  respondServerBusy,
  type SlotTracker,
} from './mcp-session-helpers.js';
import { type SessionStore } from './sessions.js';

export interface McpSessionOptions {
  readonly sessionStore: SessionStore;
  readonly maxSessions: number;
}

function startSessionInitTimeout(
  transport: StreamableHTTPServerTransport,
  tracker: SlotTracker,
  clearInitTimeout: () => void,
  timeoutMs: number
): NodeJS.Timeout | null {
  if (timeoutMs <= 0) return null;

  const timeout = setTimeout(() => {
    clearInitTimeout();
    if (tracker.isInitialized()) return;

    tracker.releaseSlot();
    void transport.close().catch((error: unknown) => {
      logWarn('Failed to close stalled session', {
        error: getErrorMessage(error),
      });
    });
    logWarn('Session initialization timed out', { timeoutMs });
  }, timeoutMs);

  timeout.unref();
  return timeout;
}

function handleSessionInitialized(
  id: string,
  transport: StreamableHTTPServerTransport,
  options: McpSessionOptions,
  tracker: SlotTracker,
  clearInitTimeout: () => void
): void {
  clearInitTimeout();
  tracker.markInitialized();
  tracker.releaseSlot();
  const now = Date.now();
  options.sessionStore.set(id, {
    transport,
    createdAt: now,
    lastSeen: now,
  });
  logInfo('Session initialized', { sessionId: id });
}

function handleSessionClosed(id: string, options: McpSessionOptions): void {
  options.sessionStore.remove(id);
  logInfo('Session closed', { sessionId: id });
}

function handleTransportClose(
  transport: StreamableHTTPServerTransport,
  options: McpSessionOptions,
  tracker: SlotTracker,
  clearInitTimeout: () => void
): void {
  clearInitTimeout();
  if (!tracker.isInitialized()) {
    tracker.releaseSlot();
  }
  if (transport.sessionId) {
    options.sessionStore.remove(transport.sessionId);
  }
}

function createTransportForNewSession(options: McpSessionOptions): {
  transport: StreamableHTTPServerTransport;
  releaseSlot: () => void;
  clearInitTimeout: () => void;
} {
  const tracker = createSlotTracker();
  let initTimeout: NodeJS.Timeout | null = null;
  const clearInitTimeout = (): void => {
    if (!initTimeout) return;
    clearTimeout(initTimeout);
    initTimeout = null;
  };
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (id) => {
      handleSessionInitialized(
        id,
        transport,
        options,
        tracker,
        clearInitTimeout
      );
    },
    onsessionclosed: (id) => {
      handleSessionClosed(id, options);
    },
  });

  transport.onclose = () => {
    handleTransportClose(transport, options, tracker, clearInitTimeout);
  };

  initTimeout = startSessionInitTimeout(
    transport,
    tracker,
    clearInitTimeout,
    config.server.sessionInitTimeoutMs
  );

  return { transport, releaseSlot: tracker.releaseSlot, clearInitTimeout };
}

function createTransportAdapter(
  transport: StreamableHTTPServerTransport
): Transport {
  const adapter: Transport = {
    start: () => transport.start(),
    send: (message, options) => transport.send(message, options),
    close: () => transport.close(),
  };

  Object.defineProperties(adapter, {
    onclose: {
      get: () => transport.onclose,
      set: (handler: (() => void) | undefined) => {
        transport.onclose = handler;
      },
      enumerable: true,
      configurable: true,
    },
    onerror: {
      get: () => transport.onerror,
      set: (handler: ((error: Error) => void) | undefined) => {
        transport.onerror = handler;
      },
      enumerable: true,
      configurable: true,
    },
    onmessage: {
      get: () => transport.onmessage,
      set: (handler: Transport['onmessage']) => {
        transport.onmessage = handler as typeof transport.onmessage;
      },
      enumerable: true,
      configurable: true,
    },
    sessionId: {
      get: () => transport.sessionId,
      enumerable: true,
      configurable: true,
    },
  });

  return adapter;
}

function findExistingTransport(
  sessionId: string | undefined,
  options: McpSessionOptions
): StreamableHTTPServerTransport | null {
  if (!sessionId) {
    return null;
  }

  const existingSession = options.sessionStore.get(sessionId);
  if (!existingSession) {
    return null;
  }

  options.sessionStore.touch(sessionId);
  return existingSession.transport;
}

function shouldInitializeSession(
  sessionId: string | undefined,
  body: McpRequestBody
): boolean {
  return !sessionId && isInitializeRequest(body);
}

async function createAndConnectTransport(
  options: McpSessionOptions,
  res: Response
): Promise<StreamableHTTPServerTransport | null> {
  if (
    !ensureSessionCapacity(
      options.sessionStore,
      options.maxSessions,
      res,
      evictOldestSession
    )
  ) {
    return null;
  }

  if (!reserveSessionSlot(options.sessionStore, options.maxSessions)) {
    respondServerBusy(res);
    return null;
  }

  const { transport, releaseSlot, clearInitTimeout } =
    createTransportForNewSession(options);
  const mcpServer = createMcpServer();
  const transportAdapter = createTransportAdapter(transport);

  try {
    await mcpServer.connect(transportAdapter);
  } catch (error) {
    clearInitTimeout();
    releaseSlot();
    logError(
      'Failed to initialize MCP session',
      error instanceof Error ? error : undefined
    );
    throw error;
  }

  return transport;
}

export async function resolveTransportForPost(
  _req: Request,
  res: Response,
  body: McpRequestBody,
  sessionId: string | undefined,
  options: McpSessionOptions
): Promise<StreamableHTTPServerTransport | null> {
  const existingTransport = findExistingTransport(sessionId, options);
  if (existingTransport) {
    return existingTransport;
  }

  if (!shouldInitializeSession(sessionId, body)) {
    respondBadRequest(res);
    return null;
  }

  evictExpiredSessions(options.sessionStore);
  return createAndConnectTransport(options, res);
}

export function evictExpiredSessions(store: SessionStore): number {
  const evicted = store.evictExpired();
  for (const session of evicted) {
    void session.transport.close().catch((error: unknown) => {
      logWarn('Failed to close expired session', {
        error: getErrorMessage(error),
      });
    });
  }
  return evicted.length;
}

function evictOldestSession(store: SessionStore): boolean {
  const session = store.evictOldest();
  if (!session) return false;
  void session.transport.close().catch((error: unknown) => {
    logWarn('Failed to close evicted session', {
      error: getErrorMessage(error),
    });
  });
  return true;
}
