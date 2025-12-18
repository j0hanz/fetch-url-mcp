#!/usr/bin/env node
import express, {
  type NextFunction,
  type Request,
  type Response,
} from 'express';

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

import { config } from './config/index.js';
import type { McpRequestBody } from './config/types.js';

import { destroyAgents } from './services/fetcher.js';
import { logError, logInfo } from './services/logger.js';
import { SessionManager } from './services/session-manager.js';

import { errorHandler } from './middleware/error-handler.js';
import { rateLimiter } from './middleware/rate-limiter.js';

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
  const app = express();

  app.use(express.json({ limit: '1mb' }));

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

  app.use(rateLimiter.middleware());

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
        'Content-Type, mcp-session-id'
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

  app.get('/health', (_req, res) => {
    res.json({
      status: 'healthy',
      name: config.server.name,
      version: config.server.version,
      uptime: process.uptime(),
    });
  });

  const sessionManager = new SessionManager();

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
        sessionCount: sessionManager.size,
      });

      const existingSession = sessionId
        ? sessionManager.get(sessionId)
        : undefined;
      if (existingSession && sessionId) {
        ({ transport } = existingSession);
        sessionManager.update(sessionId);
      } else if (!sessionId && isInitializeRequest(req.body)) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => crypto.randomUUID(),
          onsessioninitialized: (id) => {
            sessionManager.set(id, transport);
          },
          onsessionclosed: (id) => {
            sessionManager.delete(id);
          },
        });

        transport.onclose = () => {
          if (transport.sessionId) {
            sessionManager.delete(transport.sessionId);
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

      const session = sessionManager.get(sessionId);
      if (!session) {
        res.status(404).json({ error: 'Session not found' });
        return;
      }

      sessionManager.update(sessionId);

      await session.transport.handleRequest(req, res);
    })
  );

  app.delete(
    '/mcp',
    asyncHandler(async (req: Request, res: Response) => {
      const sessionId = getSessionId(req);
      const session = sessionId ? sessionManager.get(sessionId) : undefined;

      if (session) {
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

    rateLimiter.destroy();
    sessionManager.destroy();

    await sessionManager.closeAll();

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
