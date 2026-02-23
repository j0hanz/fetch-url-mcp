import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import {
  createServer as createHttpsServer,
  type ServerOptions as HttpsServerOptions,
} from 'node:https';
import { hostname } from 'node:os';
import process from 'node:process';

import { config, enableHttpMode } from '../config.js';
import { handleDownload } from '../download.js';
import {
  acceptsEventStream,
  acceptsJsonAndEventStream,
  isJsonRpcBatchRequest,
  isMcpRequestBody,
  type JsonRpcId,
} from '../mcp-validator.js';
import { cancelTasksForOwner } from '../mcp.js';
import {
  logError,
  logInfo,
  registerMcpSessionServer,
  resolveMcpSessionIdByServer,
  runWithRequestContext,
  unregisterMcpSessionServer,
  unregisterMcpSessionServerByServer,
} from '../observability.js';
import {
  applyHttpServerTuning,
  drainConnectionsOnShutdown,
} from '../server-tuning.js';
import { createMcpServerForHttpSession } from '../server.js';
import {
  composeCloseHandlers,
  createSessionStore,
  createSlotTracker,
  ensureSessionCapacity,
  reserveSessionSlot,
  type SessionStore,
  startSessionCleanupLoop,
} from '../session.js';
import {
  assertHttpModeConfiguration,
  authService,
  buildAuthFingerprint,
  corsPolicy,
  ensureMcpProtocolVersion,
  hostOriginPolicy,
} from './auth.js';
import {
  disableEventLoopMonitoring,
  resetEventLoopMonitoring,
  sendHealthRouteResponse,
  shouldHandleHealthRoute,
} from './health.js';
import {
  type AuthenticatedContext,
  buildRequestContext,
  closeMcpServerBestEffort,
  closeTransportBestEffort,
  createRequestAbortSignal,
  createTransportAdapter,
  DEFAULT_BODY_LIMIT_BYTES,
  drainRequest,
  findDuplicateSingleValueHeader,
  getHeaderValue,
  getMcpSessionId,
  jsonBodyReader,
  type NetworkServer,
  registerInboundBlockList,
  type RequestContext,
  sendError,
  sendJson,
  sendText,
} from './helpers.js';
import {
  createRateLimitManagerImpl,
  type RateLimitManagerImpl,
} from './rate-limit.js';

// ---------------------------------------------------------------------------
// MCP session gateway
// ---------------------------------------------------------------------------

class McpSessionGateway {
  constructor(
    private readonly store: SessionStore,
    private readonly createSessionServer: () => Promise<McpServer>
  ) {}

  async handlePost(ctx: AuthenticatedContext): Promise<void> {
    if (!ensureMcpProtocolVersion(ctx.req, ctx.res)) return;
    if (!acceptsJsonAndEventStream(getHeaderValue(ctx.req, 'accept'))) {
      sendJson(ctx.res, 400, {
        error:
          'Accept header must include application/json and text/event-stream',
      });
      return;
    }

    const { body } = ctx;
    if (isJsonRpcBatchRequest(body)) {
      sendError(ctx.res, -32600, 'Batch requests not supported');
      return;
    }
    if (!isMcpRequestBody(body)) {
      sendError(ctx.res, -32600, 'Invalid request body');
      return;
    }

    const requestId = body.id ?? null;
    logInfo('[MCP POST]', {
      method: body.method,
      id: body.id,
      sessionId: getMcpSessionId(ctx.req),
    });

    const transport = await this.getOrCreateTransport(ctx, requestId);
    if (!transport) return;

    await transport.handleRequest(ctx.req, ctx.res, body);
  }

  async handleGet(ctx: AuthenticatedContext): Promise<void> {
    if (!ensureMcpProtocolVersion(ctx.req, ctx.res)) return;

    const sessionId = getMcpSessionId(ctx.req);
    if (!sessionId) {
      sendError(ctx.res, -32600, 'Missing session ID');
      return;
    }

    const session = this.store.get(sessionId);
    if (!session) {
      sendError(ctx.res, -32600, 'Session not found', 404);
      return;
    }

    const acceptHeader = getHeaderValue(ctx.req, 'accept');
    if (!acceptsEventStream(acceptHeader)) {
      sendJson(ctx.res, 405, { error: 'Method Not Allowed' });
      return;
    }

    this.store.touch(sessionId);
    await session.transport.handleRequest(ctx.req, ctx.res);
  }

  async handleDelete(ctx: AuthenticatedContext): Promise<void> {
    if (!ensureMcpProtocolVersion(ctx.req, ctx.res)) return;

    const sessionId = getMcpSessionId(ctx.req);
    if (!sessionId) {
      sendError(ctx.res, -32600, 'Missing session ID');
      return;
    }

    const session = this.store.get(sessionId);
    if (session) {
      await session.transport.close();
      this.cleanupSessionRecord(sessionId, 'session-delete');
    }

    sendText(ctx.res, 200, 'Session closed');
  }

  private async getOrCreateTransport(
    ctx: AuthenticatedContext,
    requestId: JsonRpcId
  ): Promise<StreamableHTTPServerTransport | null> {
    const sessionId = getMcpSessionId(ctx.req);

    if (sessionId) {
      const fingerprint = buildAuthFingerprint(ctx.auth);
      return this.getExistingTransport(
        sessionId,
        fingerprint,
        ctx.res,
        requestId
      );
    }

    if (!isInitializeRequest(ctx.body)) {
      sendError(ctx.res, -32600, 'Missing session ID', 400, requestId);
      return null;
    }

    return this.createNewSession(ctx, requestId);
  }

  private getExistingTransport(
    sessionId: string,
    authFingerprint: string | null,
    res: ServerResponse,
    requestId: JsonRpcId
  ): StreamableHTTPServerTransport | null {
    const session = this.store.get(sessionId);
    if (!session) {
      sendError(res, -32600, 'Session not found', 404, requestId);
      return null;
    }

    if (!authFingerprint || session.authFingerprint !== authFingerprint) {
      sendError(res, -32600, 'Session not found', 404, requestId);
      return null;
    }

    this.store.touch(sessionId);
    return session.transport;
  }

  private async createNewSession(
    ctx: AuthenticatedContext,
    requestId: JsonRpcId
  ): Promise<StreamableHTTPServerTransport | null> {
    const authFingerprint = buildAuthFingerprint(ctx.auth);
    if (!authFingerprint) {
      sendError(ctx.res, -32603, 'Missing auth context', 500, requestId);
      return null;
    }

    if (!this.reserveCapacity(ctx.res, requestId)) return null;

    const tracker = createSlotTracker(this.store);
    const newSessionId = randomUUID();
    let sessionServer: McpServer;
    try {
      sessionServer = await this.createSessionServer();
    } catch (error) {
      tracker.releaseSlot();
      throw error;
    }
    const transportImpl = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => newSessionId,
    });

    const initTimeout = setTimeout(() => {
      if (!tracker.isInitialized()) {
        tracker.releaseSlot();
        void closeTransportBestEffort(transportImpl, 'session-init-timeout');
        void closeMcpServerBestEffort(sessionServer, 'session-init-timeout');
      }
    }, config.server.sessionInitTimeoutMs);
    initTimeout.unref();

    transportImpl.onclose = () => {
      clearTimeout(initTimeout);
      if (!tracker.isInitialized()) tracker.releaseSlot();
    };

    try {
      const transport = createTransportAdapter(transportImpl);
      await sessionServer.connect(transport);
    } catch (err) {
      clearTimeout(initTimeout);
      tracker.releaseSlot();
      void closeTransportBestEffort(transportImpl, 'session-connect-failed');
      void closeMcpServerBestEffort(sessionServer, 'session-connect-failed');
      throw err;
    }

    tracker.markInitialized();
    tracker.releaseSlot();

    this.store.set(newSessionId, {
      server: sessionServer,
      transport: transportImpl,
      createdAt: Date.now(),
      lastSeen: Date.now(),
      protocolInitialized: false,
      authFingerprint,
    });
    registerMcpSessionServer(newSessionId, sessionServer);

    transportImpl.onclose = composeCloseHandlers(transportImpl.onclose, () => {
      this.cleanupSessionRecord(newSessionId, 'session-close');
    });

    return transportImpl;
  }

  private cleanupSessionRecord(sessionId: string, context: string): void {
    const session = this.store.remove(sessionId);
    if (!session) return;

    cancelTasksForOwner(
      `session:${sessionId}`,
      'The task was cancelled because the MCP session ended.'
    );

    unregisterMcpSessionServer(sessionId);
    void closeMcpServerBestEffort(session.server, `${context}-server`);
  }

  private reserveCapacity(res: ServerResponse, requestId: JsonRpcId): boolean {
    const allowed = ensureSessionCapacity({
      store: this.store,
      maxSessions: config.server.maxSessions,
      evictOldest: (store) => {
        const evicted = store.evictOldest();
        if (evicted) {
          const sessionId = resolveMcpSessionIdByServer(evicted.server);
          if (sessionId) {
            cancelTasksForOwner(
              `session:${sessionId}`,
              'The task was cancelled because the MCP session was evicted.'
            );
            unregisterMcpSessionServer(sessionId);
          }

          unregisterMcpSessionServerByServer(evicted.server);
          void closeTransportBestEffort(evicted.transport, 'session-eviction');
          void closeMcpServerBestEffort(evicted.server, 'session-eviction');
          return true;
        }
        return false;
      },
    });

    if (!allowed) {
      sendError(res, -32000, 'Server busy', 503, requestId);
      return false;
    }

    if (!reserveSessionSlot(this.store, config.server.maxSessions)) {
      sendError(res, -32000, 'Server busy', 503, requestId);
      return false;
    }

    return true;
  }
}

// ---------------------------------------------------------------------------
// Download route
// ---------------------------------------------------------------------------

function checkDownloadRoute(
  path: string
): { namespace: string; hash: string } | null {
  const downloadMatch = /^\/mcp\/downloads\/([^/]+)\/([^/]+)$/.exec(path);
  if (!downloadMatch) return null;

  const namespace = downloadMatch[1];
  const hash = downloadMatch[2];
  if (!namespace || !hash) return null;

  return { namespace, hash };
}

// ---------------------------------------------------------------------------
// HTTP dispatcher
// ---------------------------------------------------------------------------

class HttpDispatcher {
  constructor(
    private readonly store: SessionStore,
    private readonly mcpGateway: McpSessionGateway
  ) {}

  private async tryHandleHealthRoute(ctx: RequestContext): Promise<boolean> {
    if (!shouldHandleHealthRoute(ctx)) return false;

    const requiresAuthForVerbose =
      isVerboseHealthRequest(ctx) && config.security.allowRemote;
    if (!requiresAuthForVerbose) {
      sendHealthRouteResponse(this.store, ctx, false);
      return true;
    }

    const healthAuth = await this.authenticateRequest(ctx);
    if (!healthAuth) return true;

    sendHealthRouteResponse(this.store, ctx, true);
    return true;
  }

  private tryHandleDownloadRoute(ctx: RequestContext): boolean {
    if (ctx.method !== 'GET') return false;

    const download = checkDownloadRoute(ctx.url.pathname);
    if (!download) return false;

    handleDownload(ctx.res, download.namespace, download.hash);
    return true;
  }

  async dispatch(ctx: RequestContext): Promise<void> {
    try {
      if (await this.tryHandleHealthRoute(ctx)) return;

      const auth = await this.authenticateRequest(ctx);
      if (!auth) return;

      const authCtx: AuthenticatedContext = { ...ctx, auth };

      if (this.tryHandleDownloadRoute(ctx)) return;

      if (ctx.url.pathname === '/mcp') {
        const handled = await this.handleMcpRoutes(authCtx);
        if (handled) return;
      }

      sendJson(ctx.res, 404, { error: 'Not Found' });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      logError('Request failed', error);
      if (!ctx.res.writableEnded) {
        sendJson(ctx.res, 500, { error: 'Internal Server Error' });
      }
    }
  }

  private async handleMcpRoutes(ctx: AuthenticatedContext): Promise<boolean> {
    switch (ctx.method) {
      case 'POST':
        await this.mcpGateway.handlePost(ctx);
        return true;
      case 'GET':
        await this.mcpGateway.handleGet(ctx);
        return true;
      case 'DELETE':
        await this.mcpGateway.handleDelete(ctx);
        return true;
      default:
        return false;
    }
  }

  private async authenticateRequest(
    ctx: RequestContext
  ): Promise<AuthInfo | null> {
    try {
      return await authService.authenticate(ctx.req, ctx.signal);
    } catch (err) {
      sendJson(ctx.res, 401, {
        error: err instanceof Error ? err.message : 'Unauthorized',
      });
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Verbose health helper (local to dispatcher)
// ---------------------------------------------------------------------------

function isVerboseHealthRequest(ctx: RequestContext): boolean {
  const value = ctx.url.searchParams.get('verbose');
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true';
}

// ---------------------------------------------------------------------------
// Request pipeline
// ---------------------------------------------------------------------------

class HttpRequestPipeline {
  constructor(
    private readonly rateLimiter: RateLimitManagerImpl,
    private readonly dispatcher: HttpDispatcher
  ) {}

  async handle(rawReq: IncomingMessage, rawRes: ServerResponse): Promise<void> {
    const requestId = getHeaderValue(rawReq, 'x-request-id') ?? randomUUID();
    const sessionId = getMcpSessionId(rawReq) ?? undefined;
    const { signal, cleanup } = createRequestAbortSignal(rawReq);

    try {
      await runWithRequestContext(
        {
          requestId,
          operationId: requestId,
          ...(sessionId ? { sessionId } : {}),
        },
        async () => {
          const duplicateHeader = findDuplicateSingleValueHeader(rawReq);
          if (duplicateHeader) {
            sendJson(rawRes, 400, {
              error: `Duplicate ${duplicateHeader} header is not allowed`,
            });
            drainRequest(rawReq);
            return;
          }

          const ctx = buildRequestContext(rawReq, rawRes, signal);
          if (!ctx) {
            drainRequest(rawReq);
            return;
          }

          if (!hostOriginPolicy.validate(ctx)) {
            drainRequest(rawReq);
            return;
          }
          if (corsPolicy.handle(ctx)) {
            drainRequest(rawReq);
            return;
          }

          if (!this.rateLimiter.check(ctx)) {
            drainRequest(rawReq);
            return;
          }

          if (ctx.method === 'POST') {
            try {
              ctx.body = await jsonBodyReader.read(
                ctx.req,
                DEFAULT_BODY_LIMIT_BYTES,
                ctx.signal
              );
            } catch {
              if (ctx.url.pathname === '/mcp') {
                sendError(ctx.res, -32700, 'Parse error', 400, null);
              } else {
                sendJson(ctx.res, 400, {
                  error: 'Invalid JSON or Payload too large',
                });
              }
              drainRequest(rawReq);
              return;
            }
          } else {
            const contentLengthHeader = getHeaderValue(
              rawReq,
              'content-length'
            );
            const transferEncodingHeader = getHeaderValue(
              rawReq,
              'transfer-encoding'
            );
            const hasRequestBody =
              (contentLengthHeader !== null &&
                Number.parseInt(contentLengthHeader, 10) > 0) ||
              transferEncodingHeader !== null;
            if (hasRequestBody) {
              drainRequest(rawReq);
            }
            ctx.body = undefined;
          }

          await this.dispatcher.dispatch(ctx);
        }
      );
    } finally {
      cleanup();
    }
  }
}

// ---------------------------------------------------------------------------
// Server bootstrap
// ---------------------------------------------------------------------------

function handlePipelineError(error: unknown, res: ServerResponse): void {
  logError(
    'Request pipeline failed',
    error instanceof Error ? error : new Error(String(error))
  );

  if (res.writableEnded) return;

  if (!res.headersSent) {
    sendJson(res, 500, { error: 'Internal Server Error' });
    return;
  }

  res.end();
}

function createNetworkServer(
  listener: (req: IncomingMessage, res: ServerResponse) => void
): NetworkServer {
  const { https } = config.server;
  if (!https.enabled) {
    return createServer(listener);
  }

  const { keyFile, certFile, caFile } = https;
  if (!keyFile || !certFile) {
    throw new Error(
      'HTTPS enabled but SERVER_TLS_KEY_FILE / SERVER_TLS_CERT_FILE are missing'
    );
  }

  const tlsOptions: HttpsServerOptions = {
    key: readFileSync(keyFile),
    cert: readFileSync(certFile),
  };

  if (caFile) {
    tlsOptions.ca = readFileSync(caFile);
  }

  return createHttpsServer(tlsOptions, listener);
}

async function listen(
  server: NetworkServer,
  host: string,
  port: number
): Promise<void> {
  await new Promise<void>((resolve, reject): void => {
    function onError(err: Error): void {
      server.off('error', onError);
      reject(err);
    }

    server.once('error', onError);
    server.listen(port, host, (): void => {
      server.off('error', onError);
      resolve();
    });
  });
}

function resolveListeningPort(server: NetworkServer, fallback: number): number {
  const addr = server.address();
  if (addr && typeof addr === 'object') return addr.port;
  return fallback;
}

function createShutdownHandler(options: {
  server: NetworkServer;
  rateLimiter: RateLimitManagerImpl;
  sessionCleanup: AbortController;
  sessionStore: SessionStore;
}): (signal: string) => Promise<void> {
  const closeBatchSize = 10;

  return async (signal: string): Promise<void> => {
    logInfo(`Stopping HTTP server (${signal})...`);

    options.rateLimiter.stop();
    options.sessionCleanup.abort();
    drainConnectionsOnShutdown(options.server);
    disableEventLoopMonitoring();

    const sessions = options.sessionStore.clear();
    for (let i = 0; i < sessions.length; i += closeBatchSize) {
      const batch = sessions.slice(i, i + closeBatchSize);
      await Promise.all(
        batch.map(async (session) => {
          const sessionId = resolveMcpSessionIdByServer(session.server);
          if (sessionId) {
            cancelTasksForOwner(
              `session:${sessionId}`,
              'The task was cancelled because the HTTP server is shutting down.'
            );
            unregisterMcpSessionServer(sessionId);
          }

          unregisterMcpSessionServerByServer(session.server);
          await closeTransportBestEffort(
            session.transport,
            'shutdown-session-close'
          );
          await closeMcpServerBestEffort(
            session.server,
            'shutdown-session-close'
          );
        })
      );
    }

    await new Promise<void>((resolve, reject): void => {
      options.server.close((err): void => {
        if (err) reject(err);
        else resolve();
      });
    });
  };
}

export async function startHttpServer(): Promise<{
  shutdown: (signal: string) => Promise<void>;
  port: number;
  host: string;
}> {
  assertHttpModeConfiguration();
  enableHttpMode();

  resetEventLoopMonitoring();

  const rateLimiter = createRateLimitManagerImpl(config.rateLimit);

  const sessionStore = createSessionStore(config.server.sessionTtlMs);
  const sessionCleanup = startSessionCleanupLoop(
    sessionStore,
    config.server.sessionTtlMs
  );

  const mcpGateway = new McpSessionGateway(
    sessionStore,
    createMcpServerForHttpSession
  );
  const dispatcher = new HttpDispatcher(sessionStore, mcpGateway);
  const pipeline = new HttpRequestPipeline(rateLimiter, dispatcher);

  const server = createNetworkServer((req, res) => {
    void pipeline.handle(req, res).catch((error: unknown) => {
      handlePipelineError(error, res);
    });
  });

  registerInboundBlockList(server);
  applyHttpServerTuning(server);
  await listen(server, config.server.host, config.server.port);

  const port = resolveListeningPort(server, config.server.port);
  const protocol = config.server.https.enabled ? 'https' : 'http';
  logInfo(`${protocol.toUpperCase()} server listening on port ${port}`, {
    platform: process.platform,
    arch: process.arch,
    hostname: hostname(),
    nodeVersion: process.version,
  });

  return {
    port,
    host: config.server.host,
    shutdown: createShutdownHandler({
      server,
      rateLimiter,
      sessionCleanup,
      sessionStore,
    }),
  };
}
