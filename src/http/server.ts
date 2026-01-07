import type { Express, RequestHandler } from 'express';

import { config, enableHttpMode } from '../config/index.js';

import { logError, logInfo } from '../services/logger.js';

import { errorHandler } from '../middleware/error-handler.js';

import { createAuthMetadataRouter, createAuthMiddleware } from './auth.js';
import { createCorsMiddleware } from './cors.js';
import { registerDownloadRoutes } from './download-routes.js';
import { registerMcpRoutes } from './mcp-routes.js';
import { createRateLimitMiddleware } from './rate-limit.js';
import { assertHttpConfiguration } from './server-config.js';
import { attachBaseMiddleware } from './server-middleware.js';
import {
  createShutdownHandler,
  registerSignalHandlers,
} from './server-shutdown.js';
import { startSessionCleanupLoop } from './session-cleanup.js';
import { createSessionStore } from './sessions.js';

function startListening(app: Express): ReturnType<Express['listen']> {
  return app
    .listen(config.server.port, config.server.host, () => {
      logInfo('superFetch MCP server started', {
        host: config.server.host,
        port: config.server.port,
      });

      const baseUrl = `http://${config.server.host}:${config.server.port}`;
      logInfo(
        `superFetch MCP server running at ${baseUrl} (health: ${baseUrl}/health, mcp: ${baseUrl}/mcp)`
      );
      logInfo('Run with --stdio flag for direct stdio integration');
    })
    .on('error', (err) => {
      logError('Failed to start server', err);
      process.exit(1);
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
  const authMiddleware = createAuthMiddleware();
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
  sessionStore: ReturnType<typeof createSessionStore>,
  authMiddleware: RequestHandler
): void {
  app.use('/mcp', authMiddleware);
  app.use('/mcp/downloads', authMiddleware);
  registerMcpRoutes(app, {
    sessionStore,
    maxSessions: config.server.maxSessions,
  });
  registerDownloadRoutes(app);
  app.use(errorHandler);
}

function attachAuthMetadata(app: Express): void {
  const authMetadataRouter = createAuthMetadataRouter();
  if (authMetadataRouter) {
    app.use(authMetadataRouter);
  }
}

async function buildServerContext(): Promise<{
  app: Express;
  sessionStore: ReturnType<typeof createSessionStore>;
  sessionCleanupController: AbortController;
  stopRateLimitCleanup: () => void;
}> {
  const { app, authMiddleware, stopRateLimitCleanup } =
    await createAppWithMiddleware();
  const { sessionStore, sessionCleanupController } = attachSessionRoutes(
    app,
    authMiddleware
  );
  return { app, sessionStore, sessionCleanupController, stopRateLimitCleanup };
}

async function createAppWithMiddleware(): Promise<{
  app: Express;
  authMiddleware: RequestHandler;
  stopRateLimitCleanup: () => void;
}> {
  const { app, jsonParser } = await createExpressApp();
  const {
    rateLimitMiddleware,
    stopRateLimitCleanup,
    authMiddleware,
    corsMiddleware,
  } = buildMiddleware();

  attachBaseMiddleware(app, jsonParser, rateLimitMiddleware, corsMiddleware);
  attachAuthMetadata(app);
  assertHttpConfiguration();

  return { app, authMiddleware, stopRateLimitCleanup };
}

function attachSessionRoutes(
  app: Express,
  authMiddleware: RequestHandler
): {
  sessionStore: ReturnType<typeof createSessionStore>;
  sessionCleanupController: AbortController;
} {
  const { sessionStore, sessionCleanupController } =
    createSessionInfrastructure();
  registerHttpRoutes(app, sessionStore, authMiddleware);
  return { sessionStore, sessionCleanupController };
}

export async function startHttpServer(): Promise<{
  shutdown: (signal: string) => Promise<void>;
}> {
  enableHttpMode();
  const { app, sessionStore, sessionCleanupController, stopRateLimitCleanup } =
    await buildServerContext();
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
