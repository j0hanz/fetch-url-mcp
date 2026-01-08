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

async function connectTransportOrThrow(
  transport: StreamableHTTPServerTransport,
  clearInitTimeout: () => void,
  releaseSlot: () => void
): Promise<void> {
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
}

async function createAndConnectTransport(
  options: McpSessionOptions,
  res: Response
): Promise<StreamableHTTPServerTransport | null> {
  if (!reserveSessionIfPossible(options, res)) return null;

  const tracker = createSlotTracker();
  const timeoutController = createTimeoutController();
  const transport = createSessionTransport(tracker, timeoutController);

  await connectTransportOrThrow(
    transport,
    timeoutController.clear,
    tracker.releaseSlot
  );

  const sessionId = resolveSessionId(
    transport,
    res,
    tracker,
    timeoutController.clear
  );
  if (!sessionId) return null;

  finalizeSession(options.sessionStore, transport, sessionId, tracker, {
    clearInitTimeout: timeoutController.clear,
  });
  return transport;
}

function reserveSessionIfPossible(
  options: McpSessionOptions,
  res: Response
): boolean {
  if (
    !ensureSessionCapacity(
      options.sessionStore,
      options.maxSessions,
      res,
      evictOldestSession
    )
  ) {
    return false;
  }
  if (!reserveSessionSlot(options.sessionStore, options.maxSessions)) {
    respondServerBusy(res);
    return false;
  }
  return true;
}

function createSessionTransport(
  tracker: SlotTracker,
  timeoutController: ReturnType<typeof createTimeoutController>
): StreamableHTTPServerTransport {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });
  transport.onclose = () => {
    timeoutController.clear();
    if (!tracker.isInitialized()) {
      tracker.releaseSlot();
    }
  };
  timeoutController.set(
    startSessionInitTimeout(
      transport,
      tracker,
      timeoutController.clear,
      config.server.sessionInitTimeoutMs
    )
  );
  return transport;
}

function resolveSessionId(
  transport: StreamableHTTPServerTransport,
  res: Response,
  tracker: SlotTracker,
  clearInitTimeout: () => void
): string | null {
  const { sessionId } = transport;
  if (typeof sessionId !== 'string') {
    clearInitTimeout();
    tracker.releaseSlot();
    respondBadRequest(res);
    return null;
  }
  return sessionId;
}

function finalizeSession(
  store: SessionStore,
  transport: StreamableHTTPServerTransport,
  sessionId: string,
  tracker: SlotTracker,
  { clearInitTimeout }: { clearInitTimeout: () => void }
): void {
  clearInitTimeout();
  tracker.markInitialized();
  tracker.releaseSlot();
  const now = Date.now();
  store.set(sessionId, {
    transport,
    createdAt: now,
    lastSeen: now,
  });
  transport.onclose = () => {
    store.remove(sessionId);
    logInfo('Session closed');
  };
  logInfo('Session initialized');
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
