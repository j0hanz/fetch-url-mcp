import { randomUUID } from 'node:crypto';

import type { Request, Response } from 'express';

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

import type { McpRequestBody } from '../config/types.js';

import { logError, logInfo, logWarn } from '../services/logger.js';

import { createMcpServer } from '../server.js';
import { type SessionStore } from './sessions.js';

export interface McpSessionOptions {
  readonly sessionStore: SessionStore;
  readonly maxSessions: number;
}

interface SlotTracker {
  readonly releaseSlot: () => void;
  readonly markInitialized: () => void;
  readonly isInitialized: () => boolean;
}

let inFlightSessions = 0;

function reserveSessionSlot(store: SessionStore, maxSessions: number): boolean {
  if (store.size() + inFlightSessions >= maxSessions) {
    return false;
  }
  inFlightSessions += 1;
  return true;
}

function releaseSessionSlot(): void {
  if (inFlightSessions > 0) {
    inFlightSessions -= 1;
  }
}

function sendJsonRpcError(
  res: Response,
  code: number,
  message: string,
  status = 503
): void {
  res.status(status).json({
    jsonrpc: '2.0',
    error: {
      code,
      message,
    },
    id: null,
  });
}

function respondServerBusy(res: Response): void {
  sendJsonRpcError(res, -32000, 'Server busy: maximum sessions reached', 503);
}

function respondBadRequest(res: Response): void {
  sendJsonRpcError(
    res,
    -32000,
    'Bad Request: Missing session ID or not an initialize request',
    400
  );
}

function isServerAtCapacity(options: McpSessionOptions): boolean {
  const currentSize = options.sessionStore.size();
  return currentSize + inFlightSessions >= options.maxSessions;
}

function tryEvictSlot(options: McpSessionOptions): boolean {
  const currentSize = options.sessionStore.size();
  const canFreeSlot =
    currentSize >= options.maxSessions &&
    currentSize - 1 + inFlightSessions < options.maxSessions;
  return canFreeSlot && evictOldestSession(options.sessionStore);
}

function ensureSessionCapacity(
  options: McpSessionOptions,
  res: Response
): boolean {
  if (!isServerAtCapacity(options)) {
    return true;
  }

  if (tryEvictSlot(options) && !isServerAtCapacity(options)) {
    return true;
  }

  respondServerBusy(res);
  return false;
}

function createSlotTracker(): SlotTracker {
  let slotReleased = false;
  let initialized = false;
  return {
    releaseSlot: (): void => {
      if (slotReleased) return;
      slotReleased = true;
      releaseSessionSlot();
    },
    markInitialized: (): void => {
      initialized = true;
    },
    isInitialized: (): boolean => initialized,
  };
}

function handleSessionInitialized(
  id: string,
  transport: StreamableHTTPServerTransport,
  options: McpSessionOptions,
  tracker: SlotTracker
): void {
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
  tracker: SlotTracker
): void {
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
} {
  const tracker = createSlotTracker();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (id) => {
      handleSessionInitialized(id, transport, options, tracker);
    },
    onsessionclosed: (id) => {
      handleSessionClosed(id, options);
    },
  });

  transport.onclose = () => {
    handleTransportClose(transport, options, tracker);
  };

  return { transport, releaseSlot: tracker.releaseSlot };
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
  if (!ensureSessionCapacity(options, res)) {
    return null;
  }

  if (!reserveSessionSlot(options.sessionStore, options.maxSessions)) {
    respondServerBusy(res);
    return null;
  }

  const { transport, releaseSlot } = createTransportForNewSession(options);
  const mcpServer = createMcpServer();

  try {
    await mcpServer.connect(transport);
  } catch (error) {
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
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    });
  }
  return evicted.length;
}

export function evictOldestSession(store: SessionStore): boolean {
  const session = store.evictOldest();
  if (!session) return false;
  void session.transport.close().catch((error: unknown) => {
    logWarn('Failed to close evicted session', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  });
  return true;
}
