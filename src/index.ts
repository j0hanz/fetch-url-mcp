#!/usr/bin/env node
import express, {
  type Request,
  type Response,
  type NextFunction,
} from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { config } from './config/index.js';
import { createMcpServer } from './server.js';
import { errorHandler } from './middleware/error-handler.js';
import { rateLimiter } from './middleware/rate-limiter.js';
import { logInfo, logError } from './services/logger.js';
import { destroyAgents } from './services/fetcher.js';

// Global error handlers for uncaught exceptions and rejections
process.on('uncaughtException', (error) => {
  logError('Uncaught exception', error);
  process.stderr.write(`Uncaught exception: ${error.message}\n`);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  const error = reason instanceof Error ? reason : new Error(String(reason));
  logError('Unhandled rejection', error);
  process.stderr.write(`Unhandled rejection: ${error.message}\n`);
});

// Check if running in stdio mode
const isStdioMode = process.argv.includes('--stdio');

// CORS allowlist - empty means allow all origins
// For production, configure this in the CORS middleware below
const ALLOWED_ORIGINS: string[] = [];

/**
 * Async error wrapper for Express route handlers
 * Catches promise rejections and forwards to error middleware
 */
const asyncHandler = (
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>
) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};

if (isStdioMode) {
  // Run in stdio mode for direct integration
  const { startStdioServer } = await import('./server.js');
  await startStdioServer();
} else {
  // Run HTTP server mode
  const app = express();

  // Middleware
  // Limit request body size to prevent DoS
  app.use(express.json({ limit: '1mb' }));

  // Handle JSON parsing errors
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

  // Rate limiting for HTTP mode
  app.use(rateLimiter.middleware());

  // CORS headers for MCP clients
  app.use((req, res, next) => {
    const origin = req.headers.origin;

    // Validate origin format if provided
    if (origin) {
      try {
        new URL(origin);
      } catch {
        // Invalid origin format - skip CORS headers
        next();
        return;
      }
    }

    // Allow if no origin (same-origin/non-browser), no allowlist configured, or origin in allowlist
    if (
      !origin ||
      ALLOWED_ORIGINS.length === 0 ||
      ALLOWED_ORIGINS.includes(origin)
    ) {
      res.header('Access-Control-Allow-Origin', origin ?? '*');
      res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      res.header(
        'Access-Control-Allow-Headers',
        'Content-Type, mcp-session-id'
      );
      res.header('Access-Control-Max-Age', '86400'); // Cache preflight for 24 hours
    }

    if (req.method === 'OPTIONS') {
      res.sendStatus(200);
      return;
    }
    next();
  });

  // Health check endpoint
  app.get('/health', (_req, res) => {
    res.json({
      status: 'healthy',
      name: config.server.name,
      version: config.server.version,
      uptime: process.uptime(),
    });
  });

  // Session management for Streamable HTTP transport
  // Store transports by session ID with creation timestamp for TTL cleanup
  interface SessionEntry {
    transport: StreamableHTTPServerTransport;
    createdAt: number;
  }
  const sessions = new Map<string, SessionEntry>();

  // Session TTL: 30 minutes (sessions without activity will be cleaned up)
  const SESSION_TTL_MS = 30 * 60 * 1000;

  // Cleanup stale sessions periodically (every 5 minutes)
  const sessionCleanupInterval = setInterval(
    () => {
      const now = Date.now();
      for (const [sessionId, entry] of sessions) {
        if (now - entry.createdAt > SESSION_TTL_MS) {
          logInfo('Cleaning up stale session', { sessionId });
          void entry.transport.close();
          sessions.delete(sessionId);
        }
      }
    },
    5 * 60 * 1000
  );
  sessionCleanupInterval.unref();

  // MCP Streamable HTTP endpoint (modern replacement for SSE)
  app.post(
    '/mcp',
    asyncHandler(async (req: Request, res: Response) => {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      let transport: StreamableHTTPServerTransport;

      // Debug logging
      const body = req.body as
        | { method?: string; id?: string | number }
        | undefined;
      logInfo('[MCP POST]', {
        method: body?.method,
        id: body?.id,
        sessionId: sessionId ?? 'none',
        isInitialize: isInitializeRequest(req.body),
        sessionCount: sessions.size,
      });

      const existingSession = sessionId ? sessions.get(sessionId) : undefined;
      if (existingSession) {
        // Reuse existing session and update timestamp
        transport = existingSession.transport;
        existingSession.createdAt = Date.now(); // Refresh TTL on activity
      } else if (!sessionId && isInitializeRequest(req.body)) {
        // New session initialization
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => crypto.randomUUID(),
          onsessioninitialized: (id) => {
            sessions.set(id, { transport, createdAt: Date.now() });
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
        // Invalid request - no session and not an initialize request
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

  // GET endpoint for SSE stream (for server-initiated messages)
  app.get(
    '/mcp',
    asyncHandler(async (req: Request, res: Response) => {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;

      if (!sessionId) {
        res.status(400).json({ error: 'Missing mcp-session-id header' });
        return;
      }

      const session = sessions.get(sessionId);
      if (!session) {
        res.status(404).json({ error: 'Session not found' });
        return;
      }

      // Refresh TTL on activity
      session.createdAt = Date.now();

      // Handle SSE stream for server-initiated messages
      await session.transport.handleRequest(req, res);
    })
  );

  // DELETE endpoint for session cleanup
  app.delete(
    '/mcp',
    asyncHandler(async (req: Request, res: Response) => {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      const session = sessionId ? sessions.get(sessionId) : undefined;

      if (session) {
        await session.transport.handleRequest(req, res);
      } else {
        res.status(204).end();
      }
    })
  );

  // Error handling middleware (must be last)
  app.use(errorHandler);

  // Start server
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

  // Graceful shutdown for HTTP mode
  const shutdown = (signal: string) => {
    process.stdout.write(`\n${signal} received, shutting down gracefully...\n`);

    // Stop accepting new sessions
    clearInterval(sessionCleanupInterval);

    // Destroy rate limiter to stop cleanup interval
    rateLimiter.destroy();

    // Close all MCP transport sessions
    for (const session of sessions.values()) {
      void session.transport.close();
    }
    sessions.clear();

    // Destroy HTTP agents to close all connections
    destroyAgents();

    server.close(() => {
      logInfo('HTTP server closed');
      process.exit(0);
    });

    // Force exit after timeout
    setTimeout(() => {
      logError('Forced shutdown after timeout');
      process.exit(1);
    }, 10000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}
