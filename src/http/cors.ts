import type { NextFunction, Request, Response } from 'express';

interface CorsOptions {
  readonly allowedOrigins: string[];
  readonly allowAllOrigins: boolean;
}

function isOriginAllowed(
  origin: string | undefined,
  options: CorsOptions
): boolean {
  if (!origin) return true;
  if (options.allowAllOrigins) return true;
  if (options.allowedOrigins.length === 0) return false;
  return options.allowedOrigins.includes(origin);
}

function isValidOrigin(origin: string): boolean {
  return URL.canParse(origin);
}

export function createCorsMiddleware(
  options: CorsOptions
): (req: Request, res: Response, next: NextFunction) => void {
  return (req: Request, res: Response, next: NextFunction): void => {
    const origin = resolveOrigin(req);
    if (shouldSkipInvalidOrigin(origin)) {
      next();
      return;
    }

    if (!applyCorsHeaders(res, origin, options)) {
      next();
      return;
    }

    if (req.method === 'OPTIONS') {
      res.sendStatus(200);
      return;
    }

    next();
  };
}

function resolveOrigin(req: Request): string | undefined {
  return req.headers.origin;
}

function shouldSkipInvalidOrigin(origin: string | undefined): boolean {
  return Boolean(origin && !isValidOrigin(origin));
}

function applyCorsHeaders(
  res: Response,
  origin: string | undefined,
  options: CorsOptions
): boolean {
  if (isOriginAllowed(origin, options)) {
    res.header('Access-Control-Allow-Origin', origin ?? '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.header(
      'Access-Control-Allow-Headers',
      'Content-Type, mcp-session-id, Authorization, X-API-Key'
    );
    res.header('Access-Control-Max-Age', '86400');
    return true;
  }

  return options.allowedOrigins.length === 0;
}
