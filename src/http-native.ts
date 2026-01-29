import { randomUUID } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { setInterval as setIntervalPromise } from 'node:timers/promises';
import { URL, URLSearchParams } from 'node:url';

import {
  InvalidTokenError,
  ServerError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

import { handleDownload } from './cache.js';
import { config, enableHttpMode } from './config.js';
import { timingSafeEqualUtf8 } from './crypto.js';
import { normalizeHost } from './host-normalization.js';
import {
  acceptsEventStream,
  isJsonRpcBatchRequest,
  isMcpRequestBody,
  type JsonRpcId,
} from './mcp-validator.js';
import { createMcpServer } from './mcp.js';
import { logError, logInfo, logWarn } from './observability.js';
import {
  applyHttpServerTuning,
  drainConnectionsOnShutdown,
} from './server-tuning.js';
import {
  composeCloseHandlers,
  createSessionStore,
  createSlotTracker,
  ensureSessionCapacity,
  reserveSessionSlot,
  type SessionStore,
  startSessionCleanupLoop,
} from './session.js';
import { isObject } from './type-guards.js';

function createTransportAdapter(
  transportImpl: StreamableHTTPServerTransport
): Transport {
  type OnClose = NonNullable<Transport['onclose']>;
  type OnError = NonNullable<Transport['onerror']>;
  type OnMessage = NonNullable<Transport['onmessage']>;

  const noopOnClose: OnClose = () => {};
  const noopOnError: OnError = () => {};
  const noopOnMessage: OnMessage = () => {};

  let oncloseHandler = noopOnClose;
  let onerrorHandler = noopOnError;
  let onmessageHandler = noopOnMessage;

  return {
    start: () => transportImpl.start(),
    send: (message, options) => transportImpl.send(message, options),
    close: () => transportImpl.close(),
    get onclose() {
      return oncloseHandler;
    },
    set onclose(handler: OnClose) {
      oncloseHandler = handler;
      transportImpl.onclose = handler;
    },
    get onerror() {
      return onerrorHandler;
    },
    set onerror(handler: OnError) {
      onerrorHandler = handler;
      transportImpl.onerror = handler;
    },
    get onmessage() {
      return onmessageHandler;
    },
    set onmessage(handler: OnMessage) {
      onmessageHandler = handler;
      transportImpl.onmessage = handler;
    },
  };
}

// --- Shim Types ---

interface ShimResponse extends ServerResponse {
  status(code: number): this;
  json(body: unknown): this;
  send(body: string | Buffer): this;
  sendStatus(code: number): this;
}

interface ShimRequest extends IncomingMessage {
  query: Record<string, string | string[]>;
  body?: unknown;
  params: Record<string, string>;
  auth?: AuthInfo;
  ip?: string;
}

function shimResponse(res: ServerResponse): ShimResponse {
  const shim = res as ShimResponse;
  shim.status = function (code: number) {
    this.statusCode = code;
    return this;
  };
  shim.json = function (body: unknown) {
    this.setHeader('Content-Type', 'application/json');
    this.end(JSON.stringify(body));
    return this;
  };
  shim.send = function (body: string | Buffer) {
    this.end(body);
    return this;
  };
  shim.sendStatus = function (code: number) {
    this.statusCode = code;
    this.end();
    return this;
  };
  return shim;
}

// --- Body Parsing ---

async function readJsonBody(
  req: IncomingMessage,
  limit = 1024 * 1024
): Promise<unknown> {
  const contentType = req.headers['content-type'];
  if (!contentType?.includes('application/json')) return undefined;

  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];

    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        req.destroy();
        reject(new Error('Payload too large'));
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      try {
        const body = Buffer.concat(chunks).toString();
        if (!body) {
          resolve(undefined);
          return;
        }
        resolve(JSON.parse(body));
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });

    req.on('error', (err) => {
      reject(err instanceof Error ? err : new Error(String(err)));
    });
  });
}

function parseQuery(url: URL): Record<string, string | string[]> {
  const query: Record<string, string | string[]> = {};
  for (const [key, value] of url.searchParams) {
    const existing = query[key];
    if (existing) {
      if (Array.isArray(existing)) {
        existing.push(value);
      } else {
        query[key] = [existing, value];
      }
    } else {
      query[key] = value;
    }
  }
  return query;
}

// --- CORS & Headers ---

function handleCors(req: IncomingMessage, res: ServerResponse): boolean {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, X-API-Key, MCP-Protocol-Version, X-MCP-Session-ID'
  );

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return true;
  }
  return false;
}

function getHeaderValue(req: IncomingMessage, name: string): string | null {
  const val = req.headers[name.toLowerCase()];
  if (!val) return null;
  if (Array.isArray(val)) return val[0] ?? null;
  return val;
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const WILDCARD_HOSTS = new Set(['0.0.0.0', '::']);

function isWildcardHost(host: string): boolean {
  return WILDCARD_HOSTS.has(host);
}

function buildAllowedHosts(): ReadonlySet<string> {
  const allowed = new Set<string>(LOOPBACK_HOSTS);

  const configuredHost = normalizeHost(config.server.host);
  if (configuredHost && !isWildcardHost(configuredHost)) {
    allowed.add(configuredHost);
  }

  for (const host of config.security.allowedHosts) {
    const normalized = normalizeHost(host);
    if (normalized) {
      allowed.add(normalized);
    }
  }

  return allowed;
}

const ALLOWED_HOSTS = buildAllowedHosts();

function resolveHostHeader(req: IncomingMessage): string | null {
  const host = getHeaderValue(req, 'host');
  if (!host) return null;
  return normalizeHost(host);
}

function resolveOriginHost(origin: string): string | null {
  if (origin === 'null') return null;
  try {
    const parsed = new URL(origin);
    return normalizeHost(parsed.host);
  } catch {
    return null;
  }
}

function rejectHostRequest(
  res: ShimResponse,
  status: number,
  message: string
): boolean {
  res.status(status).json({ error: message });
  return false;
}

function validateHostAndOrigin(
  req: IncomingMessage,
  res: ShimResponse
): boolean {
  const host = resolveHostHeader(req);
  if (!host) {
    return rejectHostRequest(res, 400, 'Missing or invalid Host header');
  }
  if (!ALLOWED_HOSTS.has(host)) {
    return rejectHostRequest(res, 403, 'Host not allowed');
  }

  const originHeader = getHeaderValue(req, 'origin');
  if (originHeader) {
    const originHost = resolveOriginHost(originHeader);
    if (!originHost) {
      return rejectHostRequest(res, 403, 'Invalid Origin header');
    }
    if (!ALLOWED_HOSTS.has(originHost)) {
      return rejectHostRequest(res, 403, 'Origin not allowed');
    }
  }

  return true;
}

function assertHttpModeConfiguration(): void {
  const configuredHost = normalizeHost(config.server.host);
  const isLoopback =
    configuredHost !== null && LOOPBACK_HOSTS.has(configuredHost);
  const isRemoteBinding = !isLoopback;

  if (isRemoteBinding && !config.security.allowRemote) {
    throw new Error(
      'ALLOW_REMOTE must be true to bind to non-loopback interfaces'
    );
  }

  if (isRemoteBinding && config.auth.mode !== 'oauth') {
    throw new Error('OAuth authentication is required for remote bindings');
  }

  if (config.auth.mode === 'static' && config.auth.staticTokens.length === 0) {
    throw new Error(
      'Static auth requires ACCESS_TOKENS or API_KEY to be configured'
    );
  }
}

// --- Rate Limit Implementation (Inline) ---

interface RateLimitEntry {
  count: number;
  resetTime: number;
  lastAccessed: number;
}

interface RateLimitConfig {
  maxRequests: number;
  windowMs: number;
  cleanupIntervalMs: number;
  enabled: boolean;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

interface RateLimitManagerImpl {
  check(req: ShimRequest, res: ShimResponse): boolean;
  stop(): void;
}

function createRateLimitManagerImpl(
  options: RateLimitConfig
): RateLimitManagerImpl {
  const store = new Map<string, RateLimitEntry>();
  const cleanup = new AbortController();

  const interval = setIntervalPromise(options.cleanupIntervalMs, Date.now, {
    signal: cleanup.signal,
    ref: false,
  });
  void (async () => {
    try {
      for await (const getNow of interval) {
        const now = getNow();
        for (const [key, entry] of store.entries()) {
          if (now - entry.lastAccessed > options.windowMs * 2) {
            store.delete(key);
          }
        }
      }
    } catch (err) {
      if (!isAbortError(err))
        logWarn('Rate limit cleanup failed', { error: err });
    }
  })();

  return {
    check: (req: ShimRequest, res: ShimResponse): boolean => {
      if (!options.enabled || req.method === 'OPTIONS') return true;
      const key = req.ip ?? 'unknown';
      const now = Date.now();
      let entry = store.get(key);
      if (!entry || now > entry.resetTime) {
        entry = {
          count: 1,
          resetTime: now + options.windowMs,
          lastAccessed: now,
        };
        store.set(key, entry);
      } else {
        entry.count++;
        entry.lastAccessed = now;
      }
      if (entry.count > options.maxRequests) {
        const retryAfter = Math.max(
          1,
          Math.ceil((entry.resetTime - now) / 1000)
        );
        res.setHeader('Retry-After', String(retryAfter));
        res.status(429).json({ error: 'Rate limit exceeded', retryAfter });
        return false;
      }
      return true;
    },
    stop: () => {
      cleanup.abort();
    },
  };
}

// --- Auth ---

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
  if (!matched) throw new InvalidTokenError('Invalid token');
  return buildStaticAuthInfo(token);
}

interface IntrospectionRequest {
  body: string;
  headers: Record<string, string>;
}

function stripHash(url: URL): string {
  const clean = new URL(url);
  clean.hash = '';
  return clean.href;
}

function buildBasicAuthHeader(
  clientId: string,
  clientSecret: string | undefined
): string {
  const credentials = `${clientId}:${clientSecret ?? ''}`;
  return `Basic ${Buffer.from(credentials).toString('base64')}`;
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
  if (clientId)
    headers.authorization = buildBasicAuthHeader(clientId, clientSecret);
  return { body, headers };
}

async function requestIntrospection(
  url: URL,
  request: IntrospectionRequest,
  timeoutMs: number
): Promise<unknown> {
  const response = await fetch(url, {
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

function buildIntrospectionAuthInfo(
  token: string,
  payload: Record<string, unknown>
): AuthInfo {
  const expiresAt = typeof payload.exp === 'number' ? payload.exp : undefined;
  const clientId =
    typeof payload.client_id === 'string' ? payload.client_id : 'unknown';

  const info: AuthInfo = {
    token,
    clientId,
    scopes: typeof payload.scope === 'string' ? payload.scope.split(' ') : [],
    resource: config.auth.resourceUrl,
  };

  if (expiresAt !== undefined) {
    info.expiresAt = expiresAt;
  }

  return info;
}

async function verifyWithIntrospection(token: string): Promise<AuthInfo> {
  if (!config.auth.introspectionUrl)
    throw new ServerError('Introspection not configured');
  const req = buildIntrospectionRequest(
    token,
    config.auth.resourceUrl,
    config.auth.clientId,
    config.auth.clientSecret
  );
  const payload = await requestIntrospection(
    config.auth.introspectionUrl,
    req,
    config.auth.introspectionTimeoutMs
  );
  if (!isObject(payload) || payload.active !== true)
    throw new InvalidTokenError('Token is inactive');
  return buildIntrospectionAuthInfo(token, payload);
}

function resolveBearerToken(authHeader: string): string {
  const [type, token] = authHeader.split(' ');
  if (type !== 'Bearer' || !token) {
    throw new InvalidTokenError('Invalid Authorization header format');
  }
  return token;
}

function authenticateWithToken(token: string): Promise<AuthInfo> {
  return config.auth.mode === 'oauth'
    ? verifyWithIntrospection(token)
    : Promise.resolve(verifyStaticToken(token));
}

function authenticateWithApiKey(req: ShimRequest): AuthInfo {
  const apiKey = getHeaderValue(req, 'x-api-key');
  if (apiKey && config.auth.mode === 'static') {
    return verifyStaticToken(apiKey);
  }
  if (apiKey && config.auth.mode === 'oauth') {
    throw new InvalidTokenError('X-API-Key not supported for OAuth');
  }
  throw new InvalidTokenError('Missing Authorization header');
}

async function authenticate(req: ShimRequest): Promise<AuthInfo> {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return authenticateWithApiKey(req);
  }

  const token = resolveBearerToken(authHeader);
  return authenticateWithToken(token);
}

// --- MCP Routes ---

function sendError(
  res: ShimResponse,
  code: number,
  message: string,
  status = 400,
  id: JsonRpcId = null
): void {
  res.status(status).json({
    jsonrpc: '2.0',
    error: { code, message },
    id,
  });
}

function ensureMcpProtocolVersion(
  req: ShimRequest,
  res: ShimResponse
): boolean {
  const version = getHeaderValue(req, 'mcp-protocol-version');
  if (!version) {
    sendError(res, -32600, 'Missing MCP-Protocol-Version header');
    return false;
  }
  if (version !== '2025-11-25') {
    sendError(res, -32600, `Unsupported MCP-Protocol-Version: ${version}`);
    return false;
  }
  return true;
}

async function createNewSession(
  store: SessionStore,
  mcpServer: McpServer,
  res: ShimResponse,
  requestId: JsonRpcId
): Promise<StreamableHTTPServerTransport | null> {
  const allowed = ensureSessionCapacity({
    store,
    maxSessions: config.server.maxSessions,
    evictOldest: (s) => {
      const evicted = s.evictOldest();
      if (evicted) {
        void evicted.transport.close().catch(() => {});
        return true;
      }
      return false;
    },
  });

  if (!allowed) {
    sendError(res, -32000, 'Server busy', 503, requestId);
    return null;
  }

  if (!reserveSessionSlot(store, config.server.maxSessions)) {
    sendError(res, -32000, 'Server busy', 503, requestId);
    return null;
  }

  const tracker = createSlotTracker(store);
  const transportImpl = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });

  const initTimeout = setTimeout(() => {
    if (!tracker.isInitialized()) {
      tracker.releaseSlot();
      void transportImpl.close().catch(() => {});
    }
  }, config.server.sessionInitTimeoutMs);

  transportImpl.onclose = () => {
    clearTimeout(initTimeout);
    if (!tracker.isInitialized()) tracker.releaseSlot();
  };

  try {
    const transport = createTransportAdapter(transportImpl);
    await mcpServer.connect(transport);
  } catch (err) {
    clearTimeout(initTimeout);
    tracker.releaseSlot();
    void transportImpl.close().catch(() => {});
    throw err;
  }

  const newSessionId = transportImpl.sessionId;
  if (!newSessionId) {
    throw new ServerError('Failed to generate session ID');
  }

  tracker.markInitialized();
  tracker.releaseSlot();
  store.set(newSessionId, {
    transport: transportImpl,
    createdAt: Date.now(),
    lastSeen: Date.now(),
    protocolInitialized: false,
  });

  transportImpl.onclose = composeCloseHandlers(transportImpl.onclose, () => {
    store.remove(newSessionId);
  });

  return transportImpl;
}

async function getOrCreateTransport(
  req: ShimRequest,
  res: ShimResponse,
  store: SessionStore,
  mcpServer: McpServer,
  requestId: JsonRpcId
): Promise<StreamableHTTPServerTransport | null> {
  const sessionId = getHeaderValue(req, 'mcp-session-id');

  if (sessionId) {
    const session = store.get(sessionId);
    if (!session) {
      sendError(res, -32600, 'Session not found', 404, requestId);
      return null;
    }
    store.touch(sessionId);
    return session.transport;
  }

  if (!isInitializeRequest(req.body)) {
    sendError(res, -32600, 'Missing session ID', 400, requestId);
    return null;
  }

  return createNewSession(store, mcpServer, res, requestId);
}

async function handleMcpPost(
  req: ShimRequest,
  res: ShimResponse,
  store: SessionStore,
  mcpServer: McpServer
): Promise<void> {
  if (!ensureMcpProtocolVersion(req, res)) return;

  const { body } = req;
  if (isJsonRpcBatchRequest(body)) {
    sendError(res, -32600, 'Batch requests not supported');
    return;
  }
  if (!isMcpRequestBody(body)) {
    sendError(res, -32600, 'Invalid request body');
    return;
  }

  const requestId = body.id ?? null;
  logInfo('[MCP POST]', {
    method: body.method,
    id: body.id,
    sessionId: getHeaderValue(req, 'mcp-session-id'),
  });

  const transport = await getOrCreateTransport(
    req,
    res,
    store,
    mcpServer,
    requestId
  );
  if (!transport) return;

  await transport.handleRequest(req, res, body);
}

async function handleMcpGet(
  req: ShimRequest,
  res: ShimResponse,
  store: SessionStore
): Promise<void> {
  if (!ensureMcpProtocolVersion(req, res)) return;

  const sessionId = getHeaderValue(req, 'mcp-session-id');
  if (!sessionId) {
    sendError(res, -32600, 'Missing session ID');
    return;
  }

  const session = store.get(sessionId);
  if (!session) {
    sendError(res, -32600, 'Session not found', 404);
    return;
  }

  const acceptHeader = getHeaderValue(req, 'accept');
  if (!acceptsEventStream(acceptHeader)) {
    res.status(406).json({ error: 'Not Acceptable' });
    return;
  }

  store.touch(sessionId);
  await session.transport.handleRequest(req, res);
}

async function handleMcpDelete(
  req: ShimRequest,
  res: ShimResponse,
  store: SessionStore
): Promise<void> {
  if (!ensureMcpProtocolVersion(req, res)) return;

  const sessionId = getHeaderValue(req, 'mcp-session-id');
  if (!sessionId) {
    sendError(res, -32600, 'Missing session ID');
    return;
  }

  const session = store.get(sessionId);
  if (session) {
    await session.transport.close();
    store.remove(sessionId);
  }

  res.status(200).send('Session closed');
}

// --- Dispatch ---

async function routeMcpRequest(
  req: ShimRequest,
  res: ShimResponse,
  url: URL,
  ctx: { store: SessionStore; mcpServer: McpServer }
): Promise<boolean> {
  const { pathname: path } = url;
  const { method } = req;

  if (path !== '/mcp') return false;

  if (method === 'POST') {
    await handleMcpPost(req, res, ctx.store, ctx.mcpServer);
    return true;
  }
  if (method === 'GET') {
    await handleMcpGet(req, res, ctx.store);
    return true;
  }
  if (method === 'DELETE') {
    await handleMcpDelete(req, res, ctx.store);
    return true;
  }

  return false;
}

function checkDownloadRoute(
  path: string
): { namespace: string; hash: string } | null {
  const downloadMatch = /^\/mcp\/downloads\/([^/]+)\/([^/]+)$/.exec(path);
  if (downloadMatch) {
    const namespace = downloadMatch[1];
    const hash = downloadMatch[2];
    if (namespace && hash) {
      return { namespace, hash };
    }
  }
  return null;
}

async function dispatchRequest(
  req: ShimRequest,
  res: ShimResponse,
  url: URL,
  ctx: { store: SessionStore; mcpServer: McpServer }
): Promise<void> {
  const { pathname: path } = url;
  const { method } = req;

  try {
    if (method === 'GET' && path === '/health') {
      res.status(200).json({ status: 'ok' });
      return;
    }

    if (!(await authenticateRequest(req, res))) {
      return;
    }

    if (method === 'GET') {
      const download = checkDownloadRoute(path);
      if (download) {
        handleDownload(res, download.namespace, download.hash);
        return;
      }
    }

    if (await routeMcpRequest(req, res, url, ctx)) return;

    res.status(404).json({ error: 'Not Found' });
  } catch (err) {
    logError(
      'Request failed',
      err instanceof Error ? err : new Error(String(err))
    );
    if (!res.writableEnded) {
      res.status(500).json({ error: 'Internal Server Error' });
    }
  }
}

async function authenticateRequest(
  req: ShimRequest,
  res: ShimResponse
): Promise<boolean> {
  try {
    req.auth = await authenticate(req);
    return true;
  } catch (err) {
    res
      .status(401)
      .json({ error: err instanceof Error ? err.message : 'Unauthorized' });
    return false;
  }
}

// --- Main ---

export async function startHttpServer(): Promise<{
  shutdown: (signal: string) => Promise<void>;
  port: number;
  host: string;
}> {
  assertHttpModeConfiguration();
  enableHttpMode();
  const mcpServer = createMcpServer();
  const rateLimiter = createRateLimitManagerImpl(config.rateLimit);
  const sessionStore = createSessionStore(config.server.sessionTtlMs);
  const sessionCleanup = startSessionCleanupLoop(
    sessionStore,
    config.server.sessionTtlMs
  );

  const server = createServer((req, res) => {
    void handleRequest(req, res, rateLimiter, {
      store: sessionStore,
      mcpServer,
    });
  });

  applyHttpServerTuning(server);

  await new Promise<void>((resolve, reject) => {
    server.listen(config.server.port, config.server.host, () => {
      resolve();
    });
    server.on('error', reject);
  });

  const addr = server.address();
  const port =
    typeof addr === 'object' && addr ? addr.port : config.server.port;
  logInfo(`HTTP server listening on port ${port}`);

  return {
    port,
    host: config.server.host,
    shutdown: async (signal) => {
      logInfo(`Stopping HTTP server (${signal})...`);
      rateLimiter.stop();
      sessionCleanup.abort();
      drainConnectionsOnShutdown(server);

      const sessions = sessionStore.clear();
      await Promise.all(
        sessions.map(async (s) => {
          try {
            await s.transport.close();
          } catch {
            /* ignore */
          }
        })
      );

      server.close();
      await mcpServer.close();
    },
  };
}

async function handleRequest(
  rawReq: IncomingMessage,
  rawRes: ServerResponse,
  rateLimiter: RateLimitManagerImpl,
  ctx: { store: SessionStore; mcpServer: McpServer }
): Promise<void> {
  const res = shimResponse(rawRes);
  const req = rawReq as ShimRequest;

  // 1. Basic Setup
  const url = new URL(req.url ?? '', 'http://localhost');

  req.query = parseQuery(url);
  if (req.socket.remoteAddress) {
    req.ip = req.socket.remoteAddress;
  }
  req.params = {};

  // 2. CORS
  if (!validateHostAndOrigin(req, res)) return;
  if (handleCors(req, res)) return;

  // 3. Body Parsing
  try {
    req.body = await readJsonBody(req);
  } catch {
    res.status(400).json({ error: 'Invalid JSON or Payload too large' });
    return;
  }

  // 4. Rate Limit
  if (!rateLimiter.check(req, res)) return;

  // 5. Routing
  await dispatchRequest(req, res, url, ctx);
}
