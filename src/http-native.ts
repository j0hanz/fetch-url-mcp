import { Buffer } from 'node:buffer';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import {
  createServer as createHttpsServer,
  type Server as HttpsServer,
  type ServerOptions as HttpsServerOptions,
} from 'node:https';
import type { Socket } from 'node:net';
import { freemem, hostname, totalmem } from 'node:os';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import process from 'node:process';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
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

import { keys as cacheKeys } from './cache.js';
import { config, enableHttpMode, serverVersion } from './config.js';
import { hmacSha256Hex, timingSafeEqualUtf8 } from './crypto.js';
import { handleDownload } from './download.js';
import { normalizeHost } from './host-normalization.js';
import {
  createDefaultBlockList,
  normalizeIpForBlockList,
} from './ip-blocklist.js';
import {
  acceptsEventStream,
  acceptsJsonAndEventStream,
  isJsonRpcBatchRequest,
  isMcpRequestBody,
  type JsonRpcId,
} from './mcp-validator.js';
import { cancelTasksForOwner } from './mcp.js';
import {
  logError,
  logInfo,
  logWarn,
  registerMcpSessionServer,
  resolveMcpSessionIdByServer,
  runWithRequestContext,
  unregisterMcpSessionServer,
  unregisterMcpSessionServerByServer,
} from './observability.js';
import {
  applyHttpServerTuning,
  drainConnectionsOnShutdown,
} from './server-tuning.js';
import { createMcpServerForHttpSession } from './server.js';
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

type NetworkServer = Server | HttpsServer;

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

interface RequestContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  method: string | undefined;
  ip: string | null;
  body: unknown;
  signal?: AbortSignal;
}

interface AuthenticatedContext extends RequestContext {
  auth: AuthInfo;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  setNoStoreHeaders(res);
  res.end(JSON.stringify(body));
}

function sendText(res: ServerResponse, status: number, body: string): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  setNoStoreHeaders(res);
  res.end(body);
}

function sendEmpty(res: ServerResponse, status: number): void {
  res.statusCode = status;
  res.setHeader('Content-Length', '0');
  res.end();
}

function setNoStoreHeaders(res: ServerResponse): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
}

function drainRequest(req: IncomingMessage): void {
  if (req.readableEnded) return;
  try {
    req.resume();
  } catch {
    // Best-effort only.
  }
}

function createRequestAbortSignal(req: IncomingMessage): {
  signal: AbortSignal;
  cleanup: () => void;
} {
  const controller = new AbortController();

  let cleanedUp = false;

  const abortRequest = (): void => {
    if (cleanedUp) return;
    if (!controller.signal.aborted) controller.abort();
  };

  if (req.destroyed) {
    abortRequest();
    return {
      signal: controller.signal,
      cleanup: () => {
        cleanedUp = true;
      },
    };
  }

  const onAborted = (): void => {
    abortRequest();
  };
  const onClose = (): void => {
    // A normal close after a complete body should not be treated as cancellation.
    if (req.complete) return;
    abortRequest();
  };
  const onError = (): void => {
    abortRequest();
  };

  req.once('aborted', onAborted);
  req.once('close', onClose);
  req.once('error', onError);

  return {
    signal: controller.signal,
    cleanup: () => {
      cleanedUp = true;
      req.removeListener('aborted', onAborted);
      req.removeListener('close', onClose);
      req.removeListener('error', onError);
    },
  };
}

function normalizeRemoteAddress(address: string | undefined): string | null {
  if (!address) return null;
  const trimmed = address.trim();
  if (!trimmed) return null;

  const normalized = normalizeIpForBlockList(trimmed);
  if (normalized) return normalized.ip;
  return trimmed;
}

function registerInboundBlockList(server: NetworkServer): void {
  if (!config.server.http.blockPrivateConnections) return;

  const blockList = createDefaultBlockList();

  server.on('connection', (socket: Socket) => {
    const remoteAddress = normalizeRemoteAddress(socket.remoteAddress);
    if (!remoteAddress) return;

    const normalized = normalizeIpForBlockList(remoteAddress);
    if (!normalized) return;

    if (blockList.check(normalized.ip, normalized.family)) {
      logWarn('Blocked inbound connection', {
        remoteAddress: normalized.ip,
        family: normalized.family,
      });
      socket.destroy();
    }
  });
}

function getHeaderValue(req: IncomingMessage, name: string): string | null {
  const val = req.headers[name];
  if (!val) return null;
  if (Array.isArray(val)) return val[0] ?? null;
  return val;
}

const SINGLE_VALUE_HEADER_NAMES: readonly string[] = [
  'authorization',
  'x-api-key',
  'host',
  'origin',
  'content-length',
  'mcp-session-id',
  'x-mcp-session-id',
];

function hasDuplicateHeader(req: IncomingMessage, name: string): boolean {
  const values = req.headersDistinct[name];
  return Array.isArray(values) && values.length > 1;
}

function findDuplicateSingleValueHeader(req: IncomingMessage): string | null {
  for (const name of SINGLE_VALUE_HEADER_NAMES) {
    if (hasDuplicateHeader(req, name)) return name;
  }
  return null;
}

function getMcpSessionId(req: IncomingMessage): string | null {
  return (
    getHeaderValue(req, 'mcp-session-id') ??
    getHeaderValue(req, 'x-mcp-session-id')
  );
}

function buildRequestContext(
  req: IncomingMessage,
  res: ServerResponse,
  signal?: AbortSignal
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
    ip: normalizeRemoteAddress(req.socket.remoteAddress),
    body: undefined,
    ...(signal ? { signal } : {}),
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

async function closeMcpServerBestEffort(
  server: McpServer,
  context: string
): Promise<void> {
  try {
    await server.close();
  } catch (error) {
    logWarn('MCP server close failed', { context, error });
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

function isRequestReadAborted(req: IncomingMessage): boolean {
  return req.destroyed && !req.complete;
}

class JsonBodyReader {
  async read(
    req: IncomingMessage,
    limit = DEFAULT_BODY_LIMIT_BYTES,
    signal?: AbortSignal
  ): Promise<unknown> {
    const contentType = getHeaderValue(req, 'content-type');
    if (!contentType?.includes('application/json')) return undefined;

    const contentLengthHeader = getHeaderValue(req, 'content-length');
    if (contentLengthHeader) {
      const contentLength = Number.parseInt(contentLengthHeader, 10);
      if (Number.isFinite(contentLength) && contentLength > limit) {
        try {
          req.destroy();
        } catch {
          // Best-effort only.
        }
        throw new JsonBodyError('payload-too-large', 'Payload too large');
      }
    }

    if (signal?.aborted || isRequestReadAborted(req)) {
      throw new JsonBodyError('read-failed', 'Request aborted');
    }

    const body = await this.readBody(req, limit, signal);
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
    limit: number,
    signal?: AbortSignal
  ): Promise<string | undefined> {
    const abortListener = this.attachAbortListener(req, signal);

    try {
      const { chunks, size } = await this.collectChunks(req, limit, signal);
      if (chunks.length === 0) return undefined;
      return Buffer.concat(chunks, size).toString('utf8');
    } finally {
      this.detachAbortListener(signal, abortListener);
    }
  }

  private attachAbortListener(
    req: IncomingMessage,
    signal?: AbortSignal
  ): (() => void) | null {
    if (!signal) return null;

    const listener = (): void => {
      try {
        req.destroy();
      } catch {
        // Best-effort only.
      }
    };

    if (signal.aborted) {
      listener();
    } else {
      signal.addEventListener('abort', listener, { once: true });
    }

    return listener;
  }

  private detachAbortListener(
    signal: AbortSignal | undefined,
    listener: (() => void) | null
  ): void {
    if (!signal || !listener) return;
    try {
      signal.removeEventListener('abort', listener);
    } catch {
      // Best-effort cleanup.
    }
  }

  private async collectChunks(
    req: IncomingMessage,
    limit: number,
    signal?: AbortSignal
  ): Promise<{ chunks: Buffer[]; size: number }> {
    let size = 0;
    const chunks: Buffer[] = [];

    const sink = new Writable({
      write: (chunk, _encoding, callback): void => {
        try {
          if (signal?.aborted || isRequestReadAborted(req)) {
            callback(new JsonBodyError('read-failed', 'Request aborted'));
            return;
          }

          const buf = this.normalizeChunk(
            chunk as Buffer | Uint8Array | string
          );
          size += buf.length;

          if (size > limit) {
            req.destroy();
            callback(
              new JsonBodyError('payload-too-large', 'Payload too large')
            );
            return;
          }

          chunks.push(buf);
          callback();
        } catch (err: unknown) {
          callback(err instanceof Error ? err : new Error(String(err)));
        }
      },
    });

    try {
      if (signal?.aborted || isRequestReadAborted(req)) {
        throw new JsonBodyError('read-failed', 'Request aborted');
      }

      await pipeline(req, sink, signal ? { signal } : undefined);
      return { chunks, size };
    } catch (err: unknown) {
      if (err instanceof JsonBodyError) throw err;
      if (signal?.aborted || isRequestReadAborted(req)) {
        throw new JsonBodyError('read-failed', 'Request aborted');
      }
      throw new JsonBodyError(
        'read-failed',
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  private normalizeChunk(chunk: Buffer | Uint8Array | string): Buffer {
    if (Buffer.isBuffer(chunk)) return chunk;
    if (typeof chunk === 'string') return Buffer.from(chunk, 'utf8');
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
      'Content-Type, Authorization, X-API-Key, MCP-Protocol-Version, MCP-Session-ID, X-MCP-Session-ID, Last-Event-ID'
    );

    if (req.method !== 'OPTIONS') return false;
    sendEmpty(res, 204);
    return true;
  }
}

const corsPolicy = new CorsPolicy();

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const WILDCARD_HOSTS = new Set(['0.0.0.0', '::']);

function hasConstantTimeMatch(
  candidates: readonly string[],
  input: string
): boolean {
  // Avoid leaking match index via early-return.
  let matched = 0;
  for (const candidate of candidates) {
    matched |= timingSafeEqualUtf8(candidate, input) ? 1 : 0;
  }
  return matched === 1;
}

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

    if (entry) {
      if (now > entry.resetTime) {
        entry.count = 1;
        entry.resetTime = now + this.options.windowMs;
        entry.lastAccessed = now;
      } else {
        entry.count += 1;
        entry.lastAccessed = now;
      }
    } else {
      entry = {
        count: 1,
        resetTime: now + this.options.windowMs,
        lastAccessed: now,
      };
      this.store.set(key, entry);
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
const STATIC_TOKEN_HMAC_KEY = randomBytes(32);
const SESSION_AUTH_FINGERPRINT_KEY = randomBytes(32);

class AuthService {
  private readonly staticTokenDigests = config.auth.staticTokens.map((token) =>
    hmacSha256Hex(STATIC_TOKEN_HMAC_KEY, token)
  );

  async authenticate(
    req: IncomingMessage,
    signal?: AbortSignal
  ): Promise<AuthInfo> {
    const authHeader = getHeaderValue(req, 'authorization');
    if (!authHeader) {
      return this.authenticateWithApiKey(req);
    }

    const token = this.resolveBearerToken(authHeader);
    return this.authenticateWithToken(token, signal);
  }

  private authenticateWithToken(
    token: string,
    signal?: AbortSignal
  ): Promise<AuthInfo> {
    return config.auth.mode === 'oauth'
      ? this.verifyWithIntrospection(token, signal)
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
    if (!authHeader.startsWith('Bearer ')) {
      throw new InvalidTokenError('Invalid Authorization header format');
    }
    const token = authHeader.substring(7);
    if (!token) {
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
    if (this.staticTokenDigests.length === 0) {
      throw new InvalidTokenError('No static tokens configured');
    }

    const tokenDigest = hmacSha256Hex(STATIC_TOKEN_HMAC_KEY, token);
    const matched = hasConstantTimeMatch(this.staticTokenDigests, tokenDigest);

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
    // Base64 is only an encoding for header transport; it is NOT encryption.
    const credentials = `${clientId}:${clientSecret ?? ''}`;
    return `Basic ${Buffer.from(credentials, 'utf8').toString('base64')}`;
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
      headers['authorization'] = this.buildBasicAuthHeader(
        clientId,
        clientSecret
      );
    }

    return { body, headers };
  }

  private async requestIntrospection(
    url: URL,
    request: { body: string; headers: Record<string, string> },
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<unknown> {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const combinedSignal = signal
      ? AbortSignal.any([signal, timeoutSignal])
      : timeoutSignal;

    const response = await fetch(url, {
      method: 'POST',
      headers: request.headers,
      body: request.body,
      signal: combinedSignal,
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
    const { exp, client_id: clientIdRaw, scope: scopeRaw } = payload;
    const expiresAt = typeof exp === 'number' ? exp : undefined;
    const clientId = typeof clientIdRaw === 'string' ? clientIdRaw : 'unknown';

    const info: AuthInfo = {
      token,
      clientId,
      scopes: typeof scopeRaw === 'string' ? scopeRaw.split(' ') : [],
      resource: config.auth.resourceUrl,
    };

    if (expiresAt !== undefined) info.expiresAt = expiresAt;
    return info;
  }

  private async verifyWithIntrospection(
    token: string,
    signal?: AbortSignal
  ): Promise<AuthInfo> {
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
      config.auth.introspectionTimeoutMs,
      signal
    );

    if (!isObject(payload) || payload['active'] !== true) {
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

const DEFAULT_MCP_PROTOCOL_VERSION = '2025-11-25';
const LEGACY_MCP_PROTOCOL_VERSION = '2025-03-26';
const SUPPORTED_MCP_PROTOCOL_VERSIONS = new Set<string>([
  DEFAULT_MCP_PROTOCOL_VERSION,
  LEGACY_MCP_PROTOCOL_VERSION,
]);

function ensureMcpProtocolVersion(
  req: IncomingMessage,
  res: ServerResponse
): boolean {
  const versionHeader = getHeaderValue(req, 'mcp-protocol-version');
  if (!versionHeader) {
    // Backwards-compatible fallback when header is missing.
    return true;
  }

  const version = versionHeader.trim();
  if (SUPPORTED_MCP_PROTOCOL_VERSIONS.has(version)) return true;

  sendError(res, -32600, `Unsupported MCP-Protocol-Version: ${version}`);
  return false;
}

function isVerboseHealthRequest(ctx: RequestContext): boolean {
  const value = ctx.url.searchParams.get('verbose');
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true';
}

function isGetHealthRoute(ctx: RequestContext): boolean {
  return ctx.method === 'GET' && ctx.url.pathname === '/health';
}

interface HealthResponse {
  status: 'ok';
  version: string;
  uptime: number;
  timestamp: string;
  os?: {
    hostname: string;
    platform: NodeJS.Platform;
    arch: string;
    memoryFree: number;
    memoryTotal: number;
  };
  process?: {
    pid: number;
    ppid: number;
    memory: NodeJS.MemoryUsage;
    cpu: NodeJS.CpuUsage;
    resource: NodeJS.ResourceUsage;
  };
  perf?: ReturnType<typeof getEventLoopStats>;
  stats?: {
    activeSessions: number;
    cacheKeys: number;
    workerPool: {
      queueDepth: number;
      activeWorkers: number;
      capacity: number;
    };
  };
}

function buildHealthResponse(
  store: SessionStore,
  includeDiagnostics: boolean
): HealthResponse {
  const base: HealthResponse = {
    status: 'ok',
    version: serverVersion,
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
  };

  if (!includeDiagnostics) return base;

  const poolStats = getTransformPoolStats();
  return {
    ...base,
    os: {
      hostname: hostname(),
      platform: process.platform,
      arch: process.arch,
      memoryFree: freemem(),
      memoryTotal: totalmem(),
    },
    process: {
      pid: process.pid,
      ppid: process.ppid,
      memory: process.memoryUsage(),
      cpu: process.cpuUsage(),
      resource: process.resourceUsage(),
    },
    perf: getEventLoopStats(),
    stats: {
      activeSessions: store.size(),
      cacheKeys: cacheKeys().length,
      workerPool: poolStats ?? {
        queueDepth: 0,
        activeWorkers: 0,
        capacity: 0,
      },
    },
  };
}

function sendHealth(
  store: SessionStore,
  res: ServerResponse,
  includeDiagnostics: boolean
): void {
  res.setHeader('Cache-Control', 'no-store');
  sendJson(res, 200, buildHealthResponse(store, includeDiagnostics));
}

function isVerboseHealthRoute(ctx: RequestContext): boolean {
  return isGetHealthRoute(ctx) && isVerboseHealthRequest(ctx);
}

function shouldAllowHealthWithoutAuth(ctx: RequestContext): boolean {
  return isGetHealthRoute(ctx) && !isVerboseHealthRequest(ctx);
}

function shouldAllowVerboseHealthWithoutAuth(ctx: RequestContext): boolean {
  if (!isVerboseHealthRoute(ctx)) return false;
  // Local-only deployments can expose verbose diagnostics without auth.
  return !config.security.allowRemote;
}

function isHealthRoute(ctx: RequestContext): boolean {
  return isGetHealthRoute(ctx);
}

function ensureHealthAuthIfNeeded(
  ctx: RequestContext,
  authPresent: boolean
): boolean {
  if (!isHealthRoute(ctx)) return true;
  if (shouldAllowHealthWithoutAuth(ctx)) return true;
  if (shouldAllowVerboseHealthWithoutAuth(ctx)) return true;
  if (authPresent) return true;
  if (!isVerboseHealthRequest(ctx)) return true;

  sendJson(ctx.res, 401, {
    error: 'Authentication required for verbose health metrics',
  });
  return false;
}

function resolveHealthDiagnosticsMode(
  ctx: RequestContext,
  authPresent: boolean
): boolean {
  if (!isVerboseHealthRoute(ctx)) return false;
  if (authPresent) return true;
  return !config.security.allowRemote;
}

function shouldHandleHealthRoute(ctx: RequestContext): boolean {
  return isGetHealthRoute(ctx);
}

function sendHealthRouteResponse(
  store: SessionStore,
  ctx: RequestContext,
  authPresent: boolean
): boolean {
  if (!shouldHandleHealthRoute(ctx)) return false;
  if (!ensureHealthAuthIfNeeded(ctx, authPresent)) return true;

  const includeDiagnostics = resolveHealthDiagnosticsMode(ctx, authPresent);
  sendHealth(store, ctx.res, includeDiagnostics);
  return true;
}

function buildAuthFingerprint(auth: AuthInfo | undefined): string | null {
  if (!auth) return null;

  const safeClientId = typeof auth.clientId === 'string' ? auth.clientId : '';
  const safeToken = typeof auth.token === 'string' ? auth.token : '';

  if (!safeClientId && !safeToken) return null;
  return hmacSha256Hex(
    SESSION_AUTH_FINGERPRINT_KEY,
    `${safeClientId}:${safeToken}`
  );
}

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

          try {
            ctx.body = await jsonBodyReader.read(
              ctx.req,
              DEFAULT_BODY_LIMIT_BYTES,
              ctx.signal
            );
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
    } finally {
      cleanup();
    }
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
    eventLoopDelay.disable();

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

  lastEventLoopUtilization = performance.eventLoopUtilization();
  eventLoopDelay.reset();
  eventLoopDelay.enable();

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
