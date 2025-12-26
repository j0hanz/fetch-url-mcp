import { randomUUID } from 'node:crypto';
import { setInterval as setIntervalPromise } from 'node:timers/promises';

import type {
  Express,
  NextFunction,
  Request,
  RequestHandler,
  Response,
} from 'express';

import { config } from '../config/index.js';

import { requestContext } from '../services/context.js';
import { destroyAgents } from '../services/fetcher.js';
import { logError, logInfo, logWarn } from '../services/logger.js';

import { errorHandler } from '../middleware/error-handler.js';

import { createAuthMiddleware } from './auth.js';
import { createCorsMiddleware } from './cors.js';
import { evictExpiredSessions, registerMcpRoutes } from './mcp-routes.js';
import { createRateLimitMiddleware } from './rate-limit.js';
import { createSessionStore, getSessionId } from './sessions.js';

function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

function buildCorsOptions(): {
  allowedOrigins: string[];
  allowAllOrigins: boolean;
} {
  const allowedOrigins = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',').map((o) => o.trim())
    : [];
  const allowAllOrigins = process.env.CORS_ALLOW_ALL === 'true';
  return { allowedOrigins, allowAllOrigins };
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

    requestContext.run({ requestId, sessionId }, () => {
      next();
    });
  };
}

function assertHttpConfiguration(): void {
  if (!config.security.allowRemote && !isLoopbackHost(config.server.host)) {
    logError(
      'Refusing to bind to non-loopback host without ALLOW_REMOTE=true',
      { host: config.server.host }
    );
    process.exit(1);
  }

  if (!config.security.apiKey) {
    logError('API_KEY is required for HTTP mode; refusing to start');
    process.exit(1);
  }
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

function attachBaseMiddleware(
  app: Express,
  jsonParser: RequestHandler,
  rateLimitMiddleware: ReturnType<
    typeof createRateLimitMiddleware
  >['middleware'],
  authMiddleware: ReturnType<typeof createAuthMiddleware>,
  corsOptions: { allowedOrigins: string[]; allowAllOrigins: boolean }
): void {
  app.use(jsonParser);
  app.use(createContextMiddleware());
  app.use(createJsonParseErrorHandler());
  app.use(createCorsMiddleware(corsOptions));
  app.use('/mcp', rateLimitMiddleware);
  app.use(authMiddleware);
  registerHealthRoute(app);
}

function startSessionCleanupLoop(
  store: ReturnType<typeof createSessionStore>,
  sessionTtlMs: number
): AbortController {
  const controller = new AbortController();
  const intervalMs = Math.min(
    Math.max(Math.floor(sessionTtlMs / 2), 10000),
    60000
  );

  void (async () => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of setIntervalPromise(intervalMs, undefined, {
        signal: controller.signal,
        ref: false,
      })) {
        const evicted = evictExpiredSessions(store);
        if (evicted > 0) {
          logInfo('Expired sessions evicted', { evicted });
        }
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        return;
      }
      logWarn('Session cleanup loop failed', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  })();

  return controller;
}

function startListening(app: Express): ReturnType<Express['listen']> {
  return app
    .listen(config.server.port, config.server.host, () => {
      logInfo('superFetch MCP server started', {
        host: config.server.host,
        port: config.server.port,
      });

      process.stdout.write(
        `V superFetch MCP server running at http://${config.server.host}:${config.server.port}\n`
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
}

function createShutdownHandler(
  server: ReturnType<Express['listen']>,
  sessionStore: ReturnType<typeof createSessionStore>,
  sessionCleanupController: AbortController,
  stopRateLimitCleanup: () => void
): (signal: string) => Promise<void> {
  return async (signal: string): Promise<void> => {
    process.stdout.write(`\n${signal} received, shutting down gracefully...\n`);

    stopRateLimitCleanup();
    sessionCleanupController.abort();

    const sessions = sessionStore.clear();
    await Promise.allSettled(
      sessions.map((session) =>
        session.transport.close().catch((error: unknown) => {
          logWarn('Failed to close session during shutdown', {
            error: error instanceof Error ? error.message : 'Unknown error',
          });
        })
      )
    );

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
}

function registerSignalHandlers(
  shutdown: (signal: string) => Promise<void>
): void {
  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
}

export async function startHttpServer(): Promise<{
  shutdown: (signal: string) => Promise<void>;
}> {
  const { default: express } = await import('express');
  const app = express();

  const jsonParser = express.json({ limit: '1mb' });
  const corsOptions = buildCorsOptions();

  const { middleware: rateLimitMiddleware, stop: stopRateLimitCleanup } =
    createRateLimitMiddleware(config.rateLimit);
  const authMiddleware = createAuthMiddleware(config.security.apiKey ?? '');

  attachBaseMiddleware(
    app,
    jsonParser,
    rateLimitMiddleware,
    authMiddleware,
    corsOptions
  );

  assertHttpConfiguration();

  const sessionStore = createSessionStore(config.server.sessionTtlMs);
  const sessionCleanupController = startSessionCleanupLoop(
    sessionStore,
    config.server.sessionTtlMs
  );

  registerMcpRoutes(app, {
    sessionStore,
    maxSessions: config.server.maxSessions,
  });

  app.use(errorHandler);

  const server = startListening(app);
  const shutdown = createShutdownHandler(
    server,
    sessionStore,
    sessionCleanupController,
    stopRateLimitCleanup
  );

  registerSignalHandlers(shutdown);

  return { shutdown };
}
