import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
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

import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

import { toCacheScopeId } from '../lib/cache.js';
import {
  composeCloseHandlers,
  config,
  createSessionStore,
  createSlotTracker,
  enableHttpMode,
  ensureSessionCapacity,
  logError,
  logInfo,
  registerMcpSessionServer,
  reserveSessionSlot,
  runWithRequestContext,
  type SessionStore,
  startSessionCleanupLoop,
} from '../lib/core.js';
import { handleDownload } from '../lib/http.js';
import {
  acceptsEventStream,
  acceptsJsonAndEventStream,
  isJsonRpcBatchRequest,
  isMcpMessageBody,
  isMcpRequestBody,
  type JsonRpcId,
} from '../lib/mcp-interop.js';
import {
  applyHttpServerTuning,
  drainConnectionsOnShutdown,
  isObject,
  toError,
} from '../lib/utils.js';

import { createMcpServerForHttpSession } from '../server.js';
import {
  applyInsufficientScopeAuthHeaders,
  applyUnauthorizedAuthHeaders,
  assertHttpModeConfiguration,
  authService,
  buildAuthFingerprint,
  buildProtectedResourceMetadataDocument,
  corsPolicy,
  DEFAULT_MCP_PROTOCOL_VERSION,
  ensureMcpProtocolVersion,
  hostOriginPolicy,
  isInsufficientScopeError,
  isOAuthMetadataEnabled,
  isProtectedResourceMetadataPath,
  SUPPORTED_MCP_PROTOCOL_VERSIONS,
} from './auth.js';
import {
  disableEventLoopMonitoring,
  isVerboseHealthRequest,
  resetEventLoopMonitoring,
  sendHealthRouteResponse,
  shouldHandleHealthRoute,
} from './health.js';
import {
  type AuthenticatedContext,
  buildRequestContext,
  createRequestAbortSignal,
  createTransportAdapter,
  DEFAULT_BODY_LIMIT_BYTES,
  drainRequest,
  findDuplicateSingleValueHeader,
  getHeaderValue,
  getMcpSessionId,
  isJsonBodyError,
  jsonBodyReader,
  type NetworkServer,
  registerInboundBlockList,
  type RequestContext,
  sendEmpty,
  sendError,
  sendJson,
} from './helpers.js';
import {
  teardownSessionRegistration,
  teardownSessionResources,
  teardownUnregisteredSessionResources,
} from './helpers.js';
import {
  createRateLimitManagerImpl,
  type RateLimitManagerImpl,
} from './rate-limit.js';

// ---------------------------------------------------------------------------
// MCP session gateway
// ---------------------------------------------------------------------------

type SessionRecord = NonNullable<ReturnType<SessionStore['get']>>;

function resolveRequestedProtocolVersion(body: unknown): string | null {
  if (!isObject(body)) return DEFAULT_MCP_PROTOCOL_VERSION;

  const { params } = body;
  if (!isObject(params)) return DEFAULT_MCP_PROTOCOL_VERSION;

  const { protocolVersion: value } = params;
  if (typeof value !== 'string') return DEFAULT_MCP_PROTOCOL_VERSION;

  const normalized = value.trim();
  if (normalized.length === 0) return DEFAULT_MCP_PROTOCOL_VERSION;
  if (!SUPPORTED_MCP_PROTOCOL_VERSIONS.has(normalized)) {
    return null;
  }

  return normalized;
}

function resolveProtocolVersionHeader(
  req: IncomingMessage
): string | undefined {
  const header = getHeaderValue(req, 'mcp-protocol-version');
  if (!header) return undefined;

  const normalized = header.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function isInitializedNotification(method: string): boolean {
  return method === 'notifications/initialized';
}

function isPingRequest(method: string): boolean {
  return method === 'ping';
}

function isMcpRoute(pathname: string): boolean {
  return pathname === '/mcp' || pathname === '/mcp/';
}

type SessionTeardownOptions = Parameters<typeof teardownSessionResources>[1];
type PostRequestBody = {
  id?: JsonRpcId | undefined;
  method?: string | undefined;
} & Record<string, unknown>;

function createSessionTeardownOptions(
  mode: 'ended' | 'evicted' | 'shutdown',
  context?: string
): SessionTeardownOptions {
  switch (mode) {
    case 'ended':
      return {
        cancelMessage: 'The task was cancelled because the MCP session ended.',
        closeServerReason: `${context ?? 'session'}-server`,
      };
    case 'evicted':
      return {
        cancelMessage:
          'The task was cancelled because the MCP session was evicted.',
        closeTransportReason: 'session-eviction',
        closeServerReason: 'session-eviction',
        unregisterByServer: true,
      };
    case 'shutdown':
      return {
        cancelMessage:
          'The task was cancelled because the HTTP server is shutting down.',
        closeTransportReason: 'shutdown-session-close',
        closeServerReason: 'shutdown-session-close',
        unregisterByServer: true,
        awaitClose: true,
      };
  }
}

class McpSessionGateway {
  private readonly sessionInitTimeouts = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly store: SessionStore,
    private readonly createSessionServer: () => Promise<McpServer>
  ) {}

  async handlePost(ctx: AuthenticatedContext): Promise<void> {
    const body = this.validatePostRequest(ctx);
    if (!body) return;

    const postState = this.resolvePostRequestState(ctx, body);
    if (!postState) return;

    const { requestId, method, sessionId, session, isInitNotification } =
      postState;

    if (session && isInitNotification) {
      this.markSessionInitialized(sessionId, session);
      sendEmpty(ctx.res, 202);
      return;
    }

    logInfo('[MCP POST]', {
      method: method ?? 'response',
      id: body.id,
      sessionId,
    });

    const transport = await this.getOrCreateTransport(ctx, requestId);
    if (!transport) return;

    await transport.handleRequest(ctx.req, ctx.res, body);
  }

  async handleGet(ctx: AuthenticatedContext): Promise<void> {
    const sessionState = this.getRequiredAuthenticatedSession(ctx, null, {
      requireInitialized: true,
    });
    if (!sessionState) return;
    const { sessionId, session } = sessionState;

    const acceptHeader = getHeaderValue(ctx.req, 'accept');
    if (!acceptsEventStream(acceptHeader)) {
      sendJson(ctx.res, 406, {
        error: 'Not Acceptable: expected text/event-stream',
      });
      return;
    }

    this.store.touch(sessionId);
    await session.transport.handleRequest(ctx.req, ctx.res);
  }

  async handleDelete(ctx: AuthenticatedContext): Promise<void> {
    const sessionState = this.getRequiredAuthenticatedSession(ctx, null, {
      requireInitialized: true,
    });
    if (!sessionState) return;
    const { sessionId, session } = sessionState;

    await session.transport.close();
    this.cleanupSessionRecord(sessionId, 'session-delete');

    sendJson(ctx.res, 200, { status: 'closed' });
  }

  private validatePostRequest(
    ctx: AuthenticatedContext
  ): PostRequestBody | null {
    if (!acceptsJsonAndEventStream(getHeaderValue(ctx.req, 'accept'))) {
      sendJson(ctx.res, 406, {
        error:
          'Not Acceptable: expected application/json and text/event-stream',
      });
      return null;
    }

    const { body } = ctx;
    if (isJsonRpcBatchRequest(body)) {
      sendError(ctx.res, -32600, 'Batch requests not supported');
      return null;
    }
    if (!isMcpMessageBody(body)) {
      sendError(ctx.res, -32600, 'Invalid request body');
      return null;
    }

    return body as PostRequestBody;
  }

  private resolvePostRequestState(
    ctx: AuthenticatedContext,
    body: PostRequestBody
  ): {
    requestId: JsonRpcId;
    method: string | null;
    sessionId: string | null;
    session: SessionRecord | undefined;
    isInitNotification: boolean;
  } | null {
    const requestId = body.id ?? null;
    const method = typeof body.method === 'string' ? body.method : null;
    const isInitializedMethod =
      method !== null && isInitializedNotification(method);
    const isInitNotification = isInitializedMethod && body.id === undefined;

    if (isInitializedMethod && !isInitNotification) {
      sendError(
        ctx.res,
        -32600,
        'notifications/initialized must be sent as a notification',
        400,
        requestId
      );
      return null;
    }

    const sessionState = this.getOptionalAuthenticatedSession(ctx, requestId);
    if (!sessionState) return null;
    const { sessionId, session } = sessionState;

    if (
      !this.ensurePostSessionAccess({
        ctx,
        sessionId,
        session,
        requestId,
        method,
        isInitNotification,
      })
    ) {
      return null;
    }

    return {
      requestId,
      method,
      sessionId,
      session,
      isInitNotification,
    };
  }

  private ensurePostSessionAccess(params: {
    ctx: AuthenticatedContext;
    sessionId: string | null;
    session: SessionRecord | undefined | null;
    requestId: JsonRpcId;
    method: string | null;
    isInitNotification: boolean;
  }): boolean {
    const { ctx, sessionId, session, requestId, method, isInitNotification } =
      params;

    if (sessionId && !session) return false;

    if (!session) {
      if (isInitNotification) {
        sendError(ctx.res, -32600, 'Missing session ID', 400, requestId);
        return false;
      }

      return ensureMcpProtocolVersion(ctx.req, ctx.res);
    }

    if (!this.ensureSessionProtocolVersion(ctx, session)) return false;
    if (session.protocolInitialized) return true;
    if (isInitNotification) return true;
    if (method !== null && isPingRequest(method)) return true;

    sendError(ctx.res, -32600, 'Session not initialized', 400, requestId);
    return false;
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

    const negotiatedProtocolVersion = this.getInitializeProtocolVersion(
      ctx,
      requestId
    );
    if (!negotiatedProtocolVersion) return null;

    return this.createNewSession(ctx, requestId, negotiatedProtocolVersion);
  }

  private getInitializeProtocolVersion(
    ctx: AuthenticatedContext,
    requestId: JsonRpcId
  ): string | null {
    if (!isMcpRequestBody(ctx.body)) {
      sendError(ctx.res, -32600, 'Missing session ID', 400, requestId);
      return null;
    }

    if (!isInitializeRequest(ctx.body)) {
      sendError(
        ctx.res,
        ctx.body.method === 'initialize' ? -32602 : -32600,
        ctx.body.method === 'initialize'
          ? 'Invalid initialize request'
          : 'Missing session ID',
        400,
        requestId
      );
      return null;
    }

    const negotiatedProtocolVersion = resolveRequestedProtocolVersion(ctx.body);
    if (!negotiatedProtocolVersion) {
      sendError(
        ctx.res,
        -32602,
        `Unsupported protocolVersion; supported versions: ${[...SUPPORTED_MCP_PROTOCOL_VERSIONS].join(', ')}`,
        400,
        requestId
      );
      return null;
    }

    const headerProtocolVersion = resolveProtocolVersionHeader(ctx.req);
    if (
      headerProtocolVersion &&
      headerProtocolVersion !== negotiatedProtocolVersion
    ) {
      sendError(
        ctx.res,
        -32600,
        `initialize protocolVersion mismatch: header=${headerProtocolVersion}, body=${negotiatedProtocolVersion}`,
        400,
        requestId
      );
      return null;
    }

    return negotiatedProtocolVersion;
  }

  private getExistingTransport(
    sessionId: string,
    authFingerprint: string | null,
    res: ServerResponse,
    requestId: JsonRpcId
  ): StreamableHTTPServerTransport | null {
    const session = this.getAuthenticatedSessionById(
      sessionId,
      authFingerprint,
      res,
      requestId
    );
    if (!session) return null;

    this.store.touch(sessionId);
    return session.transport;
  }

  private getOptionalAuthenticatedSession(
    ctx: AuthenticatedContext,
    requestId: JsonRpcId = null
  ): { sessionId: string | null; session: SessionRecord | undefined } | null {
    const sessionId = getMcpSessionId(ctx.req);
    if (!sessionId) return { sessionId: null, session: undefined };

    const authFingerprint = buildAuthFingerprint(ctx.auth);
    const session = this.getAuthenticatedSessionById(
      sessionId,
      authFingerprint,
      ctx.res,
      requestId
    );
    if (!session) return null;

    return { sessionId, session };
  }

  private getRequiredAuthenticatedSession(
    ctx: AuthenticatedContext,
    requestId: JsonRpcId = null,
    options?: { requireInitialized?: boolean }
  ): { sessionId: string; session: SessionRecord } | null {
    const state = this.getOptionalAuthenticatedSession(ctx, requestId);
    if (!state) return null;

    const { sessionId, session } = state;
    if (!sessionId || !session) {
      sendError(ctx.res, -32600, 'Missing session ID', 400, requestId);
      return null;
    }

    if (!this.ensureSessionProtocolVersion(ctx, session)) return null;
    if (options?.requireInitialized && !session.protocolInitialized) {
      sendError(ctx.res, -32600, 'Session not initialized', 400, requestId);
      return null;
    }

    return { sessionId, session };
  }

  private getAuthenticatedSessionById(
    sessionId: string,
    authFingerprint: string | null,
    res: ServerResponse,
    requestId: JsonRpcId = null
  ): SessionRecord | null {
    const session = this.store.get(sessionId);
    if (!session) {
      sendError(res, -32600, 'Session not found', 404, requestId);
      return null;
    }

    if (!authFingerprint || session.authFingerprint !== authFingerprint) {
      sendError(res, -32600, 'Session not found', 404, requestId);
      return null;
    }

    return session;
  }

  private ensureSessionProtocolVersion(
    ctx: AuthenticatedContext,
    session: SessionRecord
  ): boolean {
    return ensureMcpProtocolVersion(ctx.req, ctx.res, {
      expectedVersion: session.negotiatedProtocolVersion,
    });
  }

  private markSessionInitialized(
    sessionId: string | null,
    session: SessionRecord
  ): void {
    if (!session.protocolInitialized) {
      session.protocolInitialized = true;
    }
    this.clearSessionInitTimeout(sessionId);
    if (sessionId) this.store.touch(sessionId);
  }

  private createSessionInitTimeout(
    sessionId: string,
    tracker: ReturnType<typeof createSlotTracker>,
    unpublishedSession: {
      server: McpServer;
      transport: StreamableHTTPServerTransport;
    }
  ): NodeJS.Timeout {
    const initTimeout = setTimeout(() => {
      const session = this.store.get(sessionId);
      if (session) {
        if (session.protocolInitialized) {
          this.clearSessionInitTimeout(sessionId);
          return;
        }

        this.cleanupSessionRecord(sessionId, 'session-init-timeout');
        return;
      }

      tracker.releaseSlot();
      void teardownUnregisteredSessionResources(
        unpublishedSession,
        'session-init-timeout'
      );
    }, config.server.sessionInitTimeoutMs);
    initTimeout.unref();

    return initTimeout;
  }

  private async connectTransport(
    sessionServer: McpServer,
    transportImpl: StreamableHTTPServerTransport,
    initTimeout: NodeJS.Timeout,
    tracker: ReturnType<typeof createSlotTracker>,
    unpublishedSession: {
      server: McpServer;
      transport: StreamableHTTPServerTransport;
    },
    sessionId: string
  ): Promise<boolean> {
    const connectState = { transportClosed: false };
    transportImpl.onclose = () => {
      connectState.transportClosed = true;
      clearTimeout(initTimeout);
      this.sessionInitTimeouts.delete(sessionId);
      tracker.releaseSlot();
    };

    try {
      const transport = createTransportAdapter(transportImpl);
      await sessionServer.connect(transport);
    } catch (err) {
      clearTimeout(initTimeout);
      tracker.releaseSlot();
      void teardownUnregisteredSessionResources(
        unpublishedSession,
        'session-connect-failed'
      );
      throw err;
    }

    return !connectState.transportClosed;
  }

  private async createNewSession(
    ctx: AuthenticatedContext,
    requestId: JsonRpcId,
    negotiatedProtocolVersion: string
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
    const unpublishedSession = {
      server: sessionServer,
      transport: transportImpl,
    };

    const initTimeout = this.createSessionInitTimeout(
      newSessionId,
      tracker,
      unpublishedSession
    );

    const isConnected = await this.connectTransport(
      sessionServer,
      transportImpl,
      initTimeout,
      tracker,
      unpublishedSession,
      newSessionId
    );

    tracker.releaseSlot();

    if (!isConnected) {
      void teardownUnregisteredSessionResources(
        unpublishedSession,
        'session-closed-during-connect'
      );
      return null;
    }

    this.store.set(newSessionId, {
      server: sessionServer,
      transport: transportImpl,
      createdAt: Date.now(),
      lastSeen: Date.now(),
      protocolInitialized: false,
      negotiatedProtocolVersion,
      authFingerprint,
    });
    this.sessionInitTimeouts.set(newSessionId, initTimeout);
    registerMcpSessionServer(newSessionId, sessionServer);

    transportImpl.onclose = composeCloseHandlers(transportImpl.onclose, () => {
      this.cleanupSessionRecord(newSessionId, 'session-close');
    });

    return transportImpl;
  }

  private cleanupSessionRecord(sessionId: string, context: string): void {
    this.clearSessionInitTimeout(sessionId);
    const session = this.store.remove(sessionId);
    if (!session) return;

    void teardownSessionResources(
      session,
      createSessionTeardownOptions('ended', context)
    );
  }

  private clearSessionInitTimeout(sessionId: string | null): void {
    if (!sessionId) return;

    const timeout = this.sessionInitTimeouts.get(sessionId);
    if (!timeout) return;

    clearTimeout(timeout);
    this.sessionInitTimeouts.delete(sessionId);
  }

  private reserveCapacity(res: ServerResponse, requestId: JsonRpcId): boolean {
    const allowed = ensureSessionCapacity({
      store: this.store,
      maxSessions: config.server.maxSessions,
      evictOldest: (store) => {
        const evicted = store.evictOldest();
        if (evicted) {
          void teardownSessionResources(
            evicted,
            createSessionTeardownOptions('evicted')
          );
          return true;
        }
        return false;
      },
    });

    if (!allowed) {
      sendError(res, -32000, 'Server busy', 503, requestId);
      return false;
    }

    // Double-check: capacity may have changed during the async eviction window above.
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

  private resolveDownloadScopeId(ctx: AuthenticatedContext): string | null {
    const sessionId = getMcpSessionId(ctx.req);
    if (!sessionId) {
      sendJson(ctx.res, 400, { error: 'Missing MCP-Session-ID header' });
      return null;
    }

    const session = this.store.get(sessionId);
    const authFingerprint = buildAuthFingerprint(ctx.auth);
    if (
      !session ||
      !authFingerprint ||
      session.authFingerprint !== authFingerprint
    ) {
      sendJson(ctx.res, 404, { error: 'Not Found' });
      return null;
    }

    if (!session.protocolInitialized) {
      sendJson(ctx.res, 400, { error: 'Session not initialized' });
      return null;
    }

    return toCacheScopeId(sessionId);
  }

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

  private tryHandleDownloadRoute(ctx: AuthenticatedContext): boolean {
    if (ctx.method !== 'GET') return false;

    const download = checkDownloadRoute(ctx.url.pathname);
    if (!download) return false;

    const scopeId = this.resolveDownloadScopeId(ctx);
    if (!scopeId) return true;

    handleDownload(ctx.res, download.namespace, download.hash, { scopeId });
    return true;
  }

  private tryHandleProtectedResourceMetadataRoute(
    ctx: RequestContext
  ): boolean {
    if (ctx.method !== 'GET') return false;
    if (!isOAuthMetadataEnabled()) return false;
    if (!isProtectedResourceMetadataPath(ctx.url.pathname)) return false;

    const document = buildProtectedResourceMetadataDocument(ctx.req);
    sendJson(ctx.res, 200, document);
    return true;
  }

  async dispatch(ctx: RequestContext): Promise<void> {
    try {
      if (await this.tryHandleHealthRoute(ctx)) return;
      if (this.tryHandleProtectedResourceMetadataRoute(ctx)) return;

      const auth = await this.authenticateRequest(ctx);
      if (!auth) return;

      const authCtx: AuthenticatedContext = { ...ctx, auth };

      if (this.tryHandleDownloadRoute(authCtx)) return;

      if (isMcpRoute(ctx.url.pathname)) {
        const handled = await this.handleMcpRoutes(authCtx);
        if (handled) return;
      }

      sendJson(ctx.res, 404, { error: 'Not Found' });
    } catch (err) {
      const error = toError(err);
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
      const message = err instanceof Error ? err.message : 'Unauthorized';
      if (isInsufficientScopeError(err)) {
        applyInsufficientScopeAuthHeaders(
          ctx.req,
          ctx.res,
          err.requiredScopes,
          message
        );
        sendError(ctx.res, -32000, message, 403);
        return null;
      }

      applyUnauthorizedAuthHeaders(ctx.req, ctx.res);
      sendError(ctx.res, -32000, message, 401);
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Body parse error responses
// ---------------------------------------------------------------------------

const DEFAULT_BODY_ERROR = {
  statusCode: 400,
  mcpCode: -32700,
  mcpMsg: 'Parse error',
  restMsg: 'Invalid JSON',
};

const BODY_PARSE_ERRORS: Record<
  string,
  { statusCode: number; mcpCode: number; mcpMsg: string; restMsg: string }
> = {
  'payload-too-large': {
    statusCode: 413,
    mcpCode: -32600,
    mcpMsg: 'Request body too large',
    restMsg: 'Payload too large',
  },
  'read-failed': {
    statusCode: 400,
    mcpCode: -32600,
    mcpMsg: 'Request body read failed',
    restMsg: 'Invalid JSON',
  },
  default: DEFAULT_BODY_ERROR,
};

function sendBodyParseError(
  ctx: RequestContext,
  bodyErrorKind: string | null,
  rawReq: IncomingMessage
): void {
  const errorDef =
    BODY_PARSE_ERRORS[bodyErrorKind ?? 'default'] ?? DEFAULT_BODY_ERROR;

  if (bodyErrorKind !== 'read-failed' || !rawReq.destroyed) {
    if (isMcpRoute(ctx.url.pathname)) {
      sendError(
        ctx.res,
        errorDef.mcpCode,
        errorDef.mcpMsg,
        errorDef.statusCode,
        null
      );
    } else {
      sendJson(ctx.res, errorDef.statusCode, { error: errorDef.restMsg });
    }
  }

  drainRequest(rawReq);
}

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
          if (this.rejectDuplicateHeaders(rawReq, rawRes)) return;

          const ctx = this.buildContext(rawReq, rawRes, signal);
          if (!ctx) return;
          if (!this.applyRequestGuards(ctx, rawReq)) return;
          if (!(await this.populateRequestBody(ctx, rawReq))) return;

          await this.dispatcher.dispatch(ctx);
        }
      );
    } finally {
      cleanup();
    }
  }

  private rejectDuplicateHeaders(
    rawReq: IncomingMessage,
    rawRes: ServerResponse
  ): boolean {
    const duplicateHeader = findDuplicateSingleValueHeader(rawReq);
    if (!duplicateHeader) return false;

    sendJson(rawRes, 400, {
      error: `Duplicate ${duplicateHeader} header is not allowed`,
    });
    drainRequest(rawReq);
    return true;
  }

  private buildContext(
    rawReq: IncomingMessage,
    rawRes: ServerResponse,
    signal: AbortSignal
  ): RequestContext | null {
    const ctx = buildRequestContext(rawReq, rawRes, signal);
    if (ctx) return ctx;

    drainRequest(rawReq);
    return null;
  }

  private applyRequestGuards(
    ctx: RequestContext,
    rawReq: IncomingMessage
  ): boolean {
    if (!hostOriginPolicy.validate(ctx)) {
      drainRequest(rawReq);
      return false;
    }
    if (corsPolicy.handle(ctx)) {
      drainRequest(rawReq);
      return false;
    }
    if (!this.rateLimiter.check(ctx)) {
      sendJson(ctx.res, 429, { error: 'Too Many Requests' });
      drainRequest(rawReq);
      return false;
    }
    return true;
  }

  private async populateRequestBody(
    ctx: RequestContext,
    rawReq: IncomingMessage
  ): Promise<boolean> {
    if (ctx.method !== 'POST') {
      this.clearUnexpectedRequestBody(ctx, rawReq);
      return true;
    }

    try {
      ctx.body = await jsonBodyReader.read(
        ctx.req,
        DEFAULT_BODY_LIMIT_BYTES,
        ctx.signal
      );
      return true;
    } catch (error: unknown) {
      const bodyErrorKind = isJsonBodyError(error) ? error.kind : null;
      sendBodyParseError(ctx, bodyErrorKind, rawReq);
      return false;
    }
  }

  private clearUnexpectedRequestBody(
    ctx: RequestContext,
    rawReq: IncomingMessage
  ): void {
    const contentLengthHeader = getHeaderValue(rawReq, 'content-length');
    const transferEncodingHeader = getHeaderValue(rawReq, 'transfer-encoding');
    const hasRequestBody =
      (contentLengthHeader !== null &&
        Number.parseInt(contentLengthHeader, 10) > 0) ||
      transferEncodingHeader !== null;

    if (hasRequestBody) {
      drainRequest(rawReq);
    }
    ctx.body = undefined;
  }
}

// ---------------------------------------------------------------------------
// Server bootstrap
// ---------------------------------------------------------------------------

function handlePipelineError(error: unknown, res: ServerResponse): void {
  logError('Request pipeline failed', toError(error));

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
    return createServer({ keepAlive: true, noDelay: true }, listener);
  }

  const { keyFile, certFile, caFile } = https;
  if (!keyFile || !certFile) {
    throw new Error(
      'HTTPS enabled but SERVER_TLS_KEY_FILE / SERVER_TLS_CERT_FILE are missing'
    );
  }

  let tlsOptions: HttpsServerOptions;
  try {
    tlsOptions = {
      key: readFileSync(keyFile),
      cert: readFileSync(certFile),
    };

    if (caFile) {
      tlsOptions.ca = readFileSync(caFile);
    }
  } catch (err) {
    throw new Error(
      `Failed to read TLS files (key=${keyFile}, cert=${certFile}): ${err instanceof Error ? err.message : String(err)}`,
      { cause: err }
    );
  }

  return createHttpsServer(
    { ...tlsOptions, keepAlive: true, noDelay: true },
    listener
  );
}

async function listen(
  server: NetworkServer,
  host: string,
  port: number
): Promise<void> {
  server.listen(port, host);
  await once(server, 'listening');
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
      const results = await Promise.allSettled(
        batch.map(async (session) => {
          await teardownSessionResources(
            session,
            createSessionTeardownOptions('shutdown')
          );
        })
      );

      for (const r of results) {
        if (r.status === 'rejected') {
          logError(
            'Session teardown failed during shutdown',
            r.reason instanceof Error ? r.reason : undefined
          );
        }
      }
    }

    await options.server[Symbol.asyncDispose]();
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
    config.server.sessionTtlMs,
    {
      onEvictSession: (session) => {
        teardownSessionRegistration(
          session.server,
          'The task was cancelled because the MCP session expired.'
        );
      },
    }
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
