import { randomUUID } from 'node:crypto';

import type { Request, Response } from 'express';

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

import { config } from '../config/index.js';
import type { McpRequestBody } from '../config/types/runtime.js';

import { logError, logInfo, logWarn } from '../services/logger.js';

import { getErrorMessage } from '../utils/error-utils.js';

import { createMcpServer } from '../server.js';
import { sendJsonRpcError } from './jsonrpc-http.js';
import {
  createSlotTracker,
  ensureSessionCapacity,
  reserveSessionSlot,
  respondBadRequest,
  respondServerBusy,
  type SlotTracker,
} from './mcp-session-helpers.js';
import {
  createTimeoutController,
  createTransportAdapter,
} from './mcp-session-transport.js';
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

function createTransportForNewSession(options: McpSessionOptions): {
  transport: StreamableHTTPServerTransport;
  releaseSlot: () => void;
  clearInitTimeout: () => void;
} {
  const tracker = createSlotTracker();
  const timeoutController = createTimeoutController();
  const clearInitTimeout = timeoutController.clear;
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (id) => {
      clearInitTimeout();
      tracker.markInitialized();
      tracker.releaseSlot();
      const now = Date.now();
      options.sessionStore.set(id, {
        transport,
        createdAt: now,
        lastSeen: now,
      });
      logInfo('Session initialized');
    },
    onsessionclosed: (id) => {
      options.sessionStore.remove(id);
      logInfo('Session closed');
    },
  });

  transport.onclose = () => {
    clearInitTimeout();
    if (!tracker.isInitialized()) {
      tracker.releaseSlot();
    }
    if (transport.sessionId) {
      options.sessionStore.remove(transport.sessionId);
    }
  };

  timeoutController.set(
    startSessionInitTimeout(
      transport,
      tracker,
      clearInitTimeout,
      config.server.sessionInitTimeoutMs
    )
  );

  return { transport, releaseSlot: tracker.releaseSlot, clearInitTimeout };
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
    void transport.close().catch((closeError: unknown) => {
      logWarn('Failed to close transport after connect error', {
        error: getErrorMessage(closeError),
      });
    });
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
  if (sessionId) {
    const existingSession = options.sessionStore.get(sessionId);
    if (existingSession) {
      options.sessionStore.touch(sessionId);
      return existingSession.transport;
    }

    // Client supplied a session id but it doesn't exist; Streamable HTTP: invalid session IDs => 404.
    sendJsonRpcError(res, -32600, 'Session not found', 404);
    return null;
  }

  if (!isInitializeRequest(body)) {
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
