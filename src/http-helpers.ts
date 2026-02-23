import { Buffer } from 'node:buffer';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { Server as HttpsServer } from 'node:https';
import type { Socket } from 'node:net';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

import { config } from './config.js';
import {
  createDefaultBlockList,
  normalizeIpForBlockList,
} from './ip-blocklist.js';
import type { JsonRpcId } from './mcp-validator.js';
import { logWarn } from './observability.js';
import { composeCloseHandlers } from './session.js';

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export type NetworkServer = Server | HttpsServer;

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

export function setNoStoreHeaders(res: ServerResponse): void {
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

export function sendText(
  res: ServerResponse,
  status: number,
  body: string
): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  setNoStoreHeaders(res);
  res.end(body);
}

export function sendEmpty(res: ServerResponse, status: number): void {
  res.statusCode = status;
  res.setHeader('Content-Length', '0');
  res.end();
}

export function sendError(
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

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

export function getHeaderValue(
  req: IncomingMessage,
  name: string
): string | null {
  const val = req.headers[name];
  if (!val) return null;
  if (Array.isArray(val)) return val[0] ?? null;
  return val;
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

  const onAborted = abortRequest;
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

// ---------------------------------------------------------------------------
// IP & connection helpers
// ---------------------------------------------------------------------------

export function normalizeRemoteAddress(
  address: string | undefined
): string | null {
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

// ---------------------------------------------------------------------------
// Request context builder
// ---------------------------------------------------------------------------

export function buildRequestContext(
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
    logWarn('Transport close failed', { context, error });
  }
}

export async function closeMcpServerBestEffort(
  server: McpServer,
  context: string
): Promise<void> {
  try {
    await server.close();
  } catch (error) {
    logWarn('MCP server close failed', { context, error });
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

export const jsonBodyReader = new JsonBodyReader();
