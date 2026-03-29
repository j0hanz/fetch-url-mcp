import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
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
  resolveMcpSessionIdByServer,
  runWithRequestContext,
  serverVersion,
  type SessionStore,
  startSessionCleanupLoop,
  unregisterMcpSessionServer,
  unregisterMcpSessionServerByServer,
} from '../lib/core.js';
import { Loggers } from '../lib/core.js';
import { getErrorMessage, toError } from '../lib/error/index.js';
import {
  acceptsEventStream,
  acceptsJsonAndEventStream,
  isMcpRequestBody,
  type JsonRpcId,
} from '../lib/mcp-interop.js';
import {
  createDefaultBlockList,
  normalizeIpForBlockList,
} from '../lib/net/index.js';
import {
  applyHttpServerTuning,
  drainConnectionsOnShutdown,
  isObject,
} from '../lib/utils.js';

import { createMcpServerForHttpSession } from '../server.js';
import { buildAuthenticatedOwnerKey } from '../tasks/index.js';
import { getTransformPoolStats } from '../transform/index.js';
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
  createRateLimitManagerImpl,
  type RateLimitManagerImpl,
} from './rate-limit.js';

// --- helpers.ts ---
// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export type NetworkServer = Server | HttpsServer;

function abortControllerBestEffort(controller: AbortController): void {
  if (!controller.signal.aborted) controller.abort();
}

function destroyRequestBestEffort(req: IncomingMessage): void {
  try {
    req.destroy();
  } catch {
    // Best-effort only.
  }
}

export interface RequestContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  method: string | undefined;
  ip: string | null;
  body: unknown;
  signal?: AbortSignal;
}

export interface AuthenticatedContext extends RequestContext {
  auth: AuthInfo;
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

function setNoStoreHeaders(res: ServerResponse): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
}

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown
): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  setNoStoreHeaders(res);
  res.end(JSON.stringify(body));
}

export function sendEmpty(res: ServerResponse, status: number): void {
  res.statusCode = status;
  res.setHeader('Content-Length', '0');
  res.end();
}

export function sendError(
  res: ServerResponse,
  _code: number,
  message: string,
  status = 400,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- kept for call-site compat
  _id?: JsonRpcId | null
): void {
  sendJson(res, status, { error: message });
}

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

export function getHeaderValue(
  req: IncomingMessage,
  name: string
): string | null {
  const val = req.headers[name];
  if (!val) return null;
  return Array.isArray(val) ? (val[0] ?? null) : val;
}

export function getMcpSessionId(req: IncomingMessage): string | null {
  return (
    getHeaderValue(req, 'mcp-session-id') ??
    getHeaderValue(req, 'x-mcp-session-id')
  );
}

const SINGLE_VALUE_HEADER_NAMES: readonly string[] = [
  'authorization',
  'x-api-key',
  'host',
  'origin',
  'content-length',
  'mcp-protocol-version',
  'mcp-session-id',
  'x-mcp-session-id',
];

function hasDuplicateHeader(req: IncomingMessage, name: string): boolean {
  const values = req.headersDistinct[name];
  return Array.isArray(values) && values.length > 1;
}

export function findDuplicateSingleValueHeader(
  req: IncomingMessage
): string | null {
  for (const name of SINGLE_VALUE_HEADER_NAMES) {
    if (hasDuplicateHeader(req, name)) return name;
  }
  return null;
}

export function drainRequest(req: IncomingMessage): void {
  if (req.readableEnded) return;
  try {
    req.resume();
  } catch {
    // Best-effort only.
  }
}

// ---------------------------------------------------------------------------
// Request abort signal
// ---------------------------------------------------------------------------

export function createRequestAbortSignal(req: IncomingMessage): {
  signal: AbortSignal;
  cleanup: () => void;
} {
  const controller = new AbortController();

  let cleanedUp = false;

  const abortRequest = (): void => {
    if (cleanedUp) return;
    abortControllerBestEffort(controller);
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

  const onClose = (): void => {
    // A normal close after a complete body should not be treated as cancellation.
    if (req.complete) return;
    abortRequest();
  };
  const onError = (): void => {
    abortRequest();
  };

  req.once('close', onClose);
  req.once('error', onError);

  return {
    signal: controller.signal,
    cleanup: () => {
      cleanedUp = true;
      req.removeListener('close', onClose);
      req.removeListener('error', onError);
    },
  };
}

// ---------------------------------------------------------------------------
// IP & connection helpers
// ---------------------------------------------------------------------------

function normalizeRemoteAddress(address: string | undefined): string | null {
  if (!address) return null;
  const trimmed = address.trim();
  if (!trimmed) return null;

  const normalized = normalizeIpForBlockList(trimmed);
  if (normalized) return normalized.ip;
  return trimmed;
}

export function registerInboundBlockList(server: NetworkServer): void {
  if (!config.server.http.blockPrivateConnections) return;

  const blockList = createDefaultBlockList();

  server.on('connection', (socket: Socket) => {
    const raw = socket.remoteAddress?.trim();
    if (!raw) return;

    const normalized = normalizeIpForBlockList(raw);
    if (!normalized) return;

    if (blockList.check(normalized.ip, normalized.family)) {
      logWarn(
        'Blocked inbound connection',
        {
          remoteAddress: normalized.ip,
          family: normalized.family,
        },
        Loggers.LOG_HTTP
      );
      socket.destroy();
    }
  });
}

// ---------------------------------------------------------------------------
// Request context builder
// ---------------------------------------------------------------------------

export function buildRequestContext(
  req: IncomingMessage,
  res: ServerResponse,
  signal?: AbortSignal
): RequestContext | null {
  const url = URL.parse(req.url ?? '', 'http://localhost');
  if (!url) {
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

// ---------------------------------------------------------------------------
// Transport / MCP helpers
// ---------------------------------------------------------------------------

export async function closeTransportBestEffort(
  transport: { close: () => Promise<unknown> },
  context: string
): Promise<void> {
  try {
    await transport.close();
  } catch (error) {
    logWarn('Transport close failed', { context, error }, Loggers.LOG_HTTP);
  }
}

export async function closeMcpServerBestEffort(
  server: McpServer,
  context: string
): Promise<void> {
  try {
    await server.close();
  } catch (error) {
    logWarn('MCP server close failed', { context, error }, Loggers.LOG_HTTP);
  }
}

export function createTransportAdapter(
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

// ---------------------------------------------------------------------------
// JSON body reading
// ---------------------------------------------------------------------------

type JsonBodyErrorKind = 'payload-too-large' | 'invalid-json' | 'read-failed';

export class JsonBodyError extends Error {
  readonly kind: JsonBodyErrorKind;

  constructor(kind: JsonBodyErrorKind, message: string) {
    super(message);
    this.name = 'JsonBodyError';
    this.kind = kind;
  }
}

export function isJsonBodyError(error: unknown): error is JsonBodyError {
  return error instanceof JsonBodyError;
}

export const DEFAULT_BODY_LIMIT_BYTES = 1024 * 1024;

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
        const error = new JsonBodyError(
          'payload-too-large',
          'Payload too large'
        );
        throw error;
      }
    }

    if (signal?.aborted || isRequestReadAborted(req)) {
      const error = new JsonBodyError('read-failed', 'Request aborted');
      throw error;
    }

    const body = await this.readBody(req, limit, signal);
    if (!body) return undefined;

    try {
      return JSON.parse(body);
    } catch (err: unknown) {
      const error = new JsonBodyError('invalid-json', getErrorMessage(err));
      throw error;
    }
  }

  private async readBody(
    req: IncomingMessage,
    limit: number,
    signal?: AbortSignal
  ): Promise<string | undefined> {
    const abortListener =
      signal != null
        ? (): void => {
            destroyRequestBestEffort(req);
          }
        : null;

    if (signal != null && abortListener) {
      if (signal.aborted) {
        abortListener();
      } else {
        signal.addEventListener('abort', abortListener, { once: true });
      }
    }

    try {
      const { chunks, size } = await this.collectChunks(req, limit, signal);
      if (chunks.length === 0) return undefined;
      const combined = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        combined.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const text = new TextDecoder().decode(combined);
      return text;
    } finally {
      if (signal && abortListener) {
        try {
          signal.removeEventListener('abort', abortListener);
        } catch {
          // Best-effort cleanup.
        }
      }
    }
  }

  private async collectChunks(
    req: IncomingMessage,
    limit: number,
    signal?: AbortSignal
  ): Promise<{ chunks: Uint8Array[]; size: number }> {
    let size = 0;
    const chunks: Uint8Array[] = [];

    const sink = new Writable({
      write: (chunk, _encoding, callback): void => {
        try {
          if (signal?.aborted || isRequestReadAborted(req)) {
            callback(new JsonBodyError('read-failed', 'Request aborted'));
            return;
          }

          const buf = this.normalizeChunk(chunk as Uint8Array | string);
          size += buf.byteLength;

          if (size > limit) {
            callback(
              new JsonBodyError('payload-too-large', 'Payload too large')
            );
            return;
          }

          chunks.push(buf);
          callback();
        } catch (err: unknown) {
          callback(toError(err));
        }
      },
    });

    try {
      if (signal?.aborted || isRequestReadAborted(req)) {
        const error = new JsonBodyError('read-failed', 'Request aborted');
        throw error;
      }

      await pipeline(req, sink, signal ? { signal } : undefined);
      return { chunks, size };
    } catch (err: unknown) {
      if (err instanceof JsonBodyError) throw err;
      if (signal?.aborted || isRequestReadAborted(req)) {
        const error = new JsonBodyError('read-failed', 'Request aborted');
        throw error;
      }
      const error = new JsonBodyError('read-failed', getErrorMessage(err));
      throw error;
    }
  }

  private normalizeChunk(chunk: Uint8Array | string): Uint8Array {
    if (typeof chunk === 'string') {
      const encoded = new TextEncoder().encode(chunk);
      return encoded;
    }
    return chunk;
  }
}

export const jsonBodyReader = new JsonBodyReader();

interface SessionRecordLike {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
}

interface SessionTeardownOptions {
  cancelMessage: string;
  closeServerReason?: string;
  closeTransportReason?: string;
  unregisterByServer?: boolean;
  awaitClose?: boolean;
}

type SessionCloseOptions = Pick<
  SessionTeardownOptions,
  'closeServerReason' | 'closeTransportReason' | 'awaitClose'
>;

function unregisterSessionTaskScope(server: McpServer): string | null {
  const sessionId = resolveMcpSessionIdByServer(server);
  if (!sessionId) return null;

  unregisterMcpSessionServer(sessionId);
  return sessionId;
}

async function closeSessionResources(
  session: SessionRecordLike,
  options: SessionCloseOptions
): Promise<void> {
  const closeTasks: Promise<unknown>[] = [];
  if (options.closeTransportReason) {
    closeTasks.push(
      closeTransportBestEffort(session.transport, options.closeTransportReason)
    );
  }
  if (options.closeServerReason) {
    closeTasks.push(
      closeMcpServerBestEffort(session.server, options.closeServerReason)
    );
  }

  if (options.awaitClose && closeTasks.length > 0) {
    await Promise.all(closeTasks);
  }
}

export async function teardownSessionResources(
  session: SessionRecordLike,
  options: SessionTeardownOptions
): Promise<void> {
  unregisterSessionTaskScope(session.server);

  if (options.unregisterByServer) {
    unregisterMcpSessionServerByServer(session.server);
  }

  await closeSessionResources(session, options);
}

export async function teardownUnregisteredSessionResources(
  session: SessionRecordLike,
  context: string
): Promise<void> {
  await closeSessionResources(session, {
    closeTransportReason: context,
    closeServerReason: context,
    awaitClose: true,
  });
}

export function teardownSessionRegistration(server: McpServer): void {
  unregisterSessionTaskScope(server);
}

// --- health.ts ---
// ---------------------------------------------------------------------------
// Event-loop monitoring
// ---------------------------------------------------------------------------

const EVENT_LOOP_DELAY_RESOLUTION_MS = 20;
const eventLoopDelay = monitorEventLoopDelay({
  resolution: EVENT_LOOP_DELAY_RESOLUTION_MS,
});
let lastEventLoopUtilization = performance.eventLoopUtilization();

export function resetEventLoopMonitoring(): void {
  lastEventLoopUtilization = performance.eventLoopUtilization();
  eventLoopDelay.reset();
  eventLoopDelay.enable();
}

export function disableEventLoopMonitoring(): void {
  eventLoopDelay.disable();
}

// ---------------------------------------------------------------------------
// Stats helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Health response building
// ---------------------------------------------------------------------------

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
    availableMemory?: number;
    constrainedMemory?: number;
  };
  perf?: ReturnType<typeof getEventLoopStats>;
  activeResources?: string[];
  stats?: {
    activeSessions: number;
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
      ...(typeof process.availableMemory === 'function'
        ? { availableMemory: process.availableMemory() }
        : {}),
      ...(typeof process.constrainedMemory === 'function'
        ? { constrainedMemory: process.constrainedMemory() }
        : {}),
    },
    perf: getEventLoopStats(),
    ...(typeof process.getActiveResourcesInfo === 'function'
      ? { activeResources: process.getActiveResourcesInfo() }
      : {}),
    stats: {
      activeSessions: store.size(),
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

// ---------------------------------------------------------------------------
// Health route helpers
// ---------------------------------------------------------------------------

export function isVerboseHealthRequest(ctx: RequestContext): boolean {
  const value = ctx.url.searchParams.get('verbose');
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true';
}

function isHealthRoute(ctx: RequestContext): boolean {
  return ctx.method === 'GET' && ctx.url.pathname === '/health';
}

function isVerboseHealthRoute(ctx: RequestContext): boolean {
  return isHealthRoute(ctx) && isVerboseHealthRequest(ctx);
}

function ensureHealthAuthIfNeeded(
  ctx: RequestContext,
  authPresent: boolean
): boolean {
  if (!isVerboseHealthRoute(ctx)) return true;
  if (!config.security.allowRemote) return true;
  if (authPresent) return true;

  sendJson(ctx.res, 401, {
    error: 'Authentication required for verbose health metrics',
  });
  return false;
}

function resolveHealthDiagnosticsMode(
  ctx: RequestContext,
  authPresent: boolean
): boolean {
  return (
    isVerboseHealthRoute(ctx) && (authPresent || !config.security.allowRemote)
  );
}

export function shouldHandleHealthRoute(ctx: RequestContext): boolean {
  return isHealthRoute(ctx);
}

export function sendHealthRouteResponse(
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

// --- native.ts ---
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
    Loggers.LOG_HTTP
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
    logError('HTTP request failed with server error', meta, Loggers.LOG_HTTP);
    return;
  }

  if (params.statusCode >= 400) {
    logWarn('HTTP client error', meta, Loggers.LOG_HTTP);
    return;
  }

  logDebug('HTTP request completed', meta, Loggers.LOG_HTTP);
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
      Loggers.LOG_HTTP
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

    logDebug('MCP GET received', { sessionId }, Loggers.LOG_HTTP);
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
    logDebug('MCP DELETE received', { sessionId }, Loggers.LOG_HTTP);
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
    if (isObject(body) && !Array.isArray(body)) {
      return body as PostRequestBody;
    }

    return { id: undefined, method: undefined };
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
    logDebug('Session initialized', { sessionId }, Loggers.LOG_SESSION);
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

        logWarn('Session init timeout', { sessionId }, Loggers.LOG_SESSION);
        this.cleanupSessionRecord(
          sessionId,
          createSessionTeardownOptions('init-timeout')
        );
        return;
      }

      logWarn(
        'Session init timeout before registration completed',
        { sessionId },
        Loggers.LOG_SESSION
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
        Loggers.LOG_SESSION
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
        Loggers.LOG_SESSION
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
        Loggers.LOG_SESSION
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
        Loggers.LOG_SESSION
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
        Loggers.LOG_SESSION
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
      Loggers.LOG_SESSION
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
    logDebug('Session cleanup', { sessionId, context }, Loggers.LOG_SESSION);
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
        Loggers.LOG_SESSION
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
        Loggers.LOG_SESSION
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
      logError('Request failed', error, Loggers.LOG_HTTP);
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
        Loggers.LOG_AUTH
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
          Loggers.LOG_HTTP
        );
      } else if (bodyErrorKind === 'read-failed' || bodyErrorKind === null) {
        logError(
          'Request body parsing failed',
          toError(error),
          Loggers.LOG_HTTP
        );
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
  logError('Request pipeline failed', toError(error), Loggers.LOG_HTTP);

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
    throw Error(
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
    throw Error(
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
    logInfo(`Stopping HTTP server (${signal})...`, undefined, Loggers.LOG_HTTP);

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
            Loggers.LOG_HTTP
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
    Loggers.LOG_HTTP
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
