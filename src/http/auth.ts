import type { NextFunction, Request, Response } from 'express';

import { timingSafeEqualUtf8 } from '../utils/crypto.js';

function normalizeHeaderValue(
  header: string | string[] | undefined
): string | undefined {
  return Array.isArray(header) ? header[0] : header;
}

function timingSafeEquals(a: string, b: string): boolean {
  return timingSafeEqualUtf8(a, b);
}

function isAuthorizedRequest(req: Request, authToken: string): boolean {
  if (!authToken) return false;

  const bearerToken = getBearerToken(req);
  if (bearerToken) {
    return timingSafeEquals(bearerToken, authToken);
  }

  const apiKeyHeader = getApiKeyHeader(req);
  return apiKeyHeader ? timingSafeEquals(apiKeyHeader, authToken) : false;
}

function getBearerToken(req: Request): string | null {
  const authHeader = normalizeHeaderValue(req.headers.authorization);
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.slice('Bearer '.length).trim();
  return token.length > 0 ? token : null;
}

function getApiKeyHeader(req: Request): string | null {
  const apiKeyHeader = normalizeHeaderValue(req.headers['x-api-key']);
  return apiKeyHeader ? apiKeyHeader.trim() : null;
}

export function createAuthMiddleware(
  authToken: string
): (req: Request, res: Response, next: NextFunction) => void {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (isAuthorizedRequest(req, authToken)) {
      next();
      return;
    }

    res.set(
      'WWW-Authenticate',
      'Bearer realm="mcp", error="invalid_token", error_description="Missing or invalid credentials"'
    );
    res.status(401).json({ error: 'Unauthorized' });
  };
}
