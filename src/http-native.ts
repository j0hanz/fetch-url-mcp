import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { isIP } from 'node:net';
import { arch, freemem, hostname, platform, totalmem } from 'node:os';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import process from 'node:process';
import { setInterval as setIntervalPromise } from 'node:timers/promises';

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
import {
  logError,
  logInfo,
  logWarn,
  runWithRequestContext,
} from './observability.js';
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

type QueryParams = Record<string, string | string[]>;

interface RequestContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  method: string | undefined;
  query: QueryParams;
  ip: string | null;
  body: unknown;
}

interface AuthenticatedContext extends RequestContext {
  auth: AuthInfo;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function sendText(res: ServerResponse, status: number, body: string): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
  res.end(body);
}

function sendEmpty(res: ServerResponse, status: number): void {
  res.statusCode = status;
  res.setHeader('Content-Length', '0');
  res.end();
}

function parseQuery(url: URL): QueryParams {
  const query: QueryParams = {};
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

function drainRequest(req: IncomingMessage): void {
  if (req.readableEnded) return;
  try {
    req.resume();
  } catch {
    // Best-effort only.
  }
}

function normalizeRemoteAddress(address: string | undefined): string | null {
  if (!address) return null;
  const trimmed = address.trim();
  if (!trimmed) return null;

  const zoneIndex = trimmed.indexOf('%');
  const withoutZone = zoneIndex > 0 ? trimmed.slice(0, zoneIndex) : trimmed;
  const normalized = withoutZone.toLowerCase();

  if (normalized.startsWith('::ffff:')) {
    const mapped = normalized.slice('::ffff:'.length);
    if (isIP(mapped) === 4) return mapped;
  }

  if (isIP(normalized)) return normalized;

  return trimmed;
}

function getHeaderValue(req: IncomingMessage, name: string): string | null {
  const val = req.headers[name.toLowerCase()];
  if (!val) return null;
  if (Array.isArray(val)) return val[0] ?? null;
  return val;
}

function getMcpSessionId(req: IncomingMessage): string | null {
  return (
    getHeaderValue(req, 'mcp-session-id') ??
    getHeaderValue(req, 'x-mcp-session-id')
  );
}

function buildRequestContext(
  req: IncomingMessage,
  res: ServerResponse
): RequestContext | null {
  let url: URL;
  try {
    url = new URL(req.url ?? '', 'http://localhost');
  } catch {
    sendJson(res, 400, { error: 'Invalid request URL' });
    return null;
  }

  return {
    req,
    res,
    url,
    method: req.method,
    query: parseQuery(url),
    ip: normalizeRemoteAddress(req.socket.remoteAddress),
    body: undefined,
  };
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

type JsonBodyErrorKind = 'payload-too-large' | 'invalid-json' | 'read-failed';

class JsonBodyError extends Error {
  readonly kind: JsonBodyErrorKind;

  constructor(kind: JsonBodyErrorKind, message: string) {
    super(message);
    this.name = 'JsonBodyError';
    this.kind = kind;
  }
}

const DEFAULT_BODY_LIMIT_BYTES = 1024 * 1024;

class JsonBodyReader {
  async read(
    req: IncomingMessage,
    limit = DEFAULT_BODY_LIMIT_BYTES
  ): Promise<unknown> {
    const contentType = getHeaderValue(req, 'content-type');
    if (!contentType?.includes('application/json')) return undefined;

    const body = await this.readBody(req, limit);
    if (!body) return undefined;

    try {
      return JSON.parse(body);
    } catch (err: unknown) {
      throw new JsonBodyError(
        'invalid-json',
        err instanceof Error ? err.message : String(err)
      );
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
          throw new JsonBodyError('payload-too-large', 'Payload too large');
        }
        chunks.push(buf);
      }
    } catch (err: unknown) {
      if (err instanceof JsonBodyError) throw err;
      throw new JsonBodyError(
        'read-failed',
        err instanceof Error ? err.message : String(err)
      );
    }

    if (chunks.length === 0) return undefined;
    return Buffer.concat(chunks, size).toString();
  }

  private normalizeChunk(chunk: Buffer | Uint8Array | string): Buffer {
    if (Buffer.isBuffer(chunk)) return chunk;
    if (typeof chunk === 'string') return Buffer.from(chunk);
    return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  }
}

const jsonBodyReader = new JsonBodyReader();

class CorsPolicy {
  handle(ctx: RequestContext): boolean {
    const { req, res } = ctx;
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

    if (req.method !== 'OPTIONS') return false;
    sendEmpty(res, 204);
    return true;
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
  validate(ctx: RequestContext): boolean {
    const { req, res } = ctx;
    const host = this.resolveHostHeader(req);

    if (!host) return this.reject(res, 400, 'Missing or invalid Host header');
    if (!ALLOWED_HOSTS.has(host))
      return this.reject(res, 403, 'Host not allowed');

    const originHeader = getHeaderValue(req, 'origin');
    if (!originHeader) return true;

    const originHost = this.resolveOriginHost(originHeader);
    if (!originHost) return this.reject(res, 403, 'Invalid Origin header');
    if (!ALLOWED_HOSTS.has(originHost))
      return this.reject(res, 403, 'Origin not allowed');

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

  private reject(
    res: ServerResponse,
    status: number,
    message: string
  ): boolean {
    sendJson(res, status, { error: message });
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
  check(ctx: RequestContext): boolean;
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
          this.cleanupEntries(getNow());
        }
      } catch (err) {
        if (!isAbortError(err)) {
          logWarn('Rate limit cleanup failed', { error: err });
        }
      }
    })();
  }

  private cleanupEntries(now: number): void {
    const maxIdle = this.options.windowMs * 2;
    for (const [key, entry] of this.store.entries()) {
      if (now - entry.lastAccessed > maxIdle) {
        this.store.delete(key);
      }
    }
  }

  check(ctx: RequestContext): boolean {
    if (!this.options.enabled || ctx.method === 'OPTIONS') return true;

    const key = ctx.ip ?? 'unknown';
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
      ctx.res.setHeader('Retry-After', String(retryAfter));
      sendJson(ctx.res, 429, { error: 'Rate limit exceeded', retryAfter });
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
  async authenticate(req: IncomingMessage): Promise<AuthInfo> {
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

  private authenticateWithApiKey(req: IncomingMessage): AuthInfo {
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

    if (clientId) {
      headers.authorization = this.buildBasicAuthHeader(clientId, clientSecret);
    }

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
      if (response.body) {
        await response.body.cancel();
      }
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

const EVENT_LOOP_DELAY_RESOLUTION_MS = 20;
const eventLoopDelay = monitorEventLoopDelay({
  resolution: EVENT_LOOP_DELAY_RESOLUTION_MS,
});
let lastEventLoopUtilization = performance.eventLoopUtilization();

function roundTo(value: number, precision: number): number {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}

function formatEventLoopUtilization(
  snapshot: ReturnType<typeof performance.eventLoopUtilization>
): { utilization: number; activeMs: number; idleMs: number } {
  return {
    utilization: roundTo(snapshot.utilization, 4),
    activeMs: Math.round(snapshot.active),
    idleMs: Math.round(snapshot.idle),
  };
}

function toMs(valueNs: number): number {
  return roundTo(valueNs / 1_000_000, 3);
}

function getEventLoopStats(): {
  utilization: {
    total: { utilization: number; activeMs: number; idleMs: number };
    sinceLast: { utilization: number; activeMs: number; idleMs: number };
  };
  delay: {
    minMs: number;
    maxMs: number;
    meanMs: number;
    stddevMs: number;
    p50Ms: number;
    p95Ms: number;
    p99Ms: number;
  };
} {
  const current = performance.eventLoopUtilization();
  const delta = performance.eventLoopUtilization(
    current,
    lastEventLoopUtilization
  );
  lastEventLoopUtilization = current;

  return {
    utilization: {
      total: formatEventLoopUtilization(current),
      sinceLast: formatEventLoopUtilization(delta),
    },
    delay: {
      minMs: toMs(eventLoopDelay.min),
      maxMs: toMs(eventLoopDelay.max),
      meanMs: toMs(eventLoopDelay.mean),
      stddevMs: toMs(eventLoopDelay.stddev),
      p50Ms: toMs(eventLoopDelay.percentile(50)),
      p95Ms: toMs(eventLoopDelay.percentile(95)),
      p99Ms: toMs(eventLoopDelay.percentile(99)),
    },
  };
}

function sendError(
  res: ServerResponse,
  code: number,
  message: string,
  status = 400,
  id: JsonRpcId = null
): void {
  sendJson(res, status, {
    jsonrpc: '2.0',
    error: { code, message },
    id,
  });
}

const MCP_PROTOCOL_VERSION = '2025-11-25';

function ensureMcpProtocolVersion(
  req: IncomingMessage,
  res: ServerResponse
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

  async handlePost(ctx: AuthenticatedContext): Promise<void> {
    if (!ensureMcpProtocolVersion(ctx.req, ctx.res)) return;

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
      this.store.remove(sessionId);
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
    const transportImpl = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });

    const initTimeout = setTimeout(() => {
      if (!tracker.isInitialized()) {
        tracker.releaseSlot();
        void closeTransportBestEffort(transportImpl, 'session-init-timeout');
      }
    }, config.server.sessionInitTimeoutMs);
    initTimeout.unref();

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

  private reserveCapacity(res: ServerResponse, requestId: JsonRpcId): boolean {
    const allowed = ensureSessionCapacity({
      store: this.store,
      maxSessions: config.server.maxSessions,
      evictOldest: (store) => {
        const evicted = store.evictOldest();
        if (evicted) {
          void closeTransportBestEffort(evicted.transport, 'session-eviction');
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

  async dispatch(ctx: RequestContext): Promise<void> {
    try {
      if (ctx.method === 'GET' && ctx.url.pathname === '/health') {
        this.handleHealthCheck(ctx.res);
        return;
      }

      const auth = await this.authenticateRequest(ctx);
      if (!auth) return;

      const authCtx: AuthenticatedContext = { ...ctx, auth };

      if (ctx.method === 'GET') {
        const download = checkDownloadRoute(ctx.url.pathname);
        if (download) {
          handleDownload(ctx.res, download.namespace, download.hash);
          return;
        }
      }

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

  private handleHealthCheck(res: ServerResponse): void {
    const poolStats = getTransformPoolStats();
    res.setHeader('Cache-Control', 'no-store');
    sendJson(res, 200, {
      status: 'ok',
      version: serverVersion,
      uptime: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
      os: {
        hostname: hostname(),
        platform: platform(),
        arch: arch(),
        memoryFree: freemem(),
        memoryTotal: totalmem(),
      },
      perf: getEventLoopStats(),
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
      return await authService.authenticate(ctx.req);
    } catch (err) {
      sendJson(ctx.res, 401, {
        error: err instanceof Error ? err.message : 'Unauthorized',
      });
      return null;
    }
  }
}

class HttpRequestPipeline {
  constructor(
    private readonly rateLimiter: RateLimitManagerImpl,
    private readonly dispatcher: HttpDispatcher
  ) {}

  async handle(rawReq: IncomingMessage, rawRes: ServerResponse): Promise<void> {
    const requestId = getHeaderValue(rawReq, 'x-request-id') ?? randomUUID();
    const sessionId = getMcpSessionId(rawReq) ?? undefined;

    return runWithRequestContext(
      { requestId, ...(sessionId ? { sessionId } : {}) },
      async () => {
        const ctx = buildRequestContext(rawReq, rawRes);
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

        try {
          ctx.body = await jsonBodyReader.read(ctx.req);
        } catch {
          if (ctx.url.pathname === '/mcp' && ctx.method === 'POST') {
            sendError(ctx.res, -32700, 'Parse error', 400, null);
          } else {
            sendJson(ctx.res, 400, {
              error: 'Invalid JSON or Payload too large',
            });
          }
          drainRequest(rawReq);
          return;
        }

        await this.dispatcher.dispatch(ctx);
      }
    );
  }
}

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

async function listen(
  server: Server,
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

function resolveListeningPort(server: Server, fallback: number): number {
  const addr = server.address();
  if (addr && typeof addr === 'object') return addr.port;
  return fallback;
}

function createShutdownHandler(options: {
  server: Server;
  rateLimiter: RateLimitManagerImpl;
  sessionCleanup: AbortController;
  sessionStore: SessionStore;
  mcpServer: McpServer;
}): (signal: string) => Promise<void> {
  return async (signal: string): Promise<void> => {
    logInfo(`Stopping HTTP server (${signal})...`);

    options.rateLimiter.stop();
    options.sessionCleanup.abort();
    drainConnectionsOnShutdown(options.server);
    eventLoopDelay.disable();

    const sessions = options.sessionStore.clear();
    await Promise.all(
      sessions.map((session) =>
        closeTransportBestEffort(session.transport, 'shutdown-session-close')
      )
    );

    await new Promise<void>((resolve, reject): void => {
      options.server.close((err): void => {
        if (err) reject(err);
        else resolve();
      });
    });

    await options.mcpServer.close();
  };
}

export async function startHttpServer(): Promise<{
  shutdown: (signal: string) => Promise<void>;
  port: number;
  host: string;
}> {
  assertHttpModeConfiguration();
  enableHttpMode();

  lastEventLoopUtilization = performance.eventLoopUtilization();
  eventLoopDelay.reset();
  eventLoopDelay.enable();

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
      handlePipelineError(error, res);
    });
  });

  applyHttpServerTuning(server);
  await listen(server, config.server.host, config.server.port);

  const port = resolveListeningPort(server, config.server.port);
  logInfo(`HTTP server listening on port ${port}`, {
    platform: platform(),
    arch: arch(),
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
      mcpServer,
    }),
  };
}
