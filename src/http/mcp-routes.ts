import type { Express, Request, Response } from 'express';

import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import type { McpRequestBody } from '../config/types/runtime.js';

import { logError, logInfo } from '../services/logger.js';

import { acceptsEventStream, ensurePostAcceptHeader } from './accept-policy.js';
import { wrapAsync } from './async-handler.js';
import { sendJsonRpcError } from './jsonrpc-http.js';
import {
  type McpSessionOptions,
  resolveTransportForPost,
} from './mcp-session.js';
import { isJsonRpcBatchRequest, isMcpRequestBody } from './mcp-validation.js';
import { ensureMcpProtocolVersionHeader } from './protocol-policy.js';
import { getSessionId } from './sessions.js';

type RequestWithUnknownBody = Omit<Request, 'body'> & { body: unknown };

function respondInvalidRequestBody(res: Response): void {
  sendJsonRpcError(res, -32600, 'Invalid Request: Malformed request body', 400);
}

function respondMissingSession(res: Response): void {
  sendJsonRpcError(res, -32600, 'Missing mcp-session-id header', 400);
}

function respondSessionNotFound(res: Response): void {
  sendJsonRpcError(res, -32600, 'Session not found', 404);
}

function validatePostPayload(
  payload: unknown,
  res: Response
): McpRequestBody | null {
  if (isJsonRpcBatchRequest(payload)) {
    sendJsonRpcError(res, -32600, 'Batch requests are not supported', 400);
    return null;
  }

  if (!isMcpRequestBody(payload)) {
    respondInvalidRequestBody(res);
    return null;
  }

  return payload;
}

function logPostRequest(
  body: McpRequestBody,
  sessionId: string | undefined,
  options: McpSessionOptions
): void {
  logInfo('[MCP POST]', {
    method: body.method,
    id: body.id,
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
  const { sessionStore } = options;

  if (!sessionId) {
    respondMissingSession(res);
    return null;
  }

  const session = sessionStore.get(sessionId);
  if (!session) {
    respondSessionNotFound(res);
    return null;
  }

  sessionStore.touch(sessionId);
  return session.transport;
}

async function handlePost(
  req: RequestWithUnknownBody,
  res: Response,
  options: McpSessionOptions
): Promise<void> {
  ensurePostAcceptHeader(req);
  if (!ensureMcpProtocolVersionHeader(req, res)) return;

  const sessionId = getSessionId(req);
  const payload = validatePostPayload(req.body, res);
  if (!payload) return;

  logPostRequest(payload, sessionId, options);

  const transport = await resolveTransportForPost(
    req,
    res,
    payload,
    sessionId,
    options
  );
  if (!transport) return;

  await handleTransportRequest(transport, req, res, payload);
}

async function handleGet(
  req: Request,
  res: Response,
  options: McpSessionOptions
): Promise<void> {
  if (!ensureMcpProtocolVersionHeader(req, res)) return;
  if (!acceptsEventStream(req)) {
    res.status(406).json({
      error: 'Not Acceptable',
      code: 'ACCEPT_NOT_SUPPORTED',
    });
    return;
  }

  const transport = resolveSessionTransport(getSessionId(req), options, res);
  if (!transport) return;

  await handleTransportRequest(transport, req, res);
}

async function handleDelete(
  req: Request,
  res: Response,
  options: McpSessionOptions
): Promise<void> {
  if (!ensureMcpProtocolVersionHeader(req, res)) return;

  const transport = resolveSessionTransport(getSessionId(req), options, res);
  if (!transport) return;

  await handleTransportRequest(transport, req, res);
}

export function registerMcpRoutes(
  app: Express,
  options: McpSessionOptions
): void {
  app.post(
    '/mcp',
    wrapAsync((req, res) => handlePost(req, res, options))
  );
  app.get(
    '/mcp',
    wrapAsync((req, res) => handleGet(req, res, options))
  );
  app.delete(
    '/mcp',
    wrapAsync((req, res) => handleDelete(req, res, options))
  );
}
