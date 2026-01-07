import { randomUUID } from 'node:crypto';

import type {
  Express,
  NextFunction,
  Request,
  RequestHandler,
  Response,
} from 'express';

import { config } from '../config/index.js';

import { runWithRequestContext } from '../services/context.js';

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

  // Always allow loopback
  for (const host of LOOPBACK_HOSTS) {
    allowedHosts.add(host);
  }

  // Allow the configured host (unless it's a wildcard)
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

function createHostValidationMiddleware(): RequestHandler {
  const allowedHosts = buildAllowedHosts();
  const isWildcard =
    config.server.host === '0.0.0.0' || config.server.host === '::';

  return (req: Request, res: Response, next: NextFunction): void => {
    // Skip validation for wildcard bindings (user takes responsibility)
    if (isWildcard) {
      next();
      return;
    }

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

function createJsonParseErrorHandler(): (
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

function createContextMiddleware(): (
  req: Request,
  _res: Response,
  next: NextFunction
) => void {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const requestId = randomUUID();
    const sessionId = getSessionId(req);

    const context =
      sessionId === undefined ? { requestId } : { requestId, sessionId };

    runWithRequestContext(context, () => {
      next();
    });
  };
}

function registerHealthRoute(app: Express): void {
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
