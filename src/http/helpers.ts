import type { AuthInfo } from '@modelcontextprotocol/server';

import type { IncomingMessage, ServerResponse } from 'node:http';

import { type JsonRpcId, sendJsonRpcError } from '../lib/mcp-interop.js';

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export interface RequestContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  method: string | undefined;
  ip: string | null;
  body: unknown;
  signal?: AbortSignal;
}

export interface AuthenticatedContext extends RequestContext {
  auth: AuthInfo;
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

export function setNoStoreHeaders(res: ServerResponse): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
}

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown
): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  setNoStoreHeaders(res);
  res.end(JSON.stringify(body));
}

export function sendEmpty(res: ServerResponse, status: number): void {
  res.statusCode = status;
  res.setHeader('Content-Length', '0');
  res.end();
}

export function sendError(
  res: ServerResponse,
  code: number,
  message: string,
  status = 400,
  id?: JsonRpcId | null
): void {
  sendJsonRpcError(res, status, code, message, id ?? null);
}

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

export function getHeaderValue(
  req: IncomingMessage,
  name: string
): string | null {
  const value = req.headers[name];
  if (!value) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}
