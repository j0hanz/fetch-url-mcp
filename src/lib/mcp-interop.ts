import {
  type McpServer,
  ProtocolError,
  RELATED_TASK_META_KEY,
  type ServerContext,
} from '@modelcontextprotocol/server';

import type { ServerResponse } from 'node:http';
import { setTimeout as setTimeoutPromise } from 'node:timers/promises';

import { z } from 'zod';

import { Loggers, logWarn } from './core.js';
import { getErrorMessage } from './error/index.js';
import { formatZodError, isObject } from './utils.js';

export function createProtocolError(
  code: number,
  message: string,
  data?: unknown
): ProtocolError {
  return ProtocolError.fromError(code, message, data);
}

interface JsonRpcErrorPayload {
  code: number;
  message: string;
  data?: unknown;
}

export function buildJsonRpcErrorBody(
  code: number,
  message: string,
  id: JsonRpcId = null,
  data?: unknown
): {
  jsonrpc: '2.0';
  error: JsonRpcErrorPayload;
  id: JsonRpcId;
} {
  return {
    jsonrpc: '2.0',
    error: {
      code,
      message,
      ...(data !== undefined ? { data } : {}),
    },
    id,
  };
}

export function sendJsonRpcError(
  res: ServerResponse,
  status: number,
  code: number,
  message: string,
  id: JsonRpcId = null,
  data?: unknown
): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(buildJsonRpcErrorBody(code, message, id, data)));
}

/* =================================================================================================
 * JSON-RPC / Media type parsing
 * ================================================================================================= */

export type JsonRpcId = string | number | null;
const paramsSchema = z.looseObject({
  _meta: z.record(z.string(), z.unknown()).optional(),
});
const jsonRpcRequestIdSchema = z.union([z.string(), z.number()]);
const jsonRpcRequestSchema = z.strictObject({
  jsonrpc: z.literal('2.0'),
  method: z.string().min(1),
  id: jsonRpcRequestIdSchema.optional(),
  params: paramsSchema.optional(),
});
const jsonRpcResultResponseSchema = z.strictObject({
  jsonrpc: z.literal('2.0'),
  id: jsonRpcRequestIdSchema,
  result: z.record(z.string(), z.unknown()),
});
const jsonRpcErrorResponseSchema = z.strictObject({
  jsonrpc: z.literal('2.0'),
  id: jsonRpcRequestIdSchema.or(z.null()).optional(),
  error: z.strictObject({
    code: z.number().int(),
    message: z.string(),
    data: z.unknown().optional(),
  }),
});
const jsonRpcResponseSchema = z.union([
  jsonRpcResultResponseSchema,
  jsonRpcErrorResponseSchema,
]);
const jsonRpcMessageSchema = z.union([
  jsonRpcRequestSchema,
  jsonRpcResponseSchema,
]);
type McpRequestBody = z.infer<typeof jsonRpcRequestSchema>;
type JsonRpcResponseBody = z.infer<typeof jsonRpcResponseSchema>;
type JsonRpcMessageBody = z.infer<typeof jsonRpcMessageSchema>;
export function isJsonRpcBatchRequest(body: unknown): boolean {
  return Array.isArray(body);
}
export function isMcpRequestBody(body: unknown): body is McpRequestBody {
  return jsonRpcRequestSchema.safeParse(body).success;
}
export function isJsonRpcResponseBody(
  body: unknown
): body is JsonRpcResponseBody {
  return jsonRpcResponseSchema.safeParse(body).success;
}
export function isMcpMessageBody(body: unknown): body is JsonRpcMessageBody {
  return jsonRpcMessageSchema.safeParse(body).success;
}
function parseAcceptMediaTypes(
  header: string | null | undefined
): readonly string[] {
  if (!header) return [];
  return header
    .split(',')
    .map((v) => v.split(';', 1)[0]?.trim().toLowerCase() ?? '')
    .filter((v) => v.length > 0);
}
export function acceptsEventStream(header: string | null | undefined): boolean {
  const mediaTypes = parseAcceptMediaTypes(header);
  return mediaTypes.some((mediaType) => mediaType === 'text/event-stream');
}
export function acceptsJsonAndEventStream(
  header: string | null | undefined
): boolean {
  const mediaTypes = parseAcceptMediaTypes(header);
  const acceptsJson = mediaTypes.some(
    (m) => m === '*/*' || m === 'application/json' || m === 'application/*'
  );
  if (!acceptsJson) return false;

  return mediaTypes.some(
    (m) => m === '*/*' || m === 'text/event-stream' || m === 'text/*'
  );
}

/* =================================================================================================
 * SDK interop — server lifecycle & capability patching
 * ================================================================================================= */

type CleanupCallback = () => void;
const patchedCleanupServers = new WeakSet<McpServer>();
const serverCleanupCallbacks = new WeakMap<McpServer, Set<CleanupCallback>>();

function getServerCleanupCallbackSet(server: McpServer): Set<CleanupCallback> {
  let callbacks = serverCleanupCallbacks.get(server);
  if (!callbacks) {
    callbacks = new Set<CleanupCallback>();
    serverCleanupCallbacks.set(server, callbacks);
  }
  return callbacks;
}

function drainServerCleanupCallbacks(server: McpServer): void {
  const callbacks = serverCleanupCallbacks.get(server);
  if (!callbacks || callbacks.size === 0) return;

  const pending = [...callbacks];
  callbacks.clear();
  for (const callback of pending) {
    try {
      callback();
    } catch (error: unknown) {
      logWarn('Server cleanup callback failed', { error }, Loggers.LOG_MCP);
    }
  }
}

function ensureServerCleanupHooks(server: McpServer): void {
  if (patchedCleanupServers.has(server)) return;
  patchedCleanupServers.add(server);

  const originalOnClose = server.server.onclose;
  server.server.onclose = () => {
    drainServerCleanupCallbacks(server);
    originalOnClose?.();
  };

  const originalClose = server.close.bind(server);
  server.close = async (): Promise<void> => {
    drainServerCleanupCallbacks(server);
    await originalClose();
  };
}

export function registerServerLifecycleCleanup(
  server: McpServer,
  callback: CleanupCallback
): void {
  ensureServerCleanupHooks(server);
  getServerCleanupCallbackSet(server).add(callback);
}

/* =================================================================================================
 * Progress reporting
 * ================================================================================================= */

type ProgressToken = string | number;

interface RequestMeta {
  progressToken?: ProgressToken | undefined;
  [key: string]: unknown;
}

export interface ProgressNotificationParams {
  progressToken: ProgressToken;
  progress: number;
  total?: number;
  message?: string;
  _meta?: Record<string, unknown>;
}

export interface ProgressNotification {
  method: 'notifications/progress';
  params: ProgressNotificationParams;
}

export interface ProgressReporter {
  report: (progress: number, message: string, total?: number) => void;
}

const PROGRESS_NOTIFICATION_TIMEOUT_MS = 5000;
const PROGRESS_NOTIFICATION_MIN_INTERVAL_MS = 100;

function resolveRelatedTaskMeta(
  meta?: RequestMeta
): { taskId: string } | undefined {
  const related = meta?.[RELATED_TASK_META_KEY];
  if (!isObject(related)) return undefined;
  const { taskId } = related;
  return typeof taskId === 'string' ? { taskId } : undefined;
}

class ToolProgressReporter implements ProgressReporter {
  private lastProgress = -1;
  private lastTotal: number | undefined;
  private pendingNotification: ProgressNotification | undefined;
  private isDispatching = false;
  private lastDispatchedAt = 0;

  private constructor(
    private readonly token: ProgressToken,
    private readonly send: (
      notification: ProgressNotification
    ) => Promise<void>,
    private readonly taskMeta?: { taskId: string }
  ) {}

  static create(ctx?: ServerContext): ProgressReporter {
    if (!ctx) {
      return { report: () => {} };
    }

    const meta = ctx.mcpReq._meta as RequestMeta | undefined;
    const token = meta?.progressToken ?? null;

    if (token === null) {
      return { report: () => {} };
    }

    const send = (notification: ProgressNotification): Promise<void> =>
      ctx.mcpReq.notify({
        method: notification.method,
        params: { ...notification.params },
      });

    return new ToolProgressReporter(token, send, resolveRelatedTaskMeta(meta));
  }

  /**
   * Report progress toward completion. Steps are monotonic (never decrease)
   * and may be skipped under normal conditions (e.g., fast responses skip
   * intermediate steps). Clients should treat progress as "at least this far"
   * rather than expecting every step to fire sequentially.
   */
  report(progress: number, message: string, total?: number): void {
    const effectiveProgress = Math.max(progress, this.lastProgress);
    const effectiveTotal =
      total === undefined ? this.lastTotal : Math.max(total, effectiveProgress);
    const isIncreasing = effectiveProgress > this.lastProgress;

    this.lastProgress = effectiveProgress;
    this.lastTotal = effectiveTotal;

    if (!isIncreasing) return;

    this.pendingNotification = this.createProgressNotification({
      token: this.token,
      progress: effectiveProgress,
      message,
      ...(effectiveTotal !== undefined ? { total: effectiveTotal } : {}),
    });
    this.flushNotifications();
  }

  private flushNotifications(): void {
    if (this.isDispatching) return;
    this.isDispatching = true;

    void (async (): Promise<void> => {
      try {
        while (this.pendingNotification) {
          const remainingDelay =
            this.lastDispatchedAt +
            PROGRESS_NOTIFICATION_MIN_INTERVAL_MS -
            Date.now();
          if (remainingDelay > 0) {
            await setTimeoutPromise(remainingDelay, undefined, { ref: false });
          }

          const notification = this.pendingNotification;
          this.pendingNotification = undefined;
          await this.sendWithTimeout(notification);
          this.lastDispatchedAt = Date.now();
        }
      } finally {
        this.isDispatching = false;
      }
    })();
  }

  private async sendWithTimeout(
    notification: ProgressNotification
  ): Promise<void> {
    const ac = new AbortController();
    const timeoutPromise = setTimeoutPromise(
      PROGRESS_NOTIFICATION_TIMEOUT_MS,
      { timeout: true as const },
      { signal: ac.signal, ref: false }
    ).catch((err: unknown) => {
      if ((err as Error).name === 'AbortError') return { ok: true as const };
      throw err;
    });

    try {
      const outcome = await Promise.race([
        this.send(notification).then(() => {
          ac.abort();
          return { ok: true as const };
        }),
        timeoutPromise,
      ]);

      if ('timeout' in outcome) {
        logWarn(
          'Progress notification timed out',
          {
            progress: notification.params.progress,
            message: notification.params.message,
          },
          Loggers.LOG_MCP
        );
      }
    } catch (error: unknown) {
      logWarn(
        'Failed to send progress notification',
        {
          error: getErrorMessage(error),
          progress: notification.params.progress,
          message: notification.params.message,
        },
        Loggers.LOG_MCP
      );
    }
  }

  private createProgressNotification(params: {
    token: ProgressToken;
    progress: number;
    message: string;
    total?: number;
  }): ProgressNotification {
    return {
      method: 'notifications/progress',
      params: {
        progressToken: params.token,
        progress: params.progress,
        ...(params.total !== undefined ? { total: params.total } : {}),
        message: params.message,
        ...(this.taskMeta && {
          _meta: {
            [RELATED_TASK_META_KEY]: this.taskMeta,
          },
        }),
      },
    };
  }
}

export const createProgressReporter = (ctx?: ServerContext): ProgressReporter =>
  ToolProgressReporter.create(ctx);

export function validateOrThrow<T>(
  schema: z.ZodType<T>,
  data: unknown,
  errorCode: number,
  msg: string,
  logger: string
): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    const issues = formatZodError(result.error);
    logWarn(`Zod validation failed: ${msg}`, { issues }, logger);
    throw createProtocolError(errorCode, msg, { issues });
  }
  return result.data;
}
