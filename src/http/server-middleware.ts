import { randomUUID } from 'node:crypto';

import type {
  Express,
  NextFunction,
  Request,
  RequestHandler,
  Response,
} from 'express';

import { config } from '../config/index.js';

import { requestContext } from '../services/context.js';

import { getSessionId } from './sessions.js';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

function normalizeHost(value: string): string | null {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return null;

  const first = trimmed.split(',')[0]?.trim();
  if (!first) return null;

  if (first.startsWith('[')) {
    const end = first.indexOf(']');
    if (end === -1) return null;
    return first.slice(1, end);
  }

  const colonIndex = first.indexOf(':');
  if (colonIndex !== -1) {
    return first.slice(0, colonIndex);
  }

  return first;
}

function buildAllowedHosts(): Set<string> {
  const allowedHosts = new Set<string>();
  const raw = process.env.ALLOWED_HOSTS ?? '';

  for (const entry of raw.split(',')) {
    const normalized = normalizeHost(entry);
    if (normalized) {
      allowedHosts.add(normalized);
    }
  }

  for (const host of LOOPBACK_HOSTS) {
    allowedHosts.add(host);
  }

  const configuredHost = normalizeHost(config.server.host);
  if (
    configuredHost &&
    configuredHost !== '0.0.0.0' &&
    configuredHost !== '::'
  ) {
    allowedHosts.add(configuredHost);
  }

  return allowedHosts;
}

export function createHostValidationMiddleware(): RequestHandler {
  const allowedHosts = buildAllowedHosts();

  return (req: Request, res: Response, next: NextFunction): void => {
    const hostHeader =
      typeof req.headers.host === 'string' ? req.headers.host : '';

    const normalized = normalizeHost(hostHeader);

    if (!normalized || !allowedHosts.has(normalized)) {
      res.status(403).json({
        error: 'Host not allowed',
        code: 'HOST_NOT_ALLOWED',
      });
      return;
    }

    next();
  };
}

export function buildCorsOptions(): {
  allowedOrigins: string[];
  allowAllOrigins: boolean;
} {
  const allowedOrigins = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',').map((o) => o.trim())
    : [];
  const allowAllOrigins = process.env.CORS_ALLOW_ALL === 'true';
  return { allowedOrigins, allowAllOrigins };
}

export function createJsonParseErrorHandler(): (
  err: Error,
  _req: Request,
  res: Response,
  next: NextFunction
) => void {
  return (
    err: Error,
    _req: Request,
    res: Response,
    next: NextFunction
  ): void => {
    if (err instanceof SyntaxError && 'body' in err) {
      res.status(400).json({
        jsonrpc: '2.0',
        error: {
          code: -32700,
          message: 'Parse error: Invalid JSON',
        },
        id: null,
      });
      return;
    }
    next();
  };
}

export function createContextMiddleware(): (
  req: Request,
  _res: Response,
  next: NextFunction
) => void {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const requestId = randomUUID();
    const sessionId = getSessionId(req);

    requestContext.run({ requestId, sessionId }, () => {
      next();
    });
  };
}

export function registerHealthRoute(app: Express): void {
  app.get('/health', (_req, res) => {
    res.json({
      status: 'healthy',
      name: config.server.name,
      version: config.server.version,
      uptime: process.uptime(),
    });
  });
}

export function attachBaseMiddleware(
  app: Express,
  jsonParser: RequestHandler,
  rateLimitMiddleware: RequestHandler,
  authMiddleware: RequestHandler,
  corsMiddleware: RequestHandler
): void {
  app.use(createHostValidationMiddleware());
  app.use(jsonParser);
  app.use(createContextMiddleware());
  app.use(createJsonParseErrorHandler());
  app.use(corsMiddleware);
  app.use('/mcp', rateLimitMiddleware);
  app.use(authMiddleware);
  registerHealthRoute(app);
}
