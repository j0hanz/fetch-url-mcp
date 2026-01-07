import { styleText } from 'node:util';

import type { Express, RequestHandler } from 'express';

import { config, enableHttpMode } from '../config/index.js';

import { destroyAgents } from '../services/fetcher/agents.js';
import { logError, logInfo, logWarn } from '../services/logger.js';

import { errorHandler } from '../middleware/error-handler.js';

import { getErrorMessage } from '../utils/error-utils.js';

import { createAuthMiddleware } from './auth.js';
import { createCorsMiddleware } from './cors.js';
import { registerDownloadRoutes } from './download-routes.js';
import { registerMcpRoutes } from './mcp-routes.js';
import { createRateLimitMiddleware } from './rate-limit.js';
import { attachBaseMiddleware } from './server-middleware.js';
import { startSessionCleanupLoop } from './session-cleanup.js';
import { createSessionStore } from './sessions.js';

function assertHttpConfiguration(): void {
  const isLoopback = ['127.0.0.1', '::1', 'localhost'].includes(
    config.server.host
  );
  if (!config.security.allowRemote && !isLoopback) {
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

function startListening(app: Express): ReturnType<Express['listen']> {
  return app
    .listen(config.server.port, config.server.host, () => {
      logInfo('superFetch MCP server started', {
        host: config.server.host,
        port: config.server.port,
      });

      const baseUrl = `http://${config.server.host}:${config.server.port}`;
      process.stdout.write(
        `${styleText('green', 'V')} superFetch MCP server running at ${styleText('cyan', baseUrl)}\n` +
          `  Health check: ${styleText('dim', `${baseUrl}/health`)}\n` +
          `  MCP endpoint: ${styleText('dim', `${baseUrl}/mcp`)}\n` +
          `\n${styleText('dim', 'Run with --stdio flag for direct stdio integration')}\n`
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
    process.stdout.write(
      `\n${styleText('yellow', signal)} received, shutting down gracefully...\n`
    );

    stopRateLimitCleanup();
    sessionCleanupController.abort();

    const sessions = sessionStore.clear();
    await Promise.allSettled(
      sessions.map((session) =>
        session.transport.close().catch((error: unknown) => {
          logWarn('Failed to close session during shutdown', {
            error: getErrorMessage(error),
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

function buildMiddleware(): {
  rateLimitMiddleware: RequestHandler;
  stopRateLimitCleanup: () => void;
  authMiddleware: RequestHandler;
  corsMiddleware: RequestHandler;
} {
  const { middleware: rateLimitMiddleware, stop: stopRateLimitCleanup } =
    createRateLimitMiddleware(config.rateLimit);
  const authMiddleware = createAuthMiddleware(config.security.apiKey ?? '');
  // No CORS - MCP clients don't run in browsers
  const corsMiddleware = createCorsMiddleware();

  return {
    rateLimitMiddleware,
    stopRateLimitCleanup,
    authMiddleware,
    corsMiddleware,
  };
}

function createSessionInfrastructure(): {
  sessionStore: ReturnType<typeof createSessionStore>;
  sessionCleanupController: AbortController;
} {
  const sessionStore = createSessionStore(config.server.sessionTtlMs);
  const sessionCleanupController = startSessionCleanupLoop(
    sessionStore,
    config.server.sessionTtlMs
  );
  return { sessionStore, sessionCleanupController };
}

function registerHttpRoutes(
  app: Express,
  sessionStore: ReturnType<typeof createSessionStore>
): void {
  registerMcpRoutes(app, {
    sessionStore,
    maxSessions: config.server.maxSessions,
  });
  registerDownloadRoutes(app);
  app.use(errorHandler);
}

export async function startHttpServer(): Promise<{
  shutdown: (signal: string) => Promise<void>;
}> {
  enableHttpMode();

  const { app, jsonParser } = await createExpressApp();
  const {
    rateLimitMiddleware,
    stopRateLimitCleanup,
    authMiddleware,
    corsMiddleware,
  } = buildMiddleware();

  attachBaseMiddleware(
    app,
    jsonParser,
    rateLimitMiddleware,
    authMiddleware,
    corsMiddleware
  );
  assertHttpConfiguration();

  const { sessionStore, sessionCleanupController } =
    createSessionInfrastructure();
  registerHttpRoutes(app, sessionStore);

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

async function createExpressApp(): Promise<{
  app: Express;
  jsonParser: RequestHandler;
}> {
  const { default: express } = await import('express');
  const app = express();
  const jsonParser = express.json({ limit: '1mb' });
  return { app, jsonParser };
}
