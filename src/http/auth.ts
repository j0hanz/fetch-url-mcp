import { timingSafeEqual } from 'node:crypto';

import type { NextFunction, Request, Response } from 'express';

function normalizeHeaderValue(
  header: string | string[] | undefined
): string | undefined {
  return Array.isArray(header) ? header[0] : header;
}

function timingSafeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function isAuthorizedRequest(req: Request, authToken: string): boolean {
  if (!authToken) return false;

  const authHeader = normalizeHeaderValue(req.headers.authorization);
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice('Bearer '.length).trim();
    return token.length > 0 && timingSafeEquals(token, authToken);
  }

  const apiKeyHeader = normalizeHeaderValue(req.headers['x-api-key']);
  if (apiKeyHeader) {
    return timingSafeEquals(apiKeyHeader.trim(), authToken);
  }

  return false;
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
