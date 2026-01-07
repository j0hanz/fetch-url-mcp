import type { Express, NextFunction, Request, Response } from 'express';

import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import type { McpRequestBody } from '../config/types/runtime.js';

import { logError, logInfo } from '../services/logger.js';

import {
  type McpSessionOptions,
  resolveTransportForPost,
} from './mcp-session.js';
import { isJsonRpcBatchRequest, isMcpRequestBody } from './mcp-validation.js';
import { getSessionId } from './sessions.js';

function sendJsonRpcError(
  res: Response,
  code: number,
  message: string,
  status = 400
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

function respondInvalidRequestBody(res: Response): void {
  sendJsonRpcError(res, -32600, 'Invalid Request: Malformed request body', 400);
}

function respondMissingSession(res: Response): void {
  res.status(400).json({ error: 'Missing mcp-session-id header' });
}

function respondSessionNotFound(res: Response): void {
  res.status(404).json({ error: 'Session not found' });
}

function logPostRequest(
  body: McpRequestBody,
  sessionId: string | undefined,
  options: McpSessionOptions
): void {
  logInfo('[MCP POST]', {
    method: body.method,
    id: body.id,
    sessionId: sessionId ?? 'none',
    isInitialize: body.method === 'initialize',
    sessionCount: options.sessionStore.size(),
  });
}

async function handleTransportRequest(
  transport: StreamableHTTPServerTransport,
  req: Request,
  res: Response,
  body?: McpRequestBody
): Promise<void> {
  try {
    await dispatchTransportRequest(transport, req, res, body);
  } catch (error) {
    logError(
      'MCP request handling failed',
      error instanceof Error ? error : undefined
    );
    handleTransportError(res);
  }
}

function handleTransportError(res: Response): void {
  if (res.headersSent) return;
  res.status(500).json({ error: 'Internal Server Error' });
}

function dispatchTransportRequest(
  transport: StreamableHTTPServerTransport,
  req: Request,
  res: Response,
  body?: McpRequestBody
): Promise<void> {
  return body
    ? transport.handleRequest(req, res, body)
    : transport.handleRequest(req, res);
}

function resolveSessionTransport(
  sessionId: string | undefined,
  options: McpSessionOptions,
  res: Response
): StreamableHTTPServerTransport | null {
  if (!sessionId) {
    respondMissingSession(res);
    return null;
  }

  const session = options.sessionStore.get(sessionId);
  if (!session) {
    respondSessionNotFound(res);
    return null;
  }

  options.sessionStore.touch(sessionId);
  return session.transport;
}

async function handlePost(
  req: Request,
  res: Response,
  options: McpSessionOptions
): Promise<void> {
  const sessionId = getSessionId(req);
  const body = req.body as unknown;

  if (isJsonRpcBatchRequest(body)) {
    sendJsonRpcError(res, -32600, 'Batch requests are not supported', 400);
    return;
  }

  if (!isMcpRequestBody(body)) {
    respondInvalidRequestBody(res);
    return;
  }

  logPostRequest(body, sessionId, options);

  const transport = await resolveTransportForPost(
    req,
    res,
    body,
    sessionId,
    options
  );
  if (!transport) return;

  await handleTransportRequest(transport, req, res, body);
}

async function handleGet(
  req: Request,
  res: Response,
  options: McpSessionOptions
): Promise<void> {
  const transport = resolveSessionTransport(getSessionId(req), options, res);
  if (!transport) return;

  await handleTransportRequest(transport, req, res);
}

async function handleDelete(
  req: Request,
  res: Response,
  options: McpSessionOptions
): Promise<void> {
  const transport = resolveSessionTransport(getSessionId(req), options, res);
  if (!transport) return;

  await handleTransportRequest(transport, req, res);
}

export function registerMcpRoutes(
  app: Express,
  options: McpSessionOptions
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

export { evictExpiredSessions } from './mcp-session.js';
