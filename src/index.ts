#!/usr/bin/env node
import { randomUUID, timingSafeEqual } from 'node:crypto';

import type { NextFunction, Request, Response } from 'express';

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

import { config } from './config/index.js';
import type {
  McpRequestBody,
  RateLimitEntry,
  SessionEntry,
} from './config/types.js';

import { requestContext } from './services/context.js';
import { destroyAgents } from './services/fetcher.js';
import { logError, logInfo, logWarn } from './services/logger.js';

import { errorHandler } from './middleware/error-handler.js';

import { createMcpServer } from './server.js';

let isShuttingDown = false;

const shutdownHandlerRef: { current?: (signal: string) => Promise<void> } = {};

process.on('uncaughtException', (error) => {
  logError('Uncaught exception', error);
  process.stderr.write(`Uncaught exception: ${error.message}\n`);

  if (!isShuttingDown && !isStdioMode && shutdownHandlerRef.current) {
    isShuttingDown = true;
    // Attempt graceful cleanup before exit
    process.stderr.write('Attempting graceful shutdown...\n');
    void shutdownHandlerRef.current('UNCAUGHT_EXCEPTION');
  } else {
    process.exit(1);
  }
});

process.on('unhandledRejection', (reason) => {
  const error = reason instanceof Error ? reason : new Error(String(reason));
  logError('Unhandled rejection', error);
  process.stderr.write(`Unhandled rejection: ${error.message}\n`);
});

const isStdioMode = process.argv.includes('--stdio');

const ALLOWED_ORIGINS: string[] = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map((o) => o.trim())
  : [];

const ALLOW_ALL_ORIGINS = process.env.CORS_ALLOW_ALL === 'true';
const AUTH_TOKEN = config.security.apiKey;
const ALLOW_REMOTE = config.security.allowRemote;

function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

function normalizeHeaderValue(
  header: string | string[] | undefined
): string | undefined {
  return Array.isArray(header) ? header[0] : header;
}

function timingSafeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function isAuthorizedRequest(req: Request): boolean {
  if (!AUTH_TOKEN) return false;

  const authHeader = normalizeHeaderValue(req.headers.authorization);
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice('Bearer '.length).trim();
    return token.length > 0 && timingSafeEquals(token, AUTH_TOKEN);
  }

  const apiKeyHeader = normalizeHeaderValue(req.headers['x-api-key']);
  if (apiKeyHeader) {
    return timingSafeEquals(apiKeyHeader.trim(), AUTH_TOKEN);
  }

  return false;
}

function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (isAuthorizedRequest(req)) {
    next();
    return;
  }

  res.set(
    'WWW-Authenticate',
    'Bearer realm="mcp", error="invalid_token", error_description="Missing or invalid credentials"'
  );
  res.status(401).json({ error: 'Unauthorized' });
}

function getSessionId(req: Request): string | undefined {
  const header = req.headers['mcp-session-id'];
  return Array.isArray(header) ? header[0] : header;
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

const asyncHandler = (
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>
) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};

if (isStdioMode) {
  const { startStdioServer } = await import('./server.js');
  await startStdioServer();
} else {
  const { default: express } = await import('express');
  const app = express();

  app.use(express.json({ limit: '1mb' }));

  // Context middleware
  app.use((req, res, next) => {
    const requestId = randomUUID();
    const sessionId = getSessionId(req);

    requestContext.run({ requestId, sessionId }, () => {
      next();
    });
  });

  app.use(
    (err: Error, _req: Request, res: Response, next: NextFunction): void => {
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
      next(err);
    }
  );

  app.use((req, res, next) => {
    const { origin } = req.headers;

    if (origin) {
      try {
        new URL(origin);
      } catch {
        next();
        return;
      }
    }

    if (
      !origin ||
      ALLOW_ALL_ORIGINS ||
      (ALLOWED_ORIGINS.length > 0 && ALLOWED_ORIGINS.includes(origin))
    ) {
      res.header('Access-Control-Allow-Origin', origin ?? '*');
      res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      res.header(
        'Access-Control-Allow-Headers',
        'Content-Type, mcp-session-id, Authorization, X-API-Key'
      );
      res.header('Access-Control-Max-Age', '86400');
    } else if (ALLOWED_ORIGINS.length > 0) {
      // Origin not in allowlist
      next();
      return;
    }

    if (req.method === 'OPTIONS') {
      res.sendStatus(200);
      return;
    }
    next();
  });

  const rateLimitStore = new Map<string, RateLimitEntry>();
  const { rateLimit } = config;

  const getRateLimitKey = (req: Request): string => {
    return req.ip ?? req.socket.remoteAddress ?? 'unknown';
  };

  const rateLimitCleanup = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of rateLimitStore.entries()) {
      if (now - entry.lastAccessed > rateLimit.windowMs * 2) {
        rateLimitStore.delete(key);
      }
    }
  }, rateLimit.cleanupIntervalMs);
  rateLimitCleanup.unref();

  const rateLimitMiddleware = (
    req: Request,
    res: Response,
    next: NextFunction
  ): void => {
    if (!rateLimit.enabled || req.method === 'OPTIONS') {
      next();
      return;
    }

    const now = Date.now();
    const key = getRateLimitKey(req);
    const existing = rateLimitStore.get(key);

    if (!existing || now > existing.resetTime) {
      rateLimitStore.set(key, {
        count: 1,
        resetTime: now + rateLimit.windowMs,
        lastAccessed: now,
      });
      next();
      return;
    }

    existing.count += 1;
    existing.lastAccessed = now;

    if (existing.count > rateLimit.maxRequests) {
      const retryAfter = Math.max(
        1,
        Math.ceil((existing.resetTime - now) / 1000)
      );
      res.set('Retry-After', String(retryAfter));
      res.status(429).json({
        error: 'Rate limit exceeded',
        retryAfter,
      });
      return;
    }

    next();
  };

  app.get('/health', authMiddleware, (_req, res) => {
    res.json({
      status: 'healthy',
      name: config.server.name,
      version: config.server.version,
      uptime: process.uptime(),
    });
  });

  if (!ALLOW_REMOTE && !isLoopbackHost(config.server.host)) {
    logError(
      'Refusing to bind to non-loopback host without ALLOW_REMOTE=true',
      { host: config.server.host }
    );
    process.exit(1);
  }

  if (!AUTH_TOKEN) {
    logError('API_KEY is required for HTTP mode; refusing to start');
    process.exit(1);
  }

  // Simple session storage - Map suffices for debugging HTTP mode
  const sessions = new Map<string, SessionEntry>();
  const { sessionTtlMs, maxSessions } = config.server;

  const evictExpiredSessions = (): number => {
    const now = Date.now();
    let evicted = 0;

    for (const [id, session] of sessions.entries()) {
      if (now - session.lastSeen > sessionTtlMs) {
        sessions.delete(id);
        evicted += 1;
        session.transport.close().catch((error: unknown) => {
          logWarn('Failed to close expired session', {
            sessionId: id,
            error: error instanceof Error ? error.message : 'Unknown error',
          });
        });
      }
    }

    return evicted;
  };

  const evictOldestSession = (): boolean => {
    let oldestId: string | undefined;
    let oldestSeen = Number.POSITIVE_INFINITY;

    for (const [id, session] of sessions.entries()) {
      if (session.lastSeen < oldestSeen) {
        oldestSeen = session.lastSeen;
        oldestId = id;
      }
    }

    if (!oldestId) return false;

    const session = sessions.get(oldestId);
    sessions.delete(oldestId);
    session?.transport.close().catch((error: unknown) => {
      logWarn('Failed to close evicted session', {
        sessionId: oldestId,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    });

    return true;
  };

  const sessionCleanupInterval = setInterval(
    () => {
      const evicted = evictExpiredSessions();
      if (evicted > 0) {
        logInfo('Expired sessions evicted', { evicted });
      }
    },
    Math.min(Math.max(Math.floor(sessionTtlMs / 2), 10000), 60000)
  );
  sessionCleanupInterval.unref();

  app.use('/mcp', rateLimitMiddleware);
  app.use(authMiddleware);

  app.post(
    '/mcp',
    asyncHandler(async (req: Request, res: Response) => {
      const sessionId = getSessionId(req);
      let transport: StreamableHTTPServerTransport;

      // Validate request body structure
      if (!isMcpRequestBody(req.body)) {
        res.status(400).json({
          jsonrpc: '2.0',
          error: {
            code: -32600,
            message: 'Invalid Request: Malformed request body',
          },
          id: null,
        });
        return;
      }

      // Body is validated above as McpRequestBody via type guard
      logInfo('[MCP POST]', {
        method: req.body.method,
        id: req.body.id,
        sessionId: sessionId ?? 'none',
        isInitialize: isInitializeRequest(req.body),
        sessionCount: sessions.size,
      });

      const existingSession = sessionId ? sessions.get(sessionId) : undefined;
      if (existingSession && sessionId) {
        existingSession.lastSeen = Date.now();
        ({ transport } = existingSession);
      } else if (!sessionId && isInitializeRequest(req.body)) {
        evictExpiredSessions();

        if (sessions.size >= maxSessions && !evictOldestSession()) {
          res.status(503).json({
            jsonrpc: '2.0',
            error: {
              code: -32000,
              message: 'Server busy: maximum sessions reached',
            },
            id: null,
          });
          return;
        }

        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            const now = Date.now();
            sessions.set(id, { transport, createdAt: now, lastSeen: now });
            logInfo('Session initialized', { sessionId: id });
          },
          onsessionclosed: (id) => {
            sessions.delete(id);
            logInfo('Session closed', { sessionId: id });
          },
        });

        transport.onclose = () => {
          if (transport.sessionId) {
            sessions.delete(transport.sessionId);
          }
        };

        const mcpServer = createMcpServer();
        await mcpServer.connect(transport);
      } else {
        res.status(400).json({
          jsonrpc: '2.0',
          error: {
            code: -32000,
            message:
              'Bad Request: Missing session ID or not an initialize request',
          },
          id: null,
        });
        return;
      }

      await transport.handleRequest(req, res, req.body);
    })
  );

  app.get(
    '/mcp',
    asyncHandler(async (req: Request, res: Response) => {
      const sessionId = getSessionId(req);

      if (!sessionId) {
        res.status(400).json({ error: 'Missing mcp-session-id header' });
        return;
      }

      const session = sessionId ? sessions.get(sessionId) : undefined;
      if (!session) {
        res.status(404).json({ error: 'Session not found' });
        return;
      }

      session.lastSeen = Date.now();
      await session.transport.handleRequest(req, res);
    })
  );

  app.delete(
    '/mcp',
    asyncHandler(async (req: Request, res: Response) => {
      const sessionId = getSessionId(req);
      const session = sessionId ? sessions.get(sessionId) : undefined;

      if (session) {
        session.lastSeen = Date.now();
        await session.transport.handleRequest(req, res);
      } else {
        res.status(204).end();
      }
    })
  );

  app.use(errorHandler);

  const server = app
    .listen(config.server.port, config.server.host, () => {
      logInfo(`superFetch MCP server started`, {
        host: config.server.host,
        port: config.server.port,
      });

      process.stdout.write(
        `✓ superFetch MCP server running at http://${config.server.host}:${config.server.port}\n`
      );
      process.stdout.write(
        `  Health check: http://${config.server.host}:${config.server.port}/health\n`
      );
      process.stdout.write(
        `  MCP endpoint: http://${config.server.host}:${config.server.port}/mcp\n`
      );
      process.stdout.write(
        `\nRun with --stdio flag for direct stdio integration\n`
      );
    })
    .on('error', (err) => {
      logError('Failed to start server', err);
      process.exit(1);
    });

  const shutdownFn = async (signal: string): Promise<void> => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    process.stdout.write(`\n${signal} received, shutting down gracefully...\n`);

    // Close all sessions
    const closePromises = Array.from(sessions.values()).map((session) =>
      session.transport.close()
    );
    await Promise.allSettled(closePromises);
    sessions.clear();

    destroyAgents();

    server.close(() => {
      logInfo('HTTP server closed');
      process.exit(0);
    });

    setTimeout(() => {
      logError('Forced shutdown after timeout');
      process.exit(1);
    }, 10000).unref();
  };

  shutdownHandlerRef.current = shutdownFn;

  process.on('SIGINT', () => {
    void shutdownFn('SIGINT');
  });
  process.on('SIGTERM', () => {
    void shutdownFn('SIGTERM');
  });
}
