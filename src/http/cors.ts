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
  return (
    options.allowedOrigins.length > 0 && options.allowedOrigins.includes(origin)
  );
}

function isValidOrigin(origin: string): boolean {
  return URL.canParse(origin);
}

export function createCorsMiddleware(
  options: CorsOptions
): (req: Request, res: Response, next: NextFunction) => void {
  return (req: Request, res: Response, next: NextFunction): void => {
    const { origin } = req.headers;

    if (origin && !isValidOrigin(origin)) {
      next();
      return;
    }

    if (isOriginAllowed(origin, options)) {
      res.header('Access-Control-Allow-Origin', origin ?? '*');
      res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      res.header(
        'Access-Control-Allow-Headers',
        'Content-Type, mcp-session-id, Authorization, X-API-Key'
      );
      res.header('Access-Control-Max-Age', '86400');
    } else if (options.allowedOrigins.length > 0) {
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
