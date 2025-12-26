import { randomUUID } from 'node:crypto';

import type { Express, NextFunction, Request, Response } from 'express';

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

import type { McpRequestBody } from '../config/types.js';

import { logError, logInfo, logWarn } from '../services/logger.js';

import { createMcpServer } from '../server.js';
import { getSessionId, type SessionStore } from './sessions.js';

interface McpRouteOptions {
  readonly sessionStore: SessionStore;
  readonly maxSessions: number;
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

function respondInvalidRequestBody(res: Response): void {
  sendJsonRpcError(res, -32600, 'Invalid Request: Malformed request body', 400);
}

function isServerAtCapacity(options: McpRouteOptions): boolean {
  const currentSize = options.sessionStore.size();
  return currentSize + inFlightSessions >= options.maxSessions;
}

function tryEvictSlot(options: McpRouteOptions): boolean {
  const currentSize = options.sessionStore.size();
  const canFreeSlot =
    currentSize >= options.maxSessions &&
    currentSize - 1 + inFlightSessions < options.maxSessions;
  return canFreeSlot && evictOldestSession(options.sessionStore);
}

function createTransportForNewSession(options: McpRouteOptions): {
  transport: StreamableHTTPServerTransport;
  releaseSlot: () => void;
} {
  let slotReleased = false;
  const releaseSlot = (): void => {
    if (slotReleased) return;
    slotReleased = true;
    releaseSessionSlot();
  };

  let initialized = false;
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (id) => {
      initialized = true;
      releaseSlot();
      const now = Date.now();
      options.sessionStore.set(id, {
        transport,
        createdAt: now,
        lastSeen: now,
      });
      logInfo('Session initialized', { sessionId: id });
    },
    onsessionclosed: (id) => {
      options.sessionStore.remove(id);
      logInfo('Session closed', { sessionId: id });
    },
  });

  transport.onclose = () => {
    if (!initialized) {
      releaseSlot();
    }
    if (transport.sessionId) {
      options.sessionStore.remove(transport.sessionId);
    }
  };

  return { transport, releaseSlot };
}

function ensureSessionCapacity(
  options: McpRouteOptions,
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

async function resolveTransportForPost(
  req: Request,
  res: Response,
  body: McpRequestBody,
  sessionId: string | undefined,
  options: McpRouteOptions
): Promise<StreamableHTTPServerTransport | null> {
  if (sessionId) {
    const existingSession = options.sessionStore.get(sessionId);
    if (existingSession) {
      options.sessionStore.touch(sessionId);
      return existingSession.transport;
    }
  }

  if (!sessionId && isInitializeRequest(body)) {
    evictExpiredSessions(options.sessionStore);

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

  respondBadRequest(res);
  return null;
}

function isMcpRequestBody(body: unknown): body is McpRequestBody {
  if (!body || typeof body !== 'object') return false;
  const obj = body as Record<string, unknown>;
  return (
    (obj.method === undefined || typeof obj.method === 'string') &&
    (obj.id === undefined ||
      typeof obj.id === 'string' ||
      typeof obj.id === 'number') &&
    (obj.jsonrpc === undefined || obj.jsonrpc === '2.0') &&
    (obj.params === undefined || typeof obj.params === 'object')
  );
}

function evictExpiredSessions(store: SessionStore): number {
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

function evictOldestSession(store: SessionStore): boolean {
  const session = store.evictOldest();
  if (!session) return false;
  void session.transport.close().catch((error: unknown) => {
    logWarn('Failed to close evicted session', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  });
  return true;
}

async function handlePost(
  req: Request,
  res: Response,
  options: McpRouteOptions
): Promise<void> {
  const sessionId = getSessionId(req);
  const { body } = req as { body: unknown };
  if (!isMcpRequestBody(body)) {
    respondInvalidRequestBody(res);
    return;
  }

  const { method, id } = body;

  logInfo('[MCP POST]', {
    method,
    id,
    sessionId: sessionId ?? 'none',
    isInitialize: isInitializeRequest(body),
    sessionCount: options.sessionStore.size(),
  });

  const transport = await resolveTransportForPost(
    req,
    res,
    body,
    sessionId,
    options
  );
  if (!transport) {
    return;
  }

  try {
    await transport.handleRequest(req, res, body);
  } catch (error) {
    logError(
      'MCP request handling failed',
      error instanceof Error ? error : undefined
    );
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal Server Error' });
    }
  }
}

async function handleGet(
  req: Request,
  res: Response,
  options: McpRouteOptions
): Promise<void> {
  const sessionId = getSessionId(req);

  if (!sessionId) {
    res.status(400).json({ error: 'Missing mcp-session-id header' });
    return;
  }

  const session = options.sessionStore.get(sessionId);
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }

  options.sessionStore.touch(sessionId);
  try {
    await session.transport.handleRequest(req, res);
  } catch (error) {
    logError(
      'MCP request handling failed',
      error instanceof Error ? error : undefined
    );
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal Server Error' });
    }
  }
}

async function handleDelete(
  req: Request,
  res: Response,
  options: McpRouteOptions
): Promise<void> {
  const sessionId = getSessionId(req);
  const session = sessionId ? options.sessionStore.get(sessionId) : undefined;

  if (sessionId && session) {
    options.sessionStore.touch(sessionId);
    try {
      await session.transport.handleRequest(req, res);
    } catch (error) {
      logError(
        'MCP request handling failed',
        error instanceof Error ? error : undefined
      );
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal Server Error' });
      }
    }
    return;
  }

  res.status(204).end();
}

export function registerMcpRoutes(
  app: Express,
  options: McpRouteOptions
): void {
  const asyncHandler =
    (fn: (req: Request, res: Response) => Promise<void>) =>
    (req: Request, res: Response, next: NextFunction) => {
      Promise.resolve(fn(req, res)).catch(next);
    };

  app.post(
    '/mcp',
    asyncHandler((req, res) => handlePost(req, res, options))
  );
  app.get(
    '/mcp',
    asyncHandler((req, res) => handleGet(req, res, options))
  );
  app.delete(
    '/mcp',
    asyncHandler((req, res) => handleDelete(req, res, options))
  );
}

export { evictExpiredSessions, evictOldestSession };
