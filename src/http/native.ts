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

import {
  composeCloseHandlers,
  config,
  createSessionStore,
  createSlotTracker,
  enableHttpMode,
  ensureSessionCapacity,
  logDebug,
  logError,
  logInfo,
  logWarn,
  registerMcpSessionOwnerKey,
  registerMcpSessionServer,
  reserveSessionSlot,
  runWithRequestContext,
  type SessionStore,
  startSessionCleanupLoop,
} from '../lib/core.js';
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
import { buildAuthenticatedOwnerKey } from '../tasks/owner.js';
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

function resolveRequestedProtocolVersion(body: unknown): string {
  if (!isObject(body)) return DEFAULT_MCP_PROTOCOL_VERSION;

  const { params } = body;
  if (!isObject(params)) return DEFAULT_MCP_PROTOCOL_VERSION;

  const { protocolVersion: value } = params;
  if (typeof value !== 'string') return DEFAULT_MCP_PROTOCOL_VERSION;

  const normalized = value.trim();
  if (normalized.length === 0) return DEFAULT_MCP_PROTOCOL_VERSION;
  return SUPPORTED_MCP_PROTOCOL_VERSIONS.has(normalized)
    ? normalized
    : DEFAULT_MCP_PROTOCOL_VERSION;
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

function logGatewayRejection(params: {
  message: string;
  method?: string | undefined;
  path: string;
  reason: string;
  status?: number;
  mcpCode?: number;
  sessionId?: string | null;
  rpcId?: JsonRpcId;
  details?: Record<string, unknown>;
}): void {
  const { message, details, rpcId, ...rest } = params;
  logWarn(
    message,
    {
      ...rest,
      ...(rpcId === null || rpcId === undefined ? {} : { rpcId }),
      ...(details ?? {}),
    },
    'http'
  );
}

function resolveRequestPath(req: IncomingMessage): string {
  return URL.parse(req.url ?? '', 'http://localhost')?.pathname ?? '/';
}

function logRequestCompletion(params: {
  method?: string;
  path: string;
  statusCode: number;
  durationMs: number;
  requestId: string;
  sessionId?: string;
}): void {
  const meta = {
    method: params.method,
    path: params.path,
    statusCode: params.statusCode,
    durationMs: Math.round(params.durationMs),
    requestId: params.requestId,
    ...(params.sessionId ? { sessionId: params.sessionId } : {}),
  };

  if (params.statusCode >= 500) {
    logError('HTTP request completed with server error', meta, 'http');
    return;
  }

  if (params.statusCode >= 400) {
    logWarn('HTTP request completed with client error', meta, 'http');
    return;
  }

  logDebug('HTTP request completed', meta, 'http');
}

function createSessionTeardownOptions(
  mode: 'ended' | 'evicted' | 'shutdown' | 'init-timeout',
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
    case 'init-timeout':
      return {
        cancelMessage:
          'The task was cancelled because the MCP session did not finish initialization.',
        closeTransportReason: 'session-init-timeout',
        closeServerReason: 'session-init-timeout',
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

    logDebug(
      'MCP POST received',
      {
        method: method ?? 'response',
        rpcId: body.id,
        sessionId,
      },
      'http'
    );

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
      logGatewayRejection({
        message: 'Rejected MCP GET request',
        method: ctx.method,
        path: ctx.url.pathname,
        reason: 'accept_missing_event_stream',
        status: 406,
        sessionId,
      });
      sendJson(ctx.res, 406, {
        error: 'We need you to use "text/event-stream" for this connection.',
      });
      return;
    }

    logDebug('MCP GET received', { sessionId }, 'http');
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
    logDebug('MCP DELETE received', { sessionId }, 'http');
    this.cleanupSessionRecord(
      sessionId,
      createSessionTeardownOptions('ended', 'session-delete')
    );

    sendJson(ctx.res, 200, { status: 'closed' });
  }

  private validatePostRequest(
    ctx: AuthenticatedContext
  ): PostRequestBody | null {
    if (!acceptsJsonAndEventStream(getHeaderValue(ctx.req, 'accept'))) {
      logGatewayRejection({
        message: 'Rejected MCP POST request',
        method: ctx.method,
        path: ctx.url.pathname,
        reason: 'accept_missing_json_or_event_stream',
        status: 406,
      });
      sendJson(ctx.res, 406, {
        error:
          'We need the request to accept both "application/json" and "text/event-stream".',
      });
      return null;
    }

    const { body } = ctx;
    if (isJsonRpcBatchRequest(body)) {
      logGatewayRejection({
        message: 'Rejected MCP POST request',
        method: ctx.method,
        path: ctx.url.pathname,
        reason: 'batch_request_not_supported',
        status: 400,
        mcpCode: -32600,
      });
      sendError(
        ctx.res,
        -32600,
        "We don't support batch requests yet. Please send one request at a time."
      );
      return null;
    }
    if (!isMcpMessageBody(body)) {
      logGatewayRejection({
        message: 'Rejected MCP POST request',
        method: ctx.method,
        path: ctx.url.pathname,
        reason: 'invalid_request_body',
        status: 400,
        mcpCode: -32600,
      });
      sendError(
        ctx.res,
        -32600,
        "The request body isn't quite right. Please check the format and try again."
      );
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
      logGatewayRejection({
        message: 'Rejected MCP POST request',
        method: ctx.method,
        path: ctx.url.pathname,
        reason: 'initialized_request_must_be_notification',
        status: 400,
        mcpCode: -32600,
        rpcId: requestId,
      });
      sendError(
        ctx.res,
        -32600,
        "The 'notifications/initialized' message must be sent as a notification, without an ID.",
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
        logGatewayRejection({
          message: 'Rejected MCP POST request',
          method: ctx.method,
          path: ctx.url.pathname,
          reason: 'missing_session_id_for_initialized_notification',
          status: 400,
          mcpCode: -32600,
          rpcId: requestId,
        });
        sendError(
          ctx.res,
          -32600,
          "We couldn't find a session ID for your request. Please ensure you have an active session.",
          400,
          requestId
        );
        return false;
      }

      return true;
    }

    if (!this.ensureSessionProtocolVersion(ctx, session)) return false;
    if (session.protocolInitialized) return true;
    if (isInitNotification) return true;
    if (method !== null && isPingRequest(method)) return true;

    logGatewayRejection({
      message: 'Rejected MCP request',
      method: ctx.method,
      path: ctx.url.pathname,
      reason: 'session_not_initialized',
      status: 400,
      mcpCode: -32600,
      sessionId,
      rpcId: requestId,
    });
    sendError(
      ctx.res,
      -32600,
      "Your session hasn't been initialized yet. Please wait a moment and try again.",
      400,
      requestId
    );
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
      logGatewayRejection({
        message: 'Rejected MCP initialize request',
        method: ctx.method,
        path: ctx.url.pathname,
        reason: 'missing_session_id',
        status: 400,
        mcpCode: -32600,
        rpcId: requestId,
      });
      sendError(
        ctx.res,
        -32600,
        "We couldn't find a session ID for your request. Please ensure you have an active session.",
        400,
        requestId
      );
      return null;
    }

    if (!isInitializeRequest(ctx.body)) {
      const invalidInitialize = ctx.body.method === 'initialize';
      logGatewayRejection({
        message: 'Rejected MCP initialize request',
        method: ctx.method,
        path: ctx.url.pathname,
        reason: invalidInitialize
          ? 'invalid_initialize_request'
          : 'missing_session_id',
        status: 400,
        mcpCode: invalidInitialize ? -32602 : -32600,
        rpcId: requestId,
      });
      sendError(
        ctx.res,
        invalidInitialize ? -32602 : -32600,
        invalidInitialize
          ? 'The initialize request format is invalid. Please double-check your parameters.'
          : "We couldn't find a session ID for your request. Please ensure you have an active session.",
        400,
        requestId
      );
      return null;
    }

    const negotiatedProtocolVersion = resolveRequestedProtocolVersion(ctx.body);
    const headerProtocolVersion = resolveProtocolVersionHeader(ctx.req);
    if (
      headerProtocolVersion &&
      headerProtocolVersion !== negotiatedProtocolVersion
    ) {
      logGatewayRejection({
        message: 'Rejected MCP initialize request',
        method: ctx.method,
        path: ctx.url.pathname,
        reason: 'protocol_version_mismatch',
        status: 400,
        mcpCode: -32600,
        rpcId: requestId,
        details: {
          headerProtocolVersion,
          negotiatedProtocolVersion,
        },
      });
      sendError(
        ctx.res,
        -32600,
        `There's a mismatch in the protocol version. The header says '${headerProtocolVersion}' but the body says '${negotiatedProtocolVersion}'.`,
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
      sendError(
        ctx.res,
        -32600,
        "We couldn't find a session ID for your request. Please ensure you have an active session.",
        400,
        requestId
      );
      return null;
    }

    if (!this.ensureSessionProtocolVersion(ctx, session)) return null;
    if (options?.requireInitialized && !session.protocolInitialized) {
      sendError(
        ctx.res,
        -32600,
        "Your session hasn't been initialized yet. Please wait a moment and try again.",
        400,
        requestId
      );
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
      logGatewayRejection({
        message: 'Rejected MCP session request',
        path: '/mcp',
        reason: 'session_not_found',
        status: 404,
        mcpCode: -32600,
        sessionId,
        rpcId: requestId,
      });
      sendError(
        res,
        -32600,
        "We couldn't find your session. It might have expired or been closed.",
        404,
        requestId
      );
      return null;
    }

    if (!authFingerprint || session.authFingerprint !== authFingerprint) {
      logGatewayRejection({
        message: 'Rejected MCP session request',
        path: '/mcp',
        reason: 'session_auth_mismatch',
        status: 404,
        mcpCode: -32600,
        sessionId,
        rpcId: requestId,
      });
      sendError(
        res,
        -32600,
        "We couldn't find your session. It might have expired or been closed.",
        404,
        requestId
      );
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
    logDebug('Session initialized', { sessionId }, 'session');
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

        logWarn('Session init timeout', { sessionId }, 'session');
        this.cleanupSessionRecord(
          sessionId,
          createSessionTeardownOptions('init-timeout')
        );
        return;
      }

      logWarn(
        'Session init timeout before registration completed',
        { sessionId },
        'session'
      );
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
      logWarn(
        'Session transport connect failed',
        {
          sessionId,
          error: toError(err).message,
        },
        'session'
      );
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
      logError(
        'Session creation failed: missing auth context',
        {
          path: ctx.url.pathname,
          method: ctx.method,
        },
        'session'
      );
      sendError(
        ctx.res,
        -32603,
        "We're missing some authorization details to process this request.",
        500,
        requestId
      );
      return null;
    }

    const ownerKey = buildAuthenticatedOwnerKey(ctx.auth);
    if (!ownerKey) {
      logError(
        'Session creation failed: missing task owner context',
        {
          path: ctx.url.pathname,
          method: ctx.method,
        },
        'session'
      );
      sendError(
        ctx.res,
        -32603,
        "We're missing the owner information needed to authorize this request.",
        500,
        requestId
      );
      return null;
    }

    if (!this.reserveCapacity(ctx.res, requestId)) return null;

    const tracker = createSlotTracker(this.store);
    const newSessionId = randomUUID();
    let sessionServer: McpServer;
    try {
      sessionServer = await this.createSessionServer();
    } catch (error) {
      logError(
        'Session server creation failed',
        { sessionId: newSessionId, error: toError(error).message },
        'session'
      );
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
      logWarn(
        'Session closed before registration completed',
        { sessionId: newSessionId },
        'session'
      );
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
    registerMcpSessionOwnerKey(newSessionId, ownerKey);
    registerMcpSessionServer(newSessionId, sessionServer);
    logInfo(
      'Session created',
      { sessionId: newSessionId, negotiatedProtocolVersion },
      'session'
    );

    transportImpl.onclose = composeCloseHandlers(transportImpl.onclose, () => {
      this.cleanupSessionRecord(
        newSessionId,
        createSessionTeardownOptions('ended', 'session-close')
      );
    });

    return transportImpl;
  }

  private cleanupSessionRecord(
    sessionId: string,
    teardownOptions: SessionTeardownOptions
  ): void {
    const context =
      teardownOptions.closeTransportReason ??
      teardownOptions.closeServerReason ??
      'session';
    logDebug('Session cleanup', { sessionId, context }, 'session');
    this.clearSessionInitTimeout(sessionId);
    const session = this.store.remove(sessionId);
    if (!session) return;

    void teardownSessionResources(session, teardownOptions);
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
      logWarn(
        'Session capacity exhausted',
        { maxSessions: config.server.maxSessions },
        'session'
      );
      sendError(
        res,
        -32000,
        'The server is currently too busy to handle your request. Please try again in a little while.',
        503,
        requestId
      );
      return false;
    }

    // Double-check: capacity may have changed during the async eviction window above.
    if (!reserveSessionSlot(this.store, config.server.maxSessions)) {
      logWarn(
        'Session capacity exhausted (post-eviction)',
        { maxSessions: config.server.maxSessions },
        'session'
      );
      sendError(
        res,
        -32000,
        'The server is currently too busy to handle your request. Please try again in a little while.',
        503,
        requestId
      );
      return false;
    }

    return true;
  }
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

      if (isMcpRoute(ctx.url.pathname)) {
        const handled = await this.handleMcpRoutes(authCtx);
        if (handled) return;

        ctx.res.setHeader('Allow', 'DELETE, GET, OPTIONS, POST');
        sendJson(ctx.res, 405, {
          error:
            "Looks like you tried to use a method that isn't allowed here.",
        });
        return;
      }

      sendJson(ctx.res, 404, {
        error: "We couldn't find what you were looking for.",
      });
    } catch (err) {
      const error = toError(err);
      logError('Request failed', error, 'http');
      if (!ctx.res.writableEnded) {
        sendJson(ctx.res, 500, {
          error: "Something went wrong on our end. We're looking into it!",
        });
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
      logWarn(
        'Authentication failed',
        { message, method: ctx.method, path: ctx.url.pathname },
        'auth'
      );
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
  mcpMsg: "We couldn't parse the request body. Please ensure it's valid JSON.",
  restMsg:
    "The request body doesn't seem to be valid JSON. Please check and try again.",
};

const BODY_PARSE_ERRORS: Record<
  string,
  { statusCode: number; mcpCode: number; mcpMsg: string; restMsg: string }
> = {
  'payload-too-large': {
    statusCode: 413,
    mcpCode: -32600,
    mcpMsg: 'The request body is too large. Please send a smaller payload.',
    restMsg: 'That request is a bit too big for us to handle right now.',
  },
  'read-failed': {
    statusCode: 400,
    mcpCode: -32600,
    mcpMsg:
      'We ran into an issue reading the request. Please try sending it again.',
    restMsg:
      "The request body doesn't seem to be valid JSON. Please check and try again.",
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
    const path = resolveRequestPath(rawReq);
    const startTime = performance.now();

    rawRes.once('finish', () => {
      logRequestCompletion({
        path,
        statusCode: rawRes.statusCode,
        durationMs: performance.now() - startTime,
        requestId,
        ...(rawReq.method ? { method: rawReq.method } : {}),
        ...(sessionId ? { sessionId } : {}),
      });
    });

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

    logGatewayRejection({
      message: 'Rejected HTTP request',
      method: rawReq.method,
      path: resolveRequestPath(rawReq),
      reason: 'duplicate_single_value_header',
      status: 400,
      details: { header: duplicateHeader },
    });
    sendJson(rawRes, 400, {
      error: `It seems the '${duplicateHeader}' header was sent multiple times when it should only be sent once.`,
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
      sendJson(ctx.res, 429, {
        error:
          "You're sending requests a bit too quickly. Please slow down and try again.",
      });
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

      if (bodyErrorKind === 'payload-too-large') {
        logWarn(
          'The request body is too large. Please send a smaller payload.',
          { method: ctx.method, path: ctx.url.pathname },
          'http'
        );
      } else if (bodyErrorKind === 'read-failed' || bodyErrorKind === null) {
        logError('Request body parsing failed', toError(error), 'http');
      }

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
  logError('Request pipeline failed', toError(error), 'http');

  if (res.writableEnded) return;

  if (!res.headersSent) {
    sendJson(res, 500, {
      error: "Something went wrong on our end. We're looking into it!",
    });
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
    logInfo(`Stopping HTTP server (${signal})...`, undefined, 'http');

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
            r.reason instanceof Error ? r.reason : undefined,
            'http'
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
        teardownSessionRegistration(session.server);
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
  logInfo(
    `${protocol.toUpperCase()} server listening on port ${port}`,
    {
      platform: process.platform,
      arch: process.arch,
      hostname: hostname(),
      nodeVersion: process.version,
    },
    'http'
  );

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
