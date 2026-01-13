import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { setInterval as setIntervalPromise } from 'node:timers/promises';

import type {
  Express,
  NextFunction,
  Request,
  RequestHandler,
  Response,
  Router,
} from 'express';
import { z } from 'zod';

import {
  InvalidTokenError,
  ServerError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import {
  getOAuthProtectedResourceMetadataUrl,
  mcpAuthMetadataRouter,
} from '@modelcontextprotocol/sdk/server/auth/router.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

import { registerDownloadRoutes } from './cache.js';
import { config, enableHttpMode } from './config.js';
import { timingSafeEqualUtf8 } from './crypto.js';
import { FetchError, getErrorMessage } from './errors.js';
import { destroyAgents } from './fetch.js';
import { createMcpServer } from './mcp.js';
import {
  logDebug,
  logError,
  logInfo,
  logWarn,
  runWithRequestContext,
} from './observability.js';
import { shutdownTransformWorkerPool } from './transform.js';
import { isRecord } from './utils.js';

interface RateLimitEntry {
  count: number;
  resetTime: number;
  lastAccessed: number;
}

interface RateLimiterOptions {
  maxRequests: number;
  windowMs: number;
  cleanupIntervalMs: number;
}

interface SessionEntry {
  readonly transport: StreamableHTTPServerTransport;
  createdAt: number;
  lastSeen: number;
}

interface McpRequestParams {
  _meta?: Record<string, unknown>;
  [key: string]: unknown;
}

interface McpRequestBody {
  jsonrpc: '2.0';
  method: string;
  id?: string | number;
  params?: McpRequestParams;
}

interface RateLimitConfig extends RateLimiterOptions {
  enabled: boolean;
}

interface RateLimitMiddlewareResult {
  middleware: (req: Request, res: Response, next: NextFunction) => void;
  stop: () => void;
  store: Map<string, RateLimitEntry>;
}

function getRateLimitKey(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}

function createCleanupInterval(
  store: Map<string, RateLimitEntry>,
  options: RateLimitConfig
): AbortController {
  const controller = new AbortController();

  void startCleanupLoop(store, options, controller.signal).catch(
    handleCleanupError
  );

  return controller;
}

function createRateLimitMiddleware(
  options: RateLimitConfig
): RateLimitMiddlewareResult {
  const store = new Map<string, RateLimitEntry>();
  const cleanupController = createCleanupInterval(store, options);
  const stop = (): void => {
    cleanupController.abort();
  };
  const middleware = createRateLimitHandler(store, options);

  return { middleware, stop, store };
}

function createRateLimitHandler(
  store: Map<string, RateLimitEntry>,
  options: RateLimitConfig
): (req: Request, res: Response, next: NextFunction) => void {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (shouldSkipRateLimit(req, options)) {
      next();
      return;
    }

    const now = Date.now();
    const key = getRateLimitKey(req);
    const resolution = resolveRateLimitEntry(store, key, now, options);

    if (resolution.isNew) {
      next();
      return;
    }

    if (handleRateLimitExceeded(res, resolution.entry, now, options)) {
      return;
    }

    next();
  };
}

async function startCleanupLoop(
  store: Map<string, RateLimitEntry>,
  options: RateLimitConfig,
  signal: AbortSignal
): Promise<void> {
  for await (const getNow of setIntervalPromise(
    options.cleanupIntervalMs,
    Date.now,
    { signal, ref: false }
  )) {
    evictStaleEntries(store, options, getNow());
  }
}

function evictStaleEntries(
  store: Map<string, RateLimitEntry>,
  options: RateLimitConfig,
  now: number
): void {
  for (const [key, entry] of store.entries()) {
    if (now - entry.lastAccessed > options.windowMs * 2) {
      store.delete(key);
    }
  }
}

function isSessionAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function handleCleanupError(error: unknown): void {
  if (isAbortError(error)) {
    return;
  }

  logWarn('Rate limit cleanup loop failed', {
    error: error instanceof Error ? error.message : 'Unknown error',
  });
}

function shouldSkipRateLimit(req: Request, options: RateLimitConfig): boolean {
  return !options.enabled || req.method === 'OPTIONS';
}

function resolveRateLimitEntry(
  store: Map<string, RateLimitEntry>,
  key: string,
  now: number,
  options: RateLimitConfig
): { entry: RateLimitEntry; isNew: boolean } {
  const existing = store.get(key);
  if (!existing || now > existing.resetTime) {
    const entry = createNewEntry(now, options);
    store.set(key, entry);
    return { entry, isNew: true };
  }

  updateEntry(existing, now);
  return { entry: existing, isNew: false };
}

function createNewEntry(now: number, options: RateLimitConfig): RateLimitEntry {
  return {
    count: 1,
    resetTime: now + options.windowMs,
    lastAccessed: now,
  };
}

function updateEntry(entry: RateLimitEntry, now: number): void {
  entry.count += 1;
  entry.lastAccessed = now;
}

function handleRateLimitExceeded(
  res: Response,
  entry: RateLimitEntry,
  now: number,
  options: RateLimitConfig
): boolean {
  if (entry.count <= options.maxRequests) {
    return false;
  }

  const retryAfter = Math.max(1, Math.ceil((entry.resetTime - now) / 1000));
  res.set('Retry-After', String(retryAfter));
  res.status(429).json({
    error: 'Rate limit exceeded',
    retryAfter,
  });
  return true;
}

function assertHttpConfiguration(): void {
  ensureBindAllowed();
  ensureStaticTokens();
  if (config.auth.mode === 'oauth') {
    ensureOauthConfiguration();
  }
}

function ensureBindAllowed(): void {
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

  if (
    !isLoopback &&
    config.security.allowRemote &&
    config.auth.mode !== 'oauth'
  ) {
    logError(
      'Remote HTTP mode requires OAuth configuration; refusing to start'
    );
    process.exit(1);
  }
}

function ensureStaticTokens(): void {
  if (config.auth.mode === 'static' && config.auth.staticTokens.length === 0) {
    logError('At least one static access token is required for HTTP mode');
    process.exit(1);
  }
}

function ensureOauthConfiguration(): void {
  if (!config.auth.issuerUrl || !config.auth.authorizationUrl) {
    logError(
      'OAUTH_ISSUER_URL and OAUTH_AUTHORIZATION_URL are required for OAuth mode'
    );
    process.exit(1);
  }

  if (!config.auth.tokenUrl) {
    logError('OAUTH_TOKEN_URL is required for OAuth mode');
    process.exit(1);
  }

  if (!config.auth.introspectionUrl) {
    logError('OAUTH_INTROSPECTION_URL is required for OAuth mode');
    process.exit(1);
  }
}

function createShutdownHandler(
  server: ReturnType<Express['listen']>,
  sessionStore: SessionStore,
  sessionCleanupController: AbortController,
  stopRateLimitCleanup: () => void
): (signal: string) => Promise<void> {
  let inFlight: Promise<void> | null = null;
  let initialSignal: string | null = null;

  return (signal: string): Promise<void> => {
    if (inFlight) {
      logWarn('Shutdown already in progress; ignoring signal', {
        signal,
        initialSignal,
      });
      return inFlight;
    }

    initialSignal = signal;
    inFlight = shutdownServer(
      signal,
      server,
      sessionStore,
      sessionCleanupController,
      stopRateLimitCleanup
    ).catch((error: unknown) => {
      logError(
        'Shutdown handler failed',
        error instanceof Error ? error : { error: getErrorMessage(error) }
      );
      throw error;
    });

    return inFlight;
  };
}

async function shutdownServer(
  signal: string,
  server: ReturnType<Express['listen']>,
  sessionStore: SessionStore,
  sessionCleanupController: AbortController,
  stopRateLimitCleanup: () => void
): Promise<void> {
  logInfo(`${signal} received, shutting down gracefully...`);

  stopRateLimitCleanup();
  sessionCleanupController.abort();

  await closeSessions(sessionStore);
  destroyAgents();
  await shutdownTransformWorkerPool();
  drainConnectionsOnShutdown(server);
  closeServer(server);
  scheduleForcedShutdown(10000);
}

async function closeSessions(sessionStore: SessionStore): Promise<void> {
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
}

function closeServer(server: ReturnType<Express['listen']>): void {
  server.close(() => {
    logInfo('HTTP server closed');
    process.exit(0);
  });
}

function scheduleForcedShutdown(timeoutMs: number): void {
  setTimeout(() => {
    logError('Forced shutdown after timeout');
    process.exit(1);
  }, timeoutMs).unref();
}

function registerSignalHandlers(
  shutdown: (signal: string) => Promise<void>
): void {
  process.once('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.once('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
}

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

  attachBaseMiddleware({
    app,
    jsonParser,
    rateLimitMiddleware,
    corsMiddleware,
  });
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
  applyHttpServerTuning(server);
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

interface ErrorResponse {
  error: {
    message: string;
    code: string;
    statusCode: number;
    details?: Record<string, unknown>;
    stack?: string;
  };
}

function getStatusCode(fetchError: FetchError | null): number {
  return fetchError ? fetchError.statusCode : 500;
}

function getErrorCode(fetchError: FetchError | null): string {
  return fetchError ? fetchError.code : 'INTERNAL_ERROR';
}

function getFetchErrorMessage(fetchError: FetchError | null): string {
  return fetchError ? fetchError.message : 'Internal Server Error';
}

function getErrorDetails(
  fetchError: FetchError | null
): Record<string, unknown> | undefined {
  if (fetchError && Object.keys(fetchError.details).length > 0) {
    return fetchError.details;
  }
  return undefined;
}

function resolveRetryAfter(fetchError: FetchError | null): string | undefined {
  if (fetchError?.statusCode !== 429) return undefined;

  const { retryAfter } = fetchError.details;
  return isRetryAfterValue(retryAfter) ? String(retryAfter) : undefined;
}

function isRetryAfterValue(value: unknown): boolean {
  return typeof value === 'number' || typeof value === 'string';
}

function setRetryAfterHeader(
  res: Response,
  fetchError: FetchError | null
): void {
  const retryAfter = resolveRetryAfter(fetchError);
  if (retryAfter === undefined) return;
  res.set('Retry-After', retryAfter);
}

function buildErrorResponse(fetchError: FetchError | null): ErrorResponse {
  const details = getErrorDetails(fetchError);
  const response: ErrorResponse = {
    error: {
      message: getFetchErrorMessage(fetchError),
      code: getErrorCode(fetchError),
      statusCode: getStatusCode(fetchError),
      ...(details && { details }),
    },
  };

  return response;
}

export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  next: NextFunction
): void {
  if (res.headersSent) {
    next(err);
    return;
  }

  const fetchError = err instanceof FetchError ? err : null;
  const statusCode = getStatusCode(fetchError);

  logError(
    `HTTP ${statusCode}: ${err.message} - ${req.method} ${req.path}`,
    err
  );

  setRetryAfterHeader(res, fetchError);

  res.status(statusCode).json(buildErrorResponse(fetchError));
}

export function normalizeHost(value: string): string | null {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return null;

  const first = takeFirstHostValue(trimmed);
  if (!first) return null;

  const ipv6 = stripIpv6Brackets(first);
  if (ipv6) return ipv6;

  if (isIpV6Literal(first)) {
    return first;
  }

  return stripPortIfPresent(first);
}

function takeFirstHostValue(value: string): string | null {
  const first = value.split(',')[0];
  if (!first) return null;
  const trimmed = first.trim();
  return trimmed ? trimmed : null;
}

function stripIpv6Brackets(value: string): string | null {
  if (!value.startsWith('[')) return null;
  const end = value.indexOf(']');
  if (end === -1) return null;
  return value.slice(1, end);
}

function stripPortIfPresent(value: string): string {
  const colonIndex = value.indexOf(':');
  if (colonIndex === -1) return value;
  return value.slice(0, colonIndex);
}

function isIpV6Literal(value: string): boolean {
  return isIP(value) === 6;
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

function getNonEmptyStringHeader(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function respondHostNotAllowed(res: Response): void {
  res.status(403).json({
    error: 'Host not allowed',
    code: 'HOST_NOT_ALLOWED',
  });
}

function respondOriginNotAllowed(res: Response): void {
  res.status(403).json({
    error: 'Origin not allowed',
    code: 'ORIGIN_NOT_ALLOWED',
  });
}

function tryParseOriginHostname(originHeader: string): string | null {
  try {
    return new URL(originHeader).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function isWildcardHost(host: string): boolean {
  return host === '0.0.0.0' || host === '::';
}

function addLoopbackHosts(allowedHosts: Set<string>): void {
  for (const host of LOOPBACK_HOSTS) {
    allowedHosts.add(host);
  }
}

function addConfiguredHost(allowedHosts: Set<string>): void {
  const configuredHost = normalizeHost(config.server.host);
  if (!configuredHost) return;
  if (isWildcardHost(configuredHost)) return;
  allowedHosts.add(configuredHost);
}

function addExplicitAllowedHosts(allowedHosts: Set<string>): void {
  for (const host of config.security.allowedHosts) {
    const normalized = normalizeHost(host);
    if (!normalized) {
      logDebug('Ignoring invalid allowed host entry', { host });
      continue;
    }
    allowedHosts.add(normalized);
  }
}

function buildAllowedHosts(): Set<string> {
  const allowedHosts = new Set<string>();

  addLoopbackHosts(allowedHosts);
  addConfiguredHost(allowedHosts);
  addExplicitAllowedHosts(allowedHosts);

  return allowedHosts;
}

function createHostValidationMiddleware(): RequestHandler {
  const allowedHosts = buildAllowedHosts();

  return (req: Request, res: Response, next: NextFunction): void => {
    const hostHeader =
      typeof req.headers.host === 'string' ? req.headers.host : '';

    const normalized = normalizeHost(hostHeader);

    if (!normalized || !allowedHosts.has(normalized)) {
      respondHostNotAllowed(res);
      return;
    }

    next();
  };
}

function createOriginValidationMiddleware(): RequestHandler {
  const allowedHosts = buildAllowedHosts();

  return (req: Request, res: Response, next: NextFunction): void => {
    const originHeader = getNonEmptyStringHeader(req.headers.origin);
    if (!originHeader) {
      next();
      return;
    }

    const originHostname = tryParseOriginHostname(originHeader);
    if (!originHostname || !allowedHosts.has(originHostname)) {
      respondOriginNotAllowed(res);
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
      sessionId === undefined
        ? { requestId, operationId: requestId }
        : { requestId, operationId: requestId, sessionId };

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

export function attachBaseMiddleware(options: {
  app: Express;
  jsonParser: RequestHandler;
  rateLimitMiddleware: RequestHandler;
  corsMiddleware: RequestHandler;
}): void {
  const { app, jsonParser, rateLimitMiddleware, corsMiddleware } = options;
  app.use(createHostValidationMiddleware());
  app.use(createOriginValidationMiddleware());
  app.use(jsonParser);
  app.use(createContextMiddleware());
  app.use(createJsonParseErrorHandler());
  app.use(corsMiddleware);
  app.use('/mcp', rateLimitMiddleware);
  registerHealthRoute(app);
}

export function createCorsMiddleware(): (
  req: Request,
  res: Response,
  next: NextFunction
) => void {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.method === 'OPTIONS') {
      res.sendStatus(200);
      return;
    }

    next();
  };
}

function parseScopes(value: unknown): string[] {
  if (typeof value === 'string') {
    return value
      .split(' ')
      .map((scope) => scope.trim())
      .filter((scope) => scope.length > 0);
  }

  if (Array.isArray(value)) {
    return value.filter((scope): scope is string => typeof scope === 'string');
  }

  return [];
}

function parseResourceUrl(value: unknown): URL | undefined {
  if (typeof value !== 'string') return undefined;
  if (!URL.canParse(value)) return undefined;
  return new URL(value);
}

function parseAudResource(aud: unknown): URL | undefined {
  if (typeof aud === 'string') {
    return parseResourceUrl(aud);
  }

  if (Array.isArray(aud)) {
    for (const entry of aud) {
      const parsed = parseResourceUrl(entry);
      if (parsed) return parsed;
    }
  }

  return undefined;
}

function extractResource(data: Record<string, unknown>): URL | undefined {
  const resource = parseResourceUrl(data.resource);
  if (resource) return resource;

  return parseAudResource(data.aud);
}

function extractScopes(data: Record<string, unknown>): string[] {
  if (data.scope !== undefined) {
    return parseScopes(data.scope);
  }

  if (data.scopes !== undefined) {
    return parseScopes(data.scopes);
  }

  if (data.scp !== undefined) {
    return parseScopes(data.scp);
  }

  return [];
}

function readExpiresAt(data: Record<string, unknown>): number {
  const expiresAt = typeof data.exp === 'number' ? data.exp : Number.NaN;
  if (!Number.isFinite(expiresAt)) {
    throw new InvalidTokenError('Token has no expiration time');
  }
  return expiresAt;
}

function resolveClientId(data: Record<string, unknown>): string {
  if (typeof data.client_id === 'string') return data.client_id;
  if (typeof data.cid === 'string') return data.cid;
  if (typeof data.sub === 'string') return data.sub;
  return 'unknown';
}

function stripHash(url: URL): string {
  const copy = new URL(url.href);
  copy.hash = '';
  return copy.href;
}

function ensureResourceMatch(resource: URL | undefined): URL {
  if (!resource) {
    throw new InvalidTokenError('Token resource mismatch');
  }
  if (stripHash(resource) !== stripHash(config.auth.resourceUrl)) {
    throw new InvalidTokenError('Token resource mismatch');
  }
  return resource;
}

function buildIntrospectionAuthInfo(
  token: string,
  data: Record<string, unknown>
): AuthInfo {
  const resource = ensureResourceMatch(extractResource(data));

  return {
    token,
    clientId: resolveClientId(data),
    scopes: extractScopes(data),
    expiresAt: readExpiresAt(data),
    resource,
    extra: data,
  };
}

interface IntrospectionRequest {
  body: string;
  headers: Record<string, string>;
}

function buildBasicAuthHeader(
  clientId: string,
  clientSecret: string | undefined
): string {
  const secret = clientSecret ?? '';
  const basic = Buffer.from(`${clientId}:${secret}`, 'utf8').toString('base64');
  return `Basic ${basic}`;
}

function buildIntrospectionRequest(
  token: string,
  resourceUrl: URL,
  clientId: string | undefined,
  clientSecret: string | undefined
): IntrospectionRequest {
  const body = new URLSearchParams({
    token,
    token_type_hint: 'access_token',
    resource: stripHash(resourceUrl),
  }).toString();
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
  };
  if (clientId) {
    headers.authorization = buildBasicAuthHeader(clientId, clientSecret);
  }

  return { body, headers };
}

async function requestIntrospection(
  introspectionUrl: URL,
  request: IntrospectionRequest,
  timeoutMs: number
): Promise<unknown> {
  const response = await fetch(introspectionUrl, {
    method: 'POST',
    headers: request.headers,
    body: request.body,
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    await response.body?.cancel();
    throw new ServerError(`Token introspection failed: ${response.status}`);
  }

  return response.json();
}

function parseIntrospectionPayload(payload: unknown): Record<string, unknown> {
  if (!isRecord(payload) || Array.isArray(payload)) {
    throw new ServerError('Invalid introspection response');
  }
  if (payload.active !== true) {
    throw new InvalidTokenError('Token is inactive');
  }
  return payload;
}

async function verifyWithIntrospection(token: string): Promise<AuthInfo> {
  const { auth } = config;
  if (!auth.introspectionUrl) {
    throw new ServerError('Token introspection is not configured');
  }
  const request = buildIntrospectionRequest(
    token,
    auth.resourceUrl,
    auth.clientId,
    auth.clientSecret
  );
  const payload = await requestIntrospection(
    auth.introspectionUrl,
    request,
    auth.introspectionTimeoutMs
  );
  return buildIntrospectionAuthInfo(token, parseIntrospectionPayload(payload));
}

const STATIC_TOKEN_TTL_SECONDS = 60 * 60 * 24;

function buildStaticAuthInfo(token: string): AuthInfo {
  return {
    token,
    clientId: 'static-token',
    scopes: config.auth.requiredScopes,
    expiresAt: Math.floor(Date.now() / 1000) + STATIC_TOKEN_TTL_SECONDS,
    resource: config.auth.resourceUrl,
  };
}

function verifyStaticToken(token: string): AuthInfo {
  if (config.auth.staticTokens.length === 0) {
    throw new InvalidTokenError('No static tokens configured');
  }

  const matched = config.auth.staticTokens.some((candidate) =>
    timingSafeEqualUtf8(candidate, token)
  );
  if (!matched) {
    throw new InvalidTokenError('Invalid token');
  }

  return buildStaticAuthInfo(token);
}

function normalizeHeaderValue(
  header: string | string[] | undefined
): string | undefined {
  return Array.isArray(header) ? header[0] : header;
}

function getApiKeyHeader(req: Request): string | null {
  const apiKeyHeader = normalizeHeaderValue(req.headers['x-api-key']);
  return apiKeyHeader ? apiKeyHeader.trim() : null;
}

function createLegacyApiKeyMiddleware(): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (config.auth.mode !== 'static') {
      next();
      return;
    }

    if (!req.headers.authorization) {
      const apiKey = getApiKeyHeader(req);
      if (apiKey) {
        req.headers.authorization = `Bearer ${apiKey}`;
      }
    }

    next();
  };
}

async function verifyAccessToken(token: string): Promise<AuthInfo> {
  if (config.auth.mode === 'oauth') {
    return verifyWithIntrospection(token);
  }

  return verifyStaticToken(token);
}

function resolveMetadataUrl(): string | null {
  if (config.auth.mode !== 'oauth') return null;
  return getOAuthProtectedResourceMetadataUrl(new URL(config.auth.resourceUrl));
}

function resolveOptionalScopes(
  requiredScopes: readonly string[]
): string[] | undefined {
  return requiredScopes.length > 0 ? [...requiredScopes] : undefined;
}

type OAuthAuthConfig = typeof config.auth;

function resolveOAuthMetadataParams(
  authConfig: OAuthAuthConfig
): OAuthMetadataParams | null {
  const {
    issuerUrl,
    authorizationUrl,
    tokenUrl,
    revocationUrl,
    registrationUrl,
    requiredScopes,
  } = authConfig;

  if (!issuerUrl || !authorizationUrl || !tokenUrl) return null;

  return {
    issuerUrl,
    authorizationUrl,
    tokenUrl,
    revocationUrl,
    registrationUrl,
    requiredScopes,
  };
}

interface OAuthMetadata extends Record<string, unknown> {
  issuer: string;
  authorization_endpoint: string;
  response_types_supported: string[];
  code_challenge_methods_supported: string[];
  token_endpoint: string;
  token_endpoint_auth_methods_supported: string[];
  grant_types_supported: string[];
  scopes_supported?: string[];
  revocation_endpoint?: string;
  registration_endpoint?: string;
}

interface OAuthMetadataParams {
  issuerUrl: URL;
  authorizationUrl: URL;
  tokenUrl: URL;
  revocationUrl: URL | undefined;
  registrationUrl: URL | undefined;
  requiredScopes: readonly string[];
}

type OptionalEndpointKey = 'revocation_endpoint' | 'registration_endpoint';

function buildBaseOAuthMetadata(params: OAuthMetadataParams): OAuthMetadata {
  return {
    issuer: params.issuerUrl.href,
    authorization_endpoint: params.authorizationUrl.href,
    response_types_supported: ['code'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint: params.tokenUrl.href,
    token_endpoint_auth_methods_supported: ['client_secret_post', 'none'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
  };
}

function applyOptionalScopes(
  metadata: OAuthMetadata,
  requiredScopes: readonly string[]
): void {
  const scopesSupported = resolveOptionalScopes(requiredScopes);
  if (scopesSupported !== undefined) {
    metadata.scopes_supported = scopesSupported;
  }
}

function applyOptionalEndpoint(
  metadata: OAuthMetadata,
  key: OptionalEndpointKey,
  url: URL | undefined
): void {
  if (!url) return;
  metadata[key] = url.href;
}

function buildOAuthMetadata(params: OAuthMetadataParams): OAuthMetadata {
  const oauthMetadata = buildBaseOAuthMetadata(params);
  applyOptionalScopes(oauthMetadata, params.requiredScopes);
  applyOptionalEndpoint(
    oauthMetadata,
    'revocation_endpoint',
    params.revocationUrl
  );
  applyOptionalEndpoint(
    oauthMetadata,
    'registration_endpoint',
    params.registrationUrl
  );
  return oauthMetadata;
}

function createAuthMiddleware(): RequestHandler {
  const metadataUrl = resolveMetadataUrl();
  const authHandler = requireBearerAuth({
    verifier: { verifyAccessToken },
    requiredScopes: config.auth.requiredScopes,
    ...(metadataUrl ? { resourceMetadataUrl: metadataUrl } : {}),
  });
  const legacyHandler = createLegacyApiKeyMiddleware();

  return (req: Request, res: Response, next: NextFunction): void => {
    legacyHandler(req, res, () => {
      authHandler(req, res, next);
    });
  };
}

function createAuthMetadataRouter(): Router | null {
  if (config.auth.mode !== 'oauth') return null;

  const oauthMetadataParams = resolveOAuthMetadataParams(config.auth);
  if (!oauthMetadataParams) return null;

  return mcpAuthMetadataRouter({
    oauthMetadata: buildOAuthMetadata(oauthMetadataParams),
    resourceServerUrl: config.auth.resourceUrl,
    scopesSupported: config.auth.requiredScopes,
    resourceName: config.server.name,
  });
}

export interface SessionStore {
  get: (sessionId: string) => SessionEntry | undefined;
  touch: (sessionId: string) => void;
  set: (sessionId: string, entry: SessionEntry) => void;
  remove: (sessionId: string) => SessionEntry | undefined;
  size: () => number;
  clear: () => SessionEntry[];
  evictExpired: () => SessionEntry[];
  evictOldest: () => SessionEntry | undefined;
}

interface McpSessionOptions {
  readonly sessionStore: SessionStore;
  readonly maxSessions: number;
}

type JsonRpcId = string | number | null;

function sendJsonRpcError(
  res: Response,
  code: number,
  message: string,
  status = 400,
  id: JsonRpcId = null
): void {
  res.status(status).json({
    jsonrpc: '2.0',
    error: {
      code,
      message,
    },
    id,
  });
}

function getSessionId(req: Request): string | undefined {
  const header = req.headers['mcp-session-id'];
  return Array.isArray(header) ? header[0] : header;
}

export function createSessionStore(sessionTtlMs: number): SessionStore {
  const sessions = new Map<string, SessionEntry>();

  return {
    get: (sessionId) => sessions.get(sessionId),
    touch: (sessionId) => {
      touchSession(sessions, sessionId);
    },
    set: (sessionId, entry) => {
      sessions.set(sessionId, entry);
    },
    remove: (sessionId) => removeSession(sessions, sessionId),
    size: () => sessions.size,
    clear: () => clearSessions(sessions),
    evictExpired: () => evictExpiredSessions(sessions, sessionTtlMs),
    evictOldest: () => evictOldestSession(sessions),
  };
}

function touchSession(
  sessions: Map<string, SessionEntry>,
  sessionId: string
): void {
  const session = sessions.get(sessionId);
  if (session) {
    session.lastSeen = Date.now();
  }
}

function removeSession(
  sessions: Map<string, SessionEntry>,
  sessionId: string
): SessionEntry | undefined {
  const session = sessions.get(sessionId);
  sessions.delete(sessionId);
  return session;
}

function clearSessions(sessions: Map<string, SessionEntry>): SessionEntry[] {
  const entries = Array.from(sessions.values());
  sessions.clear();
  return entries;
}

function evictExpiredSessions(
  sessions: Map<string, SessionEntry>,
  sessionTtlMs: number
): SessionEntry[] {
  const now = Date.now();
  const evicted: SessionEntry[] = [];

  for (const [id, session] of sessions.entries()) {
    if (now - session.lastSeen > sessionTtlMs) {
      sessions.delete(id);
      evicted.push(session);
    }
  }

  return evicted;
}

function evictOldestSession(
  sessions: Map<string, SessionEntry>
): SessionEntry | undefined {
  let oldestId: string | undefined;
  let oldestSeen = Number.POSITIVE_INFINITY;

  for (const [id, session] of sessions.entries()) {
    if (session.lastSeen < oldestSeen) {
      oldestSeen = session.lastSeen;
      oldestId = id;
    }
  }

  if (!oldestId) return undefined;
  const session = sessions.get(oldestId);
  sessions.delete(oldestId);
  return session;
}

let inFlightSessions = 0;

export function reserveSessionSlot(
  store: SessionStore,
  maxSessions: number
): boolean {
  if (store.size() + inFlightSessions >= maxSessions) {
    return false;
  }
  inFlightSessions += 1;
  return true;
}

function releaseSessionSlot(): void {
  if (inFlightSessions > 0) {
    inFlightSessions -= 1;
  }
}

interface SlotTracker {
  readonly releaseSlot: () => void;
  readonly markInitialized: () => void;
  readonly isInitialized: () => boolean;
}

export function createSlotTracker(): SlotTracker {
  let slotReleased = false;
  let initialized = false;
  return {
    releaseSlot: (): void => {
      if (slotReleased) return;
      slotReleased = true;
      releaseSessionSlot();
    },
    markInitialized: (): void => {
      initialized = true;
    },
    isInitialized: (): boolean => initialized,
  };
}

function isServerAtCapacity(store: SessionStore, maxSessions: number): boolean {
  return store.size() + inFlightSessions >= maxSessions;
}

function tryEvictSlot(
  store: SessionStore,
  maxSessions: number,
  evictOldest: (store: SessionStore) => boolean
): boolean {
  const currentSize = store.size();
  const canFreeSlot =
    currentSize >= maxSessions &&
    currentSize - 1 + inFlightSessions < maxSessions;
  return canFreeSlot && evictOldest(store);
}

export function ensureSessionCapacity({
  store,
  maxSessions,
  res,
  evictOldest,
}: {
  store: SessionStore;
  maxSessions: number;
  res: Response;
  evictOldest: (store: SessionStore) => boolean;
}): boolean {
  if (!isServerAtCapacity(store, maxSessions)) {
    return true;
  }

  if (tryEvictSlot(store, maxSessions, evictOldest)) {
    return !isServerAtCapacity(store, maxSessions);
  }

  respondServerBusy(res);
  return false;
}

function respondServerBusy(res: Response): void {
  sendJsonRpcError(
    res,
    -32000,
    'Server busy: maximum sessions reached',
    503,
    null
  );
}

function respondBadRequest(res: Response, id: string | number | null): void {
  sendJsonRpcError(
    res,
    -32000,
    'Bad Request: Missing session ID or not an initialize request',
    400,
    id
  );
}

function createTimeoutController(): {
  clear: () => void;
  set: (timeout: NodeJS.Timeout | null) => void;
} {
  let initTimeout: NodeJS.Timeout | null = null;
  return {
    clear: (): void => {
      if (!initTimeout) return;
      clearTimeout(initTimeout);
      initTimeout = null;
    },
    set: (timeout: NodeJS.Timeout | null): void => {
      initTimeout = timeout;
    },
  };
}

function createTransportAdapter(
  transport: StreamableHTTPServerTransport
): Transport {
  const adapter = buildTransportAdapter(transport);
  attachTransportAccessors(adapter, transport);
  return adapter;
}

function buildTransportAdapter(
  transport: StreamableHTTPServerTransport
): Transport {
  return {
    start: () => transport.start(),
    send: (message, options) => transport.send(message, options),
    close: () => transport.close(),
  };
}

function createAccessorDescriptor<T>(
  getter: () => T,
  setter?: (value: T) => void
): PropertyDescriptor {
  return {
    get: getter,
    ...(setter ? { set: setter } : {}),
    enumerable: true,
    configurable: true,
  };
}

type CloseHandler = (() => void) | undefined;
type ErrorHandler = ((error: Error) => void) | undefined;
type MessageHandler = Transport['onmessage'];

export function composeCloseHandlers(
  first: CloseHandler,
  second: CloseHandler
): CloseHandler {
  if (!first) return second;
  if (!second) return first;
  return () => {
    try {
      first();
    } finally {
      second();
    }
  };
}

function createOnCloseDescriptor(
  transport: StreamableHTTPServerTransport
): PropertyDescriptor {
  return createAccessorDescriptor(
    () => transport.onclose,
    (handler: CloseHandler) => {
      transport.onclose = handler;
    }
  );
}

function createOnErrorDescriptor(
  transport: StreamableHTTPServerTransport
): PropertyDescriptor {
  return createAccessorDescriptor(
    () => transport.onerror,
    (handler: ErrorHandler) => {
      transport.onerror = handler;
    }
  );
}

function createOnMessageDescriptor(
  transport: StreamableHTTPServerTransport
): PropertyDescriptor {
  return createAccessorDescriptor(
    () => transport.onmessage,
    (handler: MessageHandler) => {
      transport.onmessage = handler;
    }
  );
}

function attachTransportAccessors(
  adapter: Transport,
  transport: StreamableHTTPServerTransport
): void {
  Object.defineProperties(adapter, {
    onclose: createOnCloseDescriptor(transport),
    onerror: createOnErrorDescriptor(transport),
    onmessage: createOnMessageDescriptor(transport),
    sessionId: createAccessorDescriptor(() => transport.sessionId),
  });
}

function startSessionInitTimeout({
  transport,
  tracker,
  clearInitTimeout,
  timeoutMs,
}: {
  transport: StreamableHTTPServerTransport;
  tracker: SlotTracker;
  clearInitTimeout: () => void;
  timeoutMs: number;
}): NodeJS.Timeout | null {
  if (timeoutMs <= 0) return null;
  const timeout = setTimeout(() => {
    clearInitTimeout();
    if (tracker.isInitialized()) return;
    tracker.releaseSlot();
    void transport.close().catch((error: unknown) => {
      logWarn('Failed to close stalled session', {
        error: getErrorMessage(error),
      });
    });
    logWarn('Session initialization timed out', { timeoutMs });
  }, timeoutMs);
  timeout.unref();
  return timeout;
}

function createSessionTransport({
  tracker,
  timeoutController,
}: {
  tracker: SlotTracker;
  timeoutController: ReturnType<typeof createTimeoutController>;
}): StreamableHTTPServerTransport {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });
  transport.onclose = () => {
    timeoutController.clear();
    if (!tracker.isInitialized()) {
      tracker.releaseSlot();
    }
  };
  timeoutController.set(
    startSessionInitTimeout({
      transport,
      tracker,
      clearInitTimeout: timeoutController.clear,
      timeoutMs: config.server.sessionInitTimeoutMs,
    })
  );
  return transport;
}

async function connectTransportOrThrow({
  transport,
  clearInitTimeout,
  releaseSlot,
}: {
  transport: StreamableHTTPServerTransport;
  clearInitTimeout: () => void;
  releaseSlot: () => void;
}): Promise<void> {
  const mcpServer = createMcpServer();
  const transportAdapter = createTransportAdapter(transport);
  const oncloseBeforeConnect = transport.onclose;
  try {
    await mcpServer.connect(transportAdapter);
    if (oncloseBeforeConnect && transport.onclose !== oncloseBeforeConnect) {
      transport.onclose = composeCloseHandlers(
        transport.onclose,
        oncloseBeforeConnect
      );
    }
  } catch (error) {
    clearInitTimeout();
    releaseSlot();
    void transport.close().catch((closeError: unknown) => {
      logWarn('Failed to close transport after connect error', {
        error: getErrorMessage(closeError),
      });
    });
    logError(
      'Failed to initialize MCP session',
      error instanceof Error ? error : undefined
    );
    throw error;
  }
}

function evictExpiredSessionsWithClose(store: SessionStore): number {
  const evicted = store.evictExpired();
  for (const session of evicted) {
    void session.transport.close().catch((error: unknown) => {
      logWarn('Failed to close expired session', {
        error: getErrorMessage(error),
      });
    });
  }
  return evicted.length;
}

function evictOldestSessionWithClose(store: SessionStore): boolean {
  const session = store.evictOldest();
  if (!session) return false;
  void session.transport.close().catch((error: unknown) => {
    logWarn('Failed to close evicted session', {
      error: getErrorMessage(error),
    });
  });
  return true;
}

function reserveSessionIfPossible({
  options,
  res,
}: {
  options: McpSessionOptions;
  res: Response;
}): boolean {
  if (
    !ensureSessionCapacity({
      store: options.sessionStore,
      maxSessions: options.maxSessions,
      res,
      evictOldest: evictOldestSessionWithClose,
    })
  ) {
    return false;
  }
  if (!reserveSessionSlot(options.sessionStore, options.maxSessions)) {
    respondServerBusy(res);
    return false;
  }
  return true;
}

function resolveSessionId({
  transport,
  res,
  tracker,
  clearInitTimeout,
}: {
  transport: StreamableHTTPServerTransport;
  res: Response;
  tracker: SlotTracker;
  clearInitTimeout: () => void;
}): string | null {
  const { sessionId } = transport;
  if (typeof sessionId !== 'string') {
    clearInitTimeout();
    tracker.releaseSlot();
    respondBadRequest(res, null);
    return null;
  }
  return sessionId;
}

function finalizeSession({
  store,
  transport,
  sessionId,
  tracker,
  clearInitTimeout,
}: {
  store: SessionStore;
  transport: StreamableHTTPServerTransport;
  sessionId: string;
  tracker: SlotTracker;
  clearInitTimeout: () => void;
}): void {
  clearInitTimeout();
  tracker.markInitialized();
  tracker.releaseSlot();
  const now = Date.now();
  store.set(sessionId, {
    transport,
    createdAt: now,
    lastSeen: now,
  });
  const previousOnClose = transport.onclose;
  transport.onclose = composeCloseHandlers(previousOnClose, () => {
    store.remove(sessionId);
    logInfo('Session closed');
  });
  logInfo('Session initialized');
}

async function createAndConnectTransport({
  options,
  res,
}: {
  options: McpSessionOptions;
  res: Response;
}): Promise<StreamableHTTPServerTransport | null> {
  if (!reserveSessionIfPossible({ options, res })) return null;

  const tracker = createSlotTracker();
  const timeoutController = createTimeoutController();
  const transport = createSessionTransport({ tracker, timeoutController });

  await connectTransportOrThrow({
    transport,
    clearInitTimeout: timeoutController.clear,
    releaseSlot: tracker.releaseSlot,
  });

  const sessionId = resolveSessionId({
    transport,
    res,
    tracker,
    clearInitTimeout: timeoutController.clear,
  });
  if (!sessionId) return null;

  finalizeSession({
    store: options.sessionStore,
    transport,
    sessionId,
    tracker,
    clearInitTimeout: timeoutController.clear,
  });
  return transport;
}

export async function resolveTransportForPost({
  res,
  body,
  sessionId,
  options,
}: {
  res: Response;
  body: Pick<McpRequestBody, 'method' | 'id'>;
  sessionId: string | undefined;
  options: McpSessionOptions;
}): Promise<StreamableHTTPServerTransport | null> {
  if (sessionId) {
    const existingSession = options.sessionStore.get(sessionId);
    if (existingSession) {
      options.sessionStore.touch(sessionId);
      return existingSession.transport;
    }

    // Client supplied a session id but it doesn't exist; Streamable HTTP: invalid session IDs => 404.
    sendJsonRpcError(res, -32600, 'Session not found', 404, body.id ?? null);
    return null;
  }
  if (!isInitializeRequest(body)) {
    respondBadRequest(res, body.id ?? null);
    return null;
  }
  evictExpiredSessionsWithClose(options.sessionStore);
  return createAndConnectTransport({ options, res });
}

function startSessionCleanupLoop(
  store: SessionStore,
  sessionTtlMs: number
): AbortController {
  const controller = new AbortController();
  void runSessionCleanupLoop(store, sessionTtlMs, controller.signal).catch(
    handleSessionCleanupError
  );
  return controller;
}

async function runSessionCleanupLoop(
  store: SessionStore,
  sessionTtlMs: number,
  signal: AbortSignal
): Promise<void> {
  const intervalMs = getCleanupIntervalMs(sessionTtlMs);
  for await (const getNow of setIntervalPromise(intervalMs, Date.now, {
    signal,
    ref: false,
  })) {
    handleSessionEvictions(store, getNow());
  }
}

function getCleanupIntervalMs(sessionTtlMs: number): number {
  return Math.min(Math.max(Math.floor(sessionTtlMs / 2), 10000), 60000);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function handleSessionEvictions(store: SessionStore, now: number): void {
  const evicted = evictExpiredSessionsWithClose(store);
  if (evicted > 0) {
    logInfo('Expired sessions evicted', {
      evicted,
      timestamp: new Date(now).toISOString(),
    });
  }
}

function handleSessionCleanupError(error: unknown): void {
  if (isSessionAbortError(error)) {
    return;
  }
  logWarn('Session cleanup loop failed', {
    error: error instanceof Error ? error.message : 'Unknown error',
  });
}

const paramsSchema = z.looseObject({});

const mcpRequestSchema = z.looseObject({
  jsonrpc: z.literal('2.0'),
  method: z.string().min(1),
  id: z.union([z.string(), z.number()]).optional(),
  params: paramsSchema.optional(),
});

type RequestWithUnknownBody = Omit<Request, 'body'> & { body: unknown };

function wrapAsync(
  fn: (req: Request, res: Response) => void | Promise<void>
): (req: Request, res: Response, next: NextFunction) => void {
  return (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(fn(req, res)).catch(next);
  };
}

export function isJsonRpcBatchRequest(body: unknown): boolean {
  return Array.isArray(body);
}

export function isMcpRequestBody(body: unknown): body is McpRequestBody {
  return mcpRequestSchema.safeParse(body).success;
}

function respondInvalidRequestBody(res: Response): void {
  sendJsonRpcError(res, -32600, 'Invalid Request: Malformed request body', 400);
}

function respondMissingSession(res: Response): void {
  sendJsonRpcError(res, -32600, 'Missing mcp-session-id header', 400);
}

function respondSessionNotFound(res: Response): void {
  sendJsonRpcError(res, -32600, 'Session not found', 404);
}

function validatePostPayload(
  payload: unknown,
  res: Response
): McpRequestBody | null {
  if (isJsonRpcBatchRequest(payload)) {
    sendJsonRpcError(res, -32600, 'Batch requests are not supported', 400);
    return null;
  }

  if (!isMcpRequestBody(payload)) {
    respondInvalidRequestBody(res);
    return null;
  }

  return payload;
}

function logPostRequest(
  body: McpRequestBody,
  sessionId: string | undefined,
  options: McpSessionOptions
): void {
  logInfo('[MCP POST]', {
    method: body.method,
    id: body.id,
    isInitialize: body.method === 'initialize',
    sessionCount: options.sessionStore.size(),
  });
}

async function handleTransportRequest(
  transport: StreamableHTTPServerTransport,
  req: Request,
  res: Response,
  body?: McpRequestBody
): Promise<void> {
  try {
    await dispatchTransportRequest(transport, req, res, body);
  } catch (error) {
    logError(
      'MCP request handling failed',
      error instanceof Error ? error : undefined
    );
    handleTransportError(res, body?.id ?? null);
  }
}

function handleTransportError(res: Response, id: string | number | null): void {
  if (res.headersSent) return;
  sendJsonRpcError(res, -32603, 'Internal error', 500, id);
}

function dispatchTransportRequest(
  transport: StreamableHTTPServerTransport,
  req: Request,
  res: Response,
  body?: McpRequestBody
): Promise<void> {
  return body
    ? transport.handleRequest(req, res, body)
    : transport.handleRequest(req, res);
}

function resolveSessionTransport(
  sessionId: string | undefined,
  options: McpSessionOptions,
  res: Response
): StreamableHTTPServerTransport | null {
  const { sessionStore } = options;

  if (!sessionId) {
    respondMissingSession(res);
    return null;
  }

  const session = sessionStore.get(sessionId);
  if (!session) {
    respondSessionNotFound(res);
    return null;
  }

  sessionStore.touch(sessionId);
  return session.transport;
}

const MCP_PROTOCOL_VERSION_HEADER = 'mcp-protocol-version';

const MCP_PROTOCOL_VERSIONS = {
  supported: new Set<string>(['2025-11-25']),
};

function getHeaderValue(req: Request, headerNameLower: string): string | null {
  const value = req.headers[headerNameLower];
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value[0] ?? null;
  return null;
}

export function ensureMcpProtocolVersionHeader(
  req: Request,
  res: Response
): boolean {
  const raw = getHeaderValue(req, MCP_PROTOCOL_VERSION_HEADER);
  const version = raw?.trim();

  if (!version) {
    sendJsonRpcError(
      res,
      -32600,
      'Missing required MCP-Protocol-Version header',
      400
    );
    return false;
  }

  if (!MCP_PROTOCOL_VERSIONS.supported.has(version)) {
    sendJsonRpcError(
      res,
      -32600,
      `Unsupported MCP-Protocol-Version: ${version}`,
      400
    );
    return false;
  }

  return true;
}

function getAcceptHeader(req: Request): string {
  const value = req.headers.accept;
  if (typeof value === 'string') return value;
  return '';
}

function setAcceptHeader(req: Request, value: string): void {
  req.headers.accept = value;

  const { rawHeaders } = req;
  if (!Array.isArray(rawHeaders)) return;

  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    const key = rawHeaders[i];
    if (typeof key === 'string' && key.toLowerCase() === 'accept') {
      rawHeaders[i + 1] = value;
      return;
    }
  }

  rawHeaders.push('Accept', value);
}

function hasToken(header: string, token: string): boolean {
  return header
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .some((part) => part === token || part.startsWith(`${token};`));
}

export function ensurePostAcceptHeader(req: Request): void {
  const accept = getAcceptHeader(req);

  // Some clients send */* or omit Accept; the SDK transport is picky.
  if (!accept || hasToken(accept, '*/*')) {
    setAcceptHeader(req, 'application/json, text/event-stream');
    return;
  }

  const hasJson = hasToken(accept, 'application/json');
  const hasSse = hasToken(accept, 'text/event-stream');

  if (!hasJson || !hasSse) {
    setAcceptHeader(req, 'application/json, text/event-stream');
  }
}

export function acceptsEventStream(req: Request): boolean {
  const accept = getAcceptHeader(req);
  if (!accept) return false;
  return hasToken(accept, 'text/event-stream');
}

async function handlePost(
  req: RequestWithUnknownBody,
  res: Response,
  options: McpSessionOptions
): Promise<void> {
  ensurePostAcceptHeader(req);
  if (!ensureMcpProtocolVersionHeader(req, res)) return;

  const sessionId = getSessionId(req);
  const payload = validatePostPayload(req.body, res);
  if (!payload) return;

  logPostRequest(payload, sessionId, options);

  const transport = await resolveTransportForPost({
    res,
    body: payload,
    sessionId,
    options,
  });
  if (!transport) return;

  await handleTransportRequest(transport, req, res, payload);
}

async function handleGet(
  req: Request,
  res: Response,
  options: McpSessionOptions
): Promise<void> {
  if (!ensureMcpProtocolVersionHeader(req, res)) return;
  if (!acceptsEventStream(req)) {
    res.status(406).json({
      error: 'Not Acceptable',
      code: 'ACCEPT_NOT_SUPPORTED',
    });
    return;
  }

  const transport = resolveSessionTransport(getSessionId(req), options, res);
  if (!transport) return;

  await handleTransportRequest(transport, req, res);
}

async function handleDelete(
  req: Request,
  res: Response,
  options: McpSessionOptions
): Promise<void> {
  if (!ensureMcpProtocolVersionHeader(req, res)) return;

  const transport = resolveSessionTransport(getSessionId(req), options, res);
  if (!transport) return;

  await handleTransportRequest(transport, req, res);
}

function registerMcpRoutes(app: Express, options: McpSessionOptions): void {
  app.post(
    '/mcp',
    wrapAsync((req, res) => handlePost(req, res, options))
  );
  app.get(
    '/mcp',
    wrapAsync((req, res) => handleGet(req, res, options))
  );
  app.delete(
    '/mcp',
    wrapAsync((req, res) => handleDelete(req, res, options))
  );
}

interface HttpServerTuningTarget {
  headersTimeout?: number;
  requestTimeout?: number;
  keepAliveTimeout?: number;
  closeIdleConnections?: () => void;
  closeAllConnections?: () => void;
}

export function applyHttpServerTuning(server: HttpServerTuningTarget): void {
  const { headersTimeoutMs, requestTimeoutMs, keepAliveTimeoutMs } =
    config.server.http;

  if (headersTimeoutMs !== undefined) {
    server.headersTimeout = headersTimeoutMs;
  }
  if (requestTimeoutMs !== undefined) {
    server.requestTimeout = requestTimeoutMs;
  }
  if (keepAliveTimeoutMs !== undefined) {
    server.keepAliveTimeout = keepAliveTimeoutMs;
  }

  if (
    headersTimeoutMs !== undefined ||
    requestTimeoutMs !== undefined ||
    keepAliveTimeoutMs !== undefined
  ) {
    logDebug('Applied HTTP server tuning', {
      headersTimeoutMs,
      requestTimeoutMs,
      keepAliveTimeoutMs,
    });
  }
}

export function drainConnectionsOnShutdown(
  server: HttpServerTuningTarget
): void {
  const { shutdownCloseAllConnections, shutdownCloseIdleConnections } =
    config.server.http;

  if (shutdownCloseAllConnections) {
    if (typeof server.closeAllConnections === 'function') {
      server.closeAllConnections();
      logDebug('Closed all HTTP connections during shutdown');
    } else {
      logDebug('HTTP server does not support closeAllConnections()');
    }
    return;
  }

  if (shutdownCloseIdleConnections) {
    if (typeof server.closeIdleConnections === 'function') {
      server.closeIdleConnections();
      logDebug('Closed idle HTTP connections during shutdown');
    } else {
      logDebug('HTTP server does not support closeIdleConnections()');
    }
  }
}
