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

import { keys as cacheKeys, handleDownload } from './cache.js';
import { config, enableHttpMode, serverVersion } from './config.js';
import { sha256Hex, timingSafeEqualUtf8 } from './crypto.js';
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
import { getTransformPoolStats } from './transform.js';
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

  // Preserve any existing onclose handler (e.g., session cleanup).
  const baseOnClose = transportImpl.onclose;

  let oncloseHandler: OnClose = noopOnClose;
  let onerrorHandler: OnError = noopOnError;
  let onmessageHandler: OnMessage = noopOnMessage;

  return {
    start: () => transportImpl.start(),
    send: (message, options) => transportImpl.send(message, options),
    close: () => transportImpl.close(),

    get onclose() {
      return oncloseHandler;
    },
    set onclose(handler: OnClose) {
      oncloseHandler = handler;
      transportImpl.onclose = composeCloseHandlers(baseOnClose, handler);
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

class JsonBodyReader {
  async read(req: IncomingMessage, limit = 1024 * 1024): Promise<unknown> {
    const contentType = getHeaderValue(req, 'content-type');
    if (!contentType?.includes('application/json')) return undefined;

    const body = await this.readBody(req, limit);
    if (!body) return undefined;

    try {
      return JSON.parse(body);
    } catch (err: unknown) {
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  private async readBody(
    req: IncomingMessage,
    limit: number
  ): Promise<string | undefined> {
    let size = 0;
    const chunks: Buffer[] = [];

    try {
      for await (const chunk of req as AsyncIterable<
        Buffer | Uint8Array | string
      >) {
        const buf = this.normalizeChunk(chunk);
        size += buf.length;
        if (size > limit) {
          req.destroy();
          throw new Error('Payload too large');
        }
        chunks.push(buf);
      }
    } catch (err: unknown) {
      throw err instanceof Error ? err : new Error(String(err));
    }

    if (chunks.length === 0) return undefined;
    return Buffer.concat(chunks).toString();
  }

  private normalizeChunk(chunk: Buffer | Uint8Array | string): Buffer {
    if (typeof chunk === 'string') return Buffer.from(chunk);
    if (Buffer.isBuffer(chunk)) return chunk;
    return Buffer.from(chunk);
  }
}

const jsonBodyReader = new JsonBodyReader();

function parseQuery(url: URL): Record<string, string | string[]> {
  const query: Record<string, string | string[]> = {};
  for (const [key, value] of url.searchParams) {
    const existing = query[key];
    if (existing) {
      if (Array.isArray(existing)) existing.push(value);
      else query[key] = [existing, value];
    } else {
      query[key] = value;
    }
  }
  return query;
}

function getHeaderValue(req: IncomingMessage, name: string): string | null {
  const val = req.headers[name.toLowerCase()];
  if (!val) return null;
  if (Array.isArray(val)) return val[0] ?? null;
  return val;
}

function getMcpSessionId(req: IncomingMessage): string | null {
  // Back-compat: accept both session headers.
  return (
    getHeaderValue(req, 'mcp-session-id') ??
    getHeaderValue(req, 'x-mcp-session-id')
  );
}

async function closeTransportBestEffort(
  transport: { close: () => Promise<unknown> },
  context: string
): Promise<void> {
  try {
    await transport.close();
  } catch (error) {
    logWarn('Transport close failed', { context, error });
  }
}

class CorsPolicy {
  handle(req: IncomingMessage, res: ServerResponse): boolean {
    const origin = getHeaderValue(req, 'origin');
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    } else {
      res.setHeader('Access-Control-Allow-Origin', '*');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization, X-API-Key, MCP-Protocol-Version, MCP-Session-ID, X-MCP-Session-ID'
    );

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return true;
    }
    return false;
  }
}

const corsPolicy = new CorsPolicy();

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
    if (normalized) allowed.add(normalized);
  }

  return allowed;
}

const ALLOWED_HOSTS = buildAllowedHosts();

class HostOriginPolicy {
  validate(req: IncomingMessage, res: ShimResponse): boolean {
    const host = this.resolveHostHeader(req);
    if (!host) return this.reject(res, 400, 'Missing or invalid Host header');
    if (!ALLOWED_HOSTS.has(host))
      return this.reject(res, 403, 'Host not allowed');

    const originHeader = getHeaderValue(req, 'origin');
    if (originHeader) {
      const originHost = this.resolveOriginHost(originHeader);
      if (!originHost) return this.reject(res, 403, 'Invalid Origin header');
      if (!ALLOWED_HOSTS.has(originHost))
        return this.reject(res, 403, 'Origin not allowed');
    }

    return true;
  }

  private resolveHostHeader(req: IncomingMessage): string | null {
    const host = getHeaderValue(req, 'host');
    if (!host) return null;
    return normalizeHost(host);
  }

  private resolveOriginHost(origin: string): string | null {
    if (origin === 'null') return null;
    try {
      const parsed = new URL(origin);
      return normalizeHost(parsed.host);
    } catch {
      return null;
    }
  }

  private reject(res: ShimResponse, status: number, message: string): boolean {
    res.status(status).json({ error: message });
    return false;
  }
}

const hostOriginPolicy = new HostOriginPolicy();

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

class RateLimiter implements RateLimitManagerImpl {
  private readonly store = new Map<string, RateLimitEntry>();
  private readonly cleanup = new AbortController();

  constructor(private readonly options: RateLimitConfig) {
    this.startCleanupLoop();
  }

  private startCleanupLoop(): void {
    const interval = setIntervalPromise(
      this.options.cleanupIntervalMs,
      Date.now,
      { signal: this.cleanup.signal, ref: false }
    );

    void (async () => {
      try {
        for await (const getNow of interval) {
          const now = getNow();
          for (const [key, entry] of this.store.entries()) {
            if (now - entry.lastAccessed > this.options.windowMs * 2) {
              this.store.delete(key);
            }
          }
        }
      } catch (err) {
        if (!isAbortError(err)) {
          logWarn('Rate limit cleanup failed', { error: err });
        }
      }
    })();
  }

  check(req: ShimRequest, res: ShimResponse): boolean {
    if (!this.options.enabled || req.method === 'OPTIONS') return true;

    const key = req.ip ?? 'unknown';
    const now = Date.now();
    let entry = this.store.get(key);

    if (!entry || now > entry.resetTime) {
      entry = {
        count: 1,
        resetTime: now + this.options.windowMs,
        lastAccessed: now,
      };
      this.store.set(key, entry);
    } else {
      entry.count += 1;
      entry.lastAccessed = now;
    }

    if (entry.count > this.options.maxRequests) {
      const retryAfter = Math.max(1, Math.ceil((entry.resetTime - now) / 1000));
      res.setHeader('Retry-After', String(retryAfter));
      res.status(429).json({ error: 'Rate limit exceeded', retryAfter });
      return false;
    }

    return true;
  }

  stop(): void {
    this.cleanup.abort();
  }
}

function createRateLimitManagerImpl(
  options: RateLimitConfig
): RateLimitManagerImpl {
  return new RateLimiter(options);
}

const STATIC_TOKEN_TTL_SECONDS = 60 * 60 * 24;

class AuthService {
  async authenticate(req: ShimRequest): Promise<AuthInfo> {
    const authHeader = getHeaderValue(req, 'authorization');
    if (!authHeader) {
      return this.authenticateWithApiKey(req);
    }

    const token = this.resolveBearerToken(authHeader);
    return this.authenticateWithToken(token);
  }

  private authenticateWithToken(token: string): Promise<AuthInfo> {
    return config.auth.mode === 'oauth'
      ? this.verifyWithIntrospection(token)
      : Promise.resolve(this.verifyStaticToken(token));
  }

  private authenticateWithApiKey(req: ShimRequest): AuthInfo {
    const apiKey = getHeaderValue(req, 'x-api-key');

    if (apiKey && config.auth.mode === 'static') {
      return this.verifyStaticToken(apiKey);
    }
    if (apiKey && config.auth.mode === 'oauth') {
      throw new InvalidTokenError('X-API-Key not supported for OAuth');
    }

    throw new InvalidTokenError('Missing Authorization header');
  }

  private resolveBearerToken(authHeader: string): string {
    const [type, token] = authHeader.split(' ');
    if (type !== 'Bearer' || !token) {
      throw new InvalidTokenError('Invalid Authorization header format');
    }
    return token;
  }

  private buildStaticAuthInfo(token: string): AuthInfo {
    return {
      token,
      clientId: 'static-token',
      scopes: config.auth.requiredScopes,
      expiresAt: Math.floor(Date.now() / 1000) + STATIC_TOKEN_TTL_SECONDS,
      resource: config.auth.resourceUrl,
    };
  }

  private verifyStaticToken(token: string): AuthInfo {
    if (config.auth.staticTokens.length === 0) {
      throw new InvalidTokenError('No static tokens configured');
    }

    const matched = config.auth.staticTokens.some((candidate) =>
      timingSafeEqualUtf8(candidate, token)
    );

    if (!matched) throw new InvalidTokenError('Invalid token');
    return this.buildStaticAuthInfo(token);
  }

  private stripHash(url: URL): string {
    const clean = new URL(url);
    clean.hash = '';
    return clean.href;
  }

  private buildBasicAuthHeader(
    clientId: string,
    clientSecret: string | undefined
  ): string {
    const credentials = `${clientId}:${clientSecret ?? ''}`;
    return `Basic ${Buffer.from(credentials).toString('base64')}`;
  }

  private buildIntrospectionRequest(
    token: string,
    resourceUrl: URL,
    clientId: string | undefined,
    clientSecret: string | undefined
  ): { body: string; headers: Record<string, string> } {
    const body = new URLSearchParams({
      token,
      token_type_hint: 'access_token',
      resource: this.stripHash(resourceUrl),
    }).toString();

    const headers: Record<string, string> = {
      'content-type': 'application/x-www-form-urlencoded',
    };

    if (clientId)
      headers.authorization = this.buildBasicAuthHeader(clientId, clientSecret);

    return { body, headers };
  }

  private async requestIntrospection(
    url: URL,
    request: { body: string; headers: Record<string, string> },
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

  private buildIntrospectionAuthInfo(
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

    if (expiresAt !== undefined) info.expiresAt = expiresAt;
    return info;
  }

  private async verifyWithIntrospection(token: string): Promise<AuthInfo> {
    if (!config.auth.introspectionUrl) {
      throw new ServerError('Introspection not configured');
    }

    const req = this.buildIntrospectionRequest(
      token,
      config.auth.resourceUrl,
      config.auth.clientId,
      config.auth.clientSecret
    );

    const payload = await this.requestIntrospection(
      config.auth.introspectionUrl,
      req,
      config.auth.introspectionTimeoutMs
    );

    if (!isObject(payload) || payload.active !== true) {
      throw new InvalidTokenError('Token is inactive');
    }

    return this.buildIntrospectionAuthInfo(token, payload);
  }
}

const authService = new AuthService();

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

const MCP_PROTOCOL_VERSION = '2025-11-25';

function ensureMcpProtocolVersion(
  req: ShimRequest,
  res: ShimResponse
): boolean {
  const version = getHeaderValue(req, 'mcp-protocol-version');
  if (!version) {
    sendError(res, -32600, 'Missing MCP-Protocol-Version header');
    return false;
  }
  if (version !== MCP_PROTOCOL_VERSION) {
    sendError(res, -32600, `Unsupported MCP-Protocol-Version: ${version}`);
    return false;
  }
  return true;
}

function buildAuthFingerprint(auth: AuthInfo | undefined): string | null {
  if (!auth) return null;
  const { token, clientId } = auth;
  if (!token && !clientId) return null;
  return sha256Hex(`${clientId}:${token}`);
}

class McpSessionGateway {
  constructor(
    private readonly store: SessionStore,
    private readonly mcpServer: McpServer
  ) {}

  async handlePost(req: ShimRequest, res: ShimResponse): Promise<void> {
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
      sessionId: getMcpSessionId(req),
    });

    const transport = await this.getOrCreateTransport(req, res, requestId);
    if (!transport) return;

    await transport.handleRequest(req, res, body);
  }

  async handleGet(req: ShimRequest, res: ShimResponse): Promise<void> {
    if (!ensureMcpProtocolVersion(req, res)) return;

    const sessionId = getMcpSessionId(req);
    if (!sessionId) {
      sendError(res, -32600, 'Missing session ID');
      return;
    }

    const session = this.store.get(sessionId);
    if (!session) {
      sendError(res, -32600, 'Session not found', 404);
      return;
    }

    const acceptHeader = getHeaderValue(req, 'accept');
    if (!acceptsEventStream(acceptHeader)) {
      res.status(405).json({ error: 'Method Not Allowed' });
      return;
    }

    this.store.touch(sessionId);
    await session.transport.handleRequest(req, res);
  }

  async handleDelete(req: ShimRequest, res: ShimResponse): Promise<void> {
    if (!ensureMcpProtocolVersion(req, res)) return;

    const sessionId = getMcpSessionId(req);
    if (!sessionId) {
      sendError(res, -32600, 'Missing session ID');
      return;
    }

    const session = this.store.get(sessionId);
    if (session) {
      await session.transport.close();
      this.store.remove(sessionId);
    }

    res.status(200).send('Session closed');
  }

  private async getOrCreateTransport(
    req: ShimRequest,
    res: ShimResponse,
    requestId: JsonRpcId
  ): Promise<StreamableHTTPServerTransport | null> {
    const sessionId = getMcpSessionId(req);

    if (sessionId) {
      const session = this.store.get(sessionId);
      if (!session) {
        sendError(res, -32600, 'Session not found', 404, requestId);
        return null;
      }
      const incomingFingerprint = buildAuthFingerprint(req.auth);
      if (
        !incomingFingerprint ||
        session.authFingerprint !== incomingFingerprint
      ) {
        sendError(res, -32600, 'Session not found', 404, requestId);
        return null;
      }
      this.store.touch(sessionId);
      return session.transport;
    }

    if (!isInitializeRequest(req.body)) {
      sendError(res, -32600, 'Missing session ID', 400, requestId);
      return null;
    }

    return this.createNewSession(req, res, requestId);
  }

  private async createNewSession(
    req: ShimRequest,
    res: ShimResponse,
    requestId: JsonRpcId
  ): Promise<StreamableHTTPServerTransport | null> {
    const authFingerprint = buildAuthFingerprint(req.auth);
    if (!authFingerprint) {
      sendError(res, -32603, 'Missing auth context', 500, requestId);
      return null;
    }

    const allowed = ensureSessionCapacity({
      store: this.store,
      maxSessions: config.server.maxSessions,
      evictOldest: (s) => {
        const evicted = s.evictOldest();
        if (evicted) {
          void closeTransportBestEffort(evicted.transport, 'session-eviction');
          return true;
        }
        return false;
      },
    });

    if (!allowed) {
      sendError(res, -32000, 'Server busy', 503, requestId);
      return null;
    }

    if (!reserveSessionSlot(this.store, config.server.maxSessions)) {
      sendError(res, -32000, 'Server busy', 503, requestId);
      return null;
    }

    const tracker = createSlotTracker(this.store);
    const transportImpl = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });

    const initTimeout = setTimeout(() => {
      if (!tracker.isInitialized()) {
        tracker.releaseSlot();
        void closeTransportBestEffort(transportImpl, 'session-init-timeout');
      }
    }, config.server.sessionInitTimeoutMs);

    transportImpl.onclose = () => {
      clearTimeout(initTimeout);
      if (!tracker.isInitialized()) tracker.releaseSlot();
    };

    try {
      const transport = createTransportAdapter(transportImpl);
      await this.mcpServer.connect(transport);
    } catch (err) {
      clearTimeout(initTimeout);
      tracker.releaseSlot();
      void closeTransportBestEffort(transportImpl, 'session-connect-failed');
      throw err;
    }

    const newSessionId = transportImpl.sessionId;
    if (!newSessionId) {
      throw new ServerError('Failed to generate session ID');
    }

    tracker.markInitialized();
    tracker.releaseSlot();

    this.store.set(newSessionId, {
      transport: transportImpl,
      createdAt: Date.now(),
      lastSeen: Date.now(),
      protocolInitialized: false,
      authFingerprint,
    });

    transportImpl.onclose = composeCloseHandlers(transportImpl.onclose, () => {
      this.store.remove(newSessionId);
    });

    return transportImpl;
  }
}

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

class HttpDispatcher {
  constructor(
    private readonly store: SessionStore,
    private readonly mcpGateway: McpSessionGateway
  ) {}

  async dispatch(req: ShimRequest, res: ShimResponse, url: URL): Promise<void> {
    const { pathname: path } = url;
    const { method } = req;

    try {
      // /health is intentionally unauthenticated.
      if (method === 'GET' && path === '/health') {
        this.handleHealthCheck(res);
        return;
      }

      if (!(await this.authenticateRequest(req, res))) return;

      if (method === 'GET') {
        const download = checkDownloadRoute(path);
        if (download) {
          handleDownload(res, download.namespace, download.hash);
          return;
        }
      }

      if (path === '/mcp') {
        if (await this.handleMcpRoutes(req, res, method)) {
          return;
        }
      }

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

  private handleHealthCheck(res: ShimResponse): void {
    const poolStats = getTransformPoolStats();
    res.status(200).json({
      status: 'ok',
      version: serverVersion,
      uptime: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
      stats: {
        activeSessions: this.store.size(),
        cacheKeys: cacheKeys().length,
        workerPool: poolStats ?? {
          queueDepth: 0,
          activeWorkers: 0,
          capacity: 0,
        },
      },
    });
  }

  private async handleMcpRoutes(
    req: ShimRequest,
    res: ShimResponse,
    method: string | undefined
  ): Promise<boolean> {
    if (method === 'POST') {
      await this.mcpGateway.handlePost(req, res);
      return true;
    }
    if (method === 'GET') {
      await this.mcpGateway.handleGet(req, res);
      return true;
    }
    if (method === 'DELETE') {
      await this.mcpGateway.handleDelete(req, res);
      return true;
    }
    return false;
  }

  private async authenticateRequest(
    req: ShimRequest,
    res: ShimResponse
  ): Promise<boolean> {
    try {
      req.auth = await authService.authenticate(req);
      return true;
    } catch (err) {
      res.status(401).json({
        error: err instanceof Error ? err.message : 'Unauthorized',
      });
      return false;
    }
  }
}

// Pipeline order is behavior.
class HttpRequestPipeline {
  constructor(
    private readonly rateLimiter: RateLimitManagerImpl,
    private readonly dispatcher: HttpDispatcher
  ) {}

  async handle(rawReq: IncomingMessage, rawRes: ServerResponse): Promise<void> {
    const res = shimResponse(rawRes);
    const req = rawReq as ShimRequest;

    let url: URL;
    try {
      // The base is only used to resolve relative request URLs.
      // Host/origin allowlisting is enforced later by HostOriginPolicy.
      url = new URL(req.url ?? '', 'http://localhost');
    } catch {
      res.status(400).json({ error: 'Invalid request URL' });
      return;
    }

    req.query = parseQuery(url);
    if (req.socket.remoteAddress) req.ip = req.socket.remoteAddress;
    req.params = {};

    if (!hostOriginPolicy.validate(req, res)) return;
    if (corsPolicy.handle(req, res)) return;

    try {
      req.body = await jsonBodyReader.read(req);
    } catch {
      if (url.pathname === '/mcp' && req.method === 'POST') {
        sendError(res, -32700, 'Parse error', 400, null);
      } else {
        res.status(400).json({ error: 'Invalid JSON or Payload too large' });
      }
      return;
    }

    if (!this.rateLimiter.check(req, res)) return;

    await this.dispatcher.dispatch(req, res, url);
  }
}

export async function startHttpServer(): Promise<{
  shutdown: (signal: string) => Promise<void>;
  port: number;
  host: string;
}> {
  assertHttpModeConfiguration();
  enableHttpMode();

  const mcpServer = await createMcpServer();
  const rateLimiter = createRateLimitManagerImpl(config.rateLimit);

  const sessionStore = createSessionStore(config.server.sessionTtlMs);
  const sessionCleanup = startSessionCleanupLoop(
    sessionStore,
    config.server.sessionTtlMs
  );

  const mcpGateway = new McpSessionGateway(sessionStore, mcpServer);
  const dispatcher = new HttpDispatcher(sessionStore, mcpGateway);
  const pipeline = new HttpRequestPipeline(rateLimiter, dispatcher);

  const server = createServer((req, res) => {
    void pipeline.handle(req, res).catch((error: unknown) => {
      logError(
        'Request pipeline failed',
        error instanceof Error ? error : new Error(String(error))
      );
      if (res.writableEnded) return;

      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Internal Server Error' }));
        return;
      }

      res.end();
    });
  });

  applyHttpServerTuning(server);

  await new Promise<void>((resolve, reject): void => {
    function onError(error: Error): void {
      server.off('error', onError);
      reject(error);
    }

    server.once('error', onError);
    server.listen(config.server.port, config.server.host, (): void => {
      server.off('error', onError);
      resolve();
    });
  });

  const addr = server.address();
  const port =
    typeof addr === 'object' && addr ? addr.port : config.server.port;

  logInfo(`HTTP server listening on port ${port}`);

  return {
    port,
    host: config.server.host,
    shutdown: async (signal: string): Promise<void> => {
      logInfo(`Stopping HTTP server (${signal})...`);

      rateLimiter.stop();
      sessionCleanup.abort();
      drainConnectionsOnShutdown(server);

      const sessions = sessionStore.clear();
      await Promise.all(
        sessions.map(
          (session): Promise<void> =>
            closeTransportBestEffort(
              session.transport,
              'shutdown-session-close'
            )
        )
      );

      await new Promise<void>((resolve, reject): void => {
        server.close((err): void => {
          if (err) reject(err);
          else resolve();
        });
      });
      await mcpServer.close();
    },
  };
}
